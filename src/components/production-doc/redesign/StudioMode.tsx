'use client';

import React, { useCallback, useState } from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type {
  EditorWriters,
  RowImageStateView,
} from '@/components/production-doc/editor/types';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import { getPref, setPref } from '@/lib/user-prefs';
import {
  StudioTopBar,
  type StudioSubMode,
  type SceneStripOrientation,
} from './StudioTopBar';
import { useStudioSubMode } from './use-studio-sub-mode';
import { StudioLayout } from './StudioLayout';
import { StudioLeftRail } from './StudioLeftRail';
import { StudioInspector } from './StudioInspector';
import { SceneStrip } from './SceneStrip';
import { RenderDock, type RenderDockProps } from './RenderDock';
import type { StudioInspectorImageActions } from './StudioInspectorImage';
import type { StudioInspectorVideoClipSlice } from './StudioInspectorVideo';
import type { StudioInspectorOverlayActions } from './StudioInspectorOverlay';
import type { BrollCellProps } from '@/components/production-doc/BrollCell';

const SCENE_STRIP_ORIENTATION_PREF_KEY = 'prodoc_scene_strip_orientation';

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
  /** BrollCell props bundle for the currently-selected row. Drives
   *  the editable Video tab. R3 Video-editable. */
  selectedRowBrollContext?: BrollCellProps | null;
  /** Overlay state for the currently-selected row. R3 PR5. */
  selectedRowOverlay?: RowOverlayState | null;
  /** Overlay action callbacks for the currently-selected row.
   *  R3 Overlay-editable. */
  selectedRowOverlayActions?: StudioInspectorOverlayActions;
  /** Image state per row indexed by 0-based row index. Used by the
   *  Variants tab to render mini-strip thumbnails for the group.
   *  R3 PR4d. */
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** Video clip state per row, used by the scene strip's V badge.
   *  Polish PR. */
  rowVideoClipsByIndex?: Readonly<Record<number, { status: string } | null>>;
  /** Test-only override for the initial sub-mode when StudioMode owns
   *  the state. Ignored when `subMode` + `onToggleSubMode` are
   *  provided (controlled mode). R3 PR6. */
  initialSubMode?: StudioSubMode;
  /** Controlled-mode sub-mode. When provided together with
   *  `onToggleSubMode`, StudioMode does NOT own the state — useful
   *  for `page.tsx` which also reads the sub-mode to gate the legacy
   *  Results section. R4 PR3. */
  subMode?: StudioSubMode;
  /** Controlled-mode toggle handler. Paired with `subMode`. R4 PR3. */
  onToggleSubMode?: () => void;
  /** Test-only override for the initial scene-strip orientation. In
   *  real usage the state hydrates from `getPref(SCENE_STRIP_…)`. R4 PR2. */
  initialSceneStripOrientation?: SceneStripOrientation;
  /** Called when the user clicks a SceneCard in the scene strip.
   *  Page.tsx wires this to `setExpandedRow` so the inspector
   *  populates with the clicked row. R4 PR1. */
  onSelectRow?: (rowIndex: number) => void;
  /** Full writer bundle used by the inspector tabs that need to drive
   *  variant management, section bulk-apply, overlay edits, etc.
   *  R3 (Variants editable). */
  editorWriters?: EditorWriters;
  /** Render-dock state + actions. When provided, the pinned-bottom
   *  dock renders with media counters + Start Render CTA. R5 PR1. */
  renderDock?: RenderDockProps;
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
  selectedRowBrollContext = null,
  selectedRowOverlay = null,
  selectedRowOverlayActions,
  rowImagesByIndex,
  rowVideoClipsByIndex,
  initialSubMode,
  initialSceneStripOrientation,
  subMode: controlledSubMode,
  onToggleSubMode: controlledOnToggleSubMode,
  onSelectRow,
  editorWriters,
  renderDock,
}) => {
  // R3 PR6 + R4 PR3: Studio sub-mode toggle. When the caller passes
  // controlled `subMode` + `onToggleSubMode` we defer to them (so
  // page.tsx can also read the same state for legacy-grid hiding);
  // otherwise we own the state internally, hydrating from getPref.
  const internalSubMode = useStudioSubMode(initialSubMode);
  const subMode = controlledSubMode ?? internalSubMode.subMode;
  const toggleSubMode = controlledOnToggleSubMode ?? internalSubMode.toggleSubMode;

  // R4 PR2: scene-strip orientation toggle. Default 'horizontal'
  // (per §15.2). Persisted via getPref/setPref so the user's choice
  // follows them across reloads.
  const [sceneStripOrientation, setSceneStripOrientation] = useState<SceneStripOrientation>(
    () =>
      initialSceneStripOrientation ??
      getPref<SceneStripOrientation>(SCENE_STRIP_ORIENTATION_PREF_KEY, 'horizontal'),
  );
  const toggleSceneStripOrientation = useCallback(() => {
    setSceneStripOrientation((prev) => {
      const next: SceneStripOrientation = prev === 'horizontal' ? 'vertical' : 'horizontal';
      setPref(SCENE_STRIP_ORIENTATION_PREF_KEY, next);
      console.info('[prodoc studio] scene-strip-orientation-toggle', { to: next });
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
        sceneStripOrientation={sceneStripOrientation}
        onToggleSceneStripOrientation={toggleSceneStripOrientation}
      />
      {/* When the render dock is wired the layout reserves bottom
          space so its content isn't covered by the fixed-position
          dock. Math: 56px dock-height + 16px breathing room. */}
      <div style={renderDock ? { paddingBottom: 72 } : undefined}>
      {subMode === 'bulk-grid' ? (
        // Bulk Grid sub-mode: skip the 3-column StudioLayout entirely.
        // Children (today's grid table) take the full width — the
        // escape hatch from the squashed-center cost the layout pays
        // in scene-strip mode. R3 PR6 of the plan.
        <>{children}</>
      ) : (
        <StudioLayout
          leftRail={<StudioLeftRail doc={doc} />}
          mainContent={
            <div className="space-y-4">
              <SceneStrip
                doc={doc}
                rowImagesByIndex={rowImagesByIndex}
                rowVideoClipsByIndex={rowVideoClipsByIndex}
                selectedRowIndex={selectedRowIndex}
                onSelectRow={onSelectRow}
                orientation={sceneStripOrientation}
              />
              {children}
            </div>
          }
          inspector={
            <StudioInspector
              selectedRow={selectedRow}
              selectedRowIndex={displayIndex}
              selectedRowLabel={displayLabel}
              onUpdateRow={onUpdateRow}
              selectedRowImageState={selectedRowImageState}
              selectedRowImageActions={selectedRowImageActions}
              selectedRowVideoClip={selectedRowVideoClip}
              selectedRowBrollContext={selectedRowBrollContext}
              selectedRowOverlay={selectedRowOverlay}
              selectedRowOverlayActions={selectedRowOverlayActions}
              doc={doc}
              rowImagesByIndex={rowImagesByIndex}
              editorWriters={editorWriters}
            />
          }
        />
      )}
      </div>
      {renderDock && <RenderDock {...renderDock} />}
    </>
  );
};
