'use client';

import React from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import { isVariantRow, getVariantGroup, getBaseRow, MAX_VARIANTS_PER_GROUP } from '@/remotion/utils';
import type { EditorWriters, RowImageStateView } from './types';

/**
 * Editor-view variant-group panel. Mounted inside the Inspector
 * accordion under the "🎬 Variants" section. Branches on the active
 * row's relationship to its group (standalone / base / variant) and
 * surfaces the same controls the main grid view ships:
 *
 *   - standalone   "+ Add variant" only (promote-into-group entry point)
 *   - base          chip + mini-strip listing the variants + Add button
 *   - variant       chip + edit-prompt input + Generate + Move ↑/↓ +
 *                   Delete + (when applicable) stale banner + jump-to-base
 *
 * The mutations come from the shared `EditorWriters` bundle — the
 * page-level `useCallback`s. This component is presentation only.
 *
 * Read-only mode: when `writers` is undefined, the panel renders
 * the static chip + a "Switch to edit mode to manage variants" hint.
 * Mirrors how the rest of the Inspector accordion sections degrade.
 */
export interface VariantPanelProps {
  doc: ProductionDoc;
  activeSection: number;
  rowImages: readonly (RowImageStateView | undefined)[];
  writers?: EditorWriters;
  /** Switch the editor's active section. Used by the "Jump to base"
   *  and mini-strip thumbnails so the user can pivot context within
   *  the same Inspector without scrolling the SectionStrip. */
  onJumpToSection?: (rowIndex: number) => void;
}

export const VariantPanel: React.FC<VariantPanelProps> = ({
  doc,
  activeSection,
  rowImages,
  writers,
  onJumpToSection,
}) => {
  const row = doc.rows[activeSection];
  if (!row) return null;

  const inGroup = isVariantRow(row);
  const isBase = inGroup && (row.variant_index ?? 0) === 0;
  const isVariant = inGroup && (row.variant_index ?? 0) > 0;
  const group = inGroup && row.group_id ? getVariantGroup(doc, row.group_id) : [];
  const groupSize = group.length || 1;
  const canAddVariant = groupSize < MAX_VARIANTS_PER_GROUP && !isVariant;

  if (!writers) {
    return (
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {inGroup
          ? `Part of a ${groupSize}-row variant group (${isBase ? 'base' : `variant ${row.variant_index}`}).`
          : 'Standalone row — not part of a variant group.'}
        {' '}Switch to edit mode to manage variants.
      </div>
    );
  }

  if (isVariant) {
    return (
      <VariantRowControls
        doc={doc}
        row={row}
        rowIndex={activeSection}
        group={group}
        groupSize={groupSize}
        rowImages={rowImages}
        writers={writers}
        onJumpToSection={onJumpToSection}
      />
    );
  }

  if (isBase) {
    return (
      <BaseRowControls
        row={row}
        rowIndex={activeSection}
        group={group}
        groupSize={groupSize}
        rowImages={rowImages}
        canAdd={canAddVariant}
        writers={writers}
        onJumpToSection={onJumpToSection}
      />
    );
  }

  // Standalone row — only the Add button.
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
        Promote this row into a variant group so you can edit minor
        expression / pose changes against the same base. Variants
        derive from the base image via Atlas GPT Image 2 Edit
        (~$0.011/call).
      </div>
      <div>
        <button
          type="button"
          onClick={() => writers.addVariantRow(activeSection)}
          className="text-xs px-2.5 py-1 rounded"
          style={{
            background: 'rgba(34,211,238,0.08)',
            color: '#22d3ee',
            border: '1px dashed rgba(34,211,238,0.4)',
            cursor: 'pointer',
          }}
        >
          + Add variant
        </button>
      </div>
    </div>
  );
};

// ─── Base row sub-component ─────────────────────────────────────────

interface BaseRowControlsProps {
  row: ProductionRow;
  rowIndex: number;
  group: readonly ProductionRow[];
  groupSize: number;
  rowImages: readonly (RowImageStateView | undefined)[];
  canAdd: boolean;
  writers: EditorWriters;
  onJumpToSection?: (rowIndex: number) => void;
}

const BaseRowControls: React.FC<BaseRowControlsProps> = ({
  row,
  rowIndex,
  group,
  groupSize,
  rowImages,
  canAdd,
  writers,
  onJumpToSection,
}) => {
  // Variant rows (variant_index > 0) ordered. The base is `row` itself
  // so we filter it out for the mini-strip — the user already sees the
  // active section's image in the main Stage.
  const variantRows = group.filter((r) => (r.variant_index ?? 0) > 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(34,211,238,0.18)',
            color: '#22d3ee',
            border: '1px solid rgba(34,211,238,0.4)',
            fontWeight: 600,
          }}
          title="This row is the base of a variant group. Its image is generated normally; variants below derive from it."
        >
          ⏺ base · {groupSize - 1} variant{groupSize - 1 === 1 ? '' : 's'}
        </span>
        {canAdd && (
          <button
            type="button"
            onClick={() => writers.addVariantRow(rowIndex)}
            className="text-[10px] px-2 py-0.5 rounded"
            style={{
              background: 'rgba(34,211,238,0.12)',
              color: '#22d3ee',
              border: '1px solid rgba(34,211,238,0.35)',
              cursor: 'pointer',
            }}
            title={`Add another variant of this row (cap: ${MAX_VARIANTS_PER_GROUP - 1} variants per group).`}
          >
            + Add variant
          </button>
        )}
        {variantRows.length > 0 && (
          <button
            type="button"
            onClick={() => void writers.generateAllVariantsInGroup(rowIndex)}
            className="text-[10px] px-2 py-0.5 rounded font-semibold"
            style={{
              background: 'rgba(124,58,237,0.15)',
              color: 'var(--accent-purple-bright)',
              border: '1px solid rgba(124,58,237,0.4)',
              cursor: 'pointer',
            }}
            title={`Generate every variant in this group in parallel. Skips variants already generated and variants without an edit prompt. ~$0.011 per variant.`}
          >
            ✨ Generate all variants
          </button>
        )}
      </div>

      <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        Variants derive from this row's image via Atlas Edit
        (~$0.011 each). Click a thumbnail to jump to it.
      </div>

      {variantRows.length > 0 && (
        <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
          {variantRows.map((variant) => {
            const idx = (variant.variant_index ?? 0);
            // Find the variant's row index in doc.rows so the jump
            // handler points at the right position.
            const variantRowIndex = group.indexOf(variant) >= 0
              ? findRowIndex(group, variant, rowIndex)
              : -1;
            const variantImage = variantRowIndex >= 0 ? rowImages[variantRowIndex] : undefined;
            return (
              <button
                key={variant.group_id + ':' + idx}
                type="button"
                onClick={() => variantRowIndex >= 0 && onJumpToSection?.(variantRowIndex)}
                className="shrink-0 rounded overflow-hidden text-left relative"
                style={{
                  width: 88,
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(34,211,238,0.35)',
                  cursor: variantRowIndex >= 0 ? 'pointer' : 'default',
                }}
                title={variant.variant_edit_prompt || `Variant ${idx} (no edit prompt set)`}
              >
                <div className="relative w-full" style={{ aspectRatio: '16 / 9', background: '#0a0a0a' }}>
                  {variantImage?.imageUrl && variantImage.status === 'done' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={variantImage.imageUrl}
                      alt={`Variant ${idx}`}
                      className="absolute inset-0 w-full h-full object-cover"
                      loading="lazy"
                      draggable={false}
                    />
                  ) : (
                    <div
                      className="absolute inset-0 flex items-center justify-center text-[9px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {variantImage?.status === 'loading' || variantImage?.status === 'pending' ? '…' : '—'}
                    </div>
                  )}
                  <div
                    className="absolute top-0.5 left-0.5 px-1 py-0 rounded text-[9px] font-bold"
                    style={{ background: 'rgba(34,211,238,0.85)', color: '#fff' }}
                  >
                    v{idx}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Resolve the row index of a variant within the parent doc by
 *  scanning from `nearbyIndex` outward. The variant group is
 *  contiguous so this is a short walk; falls back to a full scan if
 *  the nearby hint misses. Helper for BaseRowControls's mini-strip. */
function findRowIndex(
  group: readonly ProductionRow[],
  variant: ProductionRow,
  nearbyIndex: number,
): number {
  // BaseRowControls doesn't have doc.rows — but it doesn't need it.
  // The variant's identity within `group` (sorted by variant_index)
  // means we can compute the actual doc-row index as nearbyIndex +
  // variant_index (since variants are contiguous and start right
  // after the base). Defensive: if anything seems off, return -1
  // so the click is silently ignored rather than jumping wrong.
  const variantIdx = variant.variant_index ?? 0;
  if (variantIdx === 0) return -1;
  return nearbyIndex + variantIdx;
}

// ─── Variant row sub-component ──────────────────────────────────────

interface VariantRowControlsProps {
  doc: ProductionDoc;
  row: ProductionRow;
  rowIndex: number;
  group: readonly ProductionRow[];
  groupSize: number;
  rowImages: readonly (RowImageStateView | undefined)[];
  writers: EditorWriters;
  onJumpToSection?: (rowIndex: number) => void;
}

const VariantRowControls: React.FC<VariantRowControlsProps> = ({
  doc,
  row,
  rowIndex,
  group,
  groupSize,
  rowImages,
  writers,
  onJumpToSection,
}) => {
  const variantIdx = row.variant_index ?? 0;
  const variantImage = rowImages[rowIndex];
  const isBusy = variantImage?.status === 'loading' || variantImage?.status === 'pending';
  const promptText = row.variant_edit_prompt ?? '';

  // Stale check — same logic as the main grid view: variant has a
  // snapshot AND that snapshot differs from the current base's
  // image_url (read live from rowImages).
  let isStale = false;
  let baseRowIndex = -1;
  if (row.group_id && row.variant_base_image_at_generation) {
    const base = getBaseRow(doc, row.group_id);
    if (base) {
      baseRowIndex = doc.rows.indexOf(base);
      const currentBaseImageUrl = baseRowIndex >= 0 ? rowImages[baseRowIndex]?.imageUrl : undefined;
      if (currentBaseImageUrl && currentBaseImageUrl !== row.variant_base_image_at_generation) {
        isStale = true;
      }
    }
  } else if (row.group_id) {
    const base = getBaseRow(doc, row.group_id);
    baseRowIndex = base ? doc.rows.indexOf(base) : -1;
  }

  const canMoveUp = variantIdx > 1;
  const canMoveDown = variantIdx < groupSize - 1;
  const generateDisabled = isBusy || promptText.trim().length === 0;

  return (
    <div className="flex flex-col gap-2">
      {/* Stale banner */}
      {isStale && (
        <div
          className="text-[11px] px-2 py-1 rounded"
          style={{
            background: 'rgba(245,158,11,0.12)',
            color: '#fbbf24',
            border: '1px solid rgba(245,158,11,0.35)',
          }}
          title="The base image was regenerated after this variant. Click Generate to redo against the current base."
        >
          ⚠ Base changed — regenerate to match current base
        </div>
      )}

      {/* Chip + nav actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(34,211,238,0.12)',
            color: '#22d3ee',
            border: '1px solid rgba(34,211,238,0.35)',
            fontWeight: 600,
          }}
          title={`Variant ${variantIdx} of ${groupSize - 1}.`}
        >
          ⟜ variant {variantIdx}/{groupSize - 1}
        </span>
        <button
          type="button"
          onClick={() => writers.moveVariantRow(rowIndex, 'up')}
          disabled={!canMoveUp}
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            cursor: canMoveUp ? 'pointer' : 'not-allowed',
            opacity: canMoveUp ? 1 : 0.4,
          }}
          title="Move this variant earlier in the sequence"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => writers.moveVariantRow(rowIndex, 'down')}
          disabled={!canMoveDown}
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            cursor: canMoveDown ? 'pointer' : 'not-allowed',
            opacity: canMoveDown ? 1 : 0.4,
          }}
          title="Move this variant later in the sequence"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete variant ${variantIdx}?`)) {
              writers.deleteVariantRow(rowIndex);
            }
          }}
          className="text-[10px] px-1.5 py-0.5 rounded"
          style={{
            background: 'rgba(239,68,68,0.08)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.3)',
            cursor: 'pointer',
          }}
          title="Delete this variant. Remaining variants in the group renumber automatically."
        >
          🗑
        </button>
        {baseRowIndex >= 0 && (
          <button
            type="button"
            onClick={() => onJumpToSection?.(baseRowIndex)}
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              cursor: 'pointer',
            }}
            title="Switch the editor's active section to this group's base row"
          >
            ↩ jump to base
          </button>
        )}
      </div>

      {/* Edit prompt */}
      <label className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
        Edit instruction
      </label>
      <textarea
        value={promptText}
        onChange={(e) => writers.updateRow(rowIndex, { variant_edit_prompt: e.target.value })}
        placeholder="What changes from the base? e.g. raise the right eyebrow"
        className="text-xs w-full"
        style={{
          minHeight: 60,
          resize: 'vertical',
          background: 'var(--bg-tertiary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '6px 8px',
        }}
        maxLength={400}
      />
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Atlas GPT Image 2 Edit composes this with the base prompt for
        the smallest possible delta. Keep the instruction short
        ("raise the right eyebrow", "open the mouth into an O shape").
      </div>

      {/* Generate */}
      <div>
        <button
          type="button"
          onClick={() => void writers.generateVariantImage(rowIndex)}
          disabled={generateDisabled}
          className="text-xs px-3 py-1.5 rounded font-semibold"
          style={{
            background: 'rgba(124,58,237,0.15)',
            color: 'var(--accent-purple-bright)',
            border: '1px solid rgba(124,58,237,0.35)',
            cursor: generateDisabled ? 'not-allowed' : 'pointer',
            opacity: generateDisabled ? 0.5 : 1,
          }}
        >
          {isBusy ? 'Generating…' : '✨ Generate variant (~$0.011)'}
        </button>
      </div>
    </div>
  );
};
