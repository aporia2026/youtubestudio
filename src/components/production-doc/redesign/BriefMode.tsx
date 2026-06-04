'use client';

import React from 'react';

/**
 * Brief Mode — the pre-generation Notebook surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.1 for the
 * target layout (four numbered steps top-to-bottom: Brief, Style,
 * Script, Generate; sticky-bottom CTA; generation log expands above
 * the button).
 *
 * Phase R0: this component is a transparent pass-through of today's
 * page render. Phase R1 will replace the children with the four-step
 * Notebook layout, reusing the existing input components catalogued
 * in §3.3 of the plan.
 */
export interface BriefModeProps {
  children: React.ReactNode;
}

export const BriefMode: React.FC<BriefModeProps> = ({ children }) => {
  return <>{children}</>;
};
