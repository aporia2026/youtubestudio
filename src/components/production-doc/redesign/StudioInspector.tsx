'use client';

import React, { useEffect, useState } from 'react';
import type { ProductionDoc, ProductionRow } from '@/remotion/utils';
import type {
  EditorWriters,
  RowImageStateView,
} from '@/components/production-doc/editor/types';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import { InspectorTabBar, type InspectorTabId } from './InspectorTabBar';
import { StudioInspectorContent } from './StudioInspectorContent';
import {
  StudioInspectorImage,
  type StudioInspectorImageActions,
} from './StudioInspectorImage';
import {
  StudioInspectorVideo,
  type StudioInspectorVideoClipSlice,
} from './StudioInspectorVideo';
import {
  BrollCell,
  type BrollCellProps,
} from '@/components/production-doc/BrollCell';
import {
  StudioInspectorOverlay,
  type StudioInspectorOverlayActions,
} from './StudioInspectorOverlay';
import { StudioInspectorSection } from './StudioInspectorSection';
import { VariantPanel } from '@/components/production-doc/editor/VariantPanel';

/**
 * StudioInspector — the right column of `StudioLayout`. Hosts the
 * `InspectorTabBar` plus the tab content for the currently selected
 * row.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 / §3.4.
 * Phase progression:
 *
 *   R3 PR1  — InspectorTabBar built (not mounted)
 *   R3 PR2  — Inspector chrome + empty-state prompt
 *   R3 PR3  — Content tab body (read-only)
 *   R3 PR3b — THIS PR: Content tab body editable + tab clicks work
 *   R3 PR4  — Image / Video / Variants tab bodies
 *   R3 PR5  — Overlay / Section tab bodies
 *
 * The active tab lives in local state so tab clicks work without
 * any caller wiring. When `initialTab` changes (e.g. a future caller
 * wants to deep-link to the Image tab), the local state resets to it.
 */
export interface StudioInspectorProps {
  /** Currently-selected row data, or `null` for no selection. */
  selectedRow?: ProductionRow | null;
  /** 0-based row index for `onUpdateRow` calls. Display index is
   *  derived by adding 1 (matches the grid `#` column). */
  selectedRowIndex?: number | null;
  /** Display label for the selected row (typically its timecode). */
  selectedRowLabel?: string;
  /** Initial tab. The user can switch tabs after mount. Default
   *  `'content'`. */
  initialTab?: InspectorTabId;
  /** Optional writer for the Content tab. Same signature as today's
   *  `updateRow(rowIndex, patch)` in page.tsx. */
  onUpdateRow?: (rowIndex: number, patch: Partial<ProductionRow>) => void;
  /** Image state for the selected row. Drives the Image tab's
   *  read-only preview. R3 PR4. */
  selectedRowImageState?: RowImageStateView | null;
  /** Image writers for the selected row — Generate / Upload /
   *  Import URL / Edit / Retry. R3 PR4b. */
  selectedRowImageActions?: StudioInspectorImageActions;
  /** B-roll clip for the selected row. R3 PR4c (read-only). */
  selectedRowVideoClip?: StudioInspectorVideoClipSlice | null;
  /** Full BrollCell props bundle for the selected row. When provided
   *  the Video tab mounts the existing `BrollCell` — Generate /
   *  Re-generate buttons + model picker + polling + lock-as-still
   *  all included. When omitted the tab falls back to the read-only
   *  `StudioInspectorVideo` view. R3 Video-editable. */
  selectedRowBrollContext?: BrollCellProps | null;
  /** Overlay state for the selected row. R3 PR5 (read-only). */
  selectedRowOverlay?: RowOverlayState | null;
  /** Overlay action callbacks — Rethink / Edit / Reset / Remove.
   *  R3 Overlay-editable. */
  selectedRowOverlayActions?: StudioInspectorOverlayActions;
  /** Doc-level defaults used by the Section tab to display effective
   *  values (row override → doc default → built-in default). Also
   *  required for the Variants tab so the panel can walk the row's
   *  variant group. */
  doc?: ProductionDoc | null;
  /** Image state per row, indexed by 0-based row index. Used by the
   *  Variants tab to render the mini-strip thumbnails. R3 PR4d. */
  rowImagesByIndex?: ReadonlyArray<RowImageStateView | undefined>;
  /** Full writer bundle for the inspector to drive variant
   *  management, section bulk apply / clear, and (in later PRs) the
   *  overlay and B-roll editing flows. Same shape EditorView already
   *  uses — page.tsx exposes a single useMemo'd bundle that we share. */
  editorWriters?: EditorWriters;
  /** Header-level row navigation (prev / next via ◂ ▸ buttons).
   *  Page.tsx wires this to `setExpandedRow` keyed off the selected
   *  row's absolute index. */
  onNavigateRow?: (direction: 'prev' | 'next') => void;
  /** Total row count — used to disable Next when at the last row.
   *  Inspector derives prev-disabled from `selectedRowIndex <= 1`. */
  totalRows?: number;
  /** Delete-row callback. Wired to page.tsx's `deleteRowAtIndex`
   *  which uses `deleteRowFromProductionDocState` to atomically
   *  shift every row-indexed state slice. */
  onDeleteRow?: (rowIndex: number) => void;
  /** Active style preset slug — drives doodle_explainer_2-only
   *  affordances like the SlugChip character / scene tagging row. */
  stylePreset?: string;
  /** Character-id tally for the SlugChip dropdown. */
  characterSlugs?: ReadonlyArray<{ slug: string; count: number }>;
  /** Scene-id tally for the SlugChip dropdown. */
  sceneSlugs?: ReadonlyArray<{ slug: string; count: number }>;
  /** Character slugs that appear in row descriptions but aren't
   *  formally tagged — surface as suggestions. */
  untaggedDescriptionSlugs?: ReadonlyArray<string>;
  /** Auto-fill in-flight flag for motion_collage panels. */
  isMotionCollageAutoFilling?: boolean;
  /** Pipeline error info for the selected row when the auto-pipeline
   *  gave up. Drives the error chip + Rethink button in the Image
   *  tab. */
  pipelineError?: { class: string; message: string; at: string } | null;
  pipelineErrorExhausted?: boolean;
  onPipelineErrorRetry?: () => void;
}

export const StudioInspector: React.FC<StudioInspectorProps> = ({
  selectedRow = null,
  selectedRowIndex = null,
  selectedRowLabel,
  initialTab = 'content',
  onUpdateRow,
  selectedRowImageState = null,
  selectedRowImageActions,
  selectedRowVideoClip = null,
  selectedRowBrollContext = null,
  selectedRowOverlay = null,
  selectedRowOverlayActions,
  doc = null,
  rowImagesByIndex,
  editorWriters,
  onNavigateRow,
  totalRows = 0,
  onDeleteRow,
  stylePreset,
  characterSlugs,
  sceneSlugs,
  untaggedDescriptionSlugs,
  isMotionCollageAutoFilling = false,
  pipelineError = null,
  pipelineErrorExhausted = false,
  onPipelineErrorRetry,
}) => {
  const [currentTab, setCurrentTab] = useState<InspectorTabId>(initialTab);

  // If a future caller deep-links to a specific tab, honor the new
  // initial value. (No-op for today's wiring which always passes
  // 'content'.)
  useEffect(() => {
    setCurrentTab(initialTab);
  }, [initialTab]);

  const hasSelection = selectedRow !== null && selectedRowIndex !== null;
  // `selectedRowIndex` flows in as the 1-based display index; the
  // 0-based row index that writers need is one less.
  const writerRowIndex = hasSelection && selectedRowIndex !== null
    ? selectedRowIndex - 1
    : null;

  return (
    <section
      aria-label="Row inspector"
      className="rounded-lg overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <header
        className="px-3 py-2 flex items-center justify-between gap-3 flex-wrap"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-2 shrink-0">
          <h2
            className="text-[10px] uppercase tracking-wider font-semibold"
            style={{ color: 'var(--text-muted)' }}
          >
            Inspector
          </h2>
          {hasSelection && onNavigateRow && selectedRowIndex !== null && (
            <div className="inline-flex items-center gap-0.5" role="group" aria-label="Row navigation">
              <button
                type="button"
                onClick={() => onNavigateRow('prev')}
                disabled={selectedRowIndex <= 1}
                aria-label="Previous row"
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: selectedRowIndex <= 1 ? 'not-allowed' : 'pointer',
                  opacity: selectedRowIndex <= 1 ? 0.4 : 1,
                }}
                title="Select the previous row"
              >
                ◂
              </button>
              <button
                type="button"
                onClick={() => onNavigateRow('next')}
                disabled={selectedRowIndex >= totalRows}
                aria-label="Next row"
                className="text-xs px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: selectedRowIndex >= totalRows ? 'not-allowed' : 'pointer',
                  opacity: selectedRowIndex >= totalRows ? 0.4 : 1,
                }}
                title="Select the next row"
              >
                ▸
              </button>
            </div>
          )}
        </div>
        {hasSelection && selectedRow && (
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {/* Variant chip: shows the row's place in its variant
                group ("Base · 3 vars" / "Variant 2 of 3"). Helps the
                user understand what they're editing without scrolling
                the grid. */}
            {(() => {
              const groupId = selectedRow.group_id;
              if (!groupId || !doc) return null;
              const groupRows = doc.rows.filter((r) => r.group_id === groupId);
              if (groupRows.length <= 1) return null;
              const variantIndex = selectedRow.variant_index ?? 0;
              const total = groupRows.length;
              const label = variantIndex === 0
                ? `Base · ${total - 1} variant${total - 1 === 1 ? '' : 's'}`
                : `Variant ${variantIndex} of ${total - 1}`;
              return (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(34,211,238,0.15)',
                    color: '#22d3ee',
                    border: '1px solid rgba(34,211,238,0.35)',
                  }}
                  title={`This row is part of a ${total}-row variant group. Edit the base to update all variants' source image; edit a variant's prompt to tweak its individual look.`}
                >
                  {label}
                </span>
              );
            })()}
            {selectedRowLabel && (
              <span
                className="text-xs truncate"
                style={{ color: 'var(--text-secondary)' }}
                title={selectedRowLabel}
              >
                Row {selectedRowIndex} · {selectedRowLabel}
              </span>
            )}
            {onDeleteRow && writerRowIndex !== null && (selectedRow.variant_index ?? 0) === 0 && (
              <button
                type="button"
                onClick={() => {
                  const preview = (selectedRow.script_text ?? '').trim().slice(0, 50);
                  const confirmed = window.confirm(
                    `Delete row ${selectedRowIndex}${preview ? ` (“${preview}${preview.length === 50 ? '…' : ''}”)` : ''}?\n\nThis cannot be undone.`,
                  );
                  if (!confirmed) return;
                  onDeleteRow(writerRowIndex);
                }}
                aria-label="Delete row"
                className="text-xs px-2 py-0.5 rounded shrink-0"
                style={{
                  background: 'rgba(239,68,68,0.10)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239,68,68,0.35)',
                  cursor: 'pointer',
                }}
                title="Delete this row from the doc. Cannot be undone."
              >
                🗑
              </button>
            )}
          </div>
        )}
      </header>
      <div className="px-3 pt-2">
        <InspectorTabBar current={currentTab} onSelect={setCurrentTab} />
      </div>
      <div
        id={`inspector-panel-${currentTab}`}
        role="tabpanel"
        aria-labelledby={`inspector-tab-${currentTab}`}
        className="px-3 py-4"
      >
        {!hasSelection ? (
          <p
            className="text-xs leading-relaxed"
            style={{ color: 'var(--text-muted)' }}
          >
            Select a row to edit its content, image, video, overlay, section, or variants here.
          </p>
        ) : currentTab === 'content' && writerRowIndex !== null ? (
          <StudioInspectorContent
            rowIndex={writerRowIndex}
            row={selectedRow}
            onUpdateRow={onUpdateRow}
            docOstModeDefault={doc?.on_screen_text_mode_default}
            stylePreset={stylePreset}
            characterSlugs={characterSlugs}
            sceneSlugs={sceneSlugs}
            untaggedDescriptionSlugs={untaggedDescriptionSlugs}
          />
        ) : currentTab === 'image' ? (
          <StudioInspectorImage
            state={selectedRowImageState}
            {...(selectedRowImageActions ?? {})}
            row={selectedRow}
            onUpdateRow={onUpdateRow && writerRowIndex !== null
              ? (patch) => onUpdateRow(writerRowIndex, patch)
              : undefined}
            isAutoFillingMotionCollage={isMotionCollageAutoFilling}
            pipelineError={pipelineError}
            pipelineErrorExhausted={pipelineErrorExhausted}
            onPipelineErrorRetry={onPipelineErrorRetry}
          />
        ) : currentTab === 'video' ? (
          selectedRowBrollContext ? (
            <BrollCell {...selectedRowBrollContext} />
          ) : (
            <StudioInspectorVideo clip={selectedRowVideoClip} />
          )
        ) : currentTab === 'overlay' ? (
          <StudioInspectorOverlay
            overlay={selectedRowOverlay}
            stockTerms={selectedRow.stock_search_terms}
            {...(selectedRowOverlayActions ?? {})}
          />
        ) : currentTab === 'section' && writerRowIndex !== null ? (
          <StudioInspectorSection
            rowIndex={writerRowIndex}
            row={selectedRow}
            doc={doc}
            onUpdateRow={onUpdateRow}
            editorWriters={editorWriters}
          />
        ) : currentTab === 'variants' && doc && writerRowIndex !== null ? (
          <VariantPanel
            doc={doc}
            activeSection={writerRowIndex}
            rowImages={rowImagesByIndex ?? []}
            writers={editorWriters}
          />
        ) : (
          <p
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Tab editing lands in later R3 PRs. See plan §3.4 for the per-tab inventory.
          </p>
        )}
      </div>
    </section>
  );
};
