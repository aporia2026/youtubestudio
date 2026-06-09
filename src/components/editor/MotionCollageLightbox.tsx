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

import { useEffect, useRef, useState } from 'react';

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
  /** Per-panel actions — when set, expose action buttons in the
   *  single-panel zoom view. User-asked-for 2026-06-02: AI Replace +
   *  Upload + (Brush deferred). */
  onRegenPanel?: (panelIndex: number) => void;
  onUploadPanel?: (panelIndex: number, file: File) => void;
  onEditPanelWithPrompt?: (panelIndex: number, prompt: string) => void;
  /** Per-panel image transform (X/Y/SCALE) so a poorly-framed panel
   *  can be repositioned without regen. User-asked-for 2026-06-02. */
  panelTransforms?: ReadonlyArray<{ x_pct?: number; y_pct?: number; scale_pct?: number } | null>;
  onPanelTransformChange?: (
    panelIndex: number,
    next: { x_pct: number; y_pct: number; scale_pct: number },
  ) => void;
  /** Inflight indicator from the parent. When the panel index matches
   *  any of these states, the corresponding action button shows its
   *  busy state and the others disable. */
  busyPanelIndex?: number | null;
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
  onRegenPanel,
  onUploadPanel,
  onEditPanelWithPrompt,
  panelTransforms,
  onPanelTransformChange,
  busyPanelIndex,
}: MotionCollageLightboxProps): React.ReactElement {
  // `focusedIndex === null` means grid view; a number means single-panel
  // zoomed view. Click-a-thumb sets it; G or grid-icon clears it.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(
    typeof initialPanelIndex === 'number' ? initialPanelIndex : null,
  );
  // Per-panel edit dialog: inline prompt textarea, shown below the
  // single-panel image when the user clicks ✎ Edit with prompt.
  const [editPromptOpen, setEditPromptOpen] = useState(false);
  const [editPromptDraft, setEditPromptDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
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
          // Single-panel zoomed view + per-panel actions (PR 6 of user
          // ask 2026-06-02: edit motion frames individually).
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
            }}
          >
            { }
            {(() => {
              // Mirror the renderer's per-panel transform inside the
              // preview so the slider feedback matches what the
              // exported MP4 will paint. Containing box keeps the
              // panel's aspect; the image inside gets the transform.
              const tx = panelTransforms?.[focusedIndex];
              const xPct = typeof tx?.x_pct === 'number' && Number.isFinite(tx.x_pct) ? tx.x_pct : 0;
              const yPct = typeof tx?.y_pct === 'number' && Number.isFinite(tx.y_pct) ? tx.y_pct : 0;
              const scalePct =
                typeof tx?.scale_pct === 'number' && Number.isFinite(tx.scale_pct) ? tx.scale_pct : 100;
              const transformStr =
                xPct !== 0 || yPct !== 0 || scalePct !== 100
                  ? `translate(${xPct}%, ${yPct}%) scale(${scalePct / 100})`
                  : undefined;
              return (
                <div
                  style={{
                    position: 'relative',
                    maxWidth: '100%',
                    maxHeight: 'calc(100% - 200px)',
                    aspectRatio: '16 / 9',
                    overflow: 'hidden',
                    background: '#000',
                    border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: 4,
                  }}
                >
                  <img
                    src={panelUrls[focusedIndex]}
                    alt={`Panel ${focusedIndex + 1} of ${panelCount}`}
                    loading="eager"
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      transform: transformStr,
                      transformOrigin: 'center center',
                      display: 'block',
                    }}
                  />
                </div>
              );
            })()}
            {(onRegenPanel || onUploadPanel || onEditPanelWithPrompt) && (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  alignItems: 'center',
                  padding: '4px 0',
                }}
              >
                {onRegenPanel && (
                  <button
                    type="button"
                    onClick={() => onRegenPanel(focusedIndex)}
                    disabled={busyPanelIndex === focusedIndex}
                    title={`Regenerate panel ${focusedIndex + 1} (uses the row's panel-prompt; ~1/N the cost of a full grid regen)`}
                    style={{
                      padding: '6px 12px',
                      background: 'rgba(124,58,237,0.22)',
                      color: '#a78bfa',
                      border: '1px solid rgba(124,58,237,0.45)',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor:
                        busyPanelIndex === focusedIndex ? 'wait' : 'pointer',
                    }}
                  >
                    {busyPanelIndex === focusedIndex ? '↻ Working…' : '↻ Regenerate'}
                  </button>
                )}
                {onUploadPanel && (
                  <>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={busyPanelIndex === focusedIndex}
                      title="Upload a custom image for this panel (PNG / JPG / WebP)"
                      style={{
                        padding: '6px 12px',
                        background: 'rgba(59,130,246,0.18)',
                        color: '#60a5fa',
                        border: '1px solid rgba(59,130,246,0.40)',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        cursor:
                          busyPanelIndex === focusedIndex ? 'wait' : 'pointer',
                      }}
                    >
                      ⬆ Upload
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) onUploadPanel(focusedIndex, file);
                      }}
                    />
                  </>
                )}
                {onEditPanelWithPrompt && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditPromptDraft('');
                      setEditPromptOpen((v) => !v);
                    }}
                    disabled={busyPanelIndex === focusedIndex}
                    title="Edit this panel with an AI prompt (e.g. 'change the character's expression', 'remove the lock')"
                    style={{
                      padding: '6px 12px',
                      background: editPromptOpen
                        ? 'rgba(168,85,247,0.30)'
                        : 'rgba(168,85,247,0.18)',
                      color: '#c084fc',
                      border: '1px solid rgba(168,85,247,0.45)',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor:
                        busyPanelIndex === focusedIndex ? 'wait' : 'pointer',
                    }}
                  >
                    ✎ Edit with prompt
                  </button>
                )}
              </div>
            )}
            {onPanelTransformChange && (() => {
              // Per-panel transform sliders. Reads the current value
              // from panelTransforms[focusedIndex]; writes via the
              // parent's onPanelTransformChange. Same X/Y/SCALE shape
              // the existing per-shot ShotFreeTransformControls uses
              // so the muscle memory carries over.
              const tx = panelTransforms?.[focusedIndex];
              const xPct = typeof tx?.x_pct === 'number' ? tx.x_pct : 0;
              const yPct = typeof tx?.y_pct === 'number' ? tx.y_pct : 0;
              const scalePct = typeof tx?.scale_pct === 'number' ? tx.scale_pct : 100;
              function commit(next: { x_pct: number; y_pct: number; scale_pct: number }): void {
                onPanelTransformChange!(focusedIndex!, next);
              }
              const dirty = xPct !== 0 || yPct !== 0 || scalePct !== 100;
              return (
                <div
                  style={{
                    width: '100%',
                    maxWidth: 600,
                    display: 'grid',
                    gridTemplateColumns: '60px 1fr 56px',
                    gap: '6px 10px',
                    padding: 10,
                    background: 'rgba(0,0,0,0.55)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: 6,
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: 11,
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      gridColumn: '1 / -1',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 2,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>Position this panel</span>
                    {dirty && (
                      <button
                        type="button"
                        onClick={() => commit({ x_pct: 0, y_pct: 0, scale_pct: 100 })}
                        title="Reset transform to identity"
                        style={{
                          padding: '2px 8px',
                          fontSize: 10,
                          background: 'transparent',
                          color: 'rgba(255,255,255,0.7)',
                          border: '1px solid rgba(255,255,255,0.25)',
                          borderRadius: 3,
                          cursor: 'pointer',
                        }}
                      >
                        Reset
                      </button>
                    )}
                  </div>

                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>X</span>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={xPct}
                    onChange={(e) =>
                      commit({ x_pct: Number(e.target.value), y_pct: yPct, scale_pct: scalePct })
                    }
                    style={{ width: '100%' }}
                  />
                  <span
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      textAlign: 'right',
                      color: 'rgba(255,255,255,0.85)',
                    }}
                  >
                    {xPct >= 0 ? '+' : ''}{xPct}%
                  </span>

                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>Y</span>
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={yPct}
                    onChange={(e) =>
                      commit({ x_pct: xPct, y_pct: Number(e.target.value), scale_pct: scalePct })
                    }
                    style={{ width: '100%' }}
                  />
                  <span
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      textAlign: 'right',
                      color: 'rgba(255,255,255,0.85)',
                    }}
                  >
                    {yPct >= 0 ? '+' : ''}{yPct}%
                  </span>

                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>Scale</span>
                  <input
                    type="range"
                    min={25}
                    max={400}
                    step={1}
                    value={scalePct}
                    onChange={(e) =>
                      commit({ x_pct: xPct, y_pct: yPct, scale_pct: Number(e.target.value) })
                    }
                    style={{ width: '100%' }}
                  />
                  <span
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      textAlign: 'right',
                      color: 'rgba(255,255,255,0.85)',
                    }}
                  >
                    {scalePct}%
                  </span>
                </div>
              );
            })()}
            {editPromptOpen && onEditPanelWithPrompt && (
              <div
                style={{
                  width: '100%',
                  maxWidth: 600,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  padding: 10,
                  background: 'rgba(0,0,0,0.55)',
                  border: '1px solid rgba(168,85,247,0.45)',
                  borderRadius: 6,
                }}
              >
                <textarea
                  value={editPromptDraft}
                  onChange={(e) => setEditPromptDraft(e.target.value)}
                  autoFocus
                  rows={2}
                  placeholder="Describe the change — e.g. 'make the character smile', 'add a key in their hand'"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    color: '#fff',
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid rgba(255,255,255,0.18)',
                    borderRadius: 4,
                    outline: 'none',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setEditPromptOpen(false);
                      setEditPromptDraft('');
                    }}
                    style={{
                      padding: '4px 10px',
                      fontSize: 10,
                      background: 'transparent',
                      color: 'rgba(255,255,255,0.7)',
                      border: '1px solid rgba(255,255,255,0.20)',
                      borderRadius: 3,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      editPromptDraft.trim().length === 0 ||
                      busyPanelIndex === focusedIndex
                    }
                    onClick={() => {
                      onEditPanelWithPrompt(focusedIndex, editPromptDraft.trim());
                      setEditPromptOpen(false);
                      setEditPromptDraft('');
                    }}
                    style={{
                      padding: '4px 10px',
                      fontSize: 10,
                      fontWeight: 600,
                      background: 'rgba(168,85,247,0.30)',
                      color: '#c084fc',
                      border: '1px solid rgba(168,85,247,0.55)',
                      borderRadius: 3,
                      cursor:
                        editPromptDraft.trim().length === 0 ||
                        busyPanelIndex === focusedIndex
                          ? 'not-allowed'
                          : 'pointer',
                      opacity:
                        editPromptDraft.trim().length === 0 ||
                        busyPanelIndex === focusedIndex
                          ? 0.5
                          : 1,
                    }}
                  >
                    Apply edit
                  </button>
                </div>
              </div>
            )}
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
