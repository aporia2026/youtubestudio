'use client';

import React, { useCallback, useState } from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type {
  EditorWriters,
  RowImageStateView,
} from '@/components/production-doc/editor/types';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import { getPref, setPref } from '@/lib/user-prefs';
import { StudioTopBar, type StudioSubMode } from './StudioTopBar';
import { StudioLayout } from './StudioLayout';
import { StudioLeftRail } from './StudioLeftRail';
import { StudioInspector } from './StudioInspector';
import type { StudioInspectorImageActions } from './StudioInspectorImage';
import type { StudioInspectorVideoClipSlice } from './StudioInspectorVideo';
import type { StudioInspectorOverlayActions } from './StudioInspectorOverlay';

const STUDIO_SUB_MODE_PREF_KEY = 'prodoc_studio_sub_mode';

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
  /** Image state for the currently-selected row. R3 PR4. */
  selectedRowImageState?: RowImageStateView | null;
  /** Image writers for the currently-selected row. R3 PR4b. */
  selectedRowImageActions?: StudioInspectorImageActions;
  /** B-roll clip for the currently-selected row. R3 PR4c. */
  selectedRowVideoClip?: StudioInspectorVideoClipSlice | null;
  /** Overlay state for the currently-selected row. R3 PR5. */
  selectedRowOverlay?: RowOverlayState | null;
  /** Overlay action callbacks for the currently-selected row.
   *  R3 Overlay-editable. */
  selectedRowOverlayActions?: StudioInspectorOverlayActions;
  /** Image state per row indexed by 0-based row index. Used by the
   *  Variants tab to render mini-strip thumbnails for the group.
   *  R3 PR4d. */
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** Test-only override for the initial sub-mode. In real usage the
   *  state hydrates from `getPref(STUDIO_SUB_MODE_PREF_KEY)` so the
   *  user's last choice survives reloads. R3 PR6. */
  initialSubMode?: StudioSubMode;
  /** Full writer bundle used by the inspector tabs that need to drive
   *  variant management, section bulk-apply, overlay edits, etc.
   *  R3 (Variants editable). */
  editorWriters?: EditorWriters;
}

export const StudioMode: React.FC<StudioModeProps> = ({
  doc,
  children,
  onNewSession,
  selectedRowIndex = null,
  onUpdateRow,
  selectedRowImageState = null,
  selectedRowImageActions,
  selectedRowVideoClip = null,
  selectedRowOverlay = null,
  selectedRowOverlayActions,
  rowImagesByIndex,
  initialSubMode,
  editorWriters,
}) => {
  // R3 PR6: Studio sub-mode toggle. Default 'scene-strip' (per §15.2
  // of the plan). Persisted via getPref/setPref so the user's choice
  // follows them across sessions and devices.
  const [subMode, setSubMode] = useState<StudioSubMode>(
    () => initialSubMode ?? getPref<StudioSubMode>(STUDIO_SUB_MODE_PREF_KEY, 'scene-strip'),
  );
  const toggleSubMode = useCallback(() => {
    setSubMode((prev) => {
      const next: StudioSubMode = prev === 'scene-strip' ? 'bulk-grid' : 'scene-strip';
      setPref(STUDIO_SUB_MODE_PREF_KEY, next);
      console.info('[prodoc studio] sub-mode-toggle', { to: next });
      return next;
    });
  }, []);
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
      <StudioTopBar
        doc={doc}
        onNewSession={onNewSession}
        subMode={subMode}
        onToggleSubMode={toggleSubMode}
      />
      {subMode === 'bulk-grid' ? (
        // Bulk Grid sub-mode: skip the 3-column StudioLayout entirely.
        // Children (today's grid table) take the full width — the
        // escape hatch from the squashed-center cost the layout pays
        // in scene-strip mode. R3 PR6 of the plan.
        <>{children}</>
      ) : (
        <StudioLayout
          leftRail={<StudioLeftRail doc={doc} />}
          mainContent={children}
          inspector={
            <StudioInspector
              selectedRow={selectedRow}
              selectedRowIndex={displayIndex}
              selectedRowLabel={displayLabel}
              onUpdateRow={onUpdateRow}
              selectedRowImageState={selectedRowImageState}
              selectedRowImageActions={selectedRowImageActions}
              selectedRowVideoClip={selectedRowVideoClip}
              selectedRowOverlay={selectedRowOverlay}
              selectedRowOverlayActions={selectedRowOverlayActions}
              doc={doc}
              rowImagesByIndex={rowImagesByIndex}
              editorWriters={editorWriters}
            />
          }
        />
      )}
    </>
  );
};
