'use client';

import React from 'react';
import type { ProductionRow } from '@/remotion/utils';
import { InspectorTabBar, type InspectorTabId } from './InspectorTabBar';
import { StudioInspectorContent } from './StudioInspectorContent';

/**
 * StudioInspector — the right column of `StudioLayout`. Hosts the
 * `InspectorTabBar` plus the tab content for the currently selected
 * row.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 / §3.4 for
 * the target. Phase progression:
 *
 *   R3 PR1 — InspectorTabBar built (not mounted)
 *   R3 PR2 — Inspector chrome + empty-state prompt
 *   R3 PR3 — THIS PR: Content tab body (read-only)
 *   R3 PR4 — Image / Video / Variants tab bodies
 *   R3 PR5 — Overlay / Section tab bodies
 *
 * The empty state when no row is selected is informative, not
 * decorative — it tells the user what the inspector is for and why
 * it's currently empty.
 */
export interface StudioInspectorProps {
  /** Currently-selected row, or `null` when no row is selected.
   *  The inspector renders the Content tab body for `selectedRow`. */
  selectedRow?: ProductionRow | null;
  /** Display index of the selected row (1-based to match the grid `#`
   *  column). Only used in the header — content rendering uses
   *  `selectedRow` directly. */
  selectedRowIndex?: number | null;
  /** Display label for the selected row (typically its timecode).
   *  Only used in the header. */
  selectedRowLabel?: string;
  /** Currently-active tab. Defaults to `'content'`. R3 PR3b will
   *  hoist this into local state once `onSelect` is wired. */
  currentTab?: InspectorTabId;
}

export const StudioInspector: React.FC<StudioInspectorProps> = ({
  selectedRow = null,
  selectedRowIndex = null,
  selectedRowLabel,
  currentTab = 'content',
}) => {
  const hasSelection = selectedRow !== null && selectedRowIndex !== null;

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
        <InspectorTabBar current={currentTab} />
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
        ) : currentTab === 'content' ? (
          <StudioInspectorContent row={selectedRow} />
        ) : (
          <p
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Tab editing lands in R3 PR4+. See plan §3.4 for the per-tab inventory.
          </p>
        )}
      </div>
    </section>
  );
};
