/**
 * GPT Image 2 Edit-based mouth removal for paint_explainer_v1 character bases.
 *
 * ─── Purpose ──────────────────────────────────────────────────────────
 * The Paint Explainer V1 style animates "talking" via a procedural mouth
 * overlay (`<MouthSwap>` in Remotion) composited on top of a static base
 * image whose mouth has been erased. This helper produces that erased
 * base in one GPT Image 2 Edit call per unique character.
 *
 * Now routed through the vendor-agnostic dispatcher
 * (`generateGptImage2Edit`) which honours the user's
 * `gpt_image_2_edit_primary` setting and falls back to the other vendor
 * on failure. Cost varies per vendor: ~$0.011 on Atlas, ~$0.05 on Kie.
 *
 * The full Paint Explainer V1 architecture lives at
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`. The viability
 * test that proved Atlas Edit can cleanly remove a single feature
 * without redrawing the rest of the image lives at
 * `_plans/2026-05-28-paint-explainer-v1-viability-test.md`. The
 * provider-fallback work is at
 * `_plans/2026-05-29-gpt-image-2-edit-provider-fallback.md`.
 *
 * ─── Why a dedicated module ──────────────────────────────────────────
 * The mouth-removal prompt is load-bearing — drift on any of its
 * directives (preserve eyes, preserve eyebrows, preserve background)
 * breaks the procedural mouth overlay positioning and breaks the
 * "same frame, more motion" illusion the whole style is built around.
 * Isolating the prompt here keeps it under version control as a single
 * unit and prevents drive-by edits from elsewhere in the codebase.
 *
 * ─── How it composes ─────────────────────────────────────────────────
 * The caller (production-doc-image-gen.ts) passes the URL of an
 * already-generated character base + the active vendor primary. Per-
 * video caching is the caller's job — see
 * `ProductionDoc.paint_explainer_v1_character_cache` in
 * `src/remotion/utils.ts`. This module is stateless.
 *
 * ─── Cost ────────────────────────────────────────────────────────────
 * Returned in `MouthRemovalResult.costUsd`. Caller is responsible for
 * amortising via the per-video character cache so a recurring mascot
 * pays for this once per doc, not once per row.
 *
 * ─── Observability (rule 14) ─────────────────────────────────────────
 * Every call emits `[mouth-removal start]` and either
 * `[mouth-removal done]` or `[mouth-removal error]` with the vendor
 * used + prediction id + duration. The dispatcher emits its own
 * `[gpt2-edit dispatch ...]` lines for the underlying primary/fallback
 * decision. Caller is expected to ALSO emit a
 * `[paint-explainer-v1 mouth-removed]` line tagged with row_id /
 * character_id so chains through the per-video cost log
 * (rule 14 §13 of the plan) stay grep-able.
 */
import { generateGptImage2Edit, type Gpt2EditVendor } from './gpt-image-2-edit';

/**
 * The prompt used to ask Atlas Edit to erase the mouth and leave the
 * rest of the character identical. Calibrated during the 2026-05-28
 * viability test against the doodle_explainer_2 close-up reference,
 * which produced a clean mouth removal with zero drift on eyes,
 * eyebrows, head outline, body, or background.
 *
 * Do NOT inline-edit this prompt without re-running the viability
 * test — small wording changes can cause the model to redraw the
 * face, which breaks every downstream `<MouthSwap>` calibration.
 *
 * Exported so unit tests can assert the prompt's load-bearing
 * directives are present (preserve-eyes, preserve-eyebrows, no
 * scar/marker, etc.) — silent edits to this string have a high blast
 * radius across the whole paint_explainer_v1 architecture.
 */
export const MOUTH_REMOVAL_PROMPT =
  'Remove the small open mouth (red interior, black outline) from the doodle character\'s face. ' +
  'The area where the mouth was must become plain face — no mouth shape, no scar, no marker, no shadow, no smudge. ' +
  'Keep absolutely everything else IDENTICAL to the input image: the round head outline, both oval-shaped eyes with their pupils, both angled eyebrows above the eyes, the small visible neck and shoulder lines below the head, the position of the head in the frame, the pure white background. ' +
  'Preserve the exact hand-drawn doodle style with thick uneven black outlines. ' +
  'Do not redraw any line that is not the mouth. The output must look like the input with the mouth carefully erased and the face beneath it left blank.';

export interface MouthRemovalResult {
  /** Final image URL of the mouth-removed PNG, already cropped to 16:9
   *  by the dispatcher (Atlas vendor) or returned at 16:9 natively
   *  (Kie vendor). The caller is responsible for mirroring this to R2
   *  if it needs to persist past the vendor CDN's TTL — typical
   *  pattern: the existing R2-mirror in production-doc-image-gen. */
  url: string;
  /** Vendor prediction / task id for trace correlation with the
   *  dispatcher's `[gpt2-edit ...]` log lines. */
  predictionId: string | null;
  /** Total dispatcher duration in ms (primary attempt + fallback when
   *  applicable). The viability test saw ~40s on Atlas; Kie is
   *  comparable. */
  predictTimeMs?: number;
  /** Which vendor served — included so the caller's cost telemetry
   *  log line can attribute spend correctly. */
  vendorUsed: Gpt2EditVendor;
  /** True iff fallback fired. Useful for the row-tagged log so a
   *  recurring fallback is visible in the per-video cost trail. */
  fallbackUsed: boolean;
  /** Actual per-call cost ($0.011 Atlas / $0.05 Kie). The caller
   *  feeds this into `markDelivered` so the audit row reflects the
   *  vendor that actually invoiced. */
  costUsd: number;
}

/**
 * Generate a mouth-removed variant of the given character base image
 * URL. Returns the final image URL (16:9-cropped, vendor CDN; caller
 * mirrors to R2).
 *
 * Stateless — the per-video character cache lives one layer up
 * (`ProductionDoc.paint_explainer_v1_character_cache`). The caller is
 * responsible for:
 *   1. Checking the cache before calling (to avoid duplicate spend).
 *   2. Reading the owner's `gpt_image_2_edit_primary` setting and
 *      passing it as `primary`.
 *   3. Storing the returned URL into the cache after a successful call.
 *   4. Emitting the row-tagged cost-telemetry log line.
 *
 * Throws when BOTH vendors fail (primary error + fallback error). The
 * caller should catch and either retry once or fall back to rendering
 * without `<MouthSwap>` (the row's `motion_beats` of kind `mouth_swap`
 * are skipped if `mouth_removed_url` is empty — see the renderer's
 * fallback path).
 *
 * @param baseImageUrl - URL of the character base image. Must be
 *   publicly fetchable by the chosen vendor (typically an R2-presigned
 *   URL produced upstream in the image-gen pipeline).
 * @param primary - Vendor preference from `UserSettings.gpt_image_2_edit_primary`.
 *   Defaults to `'atlas'` when undefined (legacy callers / tests).
 */
export async function generateMouthRemovedBase(
  baseImageUrl: string,
  primary: Gpt2EditVendor = 'atlas',
): Promise<MouthRemovalResult> {
  console.info('[mouth-removal start]', {
    prompt_chars: MOUTH_REMOVAL_PROMPT.length,
    base_url_len: baseImageUrl.length,
    primary,
  });

  try {
    const dispatched = await generateGptImage2Edit({
      prompt: MOUTH_REMOVAL_PROMPT,
      sourceImageUrl: baseImageUrl,
      primary,
    });

    console.info('[mouth-removal done]', {
      vendor_used: dispatched.vendorUsed,
      fallback_used: dispatched.fallbackUsed,
      prediction_id: dispatched.providerRequestId,
      duration_ms: dispatched.durationMs,
      cost_usd: dispatched.costUsd,
      url_len: dispatched.url.length,
    });

    return {
      url: dispatched.url,
      predictionId: dispatched.providerRequestId,
      predictTimeMs: dispatched.durationMs,
      vendorUsed: dispatched.vendorUsed,
      fallbackUsed: dispatched.fallbackUsed,
      costUsd: dispatched.costUsd,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[mouth-removal error]', { detail: detail.slice(0, 240) });
    throw err;
  }
}
