/**
 * Foundation feature flags + version constants for the production-doc
 * image-generation pipeline. Stage 0 of the 2026-05-27 foundation
 * rebuild (see `_plans/2026-05-27-doodle-explainer-2-foundation.md`).
 *
 * `PROMPT_VERSION` stamps every image-gen call so any post-ship
 * regression is attributable to a known input shape. Bump this whenever
 * the productionDocPrompt template, ai_image_suffix attach logic, or
 * mixing_rules format changes in a way that affects output quality.
 *
 * The two `USE_*` flags are env-var-driven kill-switches that opt INTO
 * the new behavior. Defaults preserve current behavior so unflagged
 * deploys are byte-identical to before Stage 0. Promote a flag to
 * always-on by deleting its env-var check after the stage's QA passes.
 */

export const PROMPT_VERSION = 1;

/** When set, the variant edit prompt uses the short delta-only format
 *  (Stage 2). Drops the base-prompt prepend; sends only the edit
 *  instruction plus a style-specific preservation hint. Defaults to off
 *  so the legacy long-form composition stays the production behavior
 *  until validation passes.
 *
 *  Uses `NEXT_PUBLIC_*` because `composeVariantEditRequest` runs in the
 *  browser (it builds the request body the editor POSTs to the edit
 *  route). Next.js inlines `NEXT_PUBLIC_*` env vars at build time, so
 *  the flag is consistent between the client composer and the server
 *  route's telemetry log. Bundle exposure is benign — the flag only
 *  toggles prompt-composition strategy, not credentials or policy. */
export function useShortVariantPrompt(): boolean {
  return process.env.NEXT_PUBLIC_USE_SHORT_VARIANT_PROMPT === '1';
}

/** Style-specific preservation hint appended after the variant's edit
 *  instruction (Stage 2). The Atlas Edit model already SEES the input
 *  image, so the hint is a soft nudge against the model drifting into
 *  a fully redrawn scene — NOT a full re-description of the base.
 *  Keep entries short (one sentence each).
 *
 *  Doodle Explainer 2's hint was hand-verified by the user (2026-05-27)
 *  with a 31-word manual Atlas Edit prompt that produced perfect output.
 *  Other styles fall through to a generic default until each is tuned
 *  with the same empirical pass. Add entries as styles are validated. */
const VARIANT_PRESERVATION_HINTS: Record<string, string> = {
  doodle_explainer_2:
    'Keep the same simple black stick-figure drawing and plain white background. No text or extra elements.',
};

const DEFAULT_VARIANT_PRESERVATION_HINT =
  'Keep everything else in the image identical to the input.';

/** Return the preservation hint for a given style id, or a safe generic
 *  default when the style is unknown or has no tuned hint yet. */
export function getVariantPreservationHint(styleId: string | null | undefined): string {
  if (!styleId) return DEFAULT_VARIANT_PRESERVATION_HINT;
  return VARIANT_PRESERVATION_HINTS[styleId] ?? DEFAULT_VARIANT_PRESERVATION_HINT;
}

/** When set, ref-bearing styles use the trimmed-content versions of
 *  their `ai_image_suffix` AND `mixing_rules` (Stage 1). The visual
 *  reference images encode the style; the full text suffix fights
 *  them. The full mixing_rules (~9.7 kB for doodle_explainer_2)
 *  spends LLM attention budget on rules the auto-grouping post-process
 *  now handles deterministically.
 *
 *  Trimmed versions live in `TRIMMED_AI_IMAGE_SUFFIX` and
 *  `TRIMMED_MIXING_RULES` below — both keyed by style id. Styles
 *  without a trimmed entry fall through to their original values.
 *
 *  Server-side env var (no `NEXT_PUBLIC_`) because both call sites
 *  are server-only: the production-doc route's prompt-builder + the
 *  attachStyleSuffixToRows pass.
 *
 *  Defaults to OFF so unflagged deploys are byte-identical to before
 *  Stage 1. */
export function useTrimmedSuffix(): boolean {
  return process.env.USE_TRIMMED_SUFFIX === '1';
}

/** Trimmed `ai_image_suffix` for ref-bearing styles. Council target:
 *  ~150 chars (or empty) — refs do the visual style work, the suffix
 *  becomes a soft fallback for the rare path where refs are
 *  unavailable. Keep entries SHORT; verbose suffixes fight refs.
 *
 *  Doodle Explainer 2 — original is 1,775 chars of "CRITICAL ARM
 *  RULE… NO hand, NO fingers, NO palm…" which negative-prompts the
 *  i2i model can't truly negate AND fights against the 14 bundled
 *  visual refs that already show the no-hand stick-figure pose. The
 *  trimmed version drops to a one-sentence style descriptor — the
 *  refs carry everything else. */
export const TRIMMED_AI_IMAGE_SUFFIX: Record<string, string> = {
  doodle_explainer_2:
    'Minimalist hand-drawn stick figure cartoon on plain white background, thick uneven black ink lines, child-like freehand drawing style, no shading or gradients.',
};

/** Trimmed `mixing_rules` for ref-bearing styles. Council target:
 *  ~1.5–2.0 kB — keep overlay-stock triggers + concise on-screen-text
 *  guidance; drop the JSON example, the repetitive emphasis, and
 *  the prose explanations of "why".
 *
 *  Doodle Explainer 2 — original is 9,657 chars including 25 lines
 *  of JSON example for variant groups. The auto-grouper at
 *  `src/lib/auto-group-variants.ts` now derives variant groups
 *  deterministically from consecutive similar rows, so the LLM no
 *  longer needs detailed group-emission instructions. The trimmed
 *  version keeps the OST/overlay/composition rules, drops the
 *  variant-group block to a single sentence pointing at the auto-
 *  grouper. */
export const TRIMMED_MIXING_RULES: Record<string, string> = {
  doodle_explainer_2: [
    'Style defaults (per row):',
    '- visual_type defaults to "Animation".',
    '- ai_image_prompt: single centered subject on pure white background, thick black hand-drawn outlines, generous white space, muted palette (pale blue / pale yellow / light gray accents; saturated red ONLY for danger). Keep scenes simple enough to plausibly re-edit with a brow / mouth / hand change.',
    '',
    'ON-SCREEN TEXT (`on_screen_text`):',
    'Populate for time markers ("In May 2017"), statistics ("150 countries"), foreign or technical terms ("EternalBlue"), short punchlines (3-5 words). The renderer composites these as yellow bubble callouts — never bake text into the AI image. CRITICAL: leave `on_screen_text_mode` undefined or "overlay", NEVER "bake".',
    '',
    'Do NOT put time markers, stats, or named terms into `ai_image_prompt`. The player composites all on-screen text on top of clean illustrations.',
    '',
    'OVERLAY STOCK (`overlay_stock_terms`):',
    'When the script names a recognisable real subject, populate this so the editor composites a real asset on top of the cartoon:',
    '- Named brand → "<brand> logo official PNG"',
    '- Named software / UI → "<thing> screenshot"',
    '- Named real person → "<name> photograph"',
    '- Named place / event → "<thing> photograph"',
    '',
    'Real photos appear as inset rectangles with a thick coloured border (orange / red / blue / black to match scene mood). When populating overlay_stock_terms:',
    '- Keep visual_type as "Animation" (or "Statistics" / "Cutaway"). Do NOT switch to "Screen Recording" or "B-Roll".',
    '- `ai_image_prompt` describes a complete cartoon scene that includes an empty bordered rectangle as the placeholder — do NOT describe the real subject (the AI would draw a stylised fake; the real one is overlaid later).',
    '- Add a `notes` line: "Composite: drop the real <X> into the bordered rectangle".',
    '',
    'Aim for roughly 1 in 4 to 1 in 6 rows being a framed-photo composite.',
    '',
    'VARIANT GROUPS:',
    'Write rows naturally — do NOT set `group_id`, `variant_index`, or `variant_edit_prompt` manually. The server post-process detects consecutive rows with similar compositions and groups them automatically into variant groups (1 base + 2–3 micro-edited variants) for the additive frame-by-frame animation pattern.',
  ].join('\n'),
};

/** Resolve the effective `ai_image_suffix` for a style, honouring the
 *  trim flag. When the flag is off, returns the original verbose
 *  suffix unchanged. When on, returns the trimmed version from
 *  `TRIMMED_AI_IMAGE_SUFFIX` if one exists for this style; otherwise
 *  the original (styles without a trimmed entry are not in Stage 1's
 *  scope and continue with their full suffix). */
export function getEffectiveAiImageSuffix(style: {
  id: string;
  ai_image_suffix: string;
}): string {
  if (!useTrimmedSuffix()) return style.ai_image_suffix;
  return TRIMMED_AI_IMAGE_SUFFIX[style.id] ?? style.ai_image_suffix;
}

/** Resolve the effective `mixing_rules` for a style, honouring the
 *  trim flag. Same pattern as `getEffectiveAiImageSuffix` — flag off
 *  returns original, flag on returns the trimmed version if present.
 *
 *  Accepts the wider `string | null | undefined` shape because the
 *  resolved-style payloads in different callers (manual route, auto-
 *  pipeline stage) use slightly different nullability conventions. */
export function getEffectiveMixingRules(style: {
  id: string;
  mixing_rules?: string | null;
}): string | undefined {
  const original = style.mixing_rules ?? undefined;
  if (!useTrimmedSuffix()) return original;
  return TRIMMED_MIXING_RULES[style.id] ?? original;
}

/** Telemetry payload shape — what every image-gen log line includes so
 *  bad outputs are forensically attributable to a prompt version, style,
 *  ref set, and suffix size. Routes emit this verbatim via
 *  `logger.info('[prodoc image-gen telemetry]', payload)`. */
export interface ImageGenTelemetry {
  prompt_version: number;
  /** Resolved style id, or null when the caller passed no styleId. */
  style_id: string | null;
  /** Saved-style version bump counter; null for built-ins. */
  style_version: number | null;
  /** Number of reference images sent to the model. 0 on text-only paths;
   *  1 for variant edits (the base image); N for i2i with style refs. */
  ref_count: number;
  /** Ids of the refs sent (style ref row ids for i2i, empty for edits). */
  ref_ids: string[];
  /** Length of the style suffix that was actually appended to the prompt
   *  this call. 0 when the trimmed-suffix flag dropped it. */
  suffix_chars: number;
  /** Final prompt length sent to the model after all augmentation. */
  prompt_chars: number;
  /** Flag states at the time of the call, for forensic attribution. */
  flag_short_variant: boolean;
  flag_trimmed_suffix: boolean;
}
