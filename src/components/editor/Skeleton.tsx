'use client';

/**
 * Loading skeleton primitives — last polish item from the real-NLE
 * Phase 7 QA matrix. Bridges the brief moment between mount and
 * "data has arrived" so the user doesn't see a flash of plain
 * empty state for asynchronously-fetched surfaces.
 *
 * Used in four spots (2026-05-20):
 *   - VoiceoverPicker popover on first open (fetching library + history)
 *   - ProjectSwitcher popover on first open (fetching production-doc rows)
 *   - AudioLane while wavesurfer decodes the MP3
 *   - Timeline tiles while the per-shot thumbnail is loading
 *
 * Pure CSS — no new dependency. Animation is a 1.4s background-position
 * sweep on a linear-gradient; respects `prefers-reduced-motion` via the
 * `editor-skeleton-static` class branch.
 *
 * Important: skeletons are visible state, not data. Keep them dumb;
 * the parent decides when to show / hide.
 */

import React from 'react';

interface SkeletonProps {
  /** Width — number = px, string passes through (`'100%'`, `'4rem'`). */
  width?: number | string;
  /** Height — same as width. */
  height?: number | string;
  /** Corner radius. Defaults to 4px which matches the editor's
   *  panel chrome. Pass `'9999px'` for a pill. */
  radius?: number | string;
  /** Optional className for extra positioning (e.g. `'absolute'`). */
  className?: string;
  /** Optional inline style merge — lets callers position absolutely
   *  inside a parent without forking the component. */
  style?: React.CSSProperties;
}

export function Skeleton({
  width = '100%',
  height = 12,
  radius = 4,
  className,
  style,
}: SkeletonProps): React.ReactElement {
  return (
    <span
      aria-hidden
      className={`editor-skeleton ${className ?? ''}`.trim()}
      style={{
        display: 'inline-block',
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

/**
 * Stacked row of skeleton lines — convenience for picker popovers
 * and list panels. Each row is one skeleton block; rows render with
 * a small gap so they read as discrete entries instead of one
 * blurred bar.
 */
export function SkeletonRows({
  count = 3,
  rowHeight = 14,
  gap = 8,
}: {
  count?: number;
  rowHeight?: number;
  gap?: number;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} height={rowHeight} />
      ))}
    </div>
  );
}
