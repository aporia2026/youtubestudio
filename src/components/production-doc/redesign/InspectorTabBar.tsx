'use client';

import React from 'react';

/**
 * InspectorTabBar — the six-tab header for the contextual right
 * inspector in Studio Mode.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §3.4 / §4.2 for
 * the target. The inspector consolidates today's 13-column grid into
 * six tabs scoped to the currently selected row:
 *
 *   Content   — script_text, ai_prompt, on_screen_text, visual_type
 *   Image     — generate / upload / import / edit / undo + variants
 *   Video     — model picker, generate, undo
 *   Overlay   — position editor, edit, rethink, replace, undo, reset
 *   Section   — zoom-to, title, layout, pillarbox, transition, stripe,
 *               scene zoom, region padding, scene fade
 *   Variants  — list of variants with previews + add / regen / delete
 *
 * Phase R3 PR1 (this PR): ships the tab-bar chrome alone — no tab
 * contents yet, no mounting in Studio Mode. R3 PR2 lands the
 * three-column Studio layout that makes the inspector reachable; R3
 * PR3+ fills in each tab's contents using the existing components
 * (ImageCell, BrollCell, OverlayCell, SectionThumbnailCard, etc.).
 *
 * Per rule 10, tabs are NOT clickable in this PR — clicking would
 * change a state that has nothing behind it. The bar renders as a
 * keyboard- and screen-reader-accessible tablist that R3 PR2 wires
 * to a real `onChange` handler.
 */
export type InspectorTabId =
  | 'content'
  | 'image'
  | 'video'
  | 'overlay'
  | 'section'
  | 'variants';

export interface InspectorTabSpec {
  id: InspectorTabId;
  label: string;
}

export const INSPECTOR_TABS: ReadonlyArray<InspectorTabSpec> = [
  { id: 'content', label: 'Content' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'section', label: 'Section' },
  { id: 'variants', label: 'Variants' },
];

export interface InspectorTabBarProps {
  current: InspectorTabId;
  /** Optional click handler. Phase R3 PR1 omits this; R3 PR2 wires it
   *  when the inspector is mounted with real tab contents. */
  onSelect?: (tab: InspectorTabId) => void;
}

export const InspectorTabBar: React.FC<InspectorTabBarProps> = ({
  current,
  onSelect,
}) => {
  return (
    <div
      role="tablist"
      aria-label="Row inspector tabs"
      className="flex items-stretch gap-1 border-b"
      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
    >
      {INSPECTOR_TABS.map((tab) => {
        const isCurrent = tab.id === current;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isCurrent}
            aria-controls={`inspector-panel-${tab.id}`}
            id={`inspector-tab-${tab.id}`}
            tabIndex={isCurrent ? 0 : -1}
            disabled={!onSelect}
            onClick={onSelect ? () => onSelect(tab.id) : undefined}
            className="text-xs px-3 py-2 -mb-px whitespace-nowrap transition-colors"
            style={{
              color: isCurrent
                ? 'var(--text-primary)'
                : 'var(--text-muted)',
              borderBottom: isCurrent
                ? '2px solid var(--accent-purple-bright, #a78bfa)'
                : '2px solid transparent',
              fontWeight: isCurrent ? 600 : 400,
              background: 'transparent',
              cursor: onSelect ? 'pointer' : 'default',
              opacity: onSelect ? 1 : 0.85,
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};
