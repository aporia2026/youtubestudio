'use client';

import React from 'react';
import { BriefHeader } from './BriefHeader';
import { BriefSteps } from './BriefSteps';

/**
 * Brief Mode — the pre-generation Notebook surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.1 for the
 * target layout (four numbered steps top-to-bottom: Brief, Style,
 * Script, Generate; sticky-bottom CTA; generation log expands above
 * the button).
 *
 * Phase R1a shipped `BriefHeader`. Phase R1b (this PR) adds
 * `BriefSteps` — the four-step progress chrome — below the header.
 * The legacy input panel still renders untouched as `children`.
 * R1c will migrate the input chunks into BriefStepCard wrappers
 * anchored to each step.
 */
export interface BriefModeProps {
  children: React.ReactNode;
  onNewSession?: () => void;
}

export const BriefMode: React.FC<BriefModeProps> = ({ children, onNewSession }) => {
  return (
    <>
      <BriefHeader onNewSession={onNewSession} />
      <BriefSteps current={1} />
      {children}
    </>
  );
};
