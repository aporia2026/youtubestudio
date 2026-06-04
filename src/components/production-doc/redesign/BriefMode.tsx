'use client';

import React from 'react';
import { BriefHeader } from './BriefHeader';

/**
 * Brief Mode — the pre-generation Notebook surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.1 for the
 * target layout (four numbered steps top-to-bottom: Brief, Style,
 * Script, Generate; sticky-bottom CTA; generation log expands above
 * the button).
 *
 * Phase R1 (first PR): the new `BriefHeader` is mounted above the
 * legacy input panel (passed in via `children`). The legacy header
 * is hidden in `page.tsx` when the flag is on, so the user sees the
 * new title bar instead. The four-step Notebook restructuring of the
 * inputs themselves is the work of R1b/c.
 */
export interface BriefModeProps {
  children: React.ReactNode;
  onNewSession?: () => void;
}

export const BriefMode: React.FC<BriefModeProps> = ({ children, onNewSession }) => {
  return (
    <>
      <BriefHeader onNewSession={onNewSession} />
      {children}
    </>
  );
};
