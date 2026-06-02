'use client';

/**
 * Generic cost-gated "Generate all X" modal.
 *
 * User-asked-for (2026-06-02): three separate bulk-generate actions —
 * Generate all Base images, Generate all Variations, Generate all
 * motion collages. All three share the same shape: count rows, surface
 * cost, ask for confirmation, then kick off the generation worker.
 * This component IS that shape; each button mounts it with its own
 * filter + heading.
 *
 * Cost gate: per Rule 8, mass generation can spend real money. The
 * modal pins count + per-image cost + total estimate. The user
 * explicitly clicks Run to commit.
 */

import { useMemo } from 'react';

export interface BulkGenerateRow {
  rowIndex: number;
  /** Short label shown in the preview list — usually the row's
   *  on_screen_text / section_title / script_text snippet. */
  label: string;
}

interface BulkGenerateModalProps {
  /** Modal heading + Run button label root. e.g. "Generate base images". */
  title: string;
  /** Short explanation of WHAT this action does — used in the body. */
  description: string;
  /** The rows the modal proposes to generate. Count + first 6
   *  surface as cost preview + preview list. */
  affectedRows: readonly BulkGenerateRow[];
  /** Per-image cost label (string for display) + USD number (for
   *  total estimate). Resolved by the parent from the doc's
   *  image_model_default. */
  perImageCostLabel: string;
  perImageCostUsd: number;
  /** Total row count in the doc — context for the affected ratio. */
  totalRowCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function BulkGenerateModal({
  title,
  description,
  affectedRows,
  perImageCostLabel,
  perImageCostUsd,
  totalRowCount,
  onCancel,
  onConfirm,
}: BulkGenerateModalProps): React.ReactElement {
  const affectedCount = affectedRows.length;
  const totalCost = useMemo(
    () => (affectedCount * perImageCostUsd).toFixed(2),
    [affectedCount, perImageCostUsd],
  );
  const previewRows = affectedRows.slice(0, 6);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 540,
          background: 'var(--card-bg)',
          border: '1px solid var(--card-border)',
          borderRadius: 8,
          padding: 24,
          color: 'var(--fg)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
          {title}
        </h2>

        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 16 }}>
          {description}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 16px',
            padding: 12,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid var(--card-border)',
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 12,
          }}
        >
          <div style={{ color: 'var(--fg-muted)' }}>Affected rows</div>
          <div>
            <strong>{affectedCount}</strong>{' '}
            <span style={{ color: 'var(--fg-muted)' }}>of {totalRowCount}</span>
          </div>
          <div style={{ color: 'var(--fg-muted)' }}>Cost per image</div>
          <div>{perImageCostLabel}</div>
          <div style={{ color: 'var(--fg-muted)' }}>Estimated total</div>
          <div>
            <strong>${totalCost}</strong>
            <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>
              (count × per-image)
            </span>
          </div>
        </div>

        {previewRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              First {previewRows.length} affected shots
            </div>
            <ul
              style={{
                margin: 0,
                padding: '0 0 0 18px',
                fontSize: 11,
                color: 'var(--fg)',
                listStyle: 'disc',
                maxHeight: 120,
                overflowY: 'auto',
              }}
            >
              {previewRows.map((r) => (
                <li key={r.rowIndex}>
                  <span style={{ color: 'var(--fg-muted)', fontFamily: 'ui-monospace, monospace' }}>
                    #{r.rowIndex + 1}
                  </span>{' '}
                  {r.label.slice(0, 80)}
                  {r.label.length > 80 ? '…' : ''}
                </li>
              ))}
            </ul>
            {affectedRows.length > previewRows.length && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--fg-muted)',
                  marginTop: 4,
                  fontStyle: 'italic',
                }}
              >
                …and {affectedRows.length - previewRows.length} more
              </div>
            )}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            paddingTop: 12,
            borderTop: '1px solid var(--card-border)',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border hover:bg-white/5 transition-colors"
            style={{ borderColor: 'var(--card-border)', color: 'var(--fg)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={affectedCount === 0}
            className="text-xs px-3 py-1.5 rounded font-semibold transition-colors"
            style={{
              background: affectedCount === 0 ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.22)',
              color: '#a78bfa',
              border: '1px solid rgba(124,58,237,0.45)',
              cursor: affectedCount === 0 ? 'not-allowed' : 'pointer',
            }}
            title={
              affectedCount === 0
                ? 'Nothing to generate — every targeted row already has an image.'
                : `Run ${title} for ${affectedCount} rows (≈ $${totalCost})`
            }
          >
            {affectedCount === 0
              ? 'Nothing to do'
              : `Run — ${affectedCount} row${affectedCount === 1 ? '' : 's'} (≈ $${totalCost})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Filters (pure functions, easy to unit-test) ─────────────────────

/** Rows that need a BASE image generated.
 *  Base = not a variant (variant_index is undefined or 0) AND the row
 *  needs an image (no rowImages entry) AND visual_type isn't blank /
 *  Title Card (those don't generate images). */
export function computeMissingBaseImages(
  doc: { rows: Array<{
    visual_type?: string;
    variant_index?: number;
    on_screen_text?: string;
    section_title?: string;
    script_text?: string;
    visual_description?: string;
    shot_kind?: string;
  }> },
  rowImages: Record<number, string>,
): BulkGenerateRow[] {
  const out: BulkGenerateRow[] = [];
  doc.rows.forEach((row, rowIndex) => {
    if (rowImages[rowIndex]) return;
    if (row.visual_type === 'blank' || row.visual_type === 'Title Card') return;
    if (row.shot_kind === 'motion_collage') return; // own bulk action
    const variantIdx = row.variant_index ?? 0;
    if (variantIdx > 0) return; // variants live in the other bucket
    out.push({
      rowIndex,
      label:
        row.on_screen_text?.trim() ||
        row.section_title?.trim() ||
        row.script_text?.trim() ||
        row.visual_description?.trim() ||
        `Shot ${rowIndex + 1}`,
    });
  });
  return out;
}

/** Rows that are variants (variant_index > 0) AND don't yet have an
 *  image. */
export function computeMissingVariants(
  doc: { rows: Array<{
    variant_index?: number;
    on_screen_text?: string;
    section_title?: string;
    script_text?: string;
    visual_description?: string;
    visual_type?: string;
  }> },
  rowImages: Record<number, string>,
): BulkGenerateRow[] {
  const out: BulkGenerateRow[] = [];
  doc.rows.forEach((row, rowIndex) => {
    if (rowImages[rowIndex]) return;
    if (row.visual_type === 'blank' || row.visual_type === 'Title Card') return;
    const variantIdx = row.variant_index ?? 0;
    if (variantIdx <= 0) return;
    out.push({
      rowIndex,
      label:
        row.on_screen_text?.trim() ||
        row.section_title?.trim() ||
        row.script_text?.trim() ||
        row.visual_description?.trim() ||
        `Shot ${rowIndex + 1}`,
    });
  });
  return out;
}

/** Motion-collage rows that haven't been generated yet (no panel URLs). */
export function computeMissingMotionCollages(
  doc: { rows: Array<{
    shot_kind?: string;
    motion_collage_panel_urls?: string[];
    motion_collage_grid?: { cols: number; rows: number };
    motion_collage_panel_prompts?: string[];
    on_screen_text?: string;
    section_title?: string;
    script_text?: string;
  }> },
): BulkGenerateRow[] {
  const out: BulkGenerateRow[] = [];
  doc.rows.forEach((row, rowIndex) => {
    if (row.shot_kind !== 'motion_collage') return;
    if ((row.motion_collage_panel_urls?.length ?? 0) > 0) return;
    // Must already have a grid + prompts to be eligible. Empty rows
    // need user input (or the Auto-fill button) before they can be
    // generated.
    if (!row.motion_collage_grid) return;
    if (!row.motion_collage_panel_prompts?.length) return;
    if (row.motion_collage_panel_prompts.some((p) => !p.trim())) return;
    out.push({
      rowIndex,
      label:
        row.on_screen_text?.trim() ||
        row.section_title?.trim() ||
        row.script_text?.trim() ||
        `Shot ${rowIndex + 1}`,
    });
  });
  return out;
}
