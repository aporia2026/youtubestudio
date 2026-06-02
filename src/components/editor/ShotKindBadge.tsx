'use client';

/**
 * Tiny corner badge that surfaces a shot's kind at a glance, so the
 * timeline strip + shots list both communicate "this is a title card",
 * "this is a motion collage", "this is a blank slot", etc. without the
 * user having to open the inspector and read `Shot type`.
 *
 * User report (2026-06-02): "I want on each shot preview to have an
 * indication if it's title card, animation, motion collage, whatever
 * it is".
 *
 * Resolution precedence lives in `rowKind()` in `src/lib/shot-filter.ts`
 * (single source of truth — the SHOTS-rail filter and this badge share
 * one resolver so the filter chip and the on-thumb badge can never
 * drift). This file is the visual layer + label/color mapping only.
 *
 * Layout: absolute-positioned top-left by default. The caller wraps
 * a thumbnail in a relative container; the badge overlays without
 * affecting the thumb's own sizing.
 */

import { rowKind, type ShotKind } from '@/lib/shot-filter';

export type ShotKindLabel = 'TITLE' | 'COLLAGE' | 'MOTION' | 'STAT' | 'B-ROLL' | 'BLANK' | 'ANIM';

const KIND_TO_LABEL: Record<ShotKind, ShotKindLabel> = {
  title: 'TITLE',
  collage: 'COLLAGE',
  motion: 'MOTION',
  stat: 'STAT',
  broll: 'B-ROLL',
  blank: 'BLANK',
  anim: 'ANIM',
};

interface ShotKindBadgeProps {
  /** Renderer-routing hint — same field VideoShot / ProductionRow carry.
   *  When set to 'motion_collage' / 'motion' those win over visualType
   *  regardless of what visualType says. */
  shotKind?: string;
  /** Editorial type from the row — Title Card / Statistics / B-Roll /
   *  Animation / blank. Used when shotKind doesn't determine the kind. */
  visualType?: string;
  /** When true, the badge is absolute-positioned in the top-left corner
   *  of its containing block. When false, the badge is inline and
   *  inherits its parent's flow. Default true (the common case). */
  pinTopLeft?: boolean;
  /** Override the visual size — tiny on the left-rail (default), a hair
   *  larger on the timeline cards. */
  scale?: 'xs' | 'sm';
}

/** Per-kind color treatment. Picked to be visually distinct without
 *  clashing with the existing variant / base / title chips ShotsTab
 *  already mounts on the rail. */
const KIND_COLORS: Record<ShotKindLabel, { background: string; color: string }> = {
  TITLE:    { background: 'rgba(59, 130, 246, 0.85)',  color: '#fff' },  // blue
  COLLAGE:  { background: 'rgba(168, 85, 247, 0.85)',  color: '#fff' },  // purple
  MOTION:   { background: 'rgba(236, 72, 153, 0.85)',  color: '#fff' },  // pink
  STAT:     { background: 'rgba(245, 158, 11, 0.85)',  color: '#fff' },  // amber
  'B-ROLL': { background: 'rgba(20, 184, 166, 0.85)',  color: '#fff' },  // teal
  BLANK:    { background: 'rgba(115, 115, 115, 0.85)', color: '#fff' },  // gray
  ANIM:     { background: 'rgba(34, 197, 94, 0.80)',   color: '#fff' },  // green
};

export function resolveShotKindLabel(args: {
  shotKind?: string;
  visualType?: string;
}): ShotKindLabel {
  // Delegates to `rowKind` so the filter chip and this badge agree on
  // every row's kind. If you need to change the precedence, change
  // `rowKind` in `src/lib/shot-filter.ts` and the filter follows.
  return KIND_TO_LABEL[rowKind({ shot_kind: args.shotKind, visual_type: args.visualType })];
}

export function ShotKindBadge({
  shotKind,
  visualType,
  pinTopLeft = true,
  scale = 'xs',
}: ShotKindBadgeProps): React.ReactElement {
  const label = resolveShotKindLabel({ shotKind, visualType });
  const colors = KIND_COLORS[label];
  const fontSize = scale === 'sm' ? 9 : 8;
  const padding = scale === 'sm' ? '1px 4px' : '1px 3px';

  const positionStyle: React.CSSProperties = pinTopLeft
    ? {
        position: 'absolute',
        top: 2,
        left: 2,
        zIndex: 1,
        pointerEvents: 'none',
      }
    : {
        display: 'inline-block',
      };

  return (
    <span
      title={`Shot kind: ${label}`}
      aria-label={`Shot kind: ${label}`}
      style={{
        ...positionStyle,
        padding,
        fontSize,
        fontWeight: 700,
        lineHeight: 1.1,
        letterSpacing: 0.2,
        borderRadius: 2,
        background: colors.background,
        color: colors.color,
        fontFamily: 'ui-monospace, monospace',
        // Slight outline so the badge stays legible against any thumb.
        boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
      }}
    >
      {label}
    </span>
  );
}
