/**
 * Pure helpers for the Doodle/Paint short caption renderer.
 *
 * The renderer used to hardcode the yellow-on-black-outline-uppercase
 * look at `top: 55%`, ignoring every user-supplied control in the
 * captions panel. This module is what makes the controls take effect —
 * each field falls back to the original Doodle visual contract when
 * the user has not overridden it, so the default look is unchanged but
 * every override flows through.
 *
 * Kept pure (no React, no Remotion APIs) so the resolver is unit-testable.
 * See `_plans/2026-06-04-shorts-captions-position-and-assets-context.md`.
 */

import type { ShortsCaptionsStyle } from '@/lib/shorts-render-types';

/** Doodle defaults — the original hardcoded look from
 *  `DoodleCaptionChunk`. Every field here is the value the renderer
 *  used pre-2026-06-04 and is what we surface when the user has not
 *  set a value for that field. */
export const DOODLE_CAPTION_DEFAULTS = Object.freeze({
  fontFamily: undefined as ShortsCaptionsStyle['fontFamily'],
  fontWeight: 900,
  color: '#facc15', // doodle yellow
  highlightColor: '#facc15', // doodle keeps the highlight color matching the body
  outlineColor: '#0f172a',
  outlineWidth: 6,
  shadow: 'none',
  textTransform: 'uppercase' as const,
  letterSpacing: -0.5,
  lineHeight: 1.05,
  sizeScale: 1,
  positionY: 0.55,
  paddingX: 64,
  entryEffect: 'fade' as const,
  background: 'none' as const,
  backgroundColor: 'rgba(0,0,0,0.6)',
});

export interface ResolvedDoodleCaptionStyle {
  fontFamily: string | undefined;
  fontWeight: number;
  color: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: string;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  letterSpacing: number;
  lineHeight: number;
  sizeScale: number;
  positionY: number;
  paddingX: number;
  entryEffect: 'none' | 'fade' | 'pop' | 'slide-up';
  background: 'none' | 'solid' | 'blur';
  backgroundColor: string;
}

/** Merge a user's caption style on top of the Doodle defaults. Numeric
 *  fields are clamped so a hostile override (positionY = -5) can't
 *  break the renderer. */
export function resolveDoodleCaptionStyle(
  cfg: ShortsCaptionsStyle | undefined,
): ResolvedDoodleCaptionStyle {
  const d = DOODLE_CAPTION_DEFAULTS;
  return {
    fontFamily: cfg?.fontFamily ?? d.fontFamily,
    fontWeight: typeof cfg?.fontWeight === 'number' ? cfg.fontWeight : d.fontWeight,
    color: cfg?.color ?? d.color,
    highlightColor: cfg?.highlightColor ?? d.highlightColor,
    outlineColor: cfg?.outlineColor ?? d.outlineColor,
    outlineWidth: typeof cfg?.outlineWidth === 'number' ? Math.max(0, cfg.outlineWidth) : d.outlineWidth,
    shadow: cfg?.shadow ?? d.shadow,
    textTransform: cfg?.textTransform ?? d.textTransform,
    letterSpacing: typeof cfg?.letterSpacing === 'number' ? cfg.letterSpacing : d.letterSpacing,
    lineHeight: typeof cfg?.lineHeight === 'number' ? cfg.lineHeight : d.lineHeight,
    sizeScale: typeof cfg?.sizeScale === 'number' ? Math.max(0.1, cfg.sizeScale) : d.sizeScale,
    positionY:
      typeof cfg?.positionY === 'number'
        ? Math.max(0, Math.min(1, cfg.positionY))
        : d.positionY,
    paddingX: typeof cfg?.paddingX === 'number' ? Math.max(0, cfg.paddingX) : d.paddingX,
    entryEffect: cfg?.entryEffect ?? d.entryEffect,
    background: cfg?.background ?? d.background,
    backgroundColor: cfg?.backgroundColor ?? d.backgroundColor,
  };
}

/** Compute the entry-effect transform contribution. Mirrors the
 *  minimal renderer's effect math so a chunk fades/pops/slides
 *  consistently across styles. `sinceStart` is ms since the chunk
 *  appeared. */
export function entryEffectTransform(
  effect: ResolvedDoodleCaptionStyle['entryEffect'],
  sinceStart: number,
): { opacityMul: number; scale: number; translateY: number } {
  if (effect === 'pop') {
    const t = Math.max(0, Math.min(1, sinceStart / 140));
    return { opacityMul: 1, scale: 0.6 + 0.4 * t, translateY: 0 };
  }
  if (effect === 'slide-up') {
    const t = Math.max(0, Math.min(1, sinceStart / 160));
    return { opacityMul: 1, scale: 1, translateY: (1 - t) * 40 };
  }
  if (effect === 'none') {
    return { opacityMul: 1, scale: 1, translateY: 0 };
  }
  // 'fade' (default): the chunk's own 80ms fade-in is doing the work,
  // so we just pass opacity through.
  return { opacityMul: 1, scale: 1, translateY: 0 };
}
