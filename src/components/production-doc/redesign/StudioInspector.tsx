'use client';

import React, { useEffect, useState } from 'react';
import type { ProductionRow } from '@/remotion/utils';
import type { RowImageStateView } from '@/components/production-doc/editor/types';
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
        className="px-3 py-2 flex items-baseline justify-between gap-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <h2
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          Inspector
        </h2>
        {hasSelection && selectedRowLabel && (
          <span
            className="text-xs truncate"
            style={{ color: 'var(--text-secondary)' }}
            title={selectedRowLabel}
          >
            Row {selectedRowIndex} · {selectedRowLabel}
          </span>
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
          />
        ) : currentTab === 'image' ? (
          <StudioInspectorImage
            state={selectedRowImageState}
            {...(selectedRowImageActions ?? {})}
          />
        ) : currentTab === 'video' ? (
          <StudioInspectorVideo clip={selectedRowVideoClip} />
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
