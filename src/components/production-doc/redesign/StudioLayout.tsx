'use client';

import React from 'react';

/**
 * StudioLayout — the three-column grid that frames Studio Mode:
 * left rail · center main · right inspector.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 and §7.2's
 * R3 PR2 entry. Column widths come straight from §10 (left 200px,
 * inspector 380px, center fills the remainder). The center column
 * carries today's legacy grid render as `mainContent`; banners and
 * the future render dock continue to flow above/below the layout
 * (R3 PR3+ may grow a `mainContent` slot on the shell to separate
 * them properly — for now they share `mainContent`).
 *
 * No own visual chrome — the columns provide structure only. The
 * caller is responsible for putting LeftRail / Inspector / main
 * content into the slots.
 */
export interface StudioLayoutProps {
  leftRail: React.ReactNode;
  mainContent: React.ReactNode;
  inspector: React.ReactNode;
}

export const StudioLayout: React.FC<StudioLayoutProps> = ({
  leftRail,
  mainContent,
  inspector,
}) => {
  return (
    <div
      className="grid gap-6"
      style={{
        gridTemplateColumns: '200px minmax(0, 1fr) 380px',
        alignItems: 'start',
      }}
    >
      <aside
        aria-label="Studio left rail"
        className="min-w-0"
        style={{ position: 'sticky', top: 16, alignSelf: 'start' }}
      >
        {leftRail}
      </aside>
      <main
        aria-label="Studio main content"
        className="min-w-0"
      >
        {mainContent}
      </main>
      <aside
        aria-label="Studio inspector"
        className="min-w-0"
        style={{ position: 'sticky', top: 16, alignSelf: 'start' }}
      >
        {inspector}
      </aside>
    </div>
  );
};
