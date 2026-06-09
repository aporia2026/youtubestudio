'use client';

/**
 * Per-row zenn_v1 inspector controls.
 *
 * Mounted by `ShotInspector` when `effectiveStyleSlug === 'zenn_v1'`.
 * Surfaces three editable fields the LLM emits at doc generation
 * time but that the user might want to override per row:
 *
 *   - `zenn_mode` — which visual mode the row renders in (Stick or
 *     Scene). The LLM picks this, but the user might want to flip a
 *     misclassified row without hand-editing the doc JSON.
 *   - `zenn_character_id` — recurring character slug. Editing this
 *     either reuses an existing bank entry (when the user retypes a
 *     known slug) or seeds a new one (when the user introduces a
 *     fresh slug — pipeline picks it up on the next image-gen tick).
 *   - `zenn_world_overlay` — which Mode B world band layout to
 *     paint behind the character. Ignored when mode is Stick.
 *
 * The clean-architecture justification per plan §13 open question 1
 * is that mode pick is the load-bearing decision for visual mode
 * dispatch; the user should be able to override without going
 * around the editor.
 *
 * Wiring contract: every mutation flows through the parent's
 * `onUpdateRow` (which dispatches `PATCH_ROW` under the hood, so
 * undo / redo / auto-save all work for free). No local state.
 *
 * PR 6.5 of `_plans/2026-06-10-zenn-v1-style.md`.
 */
import type { ProductionDoc } from '@/remotion/utils';

type ProductionRow = ProductionDoc['rows'][number];

interface InspectorZennV1PanelProps {
  row: ProductionRow;
  /** Surfaced in observability when a Character ID edit fires.
   *  ShotInspector already binds the row index into `onUpdateRow`,
   *  so this prop is only used for the diagnostic log line. */
  shotIndex: number;
  onUpdateRow: (patch: Partial<ProductionRow>) => void;
}

export function InspectorZennV1Panel({
  row,
  shotIndex,
  onUpdateRow,
}: InspectorZennV1PanelProps) {
  // Read the three fields with stable empty-string defaults so the
  // <select> / <input> values are always defined (React warns when
  // a controlled input flips between undefined and a value).
  const mode = row.zenn_mode ?? '';
  const characterId = row.zenn_character_id ?? '';
  const worldOverlay = row.zenn_world_overlay ?? '';

  // Stick mode doesn't use world overlay — disable the picker so
  // the user can't set a value that the renderer would silently
  // ignore. The user can still change the mode first and then
  // re-enable the picker.
  const isStickMode = mode === 'stick';

  // Small observability helper. Logs every per-row zenn_v1 edit so
  // the user can grep the inspector console for "did I really mean
  // to flip row 27 to stick mode?" when reviewing a doc. Cheap.
  const logEdit = (field: string, next: unknown) => {
    console.info('[zenn-v1 inspector-edit]', {
      row_index: shotIndex,
      field,
      next,
    });
  };

  return (
    <div
      className="p-3 border-b"
      style={{
        borderColor: 'var(--card-border)',
        background: 'rgba(211,47,47,0.03)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <label
          className="block text-xs font-semibold uppercase tracking-wider"
          style={{ color: '#D32F2F' }}
        >
          Zenn V1 — Row settings
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {/* Mode override */}
        <Field
          label="Mode"
          help="Scene is the differentiator; Stick is for abstract beats. Auto = let the LLM pick."
        >
          <select
            value={mode}
            onChange={(e) => {
              const next = e.target.value;
              const patch: Partial<ProductionRow> = {
                zenn_mode:
                  next === 'stick' || next === 'scene' ? next : undefined,
              };
              // Clearing the mode back to auto also clears the
              // mode reason — the LLM's stale reason would mislead
              // future readers of the doc once the mode is unset.
              if (next === '') patch.zenn_mode_reason = undefined;
              logEdit('zenn_mode', patch.zenn_mode);
              onUpdateRow(patch);
            }}
            className="input-field text-xs"
            style={{ width: '100%' }}
          >
            <option value="">Auto (let LLM pick)</option>
            <option value="stick">Stick (Mode A)</option>
            <option value="scene">Scene (Mode B)</option>
          </select>
        </Field>

        {/* Character ID — free-text. Editing reuses a bank entry
            when the user retypes a known slug; seeds a new one
            otherwise. */}
        <Field
          label="Character ID"
          help="Stable slug for a recurring entity. Reuses the bank entry when typed verbatim."
        >
          <input
            type="text"
            value={characterId}
            placeholder="(none — single-shot, no bank entry)"
            onChange={(e) => {
              const next = e.target.value.trim();
              onUpdateRow({
                zenn_character_id: next === '' ? undefined : next,
              });
            }}
            className="input-field text-xs"
            style={{ width: '100%' }}
          />
        </Field>

        {/* World overlay (Mode B only) */}
        <Field
          label="World overlay"
          help={
            isStickMode
              ? 'Disabled — Stick mode renders on white canvas, not a world.'
              : 'Mode B background band layout. The doc-level palette colors paint these bands.'
          }
        >
          <select
            value={worldOverlay ?? ''}
            disabled={isStickMode}
            onChange={(e) => {
              const next = e.target.value;
              onUpdateRow({
                zenn_world_overlay:
                  next === 'sky_only' ||
                  next === 'sky_ground' ||
                  next === 'room' ||
                  next === 'underwater'
                    ? next
                    : null,
              });
            }}
            className="input-field text-xs"
            style={{ width: '100%', opacity: isStickMode ? 0.5 : 1 }}
          >
            <option value="">None (white background)</option>
            <option value="sky_only">Sky only</option>
            <option value="sky_ground">Sky + ground (Kalahari)</option>
            <option value="room">Room (interior)</option>
            <option value="underwater">Underwater (gradient)</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

const Field: React.FC<{ label: string; help: string; children: React.ReactNode }> = ({
  label,
  help,
  children,
}) => (
  <div>
    <label
      className="block text-[11px] font-medium mb-1"
      style={{ color: 'var(--text-secondary)' }}
    >
      {label}
    </label>
    <div className="mb-1">{children}</div>
    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
      {help}
    </div>
  </div>
);
