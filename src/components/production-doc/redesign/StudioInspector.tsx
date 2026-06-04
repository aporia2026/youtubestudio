'use client';

import React from 'react';
import { InspectorTabBar, type InspectorTabId } from './InspectorTabBar';

/**
 * StudioInspector — the right column of `StudioLayout`. Hosts the
 * `InspectorTabBar` plus the tab content for the currently selected
 * row.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 / §3.4 for
 * the target. Phase R3 PR2 ships the chrome plus an empty-state
 * prompt — selection plumbing (which row is active) and tab content
 * (script, image, video, overlay, section, variants editors) land in
 * R3 PR3+ as each tab's existing component is mounted into the panel.
 *
 * The empty state is informative, not decorative — it tells the user
 * what the inspector is for and why it's currently empty. That keeps
 * us inside rule 10: no dead UI, just transparent state.
 */
export interface StudioInspectorProps {
  /** Currently-selected row index (1-based to match the grid `#`
   *  column). `null` means no row is selected — show the empty state. */
  selectedRowIndex?: number | null;
  /** Display label for the selected row (e.g. its timecode or visual
   *  type). Only meaningful when `selectedRowIndex` is non-null. */
  selectedRowLabel?: string;
  /** Currently-active tab. Defaults to `'content'`. R3 PR3 will hoist
   *  this into local state once `onSelect` is wired. */
  currentTab?: InspectorTabId;
}

export const StudioInspector: React.FC<StudioInspectorProps> = ({
  selectedRowIndex = null,
  selectedRowLabel,
  currentTab = 'content',
}) => {
  const hasSelection = selectedRowIndex !== null;

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
        {hasSelection ? (
          <p
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Tab editing lands in R3 PR3. See plan §3.4 for the per-tab inventory.
          </p>
        ) : (
          <p
            className="text-xs leading-relaxed"
            style={{ color: 'var(--text-muted)' }}
          >
            Select a row to edit its content, image, video, overlay, section, or variants here.
          </p>
        )}
      </div>
    </section>
  );
};
