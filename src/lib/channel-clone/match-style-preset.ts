/**
 * Match a channel-clone visual profile to a built-in production-doc
 * style preset.
 *
 * The match is intentionally simple — a keyword scan over the visual
 * profile's `artStyle` + `mood` strings. The user can always override
 * by passing an explicit `stylePresetId` to the rowify route. We
 * never auto-derive a brand-new preset on the fly for v1 — that's a
 * deferred M5 ergonomic.
 *
 * Defaults to `paint_explainer_v1` because (a) it's the most
 * sophisticated motion-driven style we ship, (b) it matches the
 * sample channel (Zenn) we built channel-clone against, and (c)
 * mismatches degrade gracefully — `paint_explainer_v1` can render
 * any narration, just less optimally than a niche-fit preset.
 */

import type { ChannelCloneVisualProfile } from './types';

/** Built-in style preset ids the matcher can pick from. Mirrors the
 *  ids registered in `src/lib/production-doc-styles.ts`. */
const CANDIDATE_PRESETS = [
  'paint_explainer_v1',
  'doodle_explainer_2',
  'whiteboard',
  'documentary',
  'animation_2d',
  'cinematic',
  'tech',
  'viral',
  'stock',
] as const;

export type CandidateStylePresetId = (typeof CANDIDATE_PRESETS)[number];

interface MatchRule {
  preset: CandidateStylePresetId;
  /** Words that, if present in artStyle/mood/detailLevel, suggest
   *  this preset. Case-insensitive substring match. */
  keywords: string[];
}

// Rules are checked top-to-bottom — order from MOST specific to
// MOST generic so a niche match (e.g. "stick-figure", "whiteboard")
// wins over a broader one (e.g. "doodle", "marker").
const RULES: MatchRule[] = [
  { preset: 'doodle_explainer_2', keywords: ['stick figure', 'stick-figure', 'stickman', 'stickfigure', 'doodle explainer'] },
  { preset: 'whiteboard', keywords: ['whiteboard', 'blackboard', 'chalkboard', 'marker on board'] },
  { preset: 'documentary', keywords: ['documentary', 'real photo', 'photograph', 'archival', 'b-roll', 'broll', 'cinema verite', 'photojournalism'] },
  { preset: 'animation_2d', keywords: ['2d animation', '2d animated', 'cel animation', 'flat illustration', 'vector illustration'] },
  { preset: 'cinematic', keywords: ['cinematic', 'shallow depth of field', 'anamorphic', 'movie-like', 'movielike'] },
  { preset: 'tech', keywords: ['ui', 'screen recording', 'dashboard', 'code editor', 'terminal'] },
  { preset: 'viral', keywords: ['meme', 'jump cut', 'reaction face', 'shock', 'high saturation'] },
  // paint_explainer_v1 last: its keywords ("doodle", "marker", "paint")
  // are deliberately broad — they catch the long tail of hand-drawn
  // styles that don't fit a more specific bucket. Putting it last
  // means specific rules above always win.
  { preset: 'paint_explainer_v1', keywords: ['paint', 'hand-drawn', 'hand drawn', 'doodle', 'cartoon', 'illustrated', 'sketchy', 'marker', 'crayon'] },
];

export interface MatchStylePresetResult {
  presetId: CandidateStylePresetId;
  reason: string;
}

/** Walk the rules in declaration order and return the first match,
 *  defaulting to `paint_explainer_v1` when nothing fires. */
export function matchStylePreset(profile: ChannelCloneVisualProfile | undefined): MatchStylePresetResult {
  if (!profile) {
    return { presetId: 'paint_explainer_v1', reason: 'no visual profile available — defaulting to paint_explainer_v1' };
  }
  const hay = [profile.artStyle, profile.mood, profile.detailLevel, profile.compositionPatterns]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (hay.includes(kw.toLowerCase())) {
        return { presetId: rule.preset, reason: `matched keyword "${kw}" in visual profile` };
      }
    }
  }
  return { presetId: 'paint_explainer_v1', reason: 'no keyword matched — defaulting to paint_explainer_v1' };
}

export function isCandidateStylePresetId(s: string): s is CandidateStylePresetId {
  return (CANDIDATE_PRESETS as readonly string[]).includes(s);
}

export const CHANNEL_CLONE_CANDIDATE_PRESETS = CANDIDATE_PRESETS;
