"use client";

/**
 * Drag-and-drop editor for the position + size of an auto-fetched overlay
 * image (logo, screenshot, brand mark) on a production-doc row.
 *
 * Why this exists: the row's `overlay_zone` (one of 9 zones) and
 * `overlay_size` (small/medium/large) are planned by the LLM at doc-gen
 * time. They land in a sensible default spot, but the user sometimes
 * needs to move the overlay onto a specific feature in the still — a
 * face, a screen, a clean negative-space pocket — that the LLM didn't
 * pick. This editor sets `overlay_position` + `overlay_size_pct` on the
 * row, which override the zone/size at render time.
 *
 * UX:
 *   - 16:9 preview, scaled to fit the modal.
 *   - The row's still renders as the background (`object-fit: cover`),
 *     so what the user sees here matches what plays in the renderer's
 *     non-letterbox path. Letterbox mode is rare for rows that also
 *     have an overlay (overlays are typically used on full-frame
 *     b-roll), so we don't switch modes here — the position itself is
 *     in frame % so the renderer applies it correctly either way.
 *   - The overlay PNG is positioned absolutely inside the preview and
 *     is pointer-draggable. On pointerdown we capture the pointer so
 *     the drag doesn't get lost when the cursor leaves the overlay box.
 *   - A slider sets the overlay width (5-40% of frame width).
 *
 * Save converts pixel positions back into % of the FRAME (the preview's
 * own dimensions cancel out), which is what the renderer expects.
 *
 * Reset clears both `overlay_position` and `overlay_size_pct` so the
 * AI-planned zone/size kicks back in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface OverlayPositionEditorProps {
  /** The row's still image URL, shown as the preview background.
   *  Undefined when the row's image hasn't been generated yet — the
   *  editor still works, the preview just shows a checker pattern. */
  stillImageUrl: string | undefined;
  /** The fetched overlay PNG (transparent). Required — there's no point
   *  positioning an overlay that doesn't exist yet. */
  overlayUrl: string;
  /** Current manual position (% of frame). Undefined ⇒ start from the
   *  centre of the preview so the user sees the overlay even before
   *  they drag. */
  position: { x_pct: number; y_pct: number } | undefined;
  /** Current manual size (% of frame width). Undefined ⇒ default to the
   *  middle of the slider (15% — between the LLM's `medium` and
   *  `large` tiers). */
  sizePct: number | undefined;
  /** Current manual height (% of frame height) — only set when the user
   *  previously free-stretched the overlay to a non-natural aspect via
   *  Shift+drag on a resize handle. Undefined means height follows the
   *  image's natural aspect ratio. See Phase 1 of
   *  `_plans/2026-05-18-overlay-system-overhaul.md`. */
  stretchedHeightPct: number | undefined;
  /** Stock terms label — surfaced in the header so the user can tell
   *  which overlay they're positioning when several rows are open. */
  termsLabel: string;
  /** Called when the user clicks Save. `stretchedHeightPct` is non-null
   *  only when free-aspect drag produced a manual height; pass it through
   *  to the row so the renderer honours the squish. Null clears any
   *  prior stretch (an aspect-locked drag implicitly reverts to natural). */
  onSave: (
    position: { x_pct: number; y_pct: number },
    sizePct: number,
    stretchedHeightPct: number | null,
  ) => void;
  onReset: () => void;
  onClose: () => void;
}

// ─── Preview geometry ─────────────────────────────────────────────────────────

/** Preview box width in CSS pixels. 560 is wide enough to position
 *  precisely but still leaves room for the controls below at typical
 *  viewport sizes. The height is derived from 16:9 so the aspect
 *  matches the renderer. */
const PREVIEW_W = 560;
const PREVIEW_H = Math.round(PREVIEW_W * (9 / 16));

/** Size slider bounds (% of frame width). 5 keeps tiny overlays
 *  legible; 40 prevents the overlay from covering the entire scene.
 *  Resize handles have wider min/max (3-60) so the handles aren't
 *  artificially clamped to the slider's narrower range. */
const SIZE_MIN_PCT = 5;
const SIZE_MAX_PCT = 40;
const SIZE_DEFAULT_PCT = 15;
const HANDLE_MIN_WIDTH_PCT = 3;
const HANDLE_MAX_WIDTH_PCT = 60;
const HANDLE_MIN_HEIGHT_PCT = 2;
const HANDLE_MAX_HEIGHT_PCT = 70;

/** Hit-box size in CSS pixels for each resize handle. Generous so the
 *  user doesn't fight the pixel — same Canva/Photoshop convention. */
const HANDLE_PX = 12;

type ResizeHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';

const HANDLE_LIST: ResizeHandle[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];

const HANDLE_CURSORS: Record<ResizeHandle, string> = {
  tl: 'nwse-resize',
  t: 'ns-resize',
  tr: 'nesw-resize',
  r: 'ew-resize',
  br: 'nwse-resize',
  b: 'ns-resize',
  bl: 'nesw-resize',
  l: 'ew-resize',
};

/** localStorage key for the one-time free-stretch warning. Persists per
 *  device, not per workspace — good enough for v1; cross-device dismissal
 *  can be a Settings entry later. */
const STRETCH_WARNING_LS_KEY = 'overlay_free_stretch_warning_dismissed';

export function OverlayPositionEditor({
  stillImageUrl,
  overlayUrl,
  position,
  sizePct,
  stretchedHeightPct,
  termsLabel,
  onSave,
  onReset,
  onClose,
}: OverlayPositionEditorProps) {
  // Working copy of position + size. Initialised from the persisted
  // values or sensible defaults so the user sees a coherent starting
  // state without a flash of an unpositioned overlay.
  const initialX = typeof position?.x_pct === 'number' ? position.x_pct : 50 - SIZE_DEFAULT_PCT / 2;
  const initialY = typeof position?.y_pct === 'number'
    ? position.y_pct
    : 50 - (SIZE_DEFAULT_PCT * (PREVIEW_W / PREVIEW_H)) / 2;
  const initialSize = typeof sizePct === 'number' ? sizePct : SIZE_DEFAULT_PCT;
  const [xPct, setXPct] = useState(initialX);
  const [yPct, setYPct] = useState(initialY);
  const [size, setSize] = useState(initialSize);

  // Natural aspect ratio of the overlay PNG, captured from the <img> onLoad
  // handler. Null until the image has loaded — we render with a square
  // fallback until then so the user never sees a zero-height box. Mirrors
  // the renderer's logic in `src/remotion/components/RealImageOverlay.tsx`
  // so what the user positions here matches what plays back in the final
  // render.
  const [aspect, setAspect] = useState<number | null>(null);

  // Free-aspect override: when set, the overlay's height (% of frame
  // height) is locked to this value instead of being derived from the
  // image's natural aspect. Set only by Shift+drag on a resize handle;
  // an aspect-locked corner/edge drag clears it. Mirrored by the
  // renderer via `overlay.stretchedHeightPct`. Phase 1 plan.
  const [stretchedHeightPctState, setStretchedHeightPctState] = useState<number | null>(
    typeof stretchedHeightPct === 'number' && Number.isFinite(stretchedHeightPct)
      ? stretchedHeightPct
      : null,
  );

  // One-time warning when the user first holds Shift to free-stretch.
  // localStorage flag persists the dismissal across sessions on this
  // device. Read once on mount so the banner doesn't flash for users
  // who've already dismissed it.
  const [stretchWarningDismissed, setStretchWarningDismissed] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(STRETCH_WARNING_LS_KEY) === '1';
  });
  const [showStretchWarning, setShowStretchWarning] = useState(false);
  const dismissStretchWarning = useCallback(() => {
    setShowStretchWarning(false);
    setStretchWarningDismissed(true);
    try {
      window.localStorage.setItem(STRETCH_WARNING_LS_KEY, '1');
    } catch {
      /* localStorage can throw in private-browsing — fall back to in-memory */
    }
  }, []);

  // Lock scroll + Esc-to-close, mirroring the TransitionDialog pattern
  // so the editor feels like part of the same family of dialogs.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ─── Drag state ──────────────────────────────────────────────────────────
  //
  // We track the pointer offset between the cursor and the overlay's
  // top-left corner at drag start. Then every pointermove sets the
  // overlay's top-left to (cursor − offset), translated from preview
  // pixels back into frame %. setPointerCapture keeps the drag alive
  // when the cursor leaves the overlay's bounding box (otherwise
  // hovering the cursor over the still image would steal the move
  // events and the overlay would freeze).
  const previewRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null);

  // Convert frame-% coordinates → preview-pixel coordinates and back.
  // The width depends on `size` because the overlay is sized as a %
  // of frame width but rendered in preview pixels.
  //
  // Height resolution order, matching the renderer:
  //   1. `stretchedHeightPctState` — set by Shift+resize, % of frame height.
  //   2. Image's natural aspect ratio (read at load time).
  //   3. 1:1 fallback before onLoad fires.
  //
  // Height cap: 70% of the preview matches the renderer's `frameHeight
  // * 0.7` guard. The cap only auto-shrinks width on the natural-aspect
  // path; if the user explicitly stretched, their chosen width stays.
  const effectiveAspect = aspect ?? 1;
  let overlayWidthPx = (size / 100) * PREVIEW_W;
  let overlayHeightPx =
    stretchedHeightPctState !== null
      ? (stretchedHeightPctState / 100) * PREVIEW_H
      : overlayWidthPx / effectiveAspect;
  const maxOverlayHeightPx = PREVIEW_H * 0.7;
  if (overlayHeightPx > maxOverlayHeightPx) {
    overlayHeightPx = maxOverlayHeightPx;
    if (stretchedHeightPctState === null) {
      overlayWidthPx = maxOverlayHeightPx * effectiveAspect;
    }
  }
  const xPx = (xPct / 100) * PREVIEW_W;
  const yPx = (yPct / 100) * PREVIEW_H;

  // Live height as % of frame height — derived from the box that's
  // actually displayed, for the readout strip and the on-save payload.
  const liveHeightPct = (overlayHeightPx / PREVIEW_H) * 100;

  const onOverlayImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const ratio = img.naturalWidth / img.naturalHeight;
        setAspect(ratio);
        console.info('[overlay editor] aspect resolved', {
          overlayUrl,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          aspect: Number(ratio.toFixed(3)),
        });
      }
    },
    [overlayUrl],
  );

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffsetRef.current = {
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragOffsetRef.current || !previewRef.current) return;
      const previewRect = previewRef.current.getBoundingClientRect();
      const rawX = e.clientX - previewRect.left - dragOffsetRef.current.dx;
      const rawY = e.clientY - previewRect.top - dragOffsetRef.current.dy;
      // Clamp so the overlay's bounding box stays inside the preview.
      // We keep at least a sliver visible at the far edge so a runaway
      // drag never makes the overlay disappear entirely.
      const minX = -overlayWidthPx * 0.1;
      const minY = -overlayHeightPx * 0.1;
      const maxX = PREVIEW_W - overlayWidthPx * 0.9;
      const maxY = PREVIEW_H - overlayHeightPx * 0.9;
      const clampedX = Math.max(minX, Math.min(maxX, rawX));
      const clampedY = Math.max(minY, Math.min(maxY, rawY));
      setXPct((clampedX / PREVIEW_W) * 100);
      setYPct((clampedY / PREVIEW_H) * 100);
    },
    [overlayWidthPx, overlayHeightPx],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragOffsetRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* releasePointerCapture throws if no capture is active; ignore */
    }
  }, []);

  // ─── Resize state ────────────────────────────────────────────────────────
  //
  // Eight handles around the overlay box, Canva-style. Aspect-locked by
  // default (any handle scales uniformly, anchored at the opposite
  // handle); holding Shift unlocks free-aspect (corners scale both axes
  // independently, edges scale single-axis). Shift is read LIVE from the
  // pointermove event so toggling Shift mid-drag updates the mode.
  //
  // The starting state of the box (size, stretched height, position) is
  // captured at pointerdown; every move recomputes the new box from the
  // pointer delta + starting state, never from the previous frame. This
  // keeps the math idempotent and the gesture predictable.
  //
  // 16:9 ratio constant lets us convert between frame-width % and frame-
  // height % consistently with the preview. Both the preview and the
  // composition target are 16:9 so the math is portable.
  const FRAME_RATIO_W_OVER_H = PREVIEW_W / PREVIEW_H;
  const widthPctToHeightPct = useCallback(
    (widthPct: number, asp: number) => (widthPct / asp) * FRAME_RATIO_W_OVER_H,
    [FRAME_RATIO_W_OVER_H],
  );

  const resizeStateRef = useRef<{
    handle: ResizeHandle;
    startSizePct: number;
    startStretchedHPct: number | null;
    startAspect: number;
    startXPct: number;
    startYPct: number;
    startPointerX: number;
    startPointerY: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (handle: ResizeHandle) =>
      (e: React.PointerEvent<HTMLDivElement>) => {
        // Don't let the click bubble up to the overlay container's
        // reposition gesture — that would start a drag-to-move at the
        // same time as the resize.
        e.stopPropagation();
        e.preventDefault();
        resizeStateRef.current = {
          handle,
          startSizePct: size,
          startStretchedHPct: stretchedHeightPctState,
          startAspect: aspect ?? 1,
          startXPct: xPct,
          startYPct: yPct,
          startPointerX: e.clientX,
          startPointerY: e.clientY,
        };
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      },
    [size, stretchedHeightPctState, aspect, xPct, yPct],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const rs = resizeStateRef.current;
      if (!rs || !previewRef.current) return;
      const rect = previewRef.current.getBoundingClientRect();
      // Convert pointer delta from CSS pixels → frame % via the preview
      // (preview is 16:9 just like the frame, so % maps 1:1).
      const dxPctW = ((e.clientX - rs.startPointerX) / rect.width) * 100;
      const dyPctH = ((e.clientY - rs.startPointerY) / rect.height) * 100;
      const movesL = rs.handle.includes('l');
      const movesR = rs.handle.includes('r');
      const movesT = rs.handle.startsWith('t');
      const movesB = rs.handle.startsWith('b');
      const isCorner = (movesL || movesR) && (movesT || movesB);

      // Positive widthDelta = grow; positive heightDelta = grow.
      const widthDeltaPct = movesR ? dxPctW : movesL ? -dxPctW : 0;
      const heightDeltaPct = movesB ? dyPctH : movesT ? -dyPctH : 0;

      const startHPctNatural = widthPctToHeightPct(rs.startSizePct, rs.startAspect);
      const startHPct = rs.startStretchedHPct ?? startHPctNatural;

      const aspectLocked = !e.shiftKey;
      let newSize = rs.startSizePct;
      let newStretchedH: number | null = aspectLocked ? null : startHPct;

      if (aspectLocked) {
        if (isCorner) {
          // Pick the dominant axis to drive the uniform scale.
          const widthScale = Math.abs(widthDeltaPct) / Math.max(1e-6, rs.startSizePct);
          const heightScale = Math.abs(heightDeltaPct) / Math.max(1e-6, startHPctNatural);
          newSize =
            widthScale >= heightScale
              ? rs.startSizePct + widthDeltaPct
              : ((startHPctNatural + heightDeltaPct) * rs.startSizePct) /
                Math.max(1e-6, startHPctNatural);
        } else if (movesL || movesR) {
          newSize = rs.startSizePct + widthDeltaPct;
        } else {
          // Top/bottom edge — height delta converts back to width via aspect.
          newSize =
            ((startHPctNatural + heightDeltaPct) * rs.startSizePct) /
            Math.max(1e-6, startHPctNatural);
        }
      } else {
        // Free: persist stretched height. Show the one-time warning the
        // first time this branch fires for an undismissed user.
        if (!stretchWarningDismissed && !showStretchWarning) {
          setShowStretchWarning(true);
        }
        if (isCorner) {
          newSize = rs.startSizePct + widthDeltaPct;
          newStretchedH = startHPct + heightDeltaPct;
        } else if (movesL || movesR) {
          newSize = rs.startSizePct + widthDeltaPct;
          newStretchedH = startHPct;
        } else {
          newSize = rs.startSizePct;
          newStretchedH = startHPct + heightDeltaPct;
        }
      }

      // Clamp to handle min/max, then derive the anchor-preserving xPct/yPct.
      newSize = Math.max(HANDLE_MIN_WIDTH_PCT, Math.min(HANDLE_MAX_WIDTH_PCT, newSize));
      if (newStretchedH !== null) {
        newStretchedH = Math.max(
          HANDLE_MIN_HEIGHT_PCT,
          Math.min(HANDLE_MAX_HEIGHT_PCT, newStretchedH),
        );
      }

      // Anchor at the opposite side: when the left edge moves, x compensates
      // so the right edge stays put. Same for top.
      const finalHPct =
        newStretchedH !== null ? newStretchedH : widthPctToHeightPct(newSize, rs.startAspect);
      const newXPct = movesL ? rs.startXPct + (rs.startSizePct - newSize) : rs.startXPct;
      const newYPct = movesT ? rs.startYPct + (startHPct - finalHPct) : rs.startYPct;

      setSize(newSize);
      setStretchedHeightPctState(newStretchedH);
      setXPct(newXPct);
      setYPct(newYPct);
    },
    [widthPctToHeightPct, stretchWarningDismissed, showStretchWarning],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (rs) {
      console.info('[overlay editor] resize committed', {
        handle: rs.handle,
        fromSize: rs.startSizePct,
        toSize: size,
        fromStretchedH: rs.startStretchedHPct,
        toStretchedH: stretchedHeightPctState,
      });
    }
    resizeStateRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, [size, stretchedHeightPctState]);

  // ─── Render ──────────────────────────────────────────────────────────────

  // Checker pattern for the missing-still fallback. Kept inline so the
  // editor doesn't depend on any project-wide CSS being loaded.
  const checkerBg = useMemo(
    () =>
      'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 32px 32px',
    [],
  );

  const dialog = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(0,0,0,0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0f1115',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.10)',
          width: 'min(640px, 95vw)',
          boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            Position overlay
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Drag the overlay onto the spot you want. Saving overrides the AI's planned zone for this row.
            <span style={{ color: '#fbbf24', marginLeft: 6 }}>✦ {termsLabel}</span>
          </div>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* First-stretch warning. Mounted only when (a) the user just
              held Shift to free-stretch and (b) they haven't dismissed
              the warning before on this device. localStorage persists
              the "got it" dismissal so a returning user never sees it
              twice. Phase 1 plan. */}
          {showStretchWarning && !stretchWarningDismissed && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 6,
                background: 'rgba(251,191,36,0.10)',
                border: '1px solid rgba(251,191,36,0.40)',
                fontSize: 11,
                color: 'var(--text)',
                lineHeight: 1.45,
              }}
            >
              <span style={{ color: '#fbbf24', fontWeight: 600 }}>⚠</span>
              <span style={{ flex: 1 }}>
                Logos look better at their natural aspect. Hold Shift to
                stretch anyway, or release to snap back to the image's
                real shape.
              </span>
              <button
                type="button"
                onClick={dismissStretchWarning}
                style={{
                  fontSize: 10,
                  padding: '4px 8px',
                  borderRadius: 4,
                  background: 'rgba(251,191,36,0.20)',
                  color: '#fbbf24',
                  border: '1px solid rgba(251,191,36,0.40)',
                  cursor: 'pointer',
                }}
              >
                Got it
              </button>
            </div>
          )}

          {/* Preview box. Square-bracketed border + the row's still
              rendered cover-style so the user sees the live scene
              they're positioning against. */}
          <div
            ref={previewRef}
            style={{
              position: 'relative',
              width: PREVIEW_W,
              height: PREVIEW_H,
              maxWidth: '100%',
              borderRadius: 6,
              overflow: 'hidden',
              background: stillImageUrl ? '#000' : checkerBg,
              border: '1px solid rgba(255,255,255,0.15)',
              userSelect: 'none',
              touchAction: 'none',
            }}
          >
            {stillImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={stillImageUrl}
                alt="row still"
                draggable={false}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* The overlay itself — draggable. The cursor switches to
                'grab' / 'grabbing' so the affordance is unmistakable. */}
            <div
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{
                position: 'absolute',
                left: xPx,
                top: yPx,
                width: overlayWidthPx,
                height: overlayHeightPx,
                cursor: dragOffsetRef.current ? 'grabbing' : 'grab',
                touchAction: 'none',
                // Outline + soft drop shadow so the overlay's bounds
                // are visible against a wide range of stills.
                outline: '1.5px dashed rgba(255,255,255,0.65)',
                outlineOffset: 0,
                boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
                borderRadius: 4,
              }}
              role="application"
              aria-label="Overlay (drag to position)"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={overlayUrl}
                alt="overlay"
                draggable={false}
                onLoad={onOverlayImgLoad}
                style={{
                  width: '100%',
                  height: '100%',
                  // The bounding box matches the image's natural aspect after
                  // onLoad, so `cover` produces identical output to `contain`
                  // and avoids sub-pixel letterboxing — same call the renderer
                  // makes for the same reason.
                  objectFit: 'cover',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {/* Resize handles — rendered as siblings of the overlay box
                (not children) so their pointerdown doesn't bubble into
                the reposition gesture. Each handle owns its own pointer
                capture for the duration of the resize. */}
            {HANDLE_LIST.map((handle) => {
              const isLeft = handle.includes('l');
              const isRight = handle.includes('r');
              const isTop = handle.startsWith('t');
              const isBottom = handle.startsWith('b');
              const cx = isLeft ? xPx : isRight ? xPx + overlayWidthPx : xPx + overlayWidthPx / 2;
              const cy = isTop ? yPx : isBottom ? yPx + overlayHeightPx : yPx + overlayHeightPx / 2;
              return (
                <div
                  key={handle}
                  onPointerDown={onResizePointerDown(handle)}
                  onPointerMove={onResizePointerMove}
                  onPointerUp={onResizePointerUp}
                  onPointerCancel={onResizePointerUp}
                  style={{
                    position: 'absolute',
                    left: cx - HANDLE_PX / 2,
                    top: cy - HANDLE_PX / 2,
                    width: HANDLE_PX,
                    height: HANDLE_PX,
                    background: '#fff',
                    border: '1.5px solid rgba(0,0,0,0.7)',
                    borderRadius: 2,
                    cursor: HANDLE_CURSORS[handle],
                    touchAction: 'none',
                    // Sit above the dashed outline of the overlay box
                    // so the handles are clickable at the very corner.
                    zIndex: 2,
                  }}
                  aria-label={`Resize ${handle.toUpperCase()} (Shift for free aspect)`}
                />
              );
            })}
          </div>

          {/* Live coordinates so the user can copy exact positions if
              they need to nudge with the keyboard. Height is live too —
              follows natural aspect by default and the free-stretch
              value when set. The aspect-lock indicator surfaces the
              renderer's current behaviour at a glance. */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            <span>x: {xPct.toFixed(1)}%</span>
            <span>y: {yPct.toFixed(1)}%</span>
            <span>w: {size.toFixed(1)}%</span>
            <span>h: {liveHeightPct.toFixed(1)}%</span>
            <span style={{ color: stretchedHeightPctState !== null ? '#fbbf24' : 'var(--text-muted)' }}>
              {stretchedHeightPctState !== null ? '⚠ stretched' : 'natural aspect'}
            </span>
          </div>

          {/* Size slider. Secondary control — the resize handles on the
              preview are the primary way to size. Slider is kept for
              keyboard accessibility and quick coarse adjustments.
              Nudging the slider always snaps back to natural aspect
              (clears any prior free-stretch). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor="overlay-size" style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Size (width — drag handles for free aspect)
            </label>
            <input
              id="overlay-size"
              type="range"
              min={SIZE_MIN_PCT}
              max={SIZE_MAX_PCT}
              step={1}
              value={Math.min(SIZE_MAX_PCT, Math.max(SIZE_MIN_PCT, size))}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isFinite(parsed)) {
                  setSize(Math.max(SIZE_MIN_PCT, Math.min(SIZE_MAX_PCT, parsed)));
                  setStretchedHeightPctState(null);
                }
              }}
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            gap: 8,
            justifyContent: 'space-between',
          }}
        >
          <button
            type="button"
            onClick={() => {
              onReset();
              onClose();
            }}
            title="Clear the manual position and fall back to the AI-planned zone"
            style={{
              fontSize: 12,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
          >
            Reset to AI placement
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontSize: 12,
                padding: '8px 14px',
                borderRadius: 6,
                background: 'transparent',
                color: 'var(--text)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onSave({ x_pct: xPct, y_pct: yPct }, size, stretchedHeightPctState);
                onClose();
              }}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '8px 14px',
                borderRadius: 6,
                background: 'rgba(168,85,247,0.22)',
                color: '#c084fc',
                border: '1px solid rgba(168,85,247,0.45)',
                cursor: 'pointer',
              }}
            >
              Save position
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(dialog, document.body);
}
