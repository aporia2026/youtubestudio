/**
 * Inline editor for a `doodle_explainer_2` motion_collage row.
 *
 * Rendered in the AI Prompt column INSTEAD of the regular prompt
 * textarea when `row.shot_kind === 'motion_collage'`. Lets the user:
 *   - pick a grid layout from the preset menu (2×2 / 3×2 / 3×3 / 4×3)
 *   - enter one prompt per panel (N textareas)
 *   - revert the row back to a regular Animation row
 *
 * Schema invariants enforced inline (mirror the pipeline-side validation):
 *   - panel_prompts.length must equal cols × rows. Grid changes pad /
 *     truncate the array.
 *   - cols × rows ≤ 16 (the slicer's hard cap via MAX_COLLAGE_CELLS).
 *     Out-of-cap grid presets are never offered.
 *
 * The pipeline's generation step is triggered the same way any other
 * row is — flipping the row to motion_collage clears `image_url` (via
 * the parent's "convert" handler), the next auto-pipeline tick (or
 * batch-Generate button) picks it up and runs `generateMotionCollage`.
 * No separate "Generate motion collage" button is needed in v1.
 *
 * See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` §Phase 9.
 */
import React, { useState } from 'react';

/** Preset grid layouts offered in the picker. Ordered smallest first
 *  (the LLM cadence guidance prefers small grids; the editor follows
 *  suit). Each `cells` value is `cols × rows` for the at-a-glance
 *  panel-count chip. */
const GRID_PRESETS: ReadonlyArray<{ cols: number; rows: number; label: string; cells: number }> = [
  { cols: 2, rows: 2, label: '2×2', cells: 4 },
  { cols: 3, rows: 2, label: '3×2', cells: 6 },
  { cols: 2, rows: 3, label: '2×3', cells: 6 },
  { cols: 3, rows: 3, label: '3×3', cells: 9 },
  { cols: 4, rows: 3, label: '4×3', cells: 12 },
  { cols: 4, rows: 4, label: '4×4', cells: 16 },
];

export interface MotionCollageRowEditorProps {
  /** Current grid on the row. Defaults to 2×2 when undefined so the
   *  user always sees a valid layout instead of an "Add grid" gap. */
  grid: { cols: number; rows: number } | undefined;
  /** Current panel prompts on the row. Always padded to `cols × rows`
   *  by the parent before passing in. Empty strings are valid (the
   *  pipeline rejects them at generate time with a clear error). */
  panelPrompts: readonly string[];
  /** Called with the next grid + panel_prompts when either changes.
   *  `reason` tells the parent WHAT changed: a grid preset tap (`'grid'`)
   *  vs a panel textarea edit (`'prompt'`). The parent uses this to
   *  auto-fill only the newly-added blank panels on a grid expansion
   *  without re-firing on every keystroke. The parent merges into the
   *  row via `updateRow`. */
  onChange: (next: { grid: { cols: number; rows: number }; panelPrompts: string[]; reason: 'grid' | 'prompt' }) => void;
  /** Revert the row to a regular Animation row. Clears motion_collage_*
   *  fields and (in the parent) the row's image_url so the next gen
   *  picks up the new shot kind. */
  onRevertToRegular: () => void;
  /** Auto-fill the EMPTY panels from the row's narration beat (one LLM
   *  call, parent-owned). Non-destructive: panels the user already wrote
   *  are kept — clear a panel to regenerate just that one. */
  onAutoFill: () => void;
  /** True while an auto-fill request is in flight for this row — disables
   *  the button + shows a spinner so the user can't double-fire. */
  autoFilling: boolean;
}

export const MotionCollageRowEditor: React.FC<MotionCollageRowEditorProps> = ({
  grid,
  panelPrompts,
  onChange,
  onRevertToRegular,
  onAutoFill,
  autoFilling,
}) => {
  const safeGrid = grid && grid.cols > 0 && grid.rows > 0 ? grid : { cols: 2, rows: 2 };
  const N = safeGrid.cols * safeGrid.rows;
  // Pad / truncate the prompts to match the grid. Done inline so the
  // component always renders N textareas matching the grid, even when
  // the parent's row state is a tick behind a grid change.
  const normalizedPrompts: string[] = Array.from({ length: N }, (_, i) => panelPrompts[i] ?? '');

  const [focusedIdx, setFocusedIdx] = useState<number | null>(null);

  function applyGrid(nextGrid: { cols: number; rows: number }): void {
    const nextN = nextGrid.cols * nextGrid.rows;
    const nextPrompts: string[] = Array.from({ length: nextN }, (_, i) => normalizedPrompts[i] ?? '');
    onChange({ grid: nextGrid, panelPrompts: nextPrompts, reason: 'grid' });
  }

  function applyPrompt(idx: number, text: string): void {
    const next = normalizedPrompts.slice();
    next[idx] = text;
    onChange({ grid: safeGrid, panelPrompts: next, reason: 'prompt' });
  }

  // Layout coords for the per-panel label. "Top-left", "Bottom-right",
  // etc. for corners; "row R col C" otherwise.
  function panelLabel(idx: number): string {
    const col = idx % safeGrid.cols;
    const row = Math.floor(idx / safeGrid.cols);
    const isTop = row === 0;
    const isBottom = row === safeGrid.rows - 1;
    const isLeft = col === 0;
    const isRight = col === safeGrid.cols - 1;
    if (isTop && isLeft) return 'top-left';
    if (isTop && isRight) return 'top-right';
    if (isBottom && isLeft) return 'bottom-left';
    if (isBottom && isRight) return 'bottom-right';
    return `row ${row + 1}, col ${col + 1}`;
  }

  return (
    <div
      style={{
        padding: 8,
        borderRadius: 6,
        background: 'rgba(124,58,237,0.06)',
        border: '1px solid rgba(124,58,237,0.30)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: '#a78bfa' }}
        >
          ↯ Motion Collage · {N} panel{N === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={onAutoFill}
            disabled={autoFilling}
            className="text-[9px] px-1.5 py-0.5 rounded"
            style={{
              background: autoFilling ? 'rgba(124,58,237,0.12)' : 'rgba(124,58,237,0.20)',
              color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.45)',
              cursor: autoFilling ? 'wait' : 'pointer',
              opacity: autoFilling ? 0.7 : 1,
              whiteSpace: 'nowrap',
            }}
            title="Auto-fill the empty panels from this row's narration. Panels you've already written are kept — clear a panel and re-run to regenerate just that one."
          >
            {autoFilling ? '✨ Filling…' : '✨ Auto-fill panels'}
          </button>
          <button
            type="button"
            onClick={onRevertToRegular}
            className="text-[9px] px-1.5 py-0.5 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.15)',
              cursor: 'pointer',
            }}
            title="Revert this row to a regular Animation row (clears motion_collage_* fields and image_url)"
          >
            ← Regular row
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Grid:</span>
        {GRID_PRESETS.map((preset) => {
          const active = preset.cols === safeGrid.cols && preset.rows === safeGrid.rows;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyGrid({ cols: preset.cols, rows: preset.rows })}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{
                background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                color: active ? '#a78bfa' : 'var(--text-secondary)',
                border: active ? '1px solid rgba(124,58,237,0.45)' : '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
              }}
              title={`${preset.label} grid — ${preset.cells} keyframes`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${safeGrid.cols}, minmax(0, 1fr))`,
          gap: 6,
        }}
      >
        {normalizedPrompts.map((prompt, idx) => {
          const isFocused = focusedIdx === idx;
          return (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                className="text-[9px] uppercase tracking-wider"
                style={{ color: isFocused ? '#a78bfa' : 'var(--text-muted)' }}
              >
                Panel {idx + 1} · {panelLabel(idx)}
              </span>
              <textarea
                value={prompt}
                placeholder="State at this keyframe (same scene, only the moving element advances)"
                onChange={(e) => applyPrompt(idx, e.target.value)}
                onFocus={() => setFocusedIdx(idx)}
                onBlur={() => setFocusedIdx(null)}
                rows={3}
                style={{
                  fontSize: 10,
                  padding: '4px 6px',
                  borderRadius: 4,
                  background: 'rgba(0,0,0,0.20)',
                  color: 'var(--text)',
                  border: isFocused ? '1px solid rgba(124,58,237,0.55)' : '1px solid rgba(255,255,255,0.10)',
                  outline: 'none',
                  resize: 'vertical',
                  lineHeight: 1.4,
                  fontFamily: 'inherit',
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
        Same scene across every panel — only the moving element advances. Panels are auto-filled from the
        row narration on convert; edit any of them, or hit <strong>✨ Auto-fill panels</strong> to fill
        the blanks again (e.g. after enlarging the grid). The next regen runs
        <code style={{ padding: '0 3px', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>generateMotionCollage</code>.
      </div>
    </div>
  );
};
