"use client";

/**
 * Per-row overlay status cell for the Production Doc table.
 *
 * Renders alongside the row's planned `overlay_stock_terms` and shows the
 * live state of the auto-fetch pipeline (Brave search → background
 * removal → R2). Four states map to four visual treatments:
 *
 *   - undefined / 'idle'  → terms pill alone (fetch hasn't started yet)
 *   - 'loading'           → terms pill + spinner + "fetching"
 *   - 'done'              → terms pill + tiny PNG thumbnail (transparent)
 *   - 'skipped' / 'error' → terms pill + ⚠ + Retry button
 *
 * The parent owns the actual fetch — this cell only displays and offers
 * a retry hook.
 */

import type { RowOverlayState } from './overlay-types';

type Zone =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';

interface Props {
  terms: string;
  zone?: Zone;
  size?: 'small' | 'medium' | 'large';
  state?: RowOverlayState;
  onRetry: () => void;
  /** Open the drag-and-drop position editor for this row. Surfaced only
   *  when the overlay has fetched successfully — there's nothing to
   *  position before then. */
  onOpenPositionEditor?: () => void;
  /** True when the row has a manually-set position. Switches the
   *  button label so the user can tell at a glance whether this row
   *  is using the AI placement or their own. */
  hasManualPosition?: boolean;
  /** Phase 3 — invoked when the user clicks the ↻ button. Re-runs the
   *  vision placement on the existing overlay (no Brave, no RMBG).
   *  Surfaced only when the overlay is `done` AND the parent has
   *  wired the handler. */
  onRethink?: () => void;
  /** True when a rethink for this row is in flight. Replaces the ↻
   *  icon with a spinner and disables the click. */
  isRethinking?: boolean;
  /** True when this row has burned through its session rethink budget.
   *  Greys out the ↻ button with an explanatory tooltip. */
  rethinkExhausted?: boolean;
  /** Phase 5 — invoked when the user clicks the ✎ button to open the
   *  AI image-edit dialog. Surfaced only when the overlay is `done`
   *  AND the parent wired the handler. */
  onEditImage?: () => void;
  /** Phase 5 — invoked when the user clicks the ↶ Undo button. The
   *  parent pops the row's `overlay_edit_history` stack and restores
   *  the previous URL into the live overlay slot. Surfaced only when
   *  `editHistoryDepth > 0`. */
  onUndoEdit?: () => void;
  /** Number of prior overlay URLs on the row's `overlay_edit_history`
   *  stack. 0 hides the Undo button; ≥1 shows "↶ Undo"; ≥2 shows
   *  "↶ Undo (N)" so the user knows how many edits back they can go.
   *  Capped at the stack's hard limit (3) by the parent. */
  editHistoryDepth?: number;
  /** Phase 5 — invoked on right-click of the overlay cell. Parent
   *  opens an OverlayContextMenu at the cursor coords. Absent ⇒
   *  right-click falls through to the browser's default menu. */
  onShowContextMenu?: (x: number, y: number) => void;
  /** Removes the overlay from the row. Renders as a small ✕ button in
   *  the top-right of the cell on hover. The same destructive action
   *  also lives in the right-click context menu; this hover affordance
   *  is the discoverable version (right-click on a table cell is not
   *  obvious to most users). Confirms before destroying. */
  onRemove?: () => void;
}

const ZONE_LABELS: Record<Zone, string> = {
  'top-left': '↖',
  'top-right': '↗',
  'bottom-left': '↙',
  'bottom-right': '↘',
  'center-top': '↑',
  'center-bottom': '↓',
  'left-center': '←',
  'right-center': '→',
};

export function OverlayCell({
  terms,
  zone,
  size,
  state,
  onRetry,
  onOpenPositionEditor,
  hasManualPosition,
  onRethink,
  isRethinking,
  rethinkExhausted,
  onEditImage,
  onUndoEdit,
  editHistoryDepth,
  onShowContextMenu,
  onRemove,
}: Props) {
  const undoDepth = editHistoryDepth ?? 0;
  const status = state?.status ?? 'idle';
  // Hover-✕ only makes sense when there's actually an overlay to remove.
  // Mirrors the right-click context menu's visibility rule.
  const canRemove = !!onRemove && status === 'done';
  return (
    <div
      className="flex flex-col gap-1 relative group"
      // Right-click → parent opens an OverlayContextMenu at the cursor.
      // Only intercept when (a) the overlay is in `done` state (something
      // to act on) AND (b) the parent wired the handler. Otherwise let
      // the browser's default menu through.
      onContextMenu={
        onShowContextMenu && status === 'done'
          ? (e) => {
              e.preventDefault();
              onShowContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }>
      {canRemove && (
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined' && !window.confirm('Remove this overlay from the row?')) return;
            console.info('[overlay-skip] cell removed via hover');
            onRemove?.();
          }}
          className="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] leading-none rounded-full flex items-center justify-center"
          style={{
            width: 16,
            height: 16,
            background: 'rgba(239,68,68,0.85)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.2)',
            cursor: 'pointer',
            zIndex: 1,
          }}
          title="Remove this overlay (right-click also works)"
          aria-label="Remove overlay"
        >
          ✕
        </button>
      )}
      <div className="flex items-center gap-1">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
          style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24', maxWidth: 140 }}
          title={`Overlay: ${terms}${zone ? ` · ${zone}` : ''}${size ? ` · ${size}` : ''}`}
        >
          <span className="truncate">✦ {terms}</span>
        </span>
        {zone && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-muted)' }}
            title={`Planned zone: ${zone}${size ? `, ${size}` : ''}`}
          >
            {ZONE_LABELS[zone]}
          </span>
        )}
      </div>

      {status === 'loading' && (
        <div className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ width: 10, height: 10 }} />
          fetching…
        </div>
      )}

      {status === 'done' && state?.url && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            {/* 40x28 thumbnail in a table cell — next/image would require
                configuring the R2 public domain in next.config and adds
                runtime overhead unjustified for a status preview this small. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.url}
              alt={terms}
              style={{
                maxWidth: 40,
                maxHeight: 28,
                objectFit: 'contain',
                background:
                  'repeating-conic-gradient(rgba(255,255,255,0.06) 0% 25%, transparent 0% 50%) 50% / 8px 8px',
                borderRadius: 2,
              }}
              title="Auto-sourced overlay (transparent PNG, will be composited at render)"
            />
            <span className="text-[10px]" style={{ color: '#4ade80' }} title="Overlay ready">
              ✓
            </span>
          </div>
          <div className="flex items-center gap-1">
            {onOpenPositionEditor && (
              <button
                type="button"
                onClick={onOpenPositionEditor}
                className="text-[10px] px-1.5 py-0.5 rounded self-start"
                style={{
                  background: hasManualPosition ? 'rgba(168,85,247,0.16)' : 'rgba(255,255,255,0.04)',
                  color: hasManualPosition ? '#c084fc' : 'var(--text-muted)',
                  border: `1px solid ${hasManualPosition ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
                }}
                title={
                  hasManualPosition
                    ? 'Open the drag-and-drop editor — position is currently manual'
                    : 'Open the drag-and-drop editor to set a custom position'
                }
              >
                {hasManualPosition ? '✋ Position (manual)' : '✋ Position…'}
              </button>
            )}
            {/* Phase 3 — Rethink button. Re-runs the vision placement
                without re-fetching the overlay. Disabled while in
                flight and after the session cap is hit. */}
            {onRethink && (
              <button
                type="button"
                onClick={onRethink}
                disabled={isRethinking || rethinkExhausted}
                className="text-[10px] px-1.5 py-0.5 rounded self-start"
                style={{
                  background: rethinkExhausted ? 'rgba(255,255,255,0.02)' : 'rgba(99,102,241,0.14)',
                  color: rethinkExhausted ? 'rgba(255,255,255,0.30)' : '#a5b4fc',
                  border: `1px solid ${rethinkExhausted ? 'rgba(255,255,255,0.06)' : 'rgba(99,102,241,0.32)'}`,
                  cursor: isRethinking || rethinkExhausted ? 'not-allowed' : 'pointer',
                  opacity: isRethinking ? 0.7 : 1,
                }}
                title={
                  rethinkExhausted
                    ? 'Rethink limit reached this session — reload the page to reset'
                    : isRethinking
                      ? 'Asking the AI for a new placement…'
                      : 'Ask the AI to rethink this overlay\'s size and position'
                }
              >
                {isRethinking ? '↻ …' : '↻ Rethink'}
              </button>
            )}
            {/* Phase 5 — ✎ Edit image. Direct cell-level entry for the
                AI image-edit dialog so the user doesn't have to open
                the position editor first. Council outcome wanted this
                wired alongside the position-editor surface. */}
            {onEditImage && (
              <button
                type="button"
                onClick={onEditImage}
                className="text-[10px] px-1.5 py-0.5 rounded self-start"
                style={{
                  background: 'rgba(168,85,247,0.14)',
                  color: '#c084fc',
                  border: '1px solid rgba(168,85,247,0.30)',
                  cursor: 'pointer',
                }}
                title="Edit this overlay image with AI (Smart edit or Brush mask)"
              >
                ✎ Edit
              </button>
            )}
            {/* Phase 5 — Undo last AI edit. Visible when the row's
                edit-history stack has ≥1 entry. The count badge shows
                up at depth ≥2 so the user knows how many edits back
                they can step. Each click pops one. */}
            {onUndoEdit && undoDepth > 0 && (
              <button
                type="button"
                onClick={onUndoEdit}
                className="text-[10px] px-1.5 py-0.5 rounded self-start"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: 'pointer',
                }}
                title={
                  undoDepth === 1
                    ? 'Undo the most recent AI edit on this overlay'
                    : `Undo the most recent AI edit (${undoDepth} edits stored — click again to go further back)`
                }
              >
                {undoDepth > 1 ? `↶ Undo (${undoDepth})` : '↶ Undo'}
              </button>
            )}
          </div>
        </div>
      )}

      {(status === 'skipped' || status === 'error') && (
        <div className="flex items-center gap-1">
          <span
            className="text-[10px]"
            style={{ color: '#f87171' }}
            title={state?.error || 'Overlay fetch failed'}
          >
            ⚠ {status === 'skipped' ? 'not found' : 'fetch failed'}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
