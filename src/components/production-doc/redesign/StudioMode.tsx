'use client';

import React from 'react';

/**
 * Studio Mode — the post-generation Workspace surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * target layout (top bar, left rail, preview-hero center, scene strip,
 * contextual right inspector, pinned render dock). Built on top of the
 * existing Phase-3 `EditorView` shell — see §7.1 of the plan.
 *
 * Phase R0: this component is a transparent pass-through of today's
 * page render. Phases R2–R5 will progressively replace the children
 * with the new Studio surfaces (R2 shell/chrome, R3 inspector tabs,
 * R4 scene-card strip, R5 render dock + transition polish).
 */
export interface StudioModeProps {
  children: React.ReactNode;
}

export const StudioMode: React.FC<StudioModeProps> = ({ children }) => {
  return <>{children}</>;
};
