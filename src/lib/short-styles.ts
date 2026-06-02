/**
 * SHORT_STYLES registry — the contract that lets Phase 2 ship a style
 * picker without locking down which visual styles get implemented.
 *
 * Phase 15.2 ships ONE entry — `minimal_gradient_v1` — because that's
 * the existing Remotion ShortVideo composition from Phase 5.5 and it
 * already renders. Phase 15.3 adds `doodle_explainer_2_short`. Phase
 * 15.4 adds `paint_explainer_v1_short`. Each follow-on phase is a
 * registry entry + a renderer adapter; the picker contract here doesn't
 * change.
 *
 * Why a registry (not a switch / class hierarchy):
 *   - Each style varies in its render adapter (which Remotion composition
 *     to mount, what extra config keys to fill), its asset pipeline
 *     (Paint needs mouth-removed + anchor vision passes; Doodle needs
 *     Atlas Edit sibling-frame variants; Minimal needs neither), and its
 *     QA caveats (Paint needs safe-zone math; Minimal does not).
 *   - A registry keeps every per-style fact co-located in its entry, so
 *     adding a style is one file diff, not five.
 *   - The picker UI reads name + description + cost-band + preview from
 *     the registry directly — no per-style if/else in components.
 *
 * Status semantics:
 *   - `available` — the entry has a working render adapter today.
 *   - `comingPhase` — when `available` is false, which phase ships this.
 *     Displayed as a disabled chip in the picker so the user can see
 *     what's on the roadmap without leaving the UI.
 *
 * Cost band (`costBand`):
 *   - 'minimal' — voiceover-only, no image gen, no asset cache. ~$0.02
 *     of voiceover per render.
 *   - 'light' — near-static + Atlas Edit variants. ~$0.10-0.30 per
 *     render depending on shot count.
 *   - 'heavy' — full motion pipeline with mouth-removed cache + per-prop
 *     T2I + anchor vision pass. ~$0.50-1.50 per render. User sees this
 *     band on hover, cost-gate fires if their workspace setting requires
 *     confirmation above a threshold.
 */

export const SHORT_STYLE_IDS = [
  'minimal_gradient_v1',
  'doodle_explainer_2_short',
  'paint_explainer_v1_short',
] as const;
export type ShortStyleId = (typeof SHORT_STYLE_IDS)[number];

export interface ShortStyleEntry {
  id: ShortStyleId;
  /** Display label in the picker. Keep <= 28 chars. */
  label: string;
  /** One-line explainer under the label. <= 120 chars. */
  description: string;
  /** Has this style's render adapter shipped? */
  available: boolean;
  /** When `available` is false, the phase that adds it. Free-text. */
  comingPhase?: string;
  /** Cost band — shown as a chip on hover, used by cost-gate. */
  costBand: 'minimal' | 'light' | 'heavy';
}

const REGISTRY: Readonly<Record<ShortStyleId, ShortStyleEntry>> = Object.freeze({
  minimal_gradient_v1: {
    id: 'minimal_gradient_v1',
    label: 'Minimal — captions only',
    description:
      'Floor of "publishable Short" — gradient background, large captions, title chip, voiceover. No image gen, no motion.',
    available: true,
    costBand: 'minimal',
  },
  doodle_explainer_2_short: {
    id: 'doodle_explainer_2_short',
    label: 'Doodle Explainer — vertical',
    description:
      'Near-static doodle with Atlas Edit sibling-frame variants. Hand-drawn feel, low motion, calm tempo.',
    available: false,
    comingPhase: 'Phase 15.3',
    costBand: 'light',
  },
  paint_explainer_v1_short: {
    id: 'paint_explainer_v1_short',
    label: 'Paint Explainer — vertical',
    description:
      'Motion-driven hand-drawn doodle with mouth-swap, polaroid frames, label pops, scribble draw. High production value.',
    available: false,
    comingPhase: 'Phase 15.4',
    costBand: 'heavy',
  },
});

export const DEFAULT_SHORT_STYLE_ID: ShortStyleId = 'minimal_gradient_v1';

/** Return the entry for an id. Falls back to the default on unknown input
 *  so a malformed query param can't crash the picker. */
export function getShortStyle(id: string | null | undefined): ShortStyleEntry {
  if (!id) return REGISTRY[DEFAULT_SHORT_STYLE_ID];
  if ((SHORT_STYLE_IDS as readonly string[]).includes(id)) {
    return REGISTRY[id as ShortStyleId];
  }
  return REGISTRY[DEFAULT_SHORT_STYLE_ID];
}

/** Every entry, in registry order. Used by the picker to enumerate
 *  available + coming-soon options. */
export function listShortStyles(): ShortStyleEntry[] {
  return SHORT_STYLE_IDS.map((id) => REGISTRY[id]);
}

/** Only the available entries — what the user can actually pick today. */
export function listAvailableShortStyles(): ShortStyleEntry[] {
  return listShortStyles().filter((s) => s.available);
}
