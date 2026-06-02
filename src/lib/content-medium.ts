/**
 * Content-medium primitive — the load-bearing abstraction for the
 * Shorts-everywhere rollout.
 *
 * See `_plans/2026-06-02-shorts-everywhere-v1.md` §5. The council's
 * core call: a Short is not a `format` flag on a long-form artifact,
 * it's a different artifact with its own lifecycle, prompts, scorers,
 * and renderer target. Building `if (format === 'shorts')` branches
 * into every section prompt builder ends in if/else rot within a month.
 *
 * Instead: every section (Ideas / Scripts / QA / SEO) reads the active
 * `medium` from the URL via `useMedium()` and dispatches into the
 * matching strategy. Each medium owns its own behaviour. Adding a new
 * medium is a strategy implementation + a registry entry — no caller
 * changes.
 *
 * Phase 1 ships the contract + three strategy implementations:
 *   - `long_form`        — wraps existing behaviour with zero changes.
 *                          Every existing prompt builder + scorer + UI
 *                          surface still reads through this strategy.
 *   - `short_clip`       — Mode A. Find clips from an existing channel
 *                          video. No script, no render — timecodes +
 *                          YouTube Studio deep link.
 *   - `short_native`     — Mode C. Generate a fresh Short. Has script,
 *                          can be voiced, can be rendered.
 *                          Phase 1 stub returns a "Coming Phase 2"
 *                          surface. Phase 2 fills in the prompts/scorers.
 *
 * Why the strategy interface is small in Phase 1:
 *   It's tempting to declare every method up front (renderTarget,
 *   qaScorerFor, seoRulesFor, etc.) and stub them all. But that pollutes
 *   the contract with surfaces Phase 1 doesn't use, and creates pretend
 *   coverage. The interface declares ONLY what Phase 1 callers reach
 *   for; Phase 2 widens it deliberately when the QA/SEO/Ideas/render
 *   paths actually need their per-medium behaviour.
 */

export const CONTENT_MEDIA = ['long_form', 'short_clip', 'short_native'] as const;
export type ContentMedium = (typeof CONTENT_MEDIA)[number];

export const DEFAULT_MEDIUM: ContentMedium = 'long_form';

/** Sections that read the medium toggle. Each section page mounts the
 *  toggle in its header and dispatches via `getMediumStrategy(medium)`. */
export const TOGGLE_SECTIONS = ['ideas', 'scripts', 'qa', 'seo'] as const;
export type ToggleSection = (typeof TOGGLE_SECTIONS)[number];

/** Per-medium static metadata for UI labels, hints, and routing.
 *  The display label is the SHORT chip text in the toggle; the
 *  description is the tooltip / explainer copy. */
export interface MediumDisplay {
  id: ContentMedium;
  label: string;
  shortLabel: string;
  description: string;
}

export const MEDIUM_DISPLAY: Readonly<Record<ContentMedium, MediumDisplay>> = Object.freeze({
  long_form: {
    id: 'long_form',
    label: 'Long-form',
    shortLabel: 'Long',
    description: 'YouTube videos 3+ minutes — your existing pipeline.',
  },
  short_clip: {
    id: 'short_clip',
    label: 'Short — clip from video',
    shortLabel: 'Clip',
    description: "Find clippable moments in an existing channel video.",
  },
  short_native: {
    id: 'short_native',
    label: 'Short — make from scratch',
    shortLabel: 'New Short',
    description: 'Generate a fresh 60-second Short with voiceover + render.',
  },
});

/** Safe parser for the URL `?medium=` query value. Returns the default
 *  on anything other than a known value. */
export function parseMediumParam(raw: string | null | undefined): ContentMedium {
  if (!raw) return DEFAULT_MEDIUM;
  if ((CONTENT_MEDIA as readonly string[]).includes(raw)) return raw as ContentMedium;
  return DEFAULT_MEDIUM;
}

// ---------------------------------------------------------------------------
// Strategy contract
// ---------------------------------------------------------------------------

/**
 * What a section actually does for a given medium. Phase 1 only needs
 * three answers from each strategy:
 *
 *   - `headerHint` — one-line hint under the section title that explains
 *     what THIS medium does in THIS section. Keeps the lazy-user bar.
 *   - `phase1Available` — does this strategy fully implement THIS section
 *     yet, or should the section render a "Coming Phase 2" empty state?
 *     Used by the section page to decide what to render below the toggle.
 *   - `phase1EmptyHint` — when phase1Available is false, the empty state
 *     copy. Always specific to the (section, medium) pair.
 *
 * Phase 2 will extend with:
 *   - `buildPrompt(section, args)` — section-aware prompt builder.
 *   - `qaCriteria()` — per-medium QA scoring weights.
 *   - `seoRules()` — per-medium SEO grading rules.
 *   - `renderTarget()` — render registry id for short_native.
 *
 * These are deliberately NOT in Phase 1's contract — see file header.
 */
export interface MediumSectionAnswer {
  /** Sub-headline under the section title. <= 90 chars for layout. */
  headerHint: string;
  /** Does this (section, medium) pair have a real Phase 1 implementation? */
  phase1Available: boolean;
  /** Empty-state copy shown when phase1Available is false. <= 140 chars. */
  phase1EmptyHint: string;
}

export interface MediumStrategy {
  id: ContentMedium;
  forSection(section: ToggleSection): MediumSectionAnswer;
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

const LONG_FORM_STRATEGY: MediumStrategy = {
  id: 'long_form',
  forSection(section) {
    // Long-form is the existing behaviour, available in every section.
    const hints: Record<ToggleSection, string> = {
      ideas: 'Pitch ideas for 8–15 minute videos tuned to your niche + reference style.',
      scripts: 'Write or extend the active long-form script for this project.',
      qa: 'Run the QA panel against your long-form script.',
      seo: 'Optimize the long-form title, description, tags, and chapters.',
    };
    return {
      headerHint: hints[section],
      phase1Available: true,
      phase1EmptyHint: '',
    };
  },
};

const SHORT_CLIP_STRATEGY: MediumStrategy = {
  id: 'short_clip',
  forSection(section) {
    switch (section) {
      case 'ideas':
        return {
          headerHint:
            'Find clippable Short moments inside the videos already on your channel.',
          phase1Available: true,
          phase1EmptyHint: '',
        };
      case 'scripts':
        return {
          headerHint:
            'Pick a channel video; we score the strongest 45-second moments + give you a YouTube Studio deep link to cut it there.',
          phase1Available: true,
          phase1EmptyHint: '',
        };
      case 'qa':
        return {
          headerHint:
            'QA for clip recommendations lands in Phase 2 alongside the Make-from-scratch flow.',
          phase1Available: false,
          phase1EmptyHint:
            'Pick a clip in Scripts first, then come here to grade it. The lean Shorts QA panel ships in Phase 2.',
        };
      case 'seo':
        return {
          headerHint:
            'SEO for Short clips lands in Phase 2 — the title/description rules differ from long-form.',
          phase1Available: false,
          phase1EmptyHint:
            'Pick a clip in Scripts first. Shorts SEO scoring ships next phase.',
        };
    }
  },
};

const SHORT_NATIVE_STRATEGY: MediumStrategy = {
  id: 'short_native',
  forSection(section) {
    // Phase 1 deliberately defers short_native to Phase 2 across every
    // section. Each (section, native) pair gets a specific empty state
    // explaining what lands when.
    const hints: Record<ToggleSection, string> = {
      ideas:
        'Hook-first vertical idea generation ships in Phase 2 alongside the rest of the Make-a-Short flow.',
      scripts:
        'Generate a fresh Short from a chosen moment — Phase 2 wires this to the existing extractor + voiceover + render.',
      qa: 'The lean Shorts QA panel (hook, payoff, density, loop, safe-zone) ships in Phase 2.',
      seo: 'Shorts SEO grading (hashtag rules, sub-150-char description, no chapters) ships in Phase 2.',
    };
    return {
      headerHint: hints[section],
      phase1Available: false,
      phase1EmptyHint: hints[section],
    };
  },
};

const STRATEGIES: Readonly<Record<ContentMedium, MediumStrategy>> = Object.freeze({
  long_form: LONG_FORM_STRATEGY,
  short_clip: SHORT_CLIP_STRATEGY,
  short_native: SHORT_NATIVE_STRATEGY,
});

/** Dispatch — returns the strategy for a given medium. Falls back to
 *  the long-form strategy on unknown input so callers can't break by
 *  passing a malformed URL param. */
export function getMediumStrategy(medium: ContentMedium | string | null | undefined): MediumStrategy {
  if (!medium) return STRATEGIES[DEFAULT_MEDIUM];
  if ((CONTENT_MEDIA as readonly string[]).includes(medium)) {
    return STRATEGIES[medium as ContentMedium];
  }
  return STRATEGIES[DEFAULT_MEDIUM];
}
