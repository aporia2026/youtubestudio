'use client';

/**
 * Editor-native lightbox for a motion-collage row.
 *
 * Production-doc has its own ImageLightbox with a panel scrubber, but it
 * shows ONE panel at a time and doesn't surface the full grid composition.
 * Per PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`
 * (resolved Q3, editor-native showing all images of the collage AND the
 * collage itself), the editor's lightbox shows:
 *
 *   - Default view: every panel at large size in a grid mirroring the
 *     row's `motion_collage_grid` layout. This IS the "composed collage"
 *     view — the pipeline no longer renders a composite image (panel
 *     generation went per-cell in §D), so we composite client-side.
 *   - Per-panel zoom: click a thumbnail → fills the modal with that
 *     single panel. Click the grid icon (or press G) → back to grid view.
 *
 * Keyboard:
 *   - Esc           close
 *   - ← / →         cycle panel in single-panel view (no-op in grid view)
 *   - G             toggle grid ↔ single-panel
 *
 * Layout-agnostic but expects the parent to mount it (and unmount on
 * `onClose`). No portal — relies on a stacking context above the editor.
 *
 * Pure presentation: no fetches, no mutations. The inspector owns the
 * "regenerate this panel" affordance separately.
 */

import { useEffect, useState } from 'react';

interface MotionCollageLightboxProps {
  /** Panel URLs, row-major. Length should match grid.cols × grid.rows;
   *  shorter / longer arrays render whatever the underlying grid can
   *  display. */
  panelUrls: readonly string[];
  /** Grid layout. When omitted, falls back to a square-ish layout
   *  derived from the panel count — same rule as `MotionCollageThumb`. */
  grid?: { cols: number; rows: number };
  /** Shot index — surfaced in the title bar and in console logs. */
  shotIndex: number;
  /** Close handler. The parent unmounts the lightbox in response. */
  onClose: () => void;
  /** Optional: initial panel to focus, in single-panel mode. Defaults
   *  to grid view. */
  initialPanelIndex?: number;
}

function deriveSquareGrid(panelCount: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(panelCount)));
  const rows = Math.max(1, Math.ceil(panelCount / cols));
  return { cols, rows };
}

export function MotionCollageLightbox({
  panelUrls,
  grid,
  shotIndex,
  onClose,
  initialPanelIndex,
}: MotionCollageLightboxProps): React.ReactElement {
  // `focusedIndex === null` means grid view; a number means single-panel
  // zoomed view. Click-a-thumb sets it; G or grid-icon clears it.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(
    typeof initialPanelIndex === 'number' ? initialPanelIndex : null,
  );
  const panelCount = panelUrls.length;
  const resolved = grid && grid.cols > 0 && grid.rows > 0
    ? grid
    : deriveSquareGrid(panelCount);

  useEffect(() => {
    console.info('[editor motion-collage lightbox] opened', {
      shotIndex,
      panelCount,
      initialView: focusedIndex === null ? 'grid' : `panel-${focusedIndex}`,
    });
    // Mount-time only — `focusedIndex` re-logs would flood on toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setFocusedIndex((curr) => (curr === null ? 0 : null));
        return;
      }
      if (focusedIndex === null) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setFocusedIndex((curr) => (curr === null ? 0 : (curr + 1) % panelCount));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setFocusedIndex((curr) =>
          curr === null ? 0 : (curr - 1 + panelCount) % panelCount,
        );
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedIndex, panelCount, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Motion collage shot ${shotIndex + 1} — ${panelCount} panels`}
      onClick={(e) => {
        // Click the backdrop to close. Clicks on inner content stop
        // propagating below.
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {/* Title bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 1400,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
          color: 'rgba(255,255,255,0.9)',
          fontSize: 13,
        }}
      >
        <div>
          Shot {shotIndex + 1} — motion collage ({resolved.cols}×{resolved.rows}, {panelCount} panels)
          {focusedIndex !== null && (
            <span style={{ marginLeft: 12, color: 'rgba(255,255,255,0.55)' }}>
              · viewing panel {focusedIndex + 1}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {focusedIndex !== null && (
            <button
              type="button"
              onClick={() => setFocusedIndex(null)}
              title="Back to grid view (G)"
              style={{
                padding: '4px 10px',
                background: 'rgba(255,255,255,0.10)',
                color: 'rgba(255,255,255,0.9)',
                border: '1px solid rgba(255,255,255,0.20)',
                borderRadius: 4,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              ▦ Grid
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close lightbox"
            style={{
              padding: '4px 10px',
              background: 'rgba(255,255,255,0.10)',
              color: 'rgba(255,255,255,0.9)',
              border: '1px solid rgba(255,255,255,0.20)',
              borderRadius: 4,
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            ✕ Close
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          width: '100%',
          maxWidth: 1400,
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {focusedIndex === null ? (
          // Grid view — every panel at large size in the row's layout.
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'grid',
              gridTemplateColumns: `repeat(${resolved.cols}, 1fr)`,
              gridTemplateRows: `repeat(${resolved.rows}, 1fr)`,
              gap: 4,
            }}
            aria-label={`Motion collage grid, ${panelCount} panels`}
          >
            {panelUrls.slice(0, resolved.cols * resolved.rows).map((url, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  console.info('[editor motion-collage lightbox] focus panel', {
                    shotIndex,
                    panelIndex: idx,
                  });
                  setFocusedIndex(idx);
                }}
                title={`Panel ${idx + 1} — click to zoom`}
                style={{
                  padding: 0,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                  cursor: 'zoom-in',
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Panel ${idx + 1} of ${panelCount}`}
                  loading="eager"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
                {/* Per-panel ordinal badge so the user can correlate
                    "panel 3" in the inspector with the actual cell. */}
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 4,
                    padding: '2px 6px',
                    fontSize: 10,
                    fontWeight: 600,
                    background: 'rgba(0,0,0,0.65)',
                    color: '#fff',
                    borderRadius: 3,
                    pointerEvents: 'none',
                  }}
                >
                  {idx + 1}
                </span>
              </button>
            ))}
          </div>
        ) : (
          // Single-panel zoomed view.
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={panelUrls[focusedIndex]}
              alt={`Panel ${focusedIndex + 1} of ${panelCount}`}
              loading="eager"
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                display: 'block',
                border: '1px solid rgba(255,255,255,0.18)',
                borderRadius: 4,
              }}
            />
          </div>
        )}
      </div>

      {/* Keyboard hints */}
      <div
        style={{
          marginTop: 12,
          fontSize: 10,
          color: 'rgba(255,255,255,0.55)',
          letterSpacing: '0.05em',
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        ESC close · G grid ↔ panel · ← → cycle panels
      </div>
    </div>
  );
}
