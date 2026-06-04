'use client';

import React from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import { StudioTopBar } from './StudioTopBar';
import { StudioLayout } from './StudioLayout';
import { StudioLeftRail } from './StudioLeftRail';
import { StudioInspector } from './StudioInspector';

/**
 * Studio Mode — the post-generation Workspace surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * target layout (top bar, left rail, preview-hero center, scene strip,
 * contextual right inspector, pinned render dock).
 *
 * Phase progression behind the flag:
 *   R2 PR1 — top bar above children
 *   R2 PR2 — horizontal legend below top bar
 *   R3 PR1 — InspectorTabBar component (not mounted)
 *   R3 PR2 — THIS PR: three-column StudioLayout. Top bar stays
 *            full-width above. Below: 200px left rail (vertical
 *            Legend) ⋄ 1fr center (today's grid via `children`) ⋄
 *            380px right inspector (tab bar + empty-state prompt).
 *
 * Brutal honesty (rule 12): putting `children` straight into the
 * center column compresses the legacy grid to ~1fr of the viewport.
 * That's an interim cost behind the flag — flag-on is dev/QA, not
 * real users. R3 PR3+ progressively replaces the squashed grid with
 * tab content + scene strip, which removes the issue at the source.
 */
export interface StudioModeProps {
  /** Studio Mode renders only when the user has a generated doc, so
   *  the doc is guaranteed non-null at this layer. */
  doc: ProductionDoc;
  children: React.ReactNode;
  onNewSession?: () => void;
  /** Selected row index — 0-based into `doc.rows`, or `null` for no
   *  selection. R3 PR3 sources this from page.tsx's `expandedRow`
   *  state so the inspector populates whenever a user expands a row
   *  in the legacy grid. */
  selectedRowIndex?: number | null;
  /** Optional row writer (same signature as today's `updateRow` in
   *  page.tsx). When provided the Content tab's text fields become
   *  editable in-place. R3 PR3b. */
  onUpdateRow?: (rowIndex: number, patch: Partial<ProductionRow>) => void;
}

export const StudioMode: React.FC<StudioModeProps> = ({
  doc,
  children,
  onNewSession,
  selectedRowIndex = null,
  onUpdateRow,
}) => {
  const selectedRow =
    selectedRowIndex !== null && selectedRowIndex >= 0
      ? doc.rows[selectedRowIndex] ?? null
      : null;
  // Display index is 1-based to match the grid `#` column.
  const displayIndex = selectedRow !== null && selectedRowIndex !== null
    ? selectedRowIndex + 1
    : null;
  const displayLabel = selectedRow
    ? selectedRow.timecode || selectedRow.visual_type || undefined
    : undefined;

  return (
    <>
      <StudioTopBar doc={doc} onNewSession={onNewSession} />
      <StudioLayout
        leftRail={<StudioLeftRail doc={doc} />}
        mainContent={children}
        inspector={
          <StudioInspector
            selectedRow={selectedRow}
            selectedRowIndex={displayIndex}
            selectedRowLabel={displayLabel}
            onUpdateRow={onUpdateRow}
          />
        }
      />
    </>
  );
};
