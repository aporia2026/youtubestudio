'use client';

/**
 * Inspector → Variants panel for the shot-graph editor at
 * `/edit/[projectId]`. Surfaces the same variant-management
 * affordances the production-doc grid view has had since
 * _plans/2026-05-25-near-static-variants.md, but mounted inside the
 * editor's right-hand ShotInspector instead.
 *
 * Three render states (mirrors the production-doc affordance set):
 *
 *   1. Standalone row (no group_id)         → dashed "+ Add variant"
 *      button only. Click promotes the row to a base + creates the
 *      first variant immediately after it.
 *   2. Base row (variant_index === 0)       → "base · N variants" chip,
 *      horizontal mini-strip of variants (click to jump selection),
 *      "+ Add variant" (disabled at cap).
 *   3. Variant row (variant_index > 0)      → "var N/M" chip,
 *      `variant_edit_prompt` textarea (autosaves on blur via
 *      `onPatchRow`), Generate button (composes prompt + POSTs the
 *      edit), Delete, Move ↑↓.
 *
 * All store mutations go through the writers prop bundle the parent
 * supplies — this component never calls `dispatch` directly. Keeps the
 * panel testable in isolation and lets the parent (EditorClient) own
 * async side-effects + reindex calls.
 */

import { useState } from 'react';
import { Sparkles, Trash2, ArrowUp, ArrowDown, Plus } from 'lucide-react';
import type { ProductionDoc } from '@/remotion/utils';
import { MAX_VARIANTS_PER_GROUP, getBaseRow } from '@/remotion/utils';

type Row = ProductionDoc['rows'][number];

export type VariantGenState =
  | { kind: 'idle' }
  | { kind: 'generating' }
  | { kind: 'error'; message: string };

interface Props {
  /** The currently-selected row. */
  row: Row;
  /** Row's index in `doc.rows`. Needed for the writers (which all key
   *  off row index, not row identity). */
  rowIndex: number;
  /** Whole doc — needed to look up the base row + siblings in the
   *  group, and to display the variant mini-strip on base rows. */
  doc: ProductionDoc;
  /** Sparse map of row-index → image URL. The variant mini-strip uses
   *  this to render thumbnails for sibling variants. */
  rowImages: Record<number, string>;
  /** Async generation state for THIS row only. Drives the Generate
   *  button's spinner / error display. */
  genState: VariantGenState;

  // ─── Writers (parent owns dispatch + async) ─────────────────────
  onAddVariant: () => void;
  onDeleteVariant: () => void;
  onMoveVariant: (direction: 'up' | 'down') => void;
  /** Updates fields on the row via PATCH_ROW. Used for the inline
   *  variant_edit_prompt textarea. */
  onPatchRow: (patch: Partial<Row>) => void;
  /** Kick off the variant generation against the base (or previous
   *  variant if chained). Async — parent posts to the edit endpoint
   *  + persists via /row-asset. */
  onGenerateVariant: () => void;
  /** Jump the editor's selection to a different row. The variant
   *  mini-strip uses this for click-to-jump. */
  onSelectRow: (rowIndex: number) => void;
}

export function InspectorVariantsPanel({
  row,
  rowIndex,
  doc,
  rowImages,
  genState,
  onAddVariant,
  onDeleteVariant,
  onMoveVariant,
  onPatchRow,
  onGenerateVariant,
  onSelectRow,
}: Props): React.ReactElement {
  const variantIdx = row.variant_index ?? 0;
  const groupId = row.group_id;
  const isStandalone = !groupId;
  const isBase = !!groupId && variantIdx === 0;
  const isVariant = !!groupId && variantIdx > 0;

  // Sibling variants in the same group, sorted by variant_index. Empty
  // when the row is standalone. Used by the base view (mini-strip) and
  // by the variant view (chip "var N/M" denominator).
  const groupMembers = groupId
    ? doc.rows
        .map((r, i) => ({ row: r, index: i }))
        .filter(({ row: r }) => r.group_id === groupId)
        .sort((a, b) => (a.row.variant_index ?? 0) - (b.row.variant_index ?? 0))
    : [];
  const groupSize = groupMembers.length;
  const variantCount = Math.max(0, groupSize - 1);
  const atCap = (isStandalone ? 1 : groupSize) >= MAX_VARIANTS_PER_GROUP;

  // Move-up / move-down are constrained: variants 1..N-1, never past
  // the base (which sits at variant_index 0). Disable the buttons at
  // the boundaries so the user gets visual feedback before clicking.
  const canMoveUp = isVariant && variantIdx > 1;
  const canMoveDown = isVariant && variantIdx < variantCount;

  // Generate-from-base requires the base to have an image — the edit
  // endpoint refuses to generate a variant from an absent source.
  // Surfacing the requirement up front is cheaper than waiting for the
  // server to round-trip a 409.
  const base = groupId ? getBaseRow(doc, groupId) : undefined;
  const baseRowIndex = base ? doc.rows.indexOf(base) : -1;
  const baseImageUrl = baseRowIndex >= 0 ? rowImages[baseRowIndex] : undefined;
  const editPromptText = (row.variant_edit_prompt ?? '').trim();
  const canGenerate =
    isVariant
    && genState.kind !== 'generating'
    && editPromptText.length > 0
    && (row.variant_derives_from_previous
        // For chained variants the source is the previous variant;
        // require its image. For the first variant in a chain, fall
        // back to the base.
        ? variantIdx === 1
          ? Boolean(baseImageUrl)
          : Boolean(rowImages[rowIndex - 1])
        : Boolean(baseImageUrl));

  return (
    <div
      className="p-3 border-b space-y-3"
      style={{ borderColor: 'var(--card-border)' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold" style={{ color: 'var(--fg)' }}>
          Variants
        </div>
        {/* Chip — quick visual hit about what this row IS in its
            group. Different glyph per state so users can scan the
            shot strip and see at a glance which rows are bases vs
            variants. */}
        {isStandalone && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              color: 'var(--fg-muted)',
              background: 'var(--editor-edge, rgba(255,255,255,0.06))',
            }}
            title="This row is not part of a variant group. Add a variant to promote it."
          >
            standalone
          </span>
        )}
        {isBase && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              color: '#fff',
              background: 'var(--accent-purple-bright, #a78bfa)',
            }}
            title={`This row is the base image. ${variantCount} variant${variantCount === 1 ? '' : 's'} derive from it.`}
          >
            base · {variantCount} variant{variantCount === 1 ? '' : 's'}
          </span>
        )}
        {isVariant && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium"
            style={{
              color: '#fff',
              background: 'var(--accent-purple, #7c3aed)',
            }}
            title={`Variant ${variantIdx} of ${variantCount}. Derived from the base via Atlas Edit.`}
          >
            var {variantIdx}/{variantCount}
          </span>
        )}
      </div>

      {isStandalone && (
        <>
          <p
            className="text-[10px] leading-snug"
            style={{ color: 'var(--fg-muted)' }}
          >
            Promote this row into a variant group so you can edit minor
            expression / pose changes against the same base image.
          </p>
          <button
            type="button"
            onClick={onAddVariant}
            className="w-full text-[11px] px-3 py-2 rounded border-2 border-dashed hover:bg-white/5 transition-colors flex items-center justify-center gap-1.5"
            style={{
              borderColor: 'var(--accent-purple-bright, #a78bfa)',
              color: 'var(--accent-purple-bright, #a78bfa)',
            }}
          >
            <Plus size={12} /> Add variant
          </button>
        </>
      )}

      {isBase && (
        <>
          <p
            className="text-[10px] leading-snug"
            style={{ color: 'var(--fg-muted)' }}
          >
            This row&apos;s image is the base. Variants below derive from
            it via Atlas Edit (~$0.011 each).
          </p>
          {/* Horizontal mini-strip of variants in the group. Click to
              jump editor selection. Sized so 4 variants fit comfortably
              in a 380px inspector without scrolling. */}
          {variantCount > 0 && (
            <div className="flex gap-1.5 overflow-x-auto">
              {groupMembers
                .filter((m) => (m.row.variant_index ?? 0) > 0)
                .map((m) => {
                  const thumb = rowImages[m.index];
                  return (
                    <button
                      key={m.index}
                      type="button"
                      onClick={() => onSelectRow(m.index)}
                      className="shrink-0 rounded overflow-hidden text-left transition-transform hover:scale-105"
                      style={{
                        width: 64,
                        background: 'var(--editor-edge, rgba(255,255,255,0.06))',
                      }}
                      title={`Variant ${m.row.variant_index} — ${m.row.variant_edit_prompt || '(no prompt)'}`}
                    >
                      <div
                        className="aspect-video"
                        style={{ background: '#000' }}
                      >
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumb}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div
                            className="w-full h-full flex items-center justify-center text-[8px] ed-mono"
                            style={{ color: 'var(--fg-muted)' }}
                          >
                            no img
                          </div>
                        )}
                      </div>
                      <div
                        className="px-1 py-0.5 text-[9px] ed-mono tabular-nums text-center"
                        style={{ color: 'var(--fg-muted)' }}
                      >
                        v{m.row.variant_index}
                      </div>
                    </button>
                  );
                })}
            </div>
          )}
          <button
            type="button"
            onClick={onAddVariant}
            disabled={atCap}
            className="w-full text-[11px] px-3 py-2 rounded border-2 border-dashed transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:bg-white/5"
            style={{
              borderColor: 'var(--accent-purple-bright, #a78bfa)',
              color: 'var(--accent-purple-bright, #a78bfa)',
            }}
            title={
              atCap
                ? `Group is at the ${MAX_VARIANTS_PER_GROUP}-row cap (1 base + 3 variants).`
                : 'Add another variant to this group'
            }
          >
            <Plus size={12} /> Add variant
          </button>
        </>
      )}

      {isVariant && (
        <>
          <VariantEditPromptField
            value={row.variant_edit_prompt ?? ''}
            onCommit={(text) => onPatchRow({ variant_edit_prompt: text })}
          />
          {/* Stale-base check (Phase 3.7c of the variants plan): if the
              base image URL has changed since this variant was last
              generated, surface a soft banner so the user knows to
              regenerate. Cheap pure compare — no fetches. */}
          {row.variant_base_image_at_generation
            && baseImageUrl
            && row.variant_base_image_at_generation !== baseImageUrl && (
              <div
                className="text-[10px] px-2 py-1 rounded border"
                style={{
                  borderColor: 'rgba(251, 191, 36, 0.5)',
                  background: 'rgba(251, 191, 36, 0.08)',
                  color: '#fbbf24',
                }}
              >
                Base image changed since this variant was generated. Click
                Generate to refresh it against the current base.
              </div>
            )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onGenerateVariant}
              disabled={!canGenerate}
              className="flex-1 text-[11px] px-2 py-1.5 rounded border transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:bg-white/5"
              style={{
                borderColor: 'var(--accent-purple-bright, #a78bfa)',
                color: 'var(--accent-purple-bright, #a78bfa)',
              }}
              title={
                editPromptText.length === 0
                  ? 'Describe what changes from the base first.'
                  : !baseImageUrl
                    ? 'Generate the base image first — variants edit it.'
                    : 'Generate this variant from the base image (~$0.011)'
              }
            >
              <Sparkles size={12} />
              {genState.kind === 'generating'
                ? 'Generating…'
                : 'Generate variant (~$0.011)'}
            </button>
            <button
              type="button"
              onClick={() => onMoveVariant('up')}
              disabled={!canMoveUp}
              className="text-[11px] px-1.5 py-1.5 rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-white/5"
              style={{ borderColor: 'var(--card-border)' }}
              title="Move this variant up within the group"
            >
              <ArrowUp size={12} />
            </button>
            <button
              type="button"
              onClick={() => onMoveVariant('down')}
              disabled={!canMoveDown}
              className="text-[11px] px-1.5 py-1.5 rounded border transition-colors disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:bg-white/5"
              style={{ borderColor: 'var(--card-border)' }}
              title="Move this variant down within the group"
            >
              <ArrowDown size={12} />
            </button>
            <button
              type="button"
              onClick={onDeleteVariant}
              className="text-[11px] px-1.5 py-1.5 rounded border transition-colors hover:bg-white/5"
              style={{
                borderColor: 'rgba(248, 113, 113, 0.5)',
                color: '#f87171',
              }}
              title="Delete this variant"
            >
              <Trash2 size={12} />
            </button>
          </div>
          {genState.kind === 'error' && (
            <div className="text-[10px]" style={{ color: '#f87171' }}>
              {genState.message}
            </div>
          )}
          {baseRowIndex >= 0 && (
            <button
              type="button"
              onClick={() => onSelectRow(baseRowIndex)}
              className="text-[10px] underline opacity-60 hover:opacity-100"
              style={{ color: 'var(--fg-muted)' }}
            >
              Jump to base (row {baseRowIndex + 1})
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Local-state textarea — buffers keystrokes so each one doesn't pump a
 * PATCH_ROW into the undo stack. Commits on blur OR Cmd/Ctrl+Enter,
 * matching the convention the rest of the inspector uses for free-text
 * fields. The buffered value is the source of truth for what the user
 * sees; the committed value is what lives in the store.
 */
function VariantEditPromptField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (text: string) => void;
}) {
  const [local, setLocal] = useState(value);
  // External value changes (selection switch, undo/redo) win over the
  // local buffer. If the parent's value moved and differs from local,
  // re-sync — otherwise typing on row A then clicking row B would
  // surface A's pending text on B until the user typed.
  const externalChanged = value !== local && document.activeElement?.tagName !== 'TEXTAREA';
  if (externalChanged) {
    // setState during render is safe here because we're guarding on a
    // strict inequality + non-focused field. React will batch the
    // update for the next commit.
    setLocal(value);
  }
  return (
    <label className="block">
      <span
        className="text-[10px] uppercase tracking-wide"
        style={{ color: 'var(--fg-muted)' }}
      >
        Edit instruction
      </span>
      <textarea
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local.trim() !== value.trim()) onCommit(local);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (local.trim() !== value.trim()) onCommit(local);
          }
        }}
        rows={2}
        placeholder='Describe what changes from the base — e.g., "raise eyebrows", "open mouth slightly", "shift gaze left".'
        className="mt-1 w-full text-[11px] px-2 py-1.5 rounded border bg-transparent resize-y"
        style={{
          borderColor: 'var(--card-border)',
          color: 'var(--fg)',
          minHeight: 48,
        }}
      />
    </label>
  );
}
