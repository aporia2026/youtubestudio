'use client';

import React from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type { EditorWriters } from '@/components/production-doc/editor/types';

/**
 * StudioInspectorSection — Section tab body in the Studio inspector.
 * See `_plans/2026-06-04-production-doc-redesign.md` §3.4 / §4.2 and
 * the R3 PR5 + R3 Section-editable entries.
 *
 * R3 PR5 shipped this read-only. R3 Section-editable (this revision)
 * makes seven of the eight legacy SectionThumbnailCard control groups
 * editable in place, with Apply-to-all and Clear-all-overrides where
 * the legacy surface had them:
 *
 *   - Section title         (text → updateRow)
 *   - Title layout          (overlay / letterbox toggle → updateRow)
 *   - Pillarbox color       (color input + bulk apply + bulk clear)
 *   - Scene fade            (On/Off toggle → updateRow)
 *   - Scene zoom            (number + bulk apply + bulk clear)
 *   - Region zoom padding   (number + bulk apply)
 *
 * Read-only for now (rich pickers needed):
 *   - Transition kind       (object editor — own PR)
 *   - Zoom-to region        (region picker — own PR)
 *
 * Each editable field shows the EFFECTIVE value (row → doc → built-in
 * default) with an "inherited" badge when the row has no override.
 * Saving via the field's input writes a row override; Clear-all-
 * overrides removes overrides across every row at once.
 *
 * Pass `editorWriters` to switch the tab from read-only to editable.
 * Pass `onUpdateRow` for the per-row text/toggle fields. Per rule 10,
 * fields without callbacks render their read-only display.
 */
export interface StudioInspectorSectionProps {
  rowIndex: number;
  row: ProductionRow;
  doc?: ProductionDoc | null;
  /** Same signature as today's `updateRow`. Required for the per-row
   *  text + toggle + number inputs to become editable. */
  onUpdateRow?: (rowIndex: number, patch: Partial<ProductionRow>) => void;
  /** Full editor writer bundle — drives the Apply-to-all and Clear-
   *  all-overrides bulk actions. When omitted the bulk buttons hide
   *  per rule 10. */
  editorWriters?: EditorWriters;
}

interface FieldShellProps {
  label: string;
  inherited?: boolean;
  children: React.ReactNode;
}

const FieldShell: React.FC<FieldShellProps> = ({ label, inherited, children }) => (
  <div>
    <div
      className="text-[10px] uppercase tracking-wider font-semibold mb-1 flex items-center gap-1.5"
      style={{ color: 'var(--text-muted)' }}
    >
      <span>{label}</span>
      {inherited && (
        <span
          className="text-[9px] px-1 py-px rounded"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-muted)',
            border: '1px solid rgba(255,255,255,0.08)',
            textTransform: 'none',
            letterSpacing: 0,
          }}
          title="Value comes from the doc-level default. The row has no override."
        >
          inherited
        </span>
      )}
    </div>
    {children}
  </div>
);

const EMPTY_PLACEHOLDER = '—';

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(s);
}

const TEXT_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(0,0,0,0.25)',
  color: 'var(--text-primary)',
  border: '1px solid rgba(255,255,255,0.10)',
};
const PILL_BUTTON_STYLE: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--text-secondary)',
  border: '1px solid rgba(255,255,255,0.10)',
  cursor: 'pointer',
};
const ACCENT_BUTTON_STYLE: React.CSSProperties = {
  ...PILL_BUTTON_STYLE,
  background: 'rgba(124,58,237,0.18)',
  color: 'var(--accent-purple-bright, #a78bfa)',
  border: '1px solid rgba(124,58,237,0.35)',
};

export const StudioInspectorSection: React.FC<StudioInspectorSectionProps> = ({
  rowIndex,
  row,
  doc = null,
  onUpdateRow,
  editorWriters,
}) => {
  // ── Section title (per-row text) ─────────────────────────────────
  const title = row.section_title ?? '';

  // ── Title layout (per-row toggle) ────────────────────────────────
  const titleLayoutRow = row.section_title_layout;
  const titleLayoutDoc = doc?.section_title_layout_default;
  const titleLayoutEffective = titleLayoutRow ?? titleLayoutDoc ?? 'letterbox';
  const titleLayoutInherited = titleLayoutRow === undefined;

  // ── Pillarbox color (per-row + bulk) ─────────────────────────────
  const pillarboxRow = row.pillarbox_color;
  const pillarboxDoc = doc?.pillarbox_color_default;
  const pillarboxEffective = (pillarboxRow?.trim() || pillarboxDoc?.trim() || '#ffffff');
  const pillarboxInherited = !pillarboxRow?.trim();

  // ── Scene fade (per-row toggle) ──────────────────────────────────
  const fadeRow = row.scene_fade;
  const fadeDoc = doc?.scene_fade_enabled;
  const fadeEffective = fadeRow ?? fadeDoc ?? false;
  const fadeInherited = fadeRow === undefined;

  // ── Scene zoom (per-row + bulk) ──────────────────────────────────
  const zoomRow = row.scene_zoom;
  const zoomEffective = zoomRow ?? 100;
  const zoomInherited = zoomRow === undefined;

  // ── Region padding (per-row + bulk) ──────────────────────────────
  const padRow = row.region_zoom_padding_pct;
  const padEffective = padRow ?? 15;
  const padInherited = padRow === undefined;

  // ── Read-only: transition kind, zoom-to region ───────────────────
  const transitionKind = row.thumbnail_transition?.kind ?? null;
  const zoomToId = row.thumbnail_zoom_to?.trim() ?? '';

  const editable = !!onUpdateRow;

  return (
    <div className="space-y-4">
      {/* Section title */}
      <FieldShell label="Section title">
        {editable ? (
          <div className="space-y-1.5">
            <input
              type="text"
              value={title}
              onChange={(e) => onUpdateRow!(rowIndex, { section_title: e.target.value })}
              placeholder="Optional title for this scene"
              className="w-full text-xs rounded px-2 py-1.5"
              style={TEXT_INPUT_STYLE}
              aria-label="Section title"
            />
            {editorWriters && row.visual_type === 'Title Card' && (
              <button
                type="button"
                onClick={() => editorWriters.applyTitleCardAsSectionTitle(rowIndex)}
                className="text-[11px] px-2 py-0.5 rounded"
                style={PILL_BUTTON_STYLE}
                title="Copy this Title Card's text into the section title for every row in this section."
              >
                Apply title card as section title
              </button>
            )}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {title.trim() || EMPTY_PLACEHOLDER}
          </div>
        )}
      </FieldShell>

      {/* Title layout */}
      <FieldShell label="Title layout" inherited={titleLayoutInherited}>
        {editable ? (
          <div role="radiogroup" aria-label="Title layout" className="flex gap-1">
            {(['overlay', 'letterbox'] as const).map((opt) => {
              const isCurrent = titleLayoutEffective === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={isCurrent}
                  onClick={() => onUpdateRow!(rowIndex, { section_title_layout: opt })}
                  className="text-[11px] px-2 py-1 rounded"
                  style={isCurrent ? ACCENT_BUTTON_STYLE : PILL_BUTTON_STYLE}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {titleLayoutEffective}
          </div>
        )}
      </FieldShell>

      {/* Pillarbox color */}
      <FieldShell label="Pillarbox color" inherited={pillarboxInherited}>
        {editable ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={isHexColor(pillarboxEffective) ? pillarboxEffective : '#ffffff'}
                onChange={(e) => onUpdateRow!(rowIndex, { pillarbox_color: e.target.value })}
                className="h-7 w-10 rounded cursor-pointer"
                aria-label="Pillarbox color"
              />
              <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>
                {pillarboxEffective}
              </span>
            </div>
            {editorWriters && (
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => editorWriters.applyPillarboxColorToAll(pillarboxEffective)}
                  className="text-[11px] px-2 py-0.5 rounded"
                  style={PILL_BUTTON_STYLE}
                  title="Apply this color to every row, overriding existing per-row colors."
                >
                  Apply to all
                </button>
                <button
                  type="button"
                  onClick={() => editorWriters.clearPillarboxOverrides()}
                  className="text-[11px] px-2 py-0.5 rounded"
                  style={PILL_BUTTON_STYLE}
                  title="Clear every row's per-row pillarbox color override (rows fall back to the doc default)."
                >
                  Clear all overrides
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="inline-flex items-center gap-2">
            {isHexColor(pillarboxEffective) && (
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded"
                style={{
                  background: pillarboxEffective,
                  border: '1px solid rgba(255,255,255,0.15)',
                }}
              />
            )}
            <span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>
              {pillarboxEffective}
            </span>
          </div>
        )}
      </FieldShell>

      {/* Scene fade */}
      <FieldShell label="Scene fade" inherited={fadeInherited}>
        {editable ? (
          <div role="radiogroup" aria-label="Scene fade" className="flex gap-1">
            {([true, false] as const).map((opt) => {
              const isCurrent = fadeEffective === opt;
              const label = opt ? 'On' : 'Off';
              return (
                <button
                  key={String(opt)}
                  type="button"
                  role="radio"
                  aria-checked={isCurrent}
                  onClick={() => onUpdateRow!(rowIndex, { scene_fade: opt })}
                  className="text-[11px] px-2 py-1 rounded"
                  style={isCurrent ? ACCENT_BUTTON_STYLE : PILL_BUTTON_STYLE}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {fadeEffective ? 'On' : 'Off'}
          </div>
        )}
      </FieldShell>

      {/* Scene zoom */}
      <FieldShell label="Scene zoom" inherited={zoomInherited}>
        {editable ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={400}
                step={5}
                value={zoomEffective}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isFinite(next)) onUpdateRow!(rowIndex, { scene_zoom: next });
                }}
                className="w-20 text-xs rounded px-2 py-1"
                style={TEXT_INPUT_STYLE}
                aria-label="Scene zoom percentage"
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>%</span>
            </div>
            {editorWriters && (
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => editorWriters.applySceneZoomToAll(zoomEffective)}
                  className="text-[11px] px-2 py-0.5 rounded"
                  style={PILL_BUTTON_STYLE}
                  title="Apply this zoom to every row."
                >
                  Apply to all
                </button>
                <button
                  type="button"
                  onClick={() => editorWriters.clearSceneZoomOverrides()}
                  className="text-[11px] px-2 py-0.5 rounded"
                  style={PILL_BUTTON_STYLE}
                  title="Clear every row's per-row scene zoom (rows fall back to 100%)."
                >
                  Clear all overrides
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {zoomEffective}%
          </div>
        )}
      </FieldShell>

      {/* Region zoom padding */}
      <FieldShell label="Region zoom padding" inherited={padInherited}>
        {editable ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={padEffective}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isFinite(next)) onUpdateRow!(rowIndex, { region_zoom_padding_pct: next });
                }}
                className="w-20 text-xs rounded px-2 py-1"
                style={TEXT_INPUT_STYLE}
                aria-label="Region zoom padding percentage"
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>%</span>
            </div>
            {editorWriters && (
              <div className="flex gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => editorWriters.applyRegionZoomPaddingToAll(padEffective)}
                  className="text-[11px] px-2 py-0.5 rounded"
                  style={PILL_BUTTON_STYLE}
                  title="Apply this padding to every row."
                >
                  Apply to all
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {padEffective}%
          </div>
        )}
      </FieldShell>

      {/* Transition kind */}
      <FieldShell label="Transition">
        {editable ? (
          <div role="radiogroup" aria-label="Transition kind" className="flex gap-1">
            {(['hard-cut', 'smooth', 'none'] as const).map((opt) => {
              const isCurrent = transitionKind === opt;
              return (
                <button
                  key={opt}
                  type="button"
                  role="radio"
                  aria-checked={isCurrent}
                  onClick={() => onUpdateRow!(rowIndex, {
                    thumbnail_transition: { kind: opt },
                  })}
                  className="text-[11px] px-2 py-1 rounded"
                  style={isCurrent ? ACCENT_BUTTON_STYLE : PILL_BUTTON_STYLE}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {transitionKind || EMPTY_PLACEHOLDER}
          </div>
        )}
      </FieldShell>

      {/* Zoom-to region */}
      <FieldShell label="Zoom to region">
        {editable && doc?.thumbnail?.regions && doc.thumbnail.regions.length > 0 ? (
          <select
            value={zoomToId}
            onChange={(e) => onUpdateRow!(rowIndex, {
              thumbnail_zoom_to: e.target.value || undefined,
            })}
            className="text-xs rounded px-2 py-1"
            style={TEXT_INPUT_STYLE}
            aria-label="Zoom-to region"
          >
            <option value="">— none —</option>
            {doc.thumbnail.regions.map((region) => (
              <option key={region.id} value={region.id}>
                {region.label || region.id}
              </option>
            ))}
          </select>
        ) : editable && doc?.thumbnail && (doc.thumbnail.regions?.length ?? 0) === 0 ? (
          <div
            className="text-[11px] leading-relaxed px-2 py-1.5 rounded"
            style={{
              color: 'var(--text-muted)',
              background: 'rgba(255,255,255,0.02)',
              border: '1px dashed rgba(255,255,255,0.10)',
            }}
            role="status"
          >
            Section thumbnail is uploaded but has no marked regions yet. Scroll to the doc-level <strong>Section divider thumbnail</strong> block and click <strong>Mark regions</strong> to draw rectangles over each icon — those become selectable here.
          </div>
        ) : editable ? (
          <div
            className="text-[11px] leading-relaxed px-2 py-1.5 rounded"
            style={{
              color: 'var(--text-muted)',
              background: 'rgba(255,255,255,0.02)',
              border: '1px dashed rgba(255,255,255,0.10)',
            }}
            role="status"
          >
            No section thumbnail set. Upload one in the doc-level <strong>Section divider thumbnail</strong> block and mark its regions to make them selectable here.
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {zoomToId || EMPTY_PLACEHOLDER}
          </div>
        )}
      </FieldShell>
    </div>
  );
};
