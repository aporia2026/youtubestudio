'use client';

import React from 'react';
import type { ProductionRow } from '@/remotion/utils';
import { getVisualTypeColor } from '@/lib/visual-type-colors';

/**
 * StudioInspectorContent — read-only body of the Content tab in the
 * Studio inspector. See `_plans/2026-06-04-production-doc-redesign.md`
 * §3.4 (Content tab inventory) and the R3 PR3 entry in §7.2.
 *
 * R3 PR3 (this PR) ships this as read-only — the user can scan the
 * selected row's script, prompt, on-screen text, visual type, and
 * visual description in one pane without scrolling the legacy grid.
 * R3 PR3b will hook the same fields to `EditorWriters.updateRow` so
 * the same pane becomes editable.
 *
 * Empty values render as a soft "—" placeholder so the user can tell
 * the difference between "the field is blank" (visible —) and "the
 * field is hidden because it doesn't apply" (no row in the inspector
 * panel at all — handled by the parent component).
 */
export interface StudioInspectorContentProps {
  row: ProductionRow;
}

const EMPTY_PLACEHOLDER = '—';

interface FieldProps {
  label: string;
  value: string | undefined;
  multiline?: boolean;
}

const Field: React.FC<FieldProps> = ({ label, value, multiline }) => {
  const display = value?.trim() ? value : EMPTY_PLACEHOLDER;
  const isPlaceholder = display === EMPTY_PLACEHOLDER;
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div
        className={multiline ? 'whitespace-pre-wrap text-xs leading-relaxed' : 'text-xs'}
        style={{
          color: isPlaceholder ? 'var(--text-muted)' : 'var(--text-primary)',
          opacity: isPlaceholder ? 0.6 : 1,
        }}
      >
        {display}
      </div>
    </div>
  );
};

export const StudioInspectorContent: React.FC<StudioInspectorContentProps> = ({ row }) => {
  const visualType = row.visual_type?.trim() ?? '';
  const visualTypeColor = visualType ? getVisualTypeColor(visualType) : null;

  return (
    <div className="space-y-4">
      {visualType && visualTypeColor && (
        <div>
          <div
            className="text-[10px] uppercase tracking-wider font-semibold mb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            Visual type
          </div>
          <span
            className="inline-flex items-center text-xs px-2.5 py-1 rounded-full"
            style={{
              background: visualTypeColor.bg,
              color: visualTypeColor.color,
            }}
          >
            {visualType}
          </span>
        </div>
      )}
      <Field label="Script" value={row.script_text} multiline />
      <Field label="AI prompt" value={row.ai_image_prompt} multiline />
      <Field label="Visual description" value={row.visual_description} multiline />
      <Field label="On-screen text" value={row.on_screen_text} multiline />
      {row.stock_search_terms?.trim() && (
        <Field label="Stock search terms" value={row.stock_search_terms} />
      )}
      {row.notes?.trim() && <Field label="Notes" value={row.notes} multiline />}
    </div>
  );
};
