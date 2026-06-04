'use client';

import React, { useEffect, useRef } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { BriefMode } from './BriefMode';
import { StudioMode } from './StudioMode';

/**
 * Production-doc redesign V1 — the shell that switches between Brief
 * Mode (pre-generation Notebook) and Studio Mode (post-generation
 * Workspace). See `_plans/2026-06-04-production-doc-redesign.md`.
 *
 * Phase R0 (this PR): the shell is a transparent wrapper around the
 * existing page content. Flipping the `PROD_DOC_REDESIGN_V1_PUBLIC`
 * flag does not change anything visible yet. R1 starts filling in
 * Brief Mode; R2–R5 build out Studio Mode.
 */
export interface ProductionDocShellProps {
  /** Current production-doc, or null if the user has not generated one yet. */
  doc: ProductionDoc | null;
  /** Today's page render. Phase R0 passes this through unchanged. */
  children: React.ReactNode;
}

export type ProductionDocShellMode = 'brief' | 'studio';

/**
 * Pure helper extracted from the shell so unit tests can verify
 * mode-routing without rendering. Tested in
 * `tests/prodoc-redesign-shell.test.tsx`.
 */
export function selectShellMode(doc: ProductionDoc | null): ProductionDocShellMode {
  return doc ? 'studio' : 'brief';
}

export const ProductionDocShell: React.FC<ProductionDocShellProps> = ({
  doc,
  children,
}) => {
  const mode: ProductionDocShellMode = selectShellMode(doc);
  // Track the prior mode so the mode-switch log fires only on actual
  // transitions, not on the initial mount (the mount log covers that).
  const priorMode = useRef<ProductionDocShellMode | null>(null);

  useEffect(() => {
    console.info('[prodoc shell] mount', { mode, hasDoc: !!doc });
    // mount-only — intentionally omit deps so this fires once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (priorMode.current !== null && priorMode.current !== mode) {
      console.info('[prodoc shell] mode-switch', {
        from: priorMode.current,
        to: mode,
        hasDoc: !!doc,
      });
    }
    priorMode.current = mode;
  }, [mode, doc]);

  return mode === 'brief' ? (
    <BriefMode>{children}</BriefMode>
  ) : (
    <StudioMode>{children}</StudioMode>
  );
};
