'use client';

import React from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { StudioTopBar } from './StudioTopBar';
import { StudioLegend } from './StudioLegend';

/**
 * Studio Mode — the post-generation Workspace surface.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * target layout (top bar, left rail, preview-hero center, scene strip,
 * contextual right inspector, pinned render dock). Built on top of the
 * existing Phase-3 `EditorView` shell — see §7.1 of the plan.
 *
 * Phase R2 PR1 added `StudioTopBar`. Phase R2 PR2 (this PR) adds the
 * `StudioLegend` — a horizontal scene-type breakdown — below the top
 * bar. The left-rail Filters and Jump-to nav land in R3 when the
 * inspector replaces the right side of the grid (the layout change
 * fits naturally with that work).
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
      <StudioLegend doc={doc} />
      {children}
    </>
  );
};
