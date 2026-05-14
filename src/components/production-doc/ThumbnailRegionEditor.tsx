"use client";

/**
 * Visual region editor for the section-divider thumbnail.
 *
 * Phase 3 of `_plans/2026-05-13-thumbnail-zoom-section-divider.md`. The
 * creator opens this modal from the SectionThumbnailCard, sees their
 * uploaded composite at full size, and draws labelled rectangles
 * around each section's tile. Saved rectangles become the targets
 * production-doc rows reference via "Zoom to" in a later phase.
 *
 * Coordinate system: rectangles are stored in INTRINSIC image pixels
 * so they're resolution-independent. The image displays at whatever
 * scale fits the modal; we recompute display↔image scale per pointer
 * event from `<img>.getBoundingClientRect()` so a window resize during
 * editing doesn't corrupt subsequent drags.
 *
 * Persistence: regions are local-only until "Save" is clicked, with a
 * localStorage draft so an accidental close + reopen restores work.
 * On Save, the editor hands the final array back to its parent (which
 * persists through the production-doc save flow). On Cancel, the
 * draft is also dropped so the next open is clean.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { ThumbnailRegion, VideoThumbnail } from '@/remotion/types';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Soft-fill palette. Cycled by region order so adjacent regions differ.
 *  Exported so other UI surfaces (per-row controls) can pick the same color
 *  per region — visual consistency across the editor and the doc table. */
export const REGION_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b',
] as const;
const PALETTE = REGION_PALETTE;

/** Minimum committed rectangle, in image pixels. Anything smaller is treated as a misclick. */
const MIN_RECT_PX = 12;
/** Snap-to-image-edge threshold during draw, in image pixels. */
const SNAP_PX = 6;
/** Entrance + exit animation duration, ms. Kept short so the editor stays snappy. */
const ANIM_MS = 140;
/** Visible resize-handle chip size, in display pixels. Hit target is larger
 *  (see HANDLE_HIT_PX) so touch users can grab them comfortably. */
const HANDLE_DISPLAY_PX = 10;
/** Invisible hit-target around the visible handle chip. Touch screens need ≥ 24px;
 *  desktop with a mouse is happy with anything ≥ 14px. 24 is a safe middle. */
const HANDLE_HIT_PX = 24;
/** Undo stack cap. */
const UNDO_MAX = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

type DragMode =
  | { kind: 'idle' }
  | { kind: 'drawing'; startIx: number; startIy: number; ix: number; iy: number }
  | { kind: 'moving'; regionId: string; startIx: number; startIy: number; origX: number; origY: number }
  | {
      kind: 'resizing';
      regionId: string;
      handle: 'tl' | 'tr' | 'bl' | 'br' | 't' | 'r' | 'b' | 'l';
      startIx: number; startIy: number;
      origX: number; origY: number; origW: number; origH: number;
    };

interface ThumbnailRegionEditorProps {
  thumbnail: VideoThumbnail;
  onSave: (regions: ThumbnailRegion[]) => void;
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeId(): string {
  return `reg_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function snapToEdge(v: number, max: number): number {
  if (v < SNAP_PX) return 0;
  if (v > max - SNAP_PX) return max;
  return v;
}

/**
 * Snap a whole rectangle's POSITION (size unchanged) to the image edges
 * when any of its four sides falls within SNAP_PX. Used during MOVE.
 */
function snapRectMove(
  x: number, y: number, w: number, h: number,
  imgW: number, imgH: number,
): { x: number; y: number } {
  let nx = x;
  let ny = y;
  if (Math.abs(nx) < SNAP_PX) nx = 0;
  else if (Math.abs(imgW - (nx + w)) < SNAP_PX) nx = imgW - w;
  if (Math.abs(ny) < SNAP_PX) ny = 0;
  else if (Math.abs(imgH - (ny + h)) < SNAP_PX) ny = imgH - h;
  return { x: nx, y: ny };
}

/**
 * Snap the edges currently being dragged (per `handle`) to the image
 * bounds when within SNAP_PX. Adjusts SIZE for r/b handles and BOTH
 * position + size for l/t handles. Used during RESIZE.
 */
function snapRectResize(
  x: number, y: number, w: number, h: number,
  handle: string, imgW: number, imgH: number,
): { x: number; y: number; w: number; h: number } {
  let nx = x;
  let ny = y;
  let nw = w;
  let nh = h;
  if (handle.includes('l') && Math.abs(nx) < SNAP_PX) {
    const right = nx + nw;
    nx = 0;
    nw = right;
  }
  if (handle.includes('t') && Math.abs(ny) < SNAP_PX) {
    const bottom = ny + nh;
    ny = 0;
    nh = bottom;
  }
  if (handle.includes('r') && Math.abs(imgW - (nx + nw)) < SNAP_PX) {
    nw = imgW - nx;
  }
  if (handle.includes('b') && Math.abs(imgH - (ny + nh)) < SNAP_PX) {
    nh = imgH - ny;
  }
  return { x: nx, y: ny, w: nw, h: nh };
}

export function regionColorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
// Internal alias so existing call sites keep working unchanged.
const colorFor = regionColorFor;

function draftKey(imageUrl: string): string {
  return `prodoc-regions-draft:${imageUrl.slice(0, 200)}`;
}

function loadDraft(imageUrl: string): ThumbnailRegion[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(draftKey(imageUrl));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((r): r is ThumbnailRegion =>
      r && typeof r.id === 'string' && typeof r.label === 'string' &&
      typeof r.x === 'number' && typeof r.y === 'number' &&
      typeof r.w === 'number' && typeof r.h === 'number',
    );
  } catch {
    return null;
  }
}

function saveDraft(imageUrl: string, regions: ThumbnailRegion[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(draftKey(imageUrl), JSON.stringify(regions));
  } catch {
    // Quota or disabled storage — drafts are best-effort.
  }
}

function clearDraft(imageUrl: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(draftKey(imageUrl));
  } catch {
    // ignore
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ThumbnailRegionEditor({ thumbnail, onSave, onClose }: ThumbnailRegionEditorProps) {
  // Local working copy of regions. Initialized from the saved draft if
  // one exists for this image, otherwise from the persisted regions. The
  // `?? []` belt-and-suspenders defends against an older history entry
  // that pre-dates the regions field (TS would say it can't happen; old
  // JSON in the DB can).
  const [regions, setRegions] = useState<ThumbnailRegion[]>(() => {
    const draft = loadDraft(thumbnail.imageUrl);
    return draft ?? thumbnail.regions ?? [];
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [labelEditingId, setLabelEditingId] = useState<string | null>(null);
  const [freshlyDrawnId, setFreshlyDrawnId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragMode>({ kind: 'idle' });
  const [imgReady, setImgReady] = useState(false);
  /** IDs sidebar-hovered now — drives the brighter rect highlight on canvas. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** IDs whose visual is fading out before the actual array filter removes them. */
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Captured at mount via lazy useState — regions present in the initial
  // state skip the entrance animation; anything ADDED after mount plays it.
  // State (not ref) so we can read it during render without lint complaint.
  const [initiallyLoadedIds] = useState<Set<string>>(
    () => new Set((regions ?? []).map(r => r.id)),
  );

  // Undo + redo stacks — snapshots of previous `regions` arrays, capped at UNDO_MAX.
  // Any non-undo/redo mutation pushes to undoRef and clears redoRef. Undo moves a
  // snapshot from undoRef → redoRef. Redo moves it back the other way.
  const undoRef = useRef<ThumbnailRegion[][]>([]);
  const redoRef = useRef<ThumbnailRegion[][]>([]);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Persist draft on every change.
  useEffect(() => {
    saveDraft(thumbnail.imageUrl, regions);
  }, [thumbnail.imageUrl, regions]);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // — Coordinate conversion (display ↔ image pixels) ──────────────────────────

  const eventToImagePoint = useCallback((clientX: number, clientY: number): { ix: number; iy: number } | null => {
    const el = imgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scaleX = rect.width / thumbnail.width;
    const scaleY = rect.height / thumbnail.height;
    return {
      ix: (clientX - rect.left) / scaleX,
      iy: (clientY - rect.top) / scaleY,
    };
  }, [thumbnail.width, thumbnail.height]);

  // — Mutators (each pushes onto the undo stack before applying) ──────────────

  const pushUndo = useCallback(() => {
    undoRef.current.push(regions);
    if (undoRef.current.length > UNDO_MAX) {
      undoRef.current.splice(0, undoRef.current.length - UNDO_MAX);
    }
    // Any new mutation invalidates the redo chain.
    redoRef.current = [];
  }, [regions]);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(regions);
    setRegions(prev);
    setSelectedId(null);
    setLabelEditingId(null);
    setFreshlyDrawnId(null);
    // Cancel any in-flight fade-out animations — the undone state restored
    // the regions so the fade must un-fade.
    setDeletingIds(new Set());
  }, [regions]);

  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(regions);
    setRegions(next);
    setSelectedId(null);
    setLabelEditingId(null);
    setFreshlyDrawnId(null);
    setDeletingIds(new Set());
  }, [regions]);

  const deleteRegion = useCallback((id: string) => {
    // Don't double-delete a region that's already fading out.
    if (deletingIds.has(id)) return;
    pushUndo();
    setDeletingIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    if (selectedId === id) setSelectedId(null);
    if (labelEditingId === id) setLabelEditingId(null);
    if (freshlyDrawnId === id) setFreshlyDrawnId(null);
    // After the fade completes, remove the region from state for real.
    window.setTimeout(() => {
      setRegions(prev => prev.filter(r => r.id !== id));
      setDeletingIds(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, ANIM_MS);
  }, [deletingIds, pushUndo, selectedId, labelEditingId, freshlyDrawnId]);

  const commitLabel = useCallback((id: string, label: string) => {
    const trimmed = label.trim();
    const isFreshlyDrawn = freshlyDrawnId === id;
    if (isFreshlyDrawn && !trimmed) {
      // Empty label on a brand-new region → roll back the draw.
      deleteRegion(id);
      return;
    }
    pushUndo();
    setRegions(prev => prev.map(r => r.id === id ? { ...r, label: trimmed } : r));
    setLabelEditingId(null);
    setFreshlyDrawnId(null);
  }, [pushUndo, deleteRegion, freshlyDrawnId]);

  // — Pointer flow ────────────────────────────────────────────────────────────

  const onCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (!imgReady) return;
    // Don't start a new interaction if the user clicked a sidebar element
    // or the label input — those have their own handlers and stopPropagation.
    if ((e.target as HTMLElement).closest('[data-region-stop]')) return;

    const pt = eventToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    const targetEl = e.target as HTMLElement;
    const handleAttr = targetEl.getAttribute('data-handle');
    const regionAttr = targetEl.getAttribute('data-region-id') ||
      targetEl.closest('[data-region-id]')?.getAttribute('data-region-id') ||
      null;

    // Handle drag (resize) — must come before region drag (move) since
    // handles sit inside region divs.
    if (handleAttr && regionAttr) {
      const region = regions.find(r => r.id === regionAttr);
      if (region) {
        setSelectedId(regionAttr);
        setDrag({
          kind: 'resizing',
          regionId: regionAttr,
          handle: handleAttr as 'tl' | 'tr' | 'bl' | 'br' | 't' | 'r' | 'b' | 'l',
          startIx: pt.ix, startIy: pt.iy,
          origX: region.x, origY: region.y, origW: region.w, origH: region.h,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
    }

    // Region body drag (move)
    if (regionAttr) {
      const region = regions.find(r => r.id === regionAttr);
      if (region) {
        setSelectedId(regionAttr);
        setDrag({
          kind: 'moving',
          regionId: regionAttr,
          startIx: pt.ix, startIy: pt.iy,
          origX: region.x, origY: region.y,
        });
        (e.target as Element).setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
    }

    // Empty canvas → start drawing a new region.
    setSelectedId(null);
    setDrag({ kind: 'drawing', startIx: pt.ix, startIy: pt.iy, ix: pt.ix, iy: pt.iy });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [imgReady, regions, eventToImagePoint]);

  const onCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (drag.kind === 'idle') return;
    const pt = eventToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    if (drag.kind === 'drawing') {
      setDrag({ ...drag, ix: pt.ix, iy: pt.iy });
      return;
    }
    if (drag.kind === 'moving') {
      const dx = pt.ix - drag.startIx;
      const dy = pt.iy - drag.startIy;
      setRegions(prev => prev.map(r => {
        if (r.id !== drag.regionId) return r;
        const clampedX = clamp(drag.origX + dx, 0, thumbnail.width - r.w);
        const clampedY = clamp(drag.origY + dy, 0, thumbnail.height - r.h);
        const snapped = snapRectMove(clampedX, clampedY, r.w, r.h, thumbnail.width, thumbnail.height);
        return { ...r, x: snapped.x, y: snapped.y };
      }));
      return;
    }
    if (drag.kind === 'resizing') {
      const dx = pt.ix - drag.startIx;
      const dy = pt.iy - drag.startIy;
      setRegions(prev => prev.map(r => {
        if (r.id !== drag.regionId) return r;
        let nx = drag.origX;
        let ny = drag.origY;
        let nw = drag.origW;
        let nh = drag.origH;
        if (drag.handle.includes('l')) { nx = drag.origX + dx; nw = drag.origW - dx; }
        if (drag.handle.includes('r')) { nw = drag.origW + dx; }
        if (drag.handle.includes('t')) { ny = drag.origY + dy; nh = drag.origH - dy; }
        if (drag.handle.includes('b')) { nh = drag.origH + dy; }
        // Min size + bounds clamp.
        if (nw < MIN_RECT_PX) {
          if (drag.handle.includes('l')) nx = drag.origX + drag.origW - MIN_RECT_PX;
          nw = MIN_RECT_PX;
        }
        if (nh < MIN_RECT_PX) {
          if (drag.handle.includes('t')) ny = drag.origY + drag.origH - MIN_RECT_PX;
          nh = MIN_RECT_PX;
        }
        nx = clamp(nx, 0, thumbnail.width - nw);
        ny = clamp(ny, 0, thumbnail.height - nh);
        nw = clamp(nw, MIN_RECT_PX, thumbnail.width - nx);
        nh = clamp(nh, MIN_RECT_PX, thumbnail.height - ny);
        const snapped = snapRectResize(nx, ny, nw, nh, drag.handle, thumbnail.width, thumbnail.height);
        return { ...r, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
      }));
    }
  }, [drag, thumbnail.width, thumbnail.height, eventToImagePoint]);

  const onCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    if (drag.kind === 'idle') return;

    if (drag.kind === 'drawing') {
      // Normalize draft rect (handle reverse-direction drags).
      const x0 = Math.min(drag.startIx, drag.ix);
      const y0 = Math.min(drag.startIy, drag.iy);
      const x1 = Math.max(drag.startIx, drag.ix);
      const y1 = Math.max(drag.startIy, drag.iy);
      // Snap edges to image bounds when close.
      const sx0 = snapToEdge(x0, thumbnail.width);
      const sy0 = snapToEdge(y0, thumbnail.height);
      const sx1 = snapToEdge(x1, thumbnail.width);
      const sy1 = snapToEdge(y1, thumbnail.height);
      const w = sx1 - sx0;
      const h = sy1 - sy0;
      if (w >= MIN_RECT_PX && h >= MIN_RECT_PX) {
        const newRegion: ThumbnailRegion = {
          id: makeId(),
          label: '',
          x: clamp(Math.round(sx0), 0, thumbnail.width),
          y: clamp(Math.round(sy0), 0, thumbnail.height),
          w: clamp(Math.round(w), MIN_RECT_PX, thumbnail.width),
          h: clamp(Math.round(h), MIN_RECT_PX, thumbnail.height),
        };
        pushUndo();
        setRegions(prev => [...prev, newRegion]);
        setSelectedId(newRegion.id);
        setLabelEditingId(newRegion.id);
        setFreshlyDrawnId(newRegion.id);
      }
    } else if (drag.kind === 'moving' || drag.kind === 'resizing') {
      // Snapshot the post-move/resize state for undo. We push the
      // pre-drag state retroactively by re-doing the same move on a
      // copy stored at pointerdown time — simpler: snapshot AFTER
      // and let undo step back to before this drag in one hop.
      pushUndo();
    }

    setDrag({ kind: 'idle' });
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }, [drag, thumbnail.width, thumbnail.height, pushUndo]);

  // — Save / Cancel ───────────────────────────────────────────────────────────
  //
  // Declared above the keyboard effect so the effect's dep array can
  // reference `handleCancel` without hitting the TDZ.

  const handleSave = useCallback(() => {
    // Strip transient state from the payload — only the persistent fields.
    const payload = regions.map<ThumbnailRegion>(r => ({
      id: r.id, label: r.label, x: r.x, y: r.y, w: r.w, h: r.h,
    }));
    clearDraft(thumbnail.imageUrl);
    onSave(payload);
    toast.success(`Saved ${payload.length} region${payload.length === 1 ? '' : 's'}.`);
  }, [regions, thumbnail.imageUrl, onSave]);

  const handleCancel = useCallback(() => {
    clearDraft(thumbnail.imageUrl);
    onClose();
  }, [thumbnail.imageUrl, onClose]);

  // — Keyboard ────────────────────────────────────────────────────────────────

  // Nudge "session" timestamp — Arrow-key spam collapses to a single undo step
  // (one snapshot at the start of the session; subsequent nudges add to it).
  const lastNudgeAtRef = useRef(0);
  const NUDGE_SESSION_MS = 600;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept keys while typing in inputs.
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (drag.kind === 'drawing') {
          setDrag({ kind: 'idle' });
          return;
        }
        if (selectedId) {
          setSelectedId(null);
          return;
        }
        // No in-progress draw and nothing selected → close the modal.
        // Matches the TransitionDialog Esc-to-close convention.
        handleCancel();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        deleteRegion(selectedId);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        // Windows convention: Ctrl-Y is redo.
        e.preventDefault();
        redo();
        return;
      }
      // Arrow-key nudge on the selected region.
      // 1px per press, 10px with Shift.
      if (selectedId && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const now = Date.now();
        if (now - lastNudgeAtRef.current > NUDGE_SESSION_MS) {
          pushUndo();
        }
        lastNudgeAtRef.current = now;
        setRegions(prev => prev.map(r => {
          if (r.id !== selectedId) return r;
          const nx = clamp(r.x + dx, 0, thumbnail.width - r.w);
          const ny = clamp(r.y + dy, 0, thumbnail.height - r.h);
          return { ...r, x: nx, y: ny };
        }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag, selectedId, deleteRegion, undo, redo, pushUndo, handleCancel, thumbnail.width, thumbnail.height]);

  // — Render helpers ──────────────────────────────────────────────────────────

  // Currently-being-drawn draft rectangle (display coords applied in JSX).
  const draftRect = useMemo(() => {
    if (drag.kind !== 'drawing') return null;
    const x0 = Math.min(drag.startIx, drag.ix);
    const y0 = Math.min(drag.startIy, drag.iy);
    const x1 = Math.max(drag.startIx, drag.ix);
    const y1 = Math.max(drag.startIy, drag.iy);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, [drag]);

  // Aspect-ratio wrapper sizes to fit the modal; image fills wrapper.
  const aspectRatio = `${thumbnail.width} / ${thumbnail.height}`;

  // ─── Modal markup ─────────────────────────────────────────────────────────

  const modal = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleCancel(); }}
    >
      <div
        style={{
          background: '#0f1115', borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(1400px, 95vw)', height: 'min(900px, 92vh)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        {/* Title bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
              Mark thumbnail regions
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Drag to draw · Click to select · Drag handles or arrow keys to nudge · Delete to remove · ⌘Z undo · ⇧⌘Z redo
            </div>
          </div>
          <button
            onClick={handleCancel}
            aria-label="Close"
            style={{
              fontSize: 18, lineHeight: 1, padding: '6px 10px', borderRadius: 6,
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)', cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {/* Body: image + sidebar */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Image canvas */}
          <div style={{
            flex: 1, minWidth: 0, padding: 24, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background:
              'repeating-conic-gradient(rgba(255,255,255,0.02) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px',
          }}>
            <div
              ref={wrapperRef}
              style={{
                position: 'relative',
                // `aspect-ratio` alone with only `max-` constraints
                // collapses to 0×0 in a flex/centered parent because
                // there's nothing for the browser to anchor on.
                // Anchor on width and let CSS aspect-ratio compute the
                // height; max-height: 100% caps the wrapper so a tall
                // image doesn't overflow the canvas vertically (modern
                // browsers preserve the ratio when both axes have
                // constraints).
                width: '100%',
                aspectRatio,
                maxWidth: '100%',
                maxHeight: '100%',
                userSelect: 'none',
                touchAction: 'none',
              }}
            >
              {/* Editor canvas — using `<img>` for direct ref + load-event
               *  control. `next/image`'s fill mode would obscure the
               *  imgRef-based coord math the editor relies on. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={thumbnail.imageUrl}
                alt=""
                draggable={false}
                onLoad={() => setImgReady(true)}
                onError={() => toast.error('Could not load thumbnail image.')}
                style={{
                  position: 'absolute', inset: 0,
                  width: '100%', height: '100%',
                  display: 'block', pointerEvents: 'none',
                }}
              />
              <div
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                style={{
                  position: 'absolute', inset: 0,
                  cursor: drag.kind === 'drawing' ? 'crosshair' :
                          (selectedId ? 'default' : 'crosshair'),
                }}
              >
                {regions.map((r, i) => (
                  <RegionRect
                    key={r.id}
                    region={r}
                    color={colorFor(i)}
                    selected={selectedId === r.id}
                    hovered={hoveredId === r.id}
                    editingLabel={labelEditingId === r.id}
                    canvasWidth={thumbnail.width}
                    canvasHeight={thumbnail.height}
                    skipEnterAnimation={initiallyLoadedIds.has(r.id)}
                    deleting={deletingIds.has(r.id)}
                    onEditLabel={() => {
                      setSelectedId(r.id);
                      setLabelEditingId(r.id);
                    }}
                    onCommitLabel={(label) => commitLabel(r.id, label)}
                  />
                ))}
                {draftRect && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${(draftRect.x / thumbnail.width) * 100}%`,
                      top: `${(draftRect.y / thumbnail.height) * 100}%`,
                      width: `${(draftRect.w / thumbnail.width) * 100}%`,
                      height: `${(draftRect.h / thumbnail.height) * 100}%`,
                      border: '2px dashed rgba(255,255,255,0.85)',
                      background: 'rgba(255,255,255,0.06)',
                      pointerEvents: 'none',
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div style={{
            width: 260, borderLeft: '1px solid rgba(255,255,255,0.08)',
            display: 'flex', flexDirection: 'column', minHeight: 0,
          }}>
            <div style={{
              padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)',
              fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
            }}>
              Regions ({regions.length})
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {regions.length === 0 ? (
                <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  Drag on the image to mark a region.
                </div>
              ) : (
                regions.map((r, i) => (
                  <RegionListItem
                    key={r.id}
                    region={r}
                    color={colorFor(i)}
                    thumbnail={thumbnail}
                    selected={selectedId === r.id}
                    onSelect={() => setSelectedId(r.id)}
                    onRename={() => {
                      setSelectedId(r.id);
                      setLabelEditingId(r.id);
                    }}
                    onHover={(hover) => {
                      if (hover) setHoveredId(r.id);
                      // Only clear if we still own the hover — protects against a
                      // mouseleave on row N firing after a mouseenter on row N+1.
                      else setHoveredId((prev) => (prev === r.id ? null : prev));
                    }}
                    onDelete={() => deleteRegion(r.id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {thumbnail.width} × {thumbnail.height} px · changes auto-saved locally
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleCancel}
              style={{
                fontSize: 13, padding: '8px 16px', borderRadius: 6,
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid rgba(255,255,255,0.10)', cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              style={{
                fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 6,
                background: '#8b5cf6', color: '#fff', border: 'none', cursor: 'pointer',
              }}
            >
              Save regions
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Portal so the modal escapes any containing overflow / transform.
  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface RegionRectProps {
  region: ThumbnailRegion;
  color: string;
  selected: boolean;
  hovered: boolean;
  editingLabel: boolean;
  canvasWidth: number;
  canvasHeight: number;
  skipEnterAnimation: boolean;
  deleting: boolean;
  onEditLabel: () => void;
  onCommitLabel: (label: string) => void;
}

function RegionRect({
  region, color, selected, hovered, editingLabel, canvasWidth, canvasHeight,
  skipEnterAnimation, deleting,
  onEditLabel, onCommitLabel,
}: RegionRectProps) {
  const [draftLabel, setDraftLabel] = useState(region.label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Mount transform: starts at 0.96/opacity 0 unless we were here at modal
  // open (skipEnterAnimation), then a rAF flips us to 1/1. CSS transition
  // handles the rest. Initialized true when skipping so the rect is fully
  // visible on first paint.
  const [entered, setEntered] = useState(skipEnterAnimation);
  useEffect(() => {
    if (skipEnterAnimation) return;
    const id = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(id);
  }, [skipEnterAnimation]);

  // Sync local draft when external label changes (e.g. via undo).
  // Detect prop drift inline — avoids the setState-in-effect anti-pattern.
  const [lastSyncedLabel, setLastSyncedLabel] = useState(region.label);
  if (region.label !== lastSyncedLabel) {
    setLastSyncedLabel(region.label);
    setDraftLabel(region.label);
  }

  // Auto-focus on entry to label edit.
  useLayoutEffect(() => {
    if (editingLabel) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingLabel]);

  const left = `${(region.x / canvasWidth) * 100}%`;
  const top = `${(region.y / canvasHeight) * 100}%`;
  const width = `${(region.w / canvasWidth) * 100}%`;
  const height = `${(region.h / canvasHeight) * 100}%`;

  const visualScale = deleting ? 0.92 : (entered ? 1 : 0.96);
  const visualOpacity = deleting ? 0 : (entered ? 1 : 0);

  const handles: { key: string; cursor: string; style: React.CSSProperties }[] = [
    { key: 'tl', cursor: 'nwse-resize', style: { left: 0, top: 0, transform: 'translate(-50%, -50%)' } },
    { key: 'tr', cursor: 'nesw-resize', style: { right: 0, top: 0, transform: 'translate(50%, -50%)' } },
    { key: 'bl', cursor: 'nesw-resize', style: { left: 0, bottom: 0, transform: 'translate(-50%, 50%)' } },
    { key: 'br', cursor: 'nwse-resize', style: { right: 0, bottom: 0, transform: 'translate(50%, 50%)' } },
    { key: 't',  cursor: 'ns-resize',   style: { left: '50%', top: 0, transform: 'translate(-50%, -50%)' } },
    { key: 'r',  cursor: 'ew-resize',   style: { right: 0, top: '50%', transform: 'translate(50%, -50%)' } },
    { key: 'b',  cursor: 'ns-resize',   style: { left: '50%', bottom: 0, transform: 'translate(-50%, 50%)' } },
    { key: 'l',  cursor: 'ew-resize',   style: { left: 0, top: '50%', transform: 'translate(-50%, -50%)' } },
  ];

  return (
    <div
      data-region-id={region.id}
      style={{
        position: 'absolute', left, top, width, height,
        border: `2px solid ${selected ? '#fff' : (hovered ? '#fff' : color)}`,
        background: `${color}${hovered && !selected ? '40' : '26'}`, // ~25% on hover, ~15% otherwise
        boxSizing: 'border-box',
        cursor: deleting ? 'default' : (selected ? 'move' : 'pointer'),
        pointerEvents: deleting ? 'none' : 'auto',
        transform: `scale(${visualScale})`,
        opacity: visualOpacity,
        transformOrigin: 'center',
        transition: `transform ${ANIM_MS}ms cubic-bezier(0.34, 1.3, 0.64, 1), opacity ${ANIM_MS}ms ease, box-shadow 80ms ease, background 80ms ease, border-color 80ms ease`,
        boxShadow: selected
          ? `0 0 0 1px ${color}, 0 8px 24px rgba(0,0,0,0.35)`
          : (hovered ? `0 0 0 1px ${color}, 0 4px 12px rgba(0,0,0,0.25)` : 'none'),
      }}
    >
      {/* Label or input */}
      {editingLabel ? (
        <input
          ref={inputRef}
          data-region-stop
          value={draftLabel}
          onChange={(e) => setDraftLabel(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') onCommitLabel(draftLabel);
            if (e.key === 'Escape') onCommitLabel('');
          }}
          onBlur={() => onCommitLabel(draftLabel)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Label…"
          style={{
            position: 'absolute', left: 4, top: 4,
            padding: '4px 8px', fontSize: 12,
            background: 'rgba(0,0,0,0.85)', color: '#fff',
            border: `1px solid ${color}`, borderRadius: 4, outline: 'none',
            minWidth: 80, maxWidth: 200,
          }}
        />
      ) : region.label ? (
        <button
          data-region-stop
          onClick={(e) => { e.stopPropagation(); onEditLabel(); }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', left: 4, top: 4,
            padding: '2px 8px', fontSize: 11, fontWeight: 600,
            background: 'rgba(0,0,0,0.78)', color: '#fff',
            border: `1px solid ${color}`, borderRadius: 4,
            maxWidth: 'calc(100% - 8px)', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', cursor: 'text',
          }}
        >
          {region.label}
        </button>
      ) : null}

      {/* Resize handles — only when selected. Each handle is a large
       *  invisible hit box wrapping a small visible chip so touch users
       *  can grab them without zooming. */}
      {selected && handles.map(({ key, cursor, style }) => (
        <div
          key={key}
          data-handle={key}
          data-region-id={region.id}
          style={{
            position: 'absolute',
            width: HANDLE_HIT_PX, height: HANDLE_HIT_PX,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor, ...style,
          }}
        >
          <div
            style={{
              width: HANDLE_DISPLAY_PX, height: HANDLE_DISPLAY_PX,
              background: '#fff', border: `1px solid ${color}`,
              borderRadius: 2, pointerEvents: 'none',
            }}
          />
        </div>
      ))}
    </div>
  );
}

interface RegionListItemProps {
  region: ThumbnailRegion;
  color: string;
  thumbnail: VideoThumbnail;
  selected: boolean;
  onSelect: () => void;
  onRename: () => void;
  onHover: (hovering: boolean) => void;
  onDelete: () => void;
}

function RegionListItem({
  region, color, thumbnail, selected, onSelect, onRename, onHover, onDelete,
}: RegionListItemProps) {
  // Mini-preview: crop the region from the thumbnail using CSS object-fit
  // + background-image. The region's image-pixel coords become the
  // background size + position math.
  const previewWidth = 64;
  const previewHeight = Math.round(previewWidth * (region.h / region.w || 1));
  const bgScale = previewWidth / region.w;
  const bgSize = `${thumbnail.width * bgScale}px ${thumbnail.height * bgScale}px`;
  const bgPos = `-${region.x * bgScale}px -${region.y * bgScale}px`;

  const [hover, setHover] = useState(false);

  return (
    <div
      data-region-stop
      onClick={onSelect}
      onMouseEnter={() => { setHover(true); onHover(true); }}
      onMouseLeave={() => { setHover(false); onHover(false); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: 8, borderRadius: 6, cursor: 'pointer',
        background: selected ? 'rgba(139,92,246,0.15)' : (hover ? 'rgba(255,255,255,0.04)' : 'transparent'),
        border: `1px solid ${selected ? 'rgba(139,92,246,0.40)' : 'transparent'}`,
        marginBottom: 4,
      }}
    >
      <div
        style={{
          width: previewWidth, height: previewHeight,
          minHeight: 28, maxHeight: 80,
          backgroundImage: `url(${thumbnail.imageUrl})`,
          backgroundSize: bgSize, backgroundPosition: bgPos, backgroundRepeat: 'no-repeat',
          border: `2px solid ${color}`, borderRadius: 3, flexShrink: 0,
        }}
        title={`${region.w}×${region.h}px`}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          onClick={(e) => { e.stopPropagation(); onRename(); }}
          style={{
            fontSize: 13, color: region.label ? 'var(--text)' : 'var(--text-muted)',
            fontStyle: region.label ? 'normal' : 'italic',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {region.label || 'Untitled'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {region.w}×{region.h}px
        </div>
      </div>
      {hover && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          aria-label={`Delete region ${region.label || 'Untitled'}`}
          style={{
            fontSize: 14, lineHeight: 1, padding: '4px 8px', borderRadius: 4,
            background: 'transparent', color: 'rgba(239,68,68,0.85)',
            border: '1px solid transparent', cursor: 'pointer',
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
