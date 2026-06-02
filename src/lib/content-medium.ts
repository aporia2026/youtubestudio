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
 * What a section actually does for a given medium. Three answers per
 * (medium, section) pair:
 *
 *   - `headerHint` — one-line hint under the section title that explains
 *     what THIS medium does in THIS section. Keeps the lazy-user bar.
 *   - `available` — does this strategy have a real implementation for
 *     THIS section, or should the section render an empty state?
 *   - `unavailableHint` — when `available` is false, the empty-state copy.
 *     Either "ships next phase" or "not applicable for this medium".
 *
 * Per-medium prompts / scorers / SEO rules / render targets live in
 * dedicated modules (`shorts-ideas.ts`, `shorts-qa.ts`, `shorts-seo.ts`,
 * `short-styles.ts`) that the section pages reach for directly, NOT in
 * this interface — keeping `MediumStrategy` a routing primitive instead
 * of an everything-bag.
 */
export interface MediumSectionAnswer {
  /** Sub-headline under the section title. <= 200 chars for layout. */
  headerHint: string;
  /** Does this (medium, section) pair have a real implementation? */
  available: boolean;
  /** Empty-state copy shown when `available` is false. <= 200 chars. */
  unavailableHint: string;
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
      available: true,
      unavailableHint: '',
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
          available: true,
          unavailableHint: '',
        };
      case 'scripts':
        return {
          headerHint:
            'Pick a channel video; we score the strongest 45-second moments + give you a YouTube Studio deep link to cut it there.',
          available: true,
          unavailableHint: '',
        };
      case 'qa':
        return {
          headerHint:
            'QA grades scripts you write — a clip recommendation is a pointer into someone else\'s edit.',
          available: false,
          unavailableHint:
            'QA applies to Shorts you create from scratch. Flip to "New Short" to grade the script we generate.',
        };
      case 'seo':
        return {
          headerHint:
            'SEO grades artifacts you publish — clip recommendations get cut in YouTube Studio where you write the metadata.',
          available: false,
          unavailableHint:
            'SEO grading applies to Shorts you create from scratch. Flip to "New Short" to grade the title + description + hashtags.',
        };
    }
  },
};

const SHORT_NATIVE_STRATEGY: MediumStrategy = {
  id: 'short_native',
  forSection(section) {
    const hints: Record<ToggleSection, string> = {
      ideas:
        'Hook-first vertical idea generation tuned for the 60-second algorithm.',
      scripts:
        'Pick a channel-video moment, then we spin a fresh Short with voiceover + render through the existing extractor.',
      qa: 'Lean Shorts QA — hook, payoff, density, loop, vertical-safe-zone. One AI call per pass.',
      seo: 'Shorts SEO — hashtag rules, sub-150-char description, no chapters, no #Shorts injection.',
    };
    return {
      headerHint: hints[section],
      available: true,
      unavailableHint: '',
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
