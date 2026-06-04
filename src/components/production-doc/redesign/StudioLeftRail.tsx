'use client';

import React from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { StudioLegend } from './StudioLegend';

/**
 * StudioLeftRail — the left column of `StudioLayout`. Holds the
 * vertical Legend and (in later R3 PRs) the Jump-to nav and Filters
 * controls.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * target. Phase R3 PR2 ships only the Legend section — Jump-to and
 * Filters arrive in subsequent R3 PRs once filter state is plumbed
 * through the shell (Filters need real callbacks; Jump-to needs
 * anchored scroll targets).
 */
export interface StudioLeftRailProps {
  doc: ProductionDoc;
}

export const StudioLeftRail: React.FC<StudioLeftRailProps> = ({ doc }) => {
  return (
    <div className="space-y-6">
      <section aria-labelledby="left-rail-legend-heading">
        <h2
          id="left-rail-legend-heading"
          className="text-[10px] uppercase tracking-wider font-semibold mb-2"
          style={{ color: 'var(--text-muted)' }}
        >
          Legend
        </h2>
        <StudioLegend doc={doc} orientation="vertical" />
      </section>
    </div>
  );
};
