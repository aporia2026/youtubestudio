/**
 * Atlas-Edit-based mouth removal for paint_explainer_v1 character bases.
 *
 * ─── Purpose ──────────────────────────────────────────────────────────
 * The Paint Explainer V1 style animates "talking" via a procedural mouth
 * overlay (`<MouthSwap>` in Remotion) composited on top of a static base
 * image whose mouth has been erased. This helper produces that erased
 * base in one Atlas Edit call (~$0.011) per unique character.
 *
 * The full Paint Explainer V1 architecture lives at
 * `_plans/2026-05-28-paint-explainer-v1-architecture.md`. The viability
 * test that proved Atlas Edit can cleanly remove a single feature
 * without redrawing the rest of the image lives at
 * `_plans/2026-05-28-paint-explainer-v1-viability-test.md`.
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
 * The caller (production-doc-image-gen.ts, when PR 5 wires this in)
 * passes the URL of an already-generated character base. Per-video
 * caching is the caller's job — see `ProductionDoc.paint_explainer_v1_character_cache`
 * in `src/remotion/utils.ts`. This module is stateless.
 *
 * ─── Cost ────────────────────────────────────────────────────────────
 * ~$0.011 per call (Atlas Edit token-billed; verified during the
 * viability test — predict_ms ~40s, output ~1.5MB PNG). Caller is
 * responsible for amortising via the per-video character cache so
 * a recurring mascot pays for this once per doc, not once per row.
 *
 * ─── Observability (rule 14) ─────────────────────────────────────────
 * Every call emits `[atlas-mouth-removal start]` and either
 * `[atlas-mouth-removal done]` or `[atlas-mouth-removal error]` with
 * the prediction id, predict_ms, and token counts. Caller is expected
 * to ALSO emit a `[paint-explainer-v1 atlas-mouth-removed]` line tagged
 * with row_id / character_id so chains through the per-video cost log
 * (rule 14 §13 of the plan) stay grep-able.
 */
import { generateAtlasEdit, type AtlasGenerateResult } from './atlas-cloud-images';

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
 */
const MOUTH_REMOVAL_PROMPT =
  'Remove the small open mouth (red interior, black outline) from the doodle character\'s face. ' +
  'The area where the mouth was must become plain face — no mouth shape, no scar, no marker, no shadow, no smudge. ' +
  'Keep absolutely everything else IDENTICAL to the input image: the round head outline, both oval-shaped eyes with their pupils, both angled eyebrows above the eyes, the small visible neck and shoulder lines below the head, the position of the head in the frame, the pure white background. ' +
  'Preserve the exact hand-drawn doodle style with thick uneven black outlines. ' +
  'Do not redraw any line that is not the mouth. The output must look like the input with the mouth carefully erased and the face beneath it left blank.';

export interface MouthRemovalResult {
  /** Atlas CDN URL of the mouth-removed PNG. The caller is responsible
   *  for mirroring this to R2 if it needs to persist past the Atlas
   *  CDN's TTL (typical pattern: use the existing R2-mirror in the
   *  production-doc-image-gen pipeline). */
  url: string;
  /** Atlas prediction id, included in the result for trace correlation
   *  with `[atlas-images edit] success` log lines. */
  predictionId: string;
  /** Atlas-reported render time in ms, when present. The viability test
   *  saw ~40s; production is expected in the same ballpark. */
  predictTimeMs?: number;
  /** Atlas token usage breakdown when present. Used by the per-video
   *  cost telemetry (`[paint-explainer-v1 cost]` namespace per §13 of
   *  the architecture plan). */
  tokens?: AtlasGenerateResult['tokens'];
}

/**
 * Generate a mouth-removed variant of the given character base image
 * URL. Returns the new image URL (on Atlas CDN; caller mirrors to R2).
 *
 * Stateless — the per-video character cache lives one layer up
 * (`ProductionDoc.paint_explainer_v1_character_cache`). The caller is
 * responsible for:
 *   1. Checking the cache before calling (to avoid duplicate spend).
 *   2. Storing the returned URL into the cache after a successful call.
 *   3. Emitting the row-tagged cost-telemetry log line.
 *
 * Throws on Atlas error (network / quota / policy reject). The caller
 * should catch and either retry once or fall back to rendering without
 * `<MouthSwap>` (the row's `motion_beats` of kind `mouth_swap` are
 * skipped if `mouth_removed_url` is empty — see the renderer's
 * fallback path).
 *
 * @param baseImageUrl - URL of the character base image. Must be
 *   publicly fetchable by Atlas (typically an R2-presigned URL produced
 *   upstream in the image-gen pipeline).
 */
export async function generateMouthRemovedBase(baseImageUrl: string): Promise<MouthRemovalResult> {
  console.info('[atlas-mouth-removal start]', {
    prompt_chars: MOUTH_REMOVAL_PROMPT.length,
    base_url_len: baseImageUrl.length,
  });

  try {
    const result = await generateAtlasEdit({
      prompt: MOUTH_REMOVAL_PROMPT,
      images: [baseImageUrl],
      // Same size as the viability test. doodle_explainer_2 / paint_explainer_v1
      // bases are 1536x1024 (16:9-ish), which is the size that produced clean
      // mouth removal during the viability test.
      size: '1536x1024',
      quality: 'medium',
    });

    console.info('[atlas-mouth-removal done]', {
      prediction_id: result.predictionId,
      predict_ms: result.predictTimeMs,
      tokens: result.tokens,
      url_len: result.url.length,
    });

    return {
      url: result.url,
      predictionId: result.predictionId,
      predictTimeMs: result.predictTimeMs,
      tokens: result.tokens,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[atlas-mouth-removal error]', { detail: detail.slice(0, 240) });
    throw err;
  }
}
