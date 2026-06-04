'use client';

import React from 'react';

/**
 * Brief Mode header — the top chrome that introduces the page in the
 * pre-generation Notebook layout. See `_plans/2026-06-04-production-doc-redesign.md`
 * §4.1 for the target.
 *
 * Phase R1 (first PR): ships the title, subtitle, and the only
 * always-functional button — New session. The History and keyboard-
 * shortcuts buttons live in the mock but their drawers don't exist
 * yet (R2 builds them), so we keep them off the header until they
 * actually work. Better to ship a clean three-element header than a
 * pretty header full of no-op buttons that violate rule 10.
 */
export interface BriefHeaderProps {
  /** Called when the user confirms "New session". Page.tsx owns the
   *  confirmation prompt + state-reset logic; the header only fires
   *  the callback. Optional so a future caller (tests, Storybook)
   *  can render the header without the button being interactive. */
  onNewSession?: () => void;
}

export const BriefHeader: React.FC<BriefHeaderProps> = ({ onNewSession }) => {
  return (
    <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1
          className="text-3xl font-bold tracking-tight"
          style={{ color: 'var(--text-primary)' }}
        >
          Production Doc
        </h1>
        <p
          className="text-sm mt-2 max-w-prose"
          style={{ color: 'var(--text-secondary)' }}
        >
          Plan, write, and produce a video end to end.
        </p>
      </div>
      {onNewSession && (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onNewSession}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
            title="Clear the current form to start fresh. Previous generations stay in the history."
          >
            New session
          </button>
        </div>
      )}
    </header>
  );
};
