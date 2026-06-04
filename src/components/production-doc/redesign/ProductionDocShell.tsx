'use client';

import React, { useEffect, useRef } from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type {
  EditorWriters,
  RowImageStateView,
} from '@/components/production-doc/editor/types';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import type { StudioSubMode } from './StudioTopBar';
import type { StudioInspectorImageActions } from './StudioInspectorImage';
import type { StudioInspectorVideoClipSlice } from './StudioInspectorVideo';
import type { StudioInspectorOverlayActions } from './StudioInspectorOverlay';
import type { BrollCellProps } from '@/components/production-doc/BrollCell';
import { BriefMode } from './BriefMode';
import { StudioMode } from './StudioMode';

/**
 * Production-doc redesign V1 — the shell that switches between Brief
 * Mode (pre-generation Notebook) and Studio Mode (post-generation
 * Workspace). See `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Phase R0 (this PR): the shell is a transparent wrapper around the
 * existing page content. Flipping the `PROD_DOC_REDESIGN_V1_PUBLIC`
 * flag does not change anything visible yet. R1 starts filling in
 * Brief Mode; R2–R5 build out Studio Mode.
 */
export interface ProductionDocShellProps {
  /** Current production-doc, or null if the user has not generated one yet. */
  doc: ProductionDoc | null;
  /** Today's page render. Phase R0 passed this through unchanged. From R1
   *  onward the new mode chrome wraps the children — page.tsx hides any
   *  legacy chunks that the new chrome replaces (see the legacy-header
   *  conditional in `page.tsx` for the pattern). */
  children: React.ReactNode;
  /** Wired through to `BriefHeader` so the new-session button keeps
   *  firing today's `resetSession` callback. Optional so the shell
   *  stays renderable in tests without setting up the full page state. */
  onNewSession?: () => void;
  /** 0-based index into `doc.rows` for the currently-selected row, or
   *  `null` if no row is selected. Studio Mode forwards this to the
   *  inspector so the Content / Image / Video / Overlay / Section /
   *  Variants tabs populate. Ignored in Brief Mode. */
  selectedRowIndex?: number | null;
  /** Optional row writer. When provided, the inspector's Content tab
   *  becomes editable. Same signature as today's `updateRow(rowIndex,
   *  patch)` in page.tsx. Ignored in Brief Mode. */
  onUpdateRow?: (rowIndex: number, patch: Partial<ProductionRow>) => void;
  /** Image state for the currently-selected row. Drives the Image
   *  tab's read-only preview. Ignored in Brief Mode. R3 PR4. */
  selectedRowImageState?: RowImageStateView | null;
  /** Image action writers for the currently-selected row — Generate,
   *  Upload, Import URL, Edit, Retry. Ignored in Brief Mode. R3 PR4b. */
  selectedRowImageActions?: StudioInspectorImageActions;
  /** B-roll clip for the currently-selected row. Drives the Video
   *  tab's read-only preview. Ignored in Brief Mode. R3 PR4c. */
  selectedRowVideoClip?: StudioInspectorVideoClipSlice | null;
  /** Full BrollCell props bundle for the currently-selected row.
   *  When provided, drives the editable Video tab (BrollCell mount).
   *  Ignored in Brief Mode. R3 Video-editable. */
  selectedRowBrollContext?: BrollCellProps | null;
  /** Overlay state for the currently-selected row. Drives the
   *  Overlay tab's read-only preview. Ignored in Brief Mode. R3 PR5. */
  selectedRowOverlay?: RowOverlayState | null;
  /** Overlay action callbacks for the currently-selected row.
   *  Drives the Overlay tab's Rethink / Edit / Reset / Remove
   *  buttons. Ignored in Brief Mode. R3 Overlay-editable. */
  selectedRowOverlayActions?: StudioInspectorOverlayActions;
  /** Image state per row, indexed by 0-based row index. Used by the
   *  Variants tab to render mini-strip thumbnails for the row's
   *  variant group. Ignored in Brief Mode. R3 PR4d. */
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** Full editor-writer bundle. When provided, makes Variants
   *  (and, in later PRs, Section / Overlay / Video) tabs editable.
   *  Ignored in Brief Mode. */
  editorWriters?: EditorWriters;
  /** Called when a SceneCard in the scene strip is activated. Wires
   *  to today's `setExpandedRow` in page.tsx. Ignored in Brief Mode.
   *  R4 PR1. */
  onSelectRow?: (rowIndex: number) => void;
  /** Controlled Studio sub-mode. When provided together with
   *  `onToggleSubMode`, lifts the state to page.tsx so the same
   *  signal can gate other UI (e.g. hiding the legacy Results
   *  section in scene-strip mode). Ignored in Brief Mode. R4 PR3. */
  subMode?: StudioSubMode;
  /** Controlled toggle handler. Paired with `subMode`. R4 PR3. */
  onToggleSubMode?: () => void;
}

export type ProductionDocShellMode = 'brief' | 'studio';

/**
 * Pure helper extracted from the shell so unit tests can verify
 * mode-routing without rendering. Tested in
 * `tests/prodoc-redesign-shell.test.tsx`.
 */
export function selectShellMode(doc: ProductionDoc | null): ProductionDocShellMode {
  return doc ? 'studio' : 'brief';
}

export const ProductionDocShell: React.FC<ProductionDocShellProps> = ({
  doc,
  children,
  onNewSession,
  selectedRowIndex,
  onUpdateRow,
  selectedRowImageState,
  selectedRowImageActions,
  selectedRowVideoClip,
  selectedRowBrollContext,
  selectedRowOverlay,
  selectedRowOverlayActions,
  rowImagesByIndex,
  editorWriters,
  onSelectRow,
  subMode,
  onToggleSubMode,
}) => {
  const mode: ProductionDocShellMode = selectShellMode(doc);
  // Track the prior mode so the mode-switch log fires only on actual
  // transitions, not on the initial mount (the mount log covers that).
  const priorMode = useRef<ProductionDocShellMode | null>(null);

  useEffect(() => {
    console.info('[prodoc shell] mount', { mode, hasDoc: !!doc });
    // mount-only — intentionally omit deps so this fires once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (priorMode.current !== null && priorMode.current !== mode) {
      console.info('[prodoc shell] mode-switch', {
        from: priorMode.current,
        to: mode,
        hasDoc: !!doc,
      });
    }
    priorMode.current = mode;
  }, [mode, doc]);

  // `mode === 'studio'` is true only when `doc` is non-null (see
  // `selectShellMode`). The non-null assertion here is therefore safe
  // and lets `StudioMode` declare `doc` as required, which keeps the
  // downstream API honest.
  return mode === 'brief' ? (
    <BriefMode onNewSession={onNewSession}>{children}</BriefMode>
  ) : (
    <StudioMode
      doc={doc!}
      onNewSession={onNewSession}
      selectedRowIndex={selectedRowIndex}
      onUpdateRow={onUpdateRow}
      selectedRowImageState={selectedRowImageState}
      selectedRowImageActions={selectedRowImageActions}
      selectedRowVideoClip={selectedRowVideoClip}
      selectedRowBrollContext={selectedRowBrollContext}
      selectedRowOverlay={selectedRowOverlay}
      selectedRowOverlayActions={selectedRowOverlayActions}
      rowImagesByIndex={rowImagesByIndex}
      editorWriters={editorWriters}
      onSelectRow={onSelectRow}
      subMode={subMode}
      onToggleSubMode={onToggleSubMode}
    >
      {children}
    </StudioMode>
  );
};
