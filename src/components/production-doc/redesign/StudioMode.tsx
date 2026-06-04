'use client';

import React from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { StudioTopBar } from './StudioTopBar';

/**
 * Studio Mode — the post-generation Workspace surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * target layout (top bar, left rail, preview-hero center, scene strip,
 * contextual right inspector, pinned render dock). Built on top of the
 * existing Phase-3 `EditorView` shell — see §7.1 of the plan.
 *
 * Phase R2 first PR: the `StudioTopBar` is mounted above the legacy
 * grid (passed in via `children`). The left rail, preview-hero
 * restructure, scene-card strip, and render dock are subsequent R2
 * PRs.
 */
export interface StudioModeProps {
  /** Studio Mode renders only when the user has a generated doc, so
   *  the doc is guaranteed non-null at this layer. */
  doc: ProductionDoc;
  children: React.ReactNode;
  onNewSession?: () => void;
}

export const StudioMode: React.FC<StudioModeProps> = ({
  doc,
  children,
  onNewSession,
}) => {
  return (
    <>
      <StudioTopBar doc={doc} onNewSession={onNewSession} />
      {children}
    </>
  );
};
