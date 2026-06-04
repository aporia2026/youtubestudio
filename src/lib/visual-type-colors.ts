/**
 * Color tokens for the eight visual-type pills (Title Card, B-Roll,
 * Talking Head, Screen Recording, Animation, Lower Third, Statistics,
 * Cutaway). Shared between the legacy production-doc grid and the
 * redesign's `StudioLegend` so the two surfaces never drift in color.
 *
 * Extracted in Phase R2 PR2 of
 * `_plans/2026-06-04-production-doc-redesign.md`.
 */

export interface VisualTypeColor {
  /** Background fill for the pill (low-alpha tint). */
  bg: string;
  /** Foreground text + dot color. */
  color: string;
}

export const VISUAL_TYPE_COLORS: Record<string, VisualTypeColor> = {
  'Title Card':       { bg: 'rgba(124,58,237,0.15)', color: '#a78bfa' },
  'B-Roll':           { bg: 'rgba(6,182,212,0.12)',  color: '#22d3ee' },
  'Talking Head':     { bg: 'rgba(16,185,129,0.12)', color: '#34d399' },
  'Screen Recording': { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
  'Animation':        { bg: 'rgba(236,72,153,0.12)', color: '#f472b6' },
  'Lower Third':      { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
  'Statistics':       { bg: 'rgba(239,68,68,0.12)',  color: '#f87171' },
  'Cutaway':          { bg: 'rgba(107,114,128,0.12)', color: '#9ca3af' },
};

/** Fallback color used for unknown / custom visual types — keeps the
 *  pill rendered (just neutral-toned) instead of erroring or hiding. */
export const VISUAL_TYPE_COLOR_FALLBACK: VisualTypeColor = {
  bg: 'rgba(255,255,255,0.06)',
  color: 'var(--text-muted)',
};

export function getVisualTypeColor(type: string): VisualTypeColor {
  return VISUAL_TYPE_COLORS[type] ?? VISUAL_TYPE_COLOR_FALLBACK;
}
