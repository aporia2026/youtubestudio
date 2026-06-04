'use client';

import React from 'react';
import type { ProductionRow } from '@/remotion/utils';
import { getVisualTypeColor } from '@/lib/visual-type-colors';
import { InspectorInlineField } from './InspectorInlineField';

/**
 * StudioInspectorContent — Content tab body in the Studio inspector.
 * See `_plans/2026-06-04-production-doc-redesign.md` §3.4 (Content tab
 * inventory) and the R3 PR3 / R3 PR3b entries in §7.2.
 *
 * R3 PR3 shipped this read-only. R3 PR3b (this PR) wires the optional
 * `onUpdateRow` callback — when provided, each text field gains an
 * inline ✎ edit affordance (textarea + Save / Cancel + Ctrl+Enter +
 * Esc, matching today's legacy grid keyboard contract).
 *
 * `visual_type` stays read-only here for now — its picker is a
 * dropdown of fixed slugs, not a textarea, and slots better into the
 * future Section tab work.
 */
export interface StudioInspectorContentProps {
  /** 0-based row index — passed back to `onUpdateRow` so the writer
   *  patches the right row. */
  rowIndex: number;
  row: ProductionRow;
  /** Optional. When provided the text fields become editable. Same
   *  signature as today's `updateRow(rowIndex, patch)` in page.tsx. */
  onUpdateRow?: (rowIndex: number, patch: Partial<ProductionRow>) => void;
}

export const StudioInspectorContent: React.FC<StudioInspectorContentProps> = ({
  rowIndex,
  row,
  onUpdateRow,
}) => {
  const visualType = row.visual_type?.trim() ?? '';
  const visualTypeColor = visualType ? getVisualTypeColor(visualType) : null;

  const makeSaver = (field: keyof ProductionRow) => {
    if (!onUpdateRow) return undefined;
    return (next: string) => onUpdateRow(rowIndex, { [field]: next } as Partial<ProductionRow>);
  };

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
      <InspectorInlineField
        fieldId={`row-${rowIndex}-script`}
        label="Script"
        value={row.script_text}
        onSave={makeSaver('script_text')}
        multiline
      />
      <InspectorInlineField
        fieldId={`row-${rowIndex}-prompt`}
        label="AI prompt"
        value={row.ai_image_prompt}
        onSave={makeSaver('ai_image_prompt')}
        multiline
      />
      <InspectorInlineField
        fieldId={`row-${rowIndex}-visual-desc`}
        label="Visual description"
        value={row.visual_description}
        onSave={makeSaver('visual_description')}
        multiline
      />
      <InspectorInlineField
        fieldId={`row-${rowIndex}-ost`}
        label="On-screen text"
        value={row.on_screen_text}
        onSave={makeSaver('on_screen_text')}
        multiline
      />
      {(row.stock_search_terms?.trim() || onUpdateRow) && (
        <InspectorInlineField
          fieldId={`row-${rowIndex}-stock-terms`}
          label="Stock search terms"
          value={row.stock_search_terms}
          onSave={makeSaver('stock_search_terms')}
        />
      )}
      {(row.notes?.trim() || onUpdateRow) && (
        <InspectorInlineField
          fieldId={`row-${rowIndex}-notes`}
          label="Notes"
          value={row.notes}
          onSave={makeSaver('notes')}
          multiline
        />
      )}
    </div>
  );
};
