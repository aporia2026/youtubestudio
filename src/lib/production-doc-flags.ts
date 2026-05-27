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

/** When set, ref-bearing styles skip the ai_image_suffix append
 *  (Stage 1). The visual reference images encode the style; the text
 *  suffix is interference. A short fallback suffix still attaches when
 *  no usable refs exist for a generation. Defaults to off so the full
 *  suffix continues to attach until validation passes. */
export function useTrimmedSuffix(): boolean {
  return process.env.USE_TRIMMED_SUFFIX === '1';
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
