'use client';

/**
 * Cost-gated "switch OST to overlay + regen baked images" modal.
 *
 * Surfaced from the inspector kebab → "Switch OST to overlay". Solves
 * the bug from the screenshot where doodle_explainer_2 docs render
 * lower-third text as a default red/black/white bar BAKED INTO the AI
 * image pixels. The fix is two steps: (1) flip the doc to overlay mode
 * so future renders mount a yellow LowerThird on top of a clean image,
 * AND (2) regenerate every shot whose image currently has the bar
 * baked in.
 *
 * Step 1 alone is free; step 2 spends real money. This modal pins
 * count + per-image price + estimated total before the user clicks Run.
 *
 * PR 3 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
 * Per the plan's §16 cost gate: the user only commits to the regen by
 * clicking "Run" inside this modal.
 */

import { useMemo } from 'react';
import type { ProductionDoc } from '@/remotion/utils';

export interface AffectedRow {
  /** Row index in doc.rows. */
  rowIndex: number;
  /** The OST text being baked into the image — surfaced so the user
   *  can spot-check which rows will be regenerated. */
  onScreenText: string;
}

interface FlipOstToOverlayModalProps {
  /** The rows that will be regenerated. The modal computes the count
   *  and exposes the first few labels in the preview list. */
  affectedRows: readonly AffectedRow[];
  /** Per-image cost label (e.g. "$0.011 / image (GPT Image 2 Atlas)") —
   *  the EditorClient resolves this from the current image_model so the
   *  modal stays decoupled from the model registry. */
  perImageCostLabel: string;
  /** Per-image cost as a number, for the total estimate. */
  perImageCostUsd: number;
  /** Total row count in the doc — surfaced as context so the user
   *  understands what fraction of the doc will be touched. */
  totalRowCount: number;
  /** Click Cancel or backdrop. */
  onCancel: () => void;
  /** Click Run. The parent (EditorClient):
   *    1. Dispatches PATCH_DOC to set on_screen_text_mode_default = 'overlay'
   *    2. Clears image_url on every affected row (via SET_ROW_IMAGE null)
   *    3. Kicks off `runFillBlanks` so the editor's existing throttled
   *       worker fills them back in.
   *  Modal closes. */
  onConfirm: () => void;
}

export function FlipOstToOverlayModal({
  affectedRows,
  perImageCostLabel,
  perImageCostUsd,
  totalRowCount,
  onCancel,
  onConfirm,
}: FlipOstToOverlayModalProps): React.ReactElement {
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
      aria-label="Switch on-screen text to overlay mode"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.88)',
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
          // Solid dark bg — see comment in BulkGenerateModal for the
          // 2026-06-02 user-reported readability issue.
          background: '#0f172a',
          border: '1px solid rgba(255,255,255,0.18)',
          borderRadius: 8,
          padding: 24,
          color: '#f3f4f6',
          fontSize: 13,
          lineHeight: 1.5,
          boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600 }}>
          Switch on-screen text to overlay
        </h2>

        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginBottom: 16 }}>
          The doc currently bakes on-screen text into the AI image pixels
          (the default for legacy docs). For styles with a real text
          treatment (yellow doodle bubbles, etc.) the LowerThird overlay
          renders on top of a clean image instead. This action flips the
          doc-level default AND regenerates every shot whose image
          currently has text baked in, so the bar comes back the right
          way.
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
                  {r.onScreenText.slice(0, 80)}
                  {r.onScreenText.length > 80 ? '…' : ''}
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
                ? 'No rows need regeneration — every shot is already overlay/none or has no on-screen text.'
                : `Flip the doc default + clear image_url on ${affectedCount} rows + auto-fill them back in`
            }
          >
            {affectedCount === 0
              ? 'Nothing to do'
              : `Run — flip + regen ${affectedCount} row${affectedCount === 1 ? '' : 's'} (≈ $${totalCost})`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compute the set of rows that will be regenerated.
 *
 *  A row is "affected" when:
 *    1. It carries non-empty on-screen-text
 *    2. Its effective OST mode resolves to 'bake'
 *       (row.on_screen_text_mode || doc.on_screen_text_mode_default || 'bake')
 *    3. It currently has a rendered image (clearing image_url on a row
 *       that has none is a no-op; regenerating from nothing is fine but
 *       we count only the ones that will actually re-spend money — rows
 *       that never had an image weren't paying for "baked" pixels)
 *
 *  Returned in row-index order. The caller passes this directly to
 *  the modal. Pure function — tests can call it on any doc + rowImages
 *  pair without touching React state.
 */
export function computeAffectedRows(
  doc: ProductionDoc,
  rowImages: Record<number, string>,
): AffectedRow[] {
  const docDefault = doc.on_screen_text_mode_default;
  const affected: AffectedRow[] = [];
  doc.rows.forEach((row, rowIndex) => {
    const ostText = (row.on_screen_text ?? '').trim();
    if (!ostText) return;
    const effectiveMode = row.on_screen_text_mode ?? docDefault ?? 'bake';
    if (effectiveMode !== 'bake') return;
    if (!rowImages[rowIndex]) return;
    affected.push({ rowIndex, onScreenText: ostText });
  });
  return affected;
}
