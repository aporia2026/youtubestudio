"use client";

/**
 * Region JSON import dialog.
 *
 * Phase D of `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`.
 *
 * The Thumbnails page (Topic Card Grid / N Levels panels) exports
 * `result.regions` as JSON via "Copy regions JSON" — but until now
 * there was no inbound path to bring those regions back into a
 * production-doc or the editor's section-thumbnail UI. Users could
 * generate regions deterministically and then had to either hand-
 * redraw them or run the vision-model auto-detect, which defeats the
 * point of the deterministic format generators.
 *
 * This component is a single-screen modal with a pre-focused textarea.
 * Validation runs on every keystroke (inline error messaging); the
 * Import button stays disabled until the JSON parses, validates as an
 * array of `ThumbnailRegion`, and every region fits inside the target
 * image bounds.
 *
 * Behaviour:
 *   - On submit: confirms when the target already has regions, then
 *     fires `onImport(regions)` with stable IDs (regenerated if the
 *     pasted JSON has duplicates or unsafe characters).
 *   - On cancel: closes without touching parent state.
 *
 * Reusable across three surfaces: production-doc section-thumbnail
 * card, the region editor modal itself, and the editor's section-
 * thumbnail control.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import type { ThumbnailRegion } from '@/remotion/types';

interface Props {
  /** Intrinsic pixel dimensions of the target thumbnail. Used to
   *  validate that pasted regions fit inside the image. */
  imageWidth: number;
  imageHeight: number;
  /** Current region count on the target — drives the overwrite confirm. */
  existingRegionCount: number;
  /** Called with validated regions when the user clicks Import.
   *  Component leaves persistence + undo-stack handling to the caller
   *  so it can stay stateless across the three entry points. */
  onImport: (regions: ThumbnailRegion[]) => void;
  onClose: () => void;
}

// ─── Parse + validate ────────────────────────────────────────────────────────

interface ParseResult {
  ok: boolean;
  regions: ThumbnailRegion[];
  /** Inline error to render under the textarea. Empty when ok. */
  error: string;
}

const MAX_REGIONS = 50;
const MAX_LABEL = 200;

/** Match the format used by ThumbnailRegionEditor.makeId — random,
 *  16-char base36 with a `reg_` prefix. Pasted IDs that don't match
 *  this shape get regenerated so a malformed payload can't sneak in
 *  XSS-shaped strings as ids. */
function makeSafeId(): string {
  return `reg_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

function looksLikeSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function parseRegionsJson(raw: string, imgW: number, imgH: number): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, regions: [], error: '' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      regions: [],
      error: `Not valid JSON: ${err instanceof Error ? err.message : 'parse failed'}.`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, regions: [], error: 'Expected an array of regions.' };
  }
  if (parsed.length === 0) {
    return { ok: false, regions: [], error: 'Empty region list.' };
  }
  if (parsed.length > MAX_REGIONS) {
    return {
      ok: false,
      regions: [],
      error: `Too many regions (${parsed.length}); max ${MAX_REGIONS}.`,
    };
  }
  const seenIds = new Set<string>();
  const out: ThumbnailRegion[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i];
    if (!r || typeof r !== 'object') {
      return { ok: false, regions: [], error: `Region ${i + 1}: not an object.` };
    }
    const obj = r as Record<string, unknown>;
    const label = typeof obj.label === 'string' ? obj.label.slice(0, MAX_LABEL) : '';
    const x = Number(obj.x);
    const y = Number(obj.y);
    const w = Number(obj.w);
    const h = Number(obj.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) {
      return { ok: false, regions: [], error: `Region ${i + 1}: non-numeric x/y/w/h.` };
    }
    if (w <= 0 || h <= 0) {
      return { ok: false, regions: [], error: `Region ${i + 1}: width and height must be positive.` };
    }
    if (x < 0 || y < 0 || x + w > imgW || y + h > imgH) {
      return {
        ok: false,
        regions: [],
        error:
          `Region ${i + 1} (${Math.round(x)},${Math.round(y)} ${Math.round(w)}×${Math.round(h)}) ` +
          `falls outside the thumbnail bounds (${imgW}×${imgH}).`,
      };
    }
    // Either accept the pasted id (when shaped safely + not a duplicate)
    // or regenerate. Duplicates would corrupt the renderer's region
    // lookup so we silently rename instead of failing the import — the
    // user just wants the regions on the doc.
    let id: string;
    if (looksLikeSafeId(obj.id) && !seenIds.has(obj.id)) {
      id = obj.id;
    } else {
      id = makeSafeId();
    }
    seenIds.add(id);
    out.push({
      id,
      label,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    });
  }
  return { ok: true, regions: out, error: '' };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RegionJsonImportDialog({
  imageWidth,
  imageHeight,
  existingRegionCount,
  onImport,
  onClose,
}: Props) {
  const [raw, setRaw] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Lock background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Auto-focus on mount so paste works without an extra click.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Keyboard: Esc closes, Ctrl/Cmd+Enter imports if valid.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = useMemo(
    () => parseRegionsJson(raw, imageWidth, imageHeight),
    [raw, imageWidth, imageHeight],
  );

  const handleImport = () => {
    if (!parsed.ok) return;
    console.info('[regions import]', {
      bytes: raw.length,
      parsedCount: parsed.regions.length,
      existing: existingRegionCount,
      imageW: imageWidth,
      imageH: imageHeight,
    });
    if (existingRegionCount > 0) {
      const confirmed = window.confirm(
        `Replace ${existingRegionCount} existing region${existingRegionCount === 1 ? '' : 's'} with ${parsed.regions.length} imported region${parsed.regions.length === 1 ? '' : 's'}? This can be undone with ⌘Z inside the region editor.`,
      );
      if (!confirmed) return;
    }
    onImport(parsed.regions);
    toast.success(`Imported ${parsed.regions.length} region${parsed.regions.length === 1 ? '' : 's'}.`);
    onClose();
  };

  const modal = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#0f1115', borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(620px, 95vw)', maxHeight: '92vh',
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
              Paste regions JSON
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              From the Thumbnails page → Topic Card Grid / N Levels → "Copy regions JSON".
              Pasting replaces the current regions on this thumbnail.
            </div>
          </div>
          <button
            onClick={onClose}
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

        {/* Body */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            ref={textareaRef}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder='[\n  { "id": "...", "label": "Reconnaissance", "x": 0, "y": 0, "w": 480, "h": 270 },\n  ...\n]'
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 240,
              maxHeight: '50vh',
              padding: 10,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text)',
              background: 'rgba(0,0,0,0.30)',
              border: `1px solid ${parsed.error ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.10)'}`,
              borderRadius: 6,
              outline: 'none',
              resize: 'vertical',
            }}
          />
          {parsed.error ? (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: '#fca5a5',
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.30)',
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              {parsed.error}
            </div>
          ) : raw.trim() && parsed.ok ? (
            <div
              style={{
                fontSize: 12,
                color: '#86efac',
                background: 'rgba(16,185,129,0.08)',
                border: '1px solid rgba(16,185,129,0.30)',
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              {parsed.regions.length} region{parsed.regions.length === 1 ? '' : 's'} ready to
              import. Target bounds: {imageWidth} × {imageHeight} px.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Target image: {imageWidth} × {imageHeight} px. Existing regions:{' '}
              {existingRegionCount}.
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          gap: 8, padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.08)',
        }}>
          <button
            onClick={onClose}
            style={{
              fontSize: 13, padding: '8px 16px', borderRadius: 6,
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!parsed.ok}
            style={{
              fontSize: 13, fontWeight: 600, padding: '8px 18px', borderRadius: 6,
              background: parsed.ok ? '#8b5cf6' : 'rgba(139,92,246,0.30)',
              color: '#fff',
              border: 'none',
              cursor: parsed.ok ? 'pointer' : 'not-allowed',
              opacity: parsed.ok ? 1 : 0.7,
            }}
          >
            Import{parsed.ok ? ` ${parsed.regions.length}` : ''}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}
