'use client';

import React from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';

/**
 * StudioInspectorSection — read-only Section tab body in the Studio
 * inspector. Phase R3 PR5 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Shows the row's section-level fields (title, layout, pillarbox
 * color, transition, scene zoom, region padding, scene fade) with
 * effective values — i.e. row value if set, otherwise the doc-level
 * default, with a small "inherited" hint so the user knows the value
 * is coming from somewhere else.
 *
 * The editable variant — grouped accordions (Layout · Title ·
 * Transition · Zoom · Fade · Color) with Apply-to-all and Clear-all-
 * overrides per group, mirroring the legacy `SectionThumbnailCard` —
 * lands in a follow-up PR. The consolidation is the biggest UX win
 * in §3.4 of the plan and warrants its own scope.
 */
export interface StudioInspectorSectionProps {
  row: ProductionRow;
  /** Doc-level defaults the row falls back to. Optional so tests
   *  can render without a full doc. */
  doc?: ProductionDoc | null;
}

interface FieldProps {
  label: string;
  value: React.ReactNode;
  inherited?: boolean;
}

const Field: React.FC<FieldProps> = ({ label, value, inherited }) => (
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
    <div className="text-xs" style={{ color: 'var(--text-primary)' }}>
      {value}
    </div>
  </div>
);

const EMPTY_PLACEHOLDER = '—';

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(s);
}

const ColorSwatch: React.FC<{ color: string }> = ({ color }) => (
  <span className="inline-flex items-center gap-2">
    <span
      aria-hidden="true"
      className="inline-block h-3 w-3 rounded"
      style={{
        background: color,
        border: '1px solid rgba(255,255,255,0.15)',
      }}
    />
    <span style={{ fontFamily: 'monospace' }}>{color}</span>
  </span>
);

export const StudioInspectorSection: React.FC<StudioInspectorSectionProps> = ({
  row,
  doc = null,
}) => {
  // ── Section title
  const title = row.section_title?.trim() ?? '';

  // ── Title layout (overlay vs letterbox) — row override → doc default → 'letterbox'
  const titleLayoutRow = row.section_title_layout;
  const titleLayoutDoc = doc?.section_title_layout_default;
  const titleLayoutEffective = titleLayoutRow ?? titleLayoutDoc ?? 'letterbox';
  const titleLayoutInherited = titleLayoutRow === undefined;

  // ── Pillarbox color — row override → doc default → white
  const pillarboxRow = row.pillarbox_color?.trim();
  const pillarboxDoc = doc?.pillarbox_color_default?.trim();
  const pillarboxEffective = pillarboxRow || pillarboxDoc || '#ffffff';
  const pillarboxInherited = !pillarboxRow;

  // ── Scene fade — row override → doc default → false
  const fadeRow = row.scene_fade;
  const fadeDoc = doc?.scene_fade_enabled;
  const fadeEffective = fadeRow ?? fadeDoc ?? false;
  const fadeInherited = fadeRow === undefined;

  // ── Scene zoom % — row override → 100
  const zoomRow = row.scene_zoom;
  const zoomEffective = zoomRow ?? 100;
  const zoomInherited = zoomRow === undefined;

  // ── Region padding % — row override → 15 (legacy default)
  const padRow = row.region_zoom_padding_pct;
  const padEffective = padRow ?? 15;
  const padInherited = padRow === undefined;

  // ── Transition — row override only; no doc-level default at this
  //    layer (the renderer composes a default from the doc thumbnail).
  const transitionKind = row.thumbnail_transition?.kind ?? null;

  // ── Zoom-to region id (raw id; the legacy Section card picks it
  //    from a dropdown sourced from doc.thumbnail.regions).
  const zoomToId = row.thumbnail_zoom_to?.trim() ?? '';

  return (
    <div className="space-y-4">
      <Field label="Section title" value={title || EMPTY_PLACEHOLDER} />

      <Field
        label="Title layout"
        value={titleLayoutEffective}
        inherited={titleLayoutInherited}
      />

      <Field
        label="Pillarbox color"
        value={
          isHexColor(pillarboxEffective)
            ? <ColorSwatch color={pillarboxEffective} />
            : pillarboxEffective
        }
        inherited={pillarboxInherited}
      />

      <Field
        label="Scene fade"
        value={fadeEffective ? 'On' : 'Off'}
        inherited={fadeInherited}
      />

      <Field
        label="Scene zoom"
        value={`${zoomEffective}%`}
        inherited={zoomInherited}
      />

      <Field
        label="Region zoom padding"
        value={`${padEffective}%`}
        inherited={padInherited}
      />

      <Field
        label="Transition"
        value={transitionKind || EMPTY_PLACEHOLDER}
      />

      <Field label="Zoom to region" value={zoomToId || EMPTY_PLACEHOLDER} />

      <p
        className="text-[11px]"
        style={{ color: 'var(--text-muted)' }}
      >
        Editable accordions (Layout · Title · Transition · Zoom · Fade · Color) with Apply-to-all and Clear-all-overrides land in a follow-up PR.
      </p>
    </div>
  );
};
