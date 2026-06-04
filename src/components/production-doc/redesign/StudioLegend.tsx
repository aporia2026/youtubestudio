'use client';

import React, { useMemo } from 'react';
import type { ProductionDoc } from '@/remotion/utils';
import { getVisualTypeColor } from '@/lib/visual-type-colors';

/**
 * StudioLegend — a horizontal scene-type breakdown rendered under the
 * Studio top bar.
 *
 * See `_plans/2026-06-04-production-doc-redesign.md` §4.2 for the
 * left-rail target. The Legend sits in that rail in the final design
 * alongside Filters and Jump-to nav, but R2 PR2 ships it as a
 * non-layout-breaking horizontal strip — the left-rail sidebar arrives
 * with R3 when the inspector replaces the right side of the grid.
 *
 * The Legend counts visual types from `doc.rows` and renders one pill
 * per type that actually appears. The §4.2 mock improves on today's
 * legacy legend (which only shows labels) by including counts so the
 * user can scan their scene mix at a glance.
 *
 * Read-only by design — no clicks, no state. Per rule 10 we don't
 * ship interactive controls until they actually do something. Filter
 * chips with shared filter state land in R3.
 */
export interface StudioLegendProps {
  doc: ProductionDoc;
}

interface TypeTally {
  type: string;
  count: number;
}

function tallyVisualTypes(doc: ProductionDoc): TypeTally[] {
  const counts = new Map<string, number>();
  for (const row of doc.rows ?? []) {
    const type = row.visual_type?.trim();
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function countOverlays(doc: ProductionDoc): number {
  let n = 0;
  for (const row of doc.rows ?? []) {
    if (row.overlay_stock_terms?.trim()) n += 1;
  }
  return n;
}

export const StudioLegend: React.FC<StudioLegendProps> = ({ doc }) => {
  const tallies = useMemo(() => tallyVisualTypes(doc), [doc]);
  const overlayCount = useMemo(() => countOverlays(doc), [doc]);

  if (tallies.length === 0 && overlayCount === 0) return null;

  return (
    <section
      aria-label="Scene type breakdown"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      {tallies.map(({ type, count }) => {
        const { bg, color } = getVisualTypeColor(type);
        return (
          <span
            key={type}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
            style={{ background: bg, color }}
            title={`${count} ${type.toLowerCase()} ${count === 1 ? 'row' : 'rows'}`}
          >
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: color }}
            />
            <span>{type}</span>
            <span className="font-semibold" style={{ opacity: 0.85 }}>
              {count}
            </span>
          </span>
        );
      })}
      {overlayCount > 0 && (
        <span
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
          style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
          title={`${overlayCount} ${overlayCount === 1 ? 'row' : 'rows'} flagged for editor-composited real-image overlays`}
        >
          <span aria-hidden="true">✦</span>
          <span>Overlays</span>
          <span className="font-semibold" style={{ opacity: 0.85 }}>
            {overlayCount}
          </span>
        </span>
      )}
    </section>
  );
};
