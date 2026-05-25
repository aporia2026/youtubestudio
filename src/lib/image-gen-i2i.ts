/**
 * Cloud i2i image generation — the dispatcher half of Phase 4 of
 * `_plans/2026-05-21-user-defined-styles-with-reference-images.md`.
 *
 * Wraps the Kie.ai createTask/pollResult dance for ref-bearing
 * generation:
 *
 *   - Verifies the chosen model is i2i-capable (has `i2iRefsField`)
 *   - Builds the per-model input payload via `buildKieI2IInput` —
 *     each Kie i2i model uses a slightly different field name
 *     (`image_input` vs `input_urls` vs `image_url`)
 *   - Mints presigned R2 GET URLs for each ref at DISPATCH time
 *     (TTL = REF_PRESIGN_TTL_SECONDS) so a slow Kie queue can't
 *     out-run the URL's validity window
 *   - Catches Kie's content-refusal-style errors and throws a
 *     typed `ReferenceRejectedError` so route layers can offer the
 *     user a "Regenerate without rejected refs" path instead of a
 *     generic 500
 *   - Re-hosts the result to R2 so the returned URL outlives
 *     Kie's CDN retention window
 *
 * Used by:
 *   - `POST /api/production-doc/styles/[id]/test-render` (Phase 5)
 *   - `POST /api/generate/production-doc/image` (Phase 4 integration)
 *
 * The T2I fallback-chain dispatcher in `auto-pipeline/image-gen.ts`
 * stays separate — fallback chains don't compose with i2i because
 * each i2i model takes refs in a different field name and the
 * caller usually picks a single model deliberately.
 */
import {
  buildKieI2IInput,
  getI2IModelSpec,
  isKieI2ISpec,
  type I2IModelSpec,
} from './image-models-i2i';
import { createKieTask, pollKieResultThenUpscale } from './kie-poll';
import { generateAtlasI2I } from './atlas-cloud-images';
import { cropTo16x9AndUpload, ATLAS_NATIVE_16X9_SIZES } from './image-gen-dispatch';
import { upscaleViaRecraft } from './upscale';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from './r2';
import type { StyleReferenceImage } from './production-doc-styles-refs';
import { logger } from './logger';

/**
 * Note on presigned URL TTL: `getDownloadUrlForBucket` mints presigned
 * R2 GETs with a 7-day TTL hard-coded in `r2.ts:53`. That's much
 * longer than the worst-observed Kie queue duration during the Phase
 * 0 spike (~300s), so URL expiry can never be confused for content
 * refusal in practice. We previously exported a `REF_PRESIGN_TTL_SECONDS`
 * constant here, but it was never wired through to the helper —
 * removed to avoid misleading future readers into thinking it's
 * actually used.
 */

/**
 * Thrown when Kie.ai (or any cloud provider) refuses to use one or
 * more reference images. Routes catch this to offer a "Regenerate
 * without these refs" affordance.
 *
 * `rejectedRefIds` is best-effort: NanoBanana Pro sometimes reports
 * which input index it refused, but the standard /jobs endpoint
 * response doesn't always carry that detail. When the index is
 * unknown, this array is empty and the route should treat ALL refs
 * in the dispatched call as suspect.
 */
export class ReferenceRejectedError extends Error {
  public readonly rejectedRefIds: readonly string[];
  public readonly provider: string;
  public readonly reason: string;
  constructor(opts: { rejectedRefIds: readonly string[]; provider: string; reason: string }) {
    super(`Reference images rejected by ${opts.provider}: ${opts.reason}`);
    this.name = 'ReferenceRejectedError';
    this.rejectedRefIds = opts.rejectedRefIds;
    this.provider = opts.provider;
    this.reason = opts.reason;
  }
}

export interface GenerateImageWithRefsResult {
  /** R2-hosted URL of the generated image. Doesn't depend on Kie's
   *  CDN retention because we re-host every successful result. */
  imageUrl: string;
  /** R2 key under the images bucket where the result was mirrored.
   *  Persisted alongside `output_url` so eviction / cleanup paths
   *  (e.g. test-render gallery cap) can identify which blob to
   *  delete — the presigned URL alone isn't enough since it expires.
   *  Undefined when the mirror failed and we fell back to the upstream
   *  URL (caller still gets a usable image, just no R2 cleanup hook). */
  r2Key?: string;
  /** Which i2i model produced this image. Echoed back so the caller
   *  can pin it on the resulting record (test render, generation
   *  history, etc). */
  modelUsed: string;
  /** Kie's task id — populated only on cloud i2i generations.
   *  Useful for cross-referencing with Kie's billing dashboard. */
  kieTaskId?: string;
  /** ComfyUI prompt id — populated only on local i2i generations. */
  comfyPromptId?: string;
  /** Wall-clock latency in ms — surfaced so the editor can show
   *  "~Xs" next to test render thumbs and the production-doc cost
   *  gauge can compute per-row averages. */
  durationMs: number;
  /** Number of refs that were actually included in the dispatched
   *  call. Differs from the requested count when:
   *   - the model's i2iMaxRefs caps below the requested set, OR
   *   - rejected refs were excluded server-side
   */
  refsSent: number;
}

export interface GenerateImageWithRefsOptions {
  /** Override the destination prefix for the re-hosted R2 object.
   *  Test renders use a different prefix from production-doc
   *  generations so bucket listings stay browsable. */
  r2KeyPrefix?: string;
  /** Filename of the source ref the caller knows is the strongest
   *  style anchor. Used for the result file naming convention only;
   *  the dispatch logic doesn't read this. */
  hintFilename?: string;
  /** Local-only — output canvas width passed to the ComfyUI workflow's
   *  `<<WIDTH>>` placeholder. Ignored by cloud i2i (Kie controls
   *  dimensions via the model's `aspect_ratio` + `resolution` extra
   *  inputs). Defaults to 1920 (16:9 production HD). */
  width?: number;
  /** Local-only — output canvas height. Defaults to 1080. */
  height?: number;
  /** Local-only — denoise strength for ref-driven workflows. Higher =
   *  more deviation from the anchor; lower = closer to a copy. Defaults
   *  to 0.7 (sweet spot for the Qwen-Image i2i workflow). */
  denoise?: number;
  /** Cloud-only opt-in (default false). When the provider returns an
   *  ambiguous content refusal (no specific ref index identified), the
   *  dispatcher splits the ref set in half and tries each side
   *  separately, recursing on the failing half. Identifies the actual
   *  offending ref within log2(N) extra calls but COSTS each split:
   *  up to ~$0.30 worst-case for 8 refs at $0.05/call. Without this
   *  flag, every ref in the dispatched call gets flagged on
   *  ambiguous refusal (false positives) — cheaper but less accurate.
   *  Recommended only when the user has explicitly asked for "find
   *  which ref is bad" rather than the default "give up". */
  bisectOnAmbiguousRefusal?: boolean;
  /** Internal — used by the bisection recursion to short-circuit when
   *  a single ref reaches the leaf. Not part of the public API. */
  _bisectionDepth?: number;
}

/**
 * Dispatch a single ref-bearing image generation. Provider-agnostic
 * entrypoint — branches on the model spec's `provider` to either:
 *
 *   - `comfyui-local` → `generateImageWithRefsLocal` (Qwen-Image i2i;
 *      single-ref, position-0 anchor, $0 marginal cost)
 *   - `kie` → cloud i2i (NanoBanana Pro / Flux 2 Pro / GPT Image 2;
 *      multi-ref, ~$0.05/image)
 *
 * `refs` is the full set of style-attached refs (already filtered for
 * `rejected_by_provider` by the caller via
 * `loadStyleReferences({ excludeRejected: true })`).
 *
 * Throws:
 *   - `ReferenceRejectedError` when the provider returns a content refusal
 *   - generic `Error` for transient / unknown failures
 */
export async function generateImageWithRefs(
  modelValue: string,
  prompt: string,
  refs: readonly StyleReferenceImage[],
  opts: GenerateImageWithRefsOptions = {},
): Promise<GenerateImageWithRefsResult> {
  const spec = getI2IModelSpec(modelValue);
  if (!spec || typeof spec.maxRefs !== 'number' || spec.maxRefs <= 0) {
    throw new Error(`generateImageWithRefs: '${modelValue}' is not an i2i-capable model`);
  }
  if (refs.length === 0) {
    throw new Error(`generateImageWithRefs: no refs supplied for '${modelValue}'`);
  }

  // Local branch — Qwen-Image i2i via ComfyUI. Single-ref by workflow
  // contract (the VAE-encoded latent only takes one anchor); cloud
  // models accept up to 8 or 16 refs depending on the variant.
  if (spec.provider === 'comfyui-local') {
    return generateImageWithRefsLocal(modelValue, prompt, refs, opts);
  }
  // Atlas Cloud branch — GPT Image 2 i2i. Cheaper invoice than Kie's
  // gpt-image-2-image-to-image for the same underlying OpenAI model.
  // Atlas's i2i returns the configured size (1536×1024 = 3:2 by
  // default) so we run the same 16:9 center-crop the t2i path uses
  // before handing off to Recraft for the system-wide upscale. Atlas
  // does not emit per-ref refusal signals, so there's no
  // `ReferenceRejectedError` classification on this path — transient
  // failures bubble up as plain Errors. See
  // _plans/2026-05-25-atlas-cloud-gpt-image-2.md (Phase 3).
  if (spec.provider === 'atlas') {
    return generateImageWithRefsAtlas(modelValue, spec, prompt, refs, opts);
  }
  if (!isKieI2ISpec(spec)) {
    throw new Error(`generateImageWithRefs: '${modelValue}' has provider='${spec.provider}' but no i2i dispatch path`);
  }
  // `spec` is now narrowed: kieModel + refsField are non-null. Below
  // code can use them without `!` assertions.

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not configured');

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error('generateImageWithRefs: empty prompt');
  if (trimmedPrompt.length > 2000) {
    throw new Error('generateImageWithRefs: prompt > 2000 chars');
  }

  // Mint presigned URLs AT DISPATCH so a slow Kie queue can't outlive
  // the URL's signed validity window. Council pattern — see Contrarian
  // unnamed-failure-mode flag in the council verdict.
  //
  // v3 (2026-05-22): built-in refs carry a `public_url` field with an
  // already-absolute URL pointing to a `/style-refs/...` static asset.
  // Use it directly — no R2 presign is possible (these refs aren't in
  // R2). DB-backed saved-style refs still go through the presign path.
  const refUrls: string[] = await Promise.all(
    refs.map((r) =>
      r.public_url
        ? Promise.resolve(r.public_url)
        : getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined),
    ),
  );
  // Trim to the model's max — the buildKieI2IInput helper also caps,
  // but trimming here keeps the `refsSent` accounting accurate.
  const refsSent = Math.min(refUrls.length, spec.maxRefs);
  const cappedRefUrls = refUrls.slice(0, refsSent);

  const input = buildKieI2IInput(modelValue, trimmedPrompt, cappedRefUrls);

  const started = Date.now();
  logger.info('[image-gen kie-i2i submit]', {
    model: modelValue,
    kie_model: spec.kieModel,
    refs_sent: refsSent,
    prompt_slice: trimmedPrompt.slice(0, 80),
  });

  let taskId: string;
  try {
    taskId = await createKieTask(apiKey, spec.kieModel, input);
  } catch (err) {
    const refusal = classifyAsReferenceRejection(err);
    if (refusal) {
      throw new ReferenceRejectedError({
        rejectedRefIds: refs.slice(0, refsSent).map((r) => r.id),
        provider: `kie:${spec.kieModel}`,
        reason: refusal,
      });
    }
    throw err;
  }

  let kieUrl: string;
  try {
    // System-wide auto-upscale runs after poll. See src/lib/upscale.ts.
    kieUrl = await pollKieResultThenUpscale(taskId, apiKey);
  } catch (err) {
    const refusal = classifyAsReferenceRejection(err);
    if (refusal) {
      throw new ReferenceRejectedError({
        rejectedRefIds: refs.slice(0, refsSent).map((r) => r.id),
        provider: `kie:${spec.kieModel}`,
        reason: refusal,
      });
    }
    throw err;
  }

  // Re-host result to R2 so the URL doesn't depend on Kie's CDN
  // retention. On mirror failure, fall back to the Kie URL — image
  // still usable until upstream expires, which is short but
  // non-zero.
  let imageUrl = kieUrl;
  let mirroredR2Key: string | undefined;
  try {
    const res = await fetch(kieUrl);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const prefix = opts.r2KeyPrefix ?? 'i2i-results';
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const r2Key = `${prefix}/${Date.now()}-${randomSuffix}.${ext}`;
      const bucket = getImagesBucket();
      await uploadToBucket(bucket, r2Key, buffer, contentType);
      imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      mirroredR2Key = r2Key;
    }
  } catch (rehostErr) {
    logger.warn('[image-gen kie-i2i rehost failed]', {
      detail: rehostErr instanceof Error ? rehostErr.message : String(rehostErr),
    });
  }

  const durationMs = Date.now() - started;
  logger.info('[image-gen kie-i2i complete]', {
    model: modelValue,
    duration_ms: durationMs,
    kie_task_id: taskId,
    refs_sent: refsSent,
    has_r2_mirror: Boolean(mirroredR2Key),
  });

  return {
    imageUrl,
    r2Key: mirroredR2Key,
    modelUsed: modelValue,
    kieTaskId: taskId,
    durationMs,
    refsSent,
  };
}

/**
 * Cloud i2i with 1-level bisection on ambiguous content refusals.
 * Wraps `generateImageWithRefs`. On the first ReferenceRejectedError,
 * splits refs into two halves and tries each separately:
 *
 *   - Only the first half succeeds → problem refs are in the second
 *     half. Re-throws with narrowed `rejectedRefIds`. The first-half
 *     result is discarded (we want full-set behaviour on retry, not
 *     partial coverage).
 *   - Only the second half succeeds → mirror.
 *   - Both succeed → original refusal was transient. Retry the full
 *     set once; if that also fails, surface the original error.
 *   - Both fail → problem refs are in both halves. Re-throw the
 *     original error unchanged (all refs flagged).
 *
 * Costs: best case +1 call ($0.05). Worst case +3 calls ($0.15) on
 * the both-succeed retry path. Opt-in only — `bisectOnAmbiguousRefusal`
 * isn't read by the base function, so this wrapper is the only way
 * to invoke the behaviour. Caller decides when the extra spend is
 * worth it (e.g. a power-user "find which ref is bad" affordance).
 *
 * NOT recursive in v1 — a 1-level split identifies WHICH half holds
 * the offender but doesn't narrow further. Full log2(N) recursion is
 * documented in `_plans/2026-05-22-v2-styles-onboarding.md` as a
 * follow-up; v1 wants the bounded-cost story.
 */
export async function generateImageWithRefsBisecting(
  modelValue: string,
  prompt: string,
  refs: readonly StyleReferenceImage[],
  opts: GenerateImageWithRefsOptions = {},
): Promise<GenerateImageWithRefsResult> {
  try {
    return await generateImageWithRefs(modelValue, prompt, refs, opts);
  } catch (err) {
    if (!(err instanceof ReferenceRejectedError)) throw err;
    if (refs.length < 2) throw err;

    const mid = Math.floor(refs.length / 2);
    const firstHalf = refs.slice(0, mid);
    const secondHalf = refs.slice(mid);

    logger.info('[image-gen kie-i2i bisection start]', {
      model: modelValue,
      total_refs: refs.length,
      first_half: firstHalf.length,
      second_half: secondHalf.length,
      original_reason: err.reason.slice(0, 200),
    });

    let firstResult: GenerateImageWithRefsResult | null = null;
    let firstRefusal: ReferenceRejectedError | null = null;
    try {
      firstResult = await generateImageWithRefs(modelValue, prompt, firstHalf, opts);
    } catch (e) {
      if (e instanceof ReferenceRejectedError) firstRefusal = e;
      else throw e;
    }

    let secondResult: GenerateImageWithRefsResult | null = null;
    let secondRefusal: ReferenceRejectedError | null = null;
    try {
      secondResult = await generateImageWithRefs(modelValue, prompt, secondHalf, opts);
    } catch (e) {
      if (e instanceof ReferenceRejectedError) secondRefusal = e;
      else throw e;
    }

    if (firstResult && !secondResult) {
      logger.info('[image-gen kie-i2i bisection narrowed]', {
        model: modelValue,
        bad_half: 'second',
        bad_ref_ids: secondHalf.map((r) => r.id),
      });
      throw new ReferenceRejectedError({
        rejectedRefIds: secondHalf.map((r) => r.id),
        provider: err.provider,
        reason: `${err.reason} (narrowed via bisection: 2nd half)`,
      });
    }
    if (secondResult && !firstResult) {
      logger.info('[image-gen kie-i2i bisection narrowed]', {
        model: modelValue,
        bad_half: 'first',
        bad_ref_ids: firstHalf.map((r) => r.id),
      });
      throw new ReferenceRejectedError({
        rejectedRefIds: firstHalf.map((r) => r.id),
        provider: err.provider,
        reason: `${err.reason} (narrowed via bisection: 1st half)`,
      });
    }
    if (firstResult && secondResult) {
      // Both halves alone succeeded — likely the original was a
      // transient flake. Retry the full set once. If THAT also fails,
      // surface the original error so the user isn't stuck looping.
      logger.info('[image-gen kie-i2i bisection both-ok retry]', { model: modelValue });
      try {
        return await generateImageWithRefs(modelValue, prompt, refs, opts);
      } catch {
        throw err;
      }
    }
    // Both halves failed — problem is in both. Surface the original
    // error which flagged all refs.
    logger.info('[image-gen kie-i2i bisection both-failed]', {
      model: modelValue,
      first_reason: firstRefusal?.reason.slice(0, 100),
      second_reason: secondRefusal?.reason.slice(0, 100),
    });
    throw err;
  }
}

/**
 * Local i2i via ComfyUI (Qwen-Image as of the 2026-05-21 local spike).
 * Single-ref by workflow contract — uses position 0 of the supplied
 * refs as the strongest anchor (matches the cloud Ideogram Remix
 * convention for single-ref models).
 *
 *   - Validates LOCAL_STUDIO=1 + ComfyUI reachability up front so the
 *     caller gets a clean 503-shaped error instead of a deep-stack
 *     fetch failure
 *   - Mints a fresh presigned R2 GET for the anchor, uploads it to
 *     ComfyUI's input/ folder via the existing uploadUrlToComfyInput
 *     helper (the local generator auto-swaps t2i → i2i variant of the
 *     workflow when `refImageFilename` is supplied)
 *   - Fetches the result bytes server-side, mirrors to R2 so the
 *     returned URL outlives the ComfyUI session
 *
 * Throws plain `Error` on infrastructure failures. Local providers
 * don't emit content-refusal signals the way Kie does, so no
 * `ReferenceRejectedError` path here — the dispatcher above handles
 * the cloud-only refusal classification.
 */
export async function generateImageWithRefsLocal(
  modelValue: string,
  prompt: string,
  refs: readonly StyleReferenceImage[],
  opts: GenerateImageWithRefsOptions = {},
): Promise<GenerateImageWithRefsResult> {
  const spec = getI2IModelSpec(modelValue);
  if (!spec || spec.provider !== 'comfyui-local' || !spec.localWorkflowId) {
    throw new Error(`generateImageWithRefsLocal: '${modelValue}' is not a local ComfyUI i2i model`);
  }
  if (refs.length === 0) {
    throw new Error(`generateImageWithRefsLocal: no refs supplied for '${modelValue}'`);
  }
  if (process.env.LOCAL_STUDIO !== '1') {
    throw new Error('LOCAL_STUDIO=1 must be set to run local i2i generation. Start the dev server with `$env:LOCAL_STUDIO=1; npm run dev` with ComfyUI on localhost:8188.');
  }
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error('generateImageWithRefsLocal: empty prompt');

  // Dynamic imports keep the cloud path's bundle slim — these modules
  // pull in workflow JSON templates eagerly at module init and aren't
  // needed when the cloud branch wins above.
  const { ComfyUILocalGenerator } = await import('./visual-generator/comfyui-local');
  const { ComfyUIClient } = await import('./comfyui/client');
  const { uploadUrlToComfyInput } = await import('./comfyui/upload');

  const generator = new ComfyUILocalGenerator();
  if (!(await generator.isReachable())) {
    throw new Error('ComfyUI not reachable on localhost:8188 — start it and try again.');
  }

  // Mint fresh presigned URLs + upload to ComfyUI's input/ so the
  // workflow's LoadImage nodes can find them by filename. Number of
  // refs uploaded = min(refs.length, spec.maxRefs). Position 0 is the
  // strongest anchor by ref-ordering convention. R2 presigned TTL is
  // 7 days by default — plenty for a single ComfyUI run.
  //
  // v3 (2026-05-22): built-in refs carry an absolute `public_url` —
  // use it directly. ComfyUI fetches the URL from its host (which
  // for local-studio is the user's PC) so the URL must be absolute.
  const refsToUpload = refs.slice(0, spec.maxRefs);
  const refImageFilenames: string[] = await Promise.all(
    refsToUpload.map(async (r) => {
      const url = r.public_url
        ? r.public_url
        : await getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined);
      return uploadUrlToComfyInput(url, {
        filenamePrefix: `style-ref-${r.style_id.slice(0, 8)}-${r.position}`,
      });
    }),
  );

  const width = opts.width ?? 1920;
  const height = opts.height ?? 1080;
  const denoise = opts.denoise ?? 0.7;

  const started = Date.now();
  logger.info('[image-gen comfyui-i2i submit]', {
    model: modelValue,
    workflow: spec.localWorkflowId,
    width,
    height,
    denoise,
    refs_uploaded: refImageFilenames.length,
    anchor_r2_key: refsToUpload[0].r2_key,
    prompt_slice: trimmedPrompt.slice(0, 80),
  });

  const localResult = await generator.generateImage(trimmedPrompt, {
    workflowId: spec.localWorkflowId,
    width,
    height,
    // Multi-ref path for workflows that accept it (Qwen-Image-Edit-2509);
    // single-ref legacy workflows ignore this and read refImageFilename
    // instead. Setting both is harmless — generateImage picks based on
    // workflowId.
    refImageFilenames,
    refImageFilename: refImageFilenames[0],
    denoise,
  });

  // Fetch result bytes from ComfyUI's /view endpoint for R2 mirroring.
  // The proxy URL the generator returns is localhost-only by contract;
  // mirroring to R2 makes it portable.
  let imageBuffer: Buffer | null = null;
  try {
    const m = localResult.url.match(/\bfilename=([^&]+).*?subfolder=([^&]*).*?type=([^&]+)/);
    if (m) {
      const comfy = new ComfyUIClient();
      const { bytes } = await comfy.fetchOutputBytes({
        filename: decodeURIComponent(m[1]),
        subfolder: decodeURIComponent(m[2]),
        type: decodeURIComponent(m[3]) as 'output' | 'temp' | 'input',
      });
      imageBuffer = Buffer.from(bytes);
    }
  } catch (fetchErr) {
    logger.warn('[image-gen comfyui-i2i bytes-fetch failed]', {
      detail: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
    });
  }

  // R2 mirror. Falls back to the ComfyUI proxy URL on mirror failure —
  // image still viewable while LOCAL_STUDIO=1, just not portable.
  let imageUrl = localResult.url;
  let mirroredR2Key: string | undefined;
  if (imageBuffer) {
    try {
      const prefix = opts.r2KeyPrefix ?? 'i2i-results-local';
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const r2Key = `${prefix}/${Date.now()}-${randomSuffix}.png`;
      const bucket = getImagesBucket();
      await uploadToBucket(bucket, r2Key, imageBuffer, 'image/png');
      imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      mirroredR2Key = r2Key;
    } catch (mirrorErr) {
      logger.warn('[image-gen comfyui-i2i r2-mirror failed]', {
        detail: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
      });
    }
  }

  const durationMs = Date.now() - started;
  logger.info('[image-gen comfyui-i2i complete]', {
    model: modelValue,
    duration_ms: durationMs,
    has_r2_mirror: Boolean(mirroredR2Key),
  });

  return {
    imageUrl,
    r2Key: mirroredR2Key,
    modelUsed: modelValue,
    durationMs,
    refsSent: refImageFilenames.length,
  };
}

/**
 * Atlas Cloud i2i. Same multi-image input shape as Atlas Edit; the
 * caller's `refs` array becomes the `images` field in the Atlas
 * request (capped at `spec.maxRefs`, conservative 4 for v1). Atlas
 * I2I returns the requested size (1536×1024 default = 3:2), so this
 * helper:
 *
 *   1. Generates via Atlas → vendor URL at 3:2.
 *   2. Crops to 16:9 via `cropTo16x9AndUpload` → intermediate R2 URL
 *      (1536×864).
 *   3. Hands the cropped URL to `upscaleViaRecraft` → Recraft CDN URL
 *      at ~4×.
 *   4. Mirrors the final upscaled bytes to R2 under `i2i-results/...`
 *      so the URL outlives Recraft's CDN retention.
 *
 * No `ReferenceRejectedError` path — Atlas does not emit per-ref
 * refusal signals the way Kie does, so a generic refusal surfaces as
 * a plain `Error`. The bisection wrapper above won't engage for this
 * provider because no rejection is ever thrown to catch.
 */
async function generateImageWithRefsAtlas(
  modelValue: string,
  spec: I2IModelSpec,
  prompt: string,
  refs: readonly StyleReferenceImage[],
  opts: GenerateImageWithRefsOptions,
): Promise<GenerateImageWithRefsResult> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error('generateImageWithRefs: empty prompt');
  if (trimmedPrompt.length > 2000) {
    throw new Error('generateImageWithRefs: prompt > 2000 chars');
  }

  // Mint URLs for refs. Built-in refs (per the v3 2026-05-22 shim)
  // carry a `public_url` to a static asset; DB-backed refs get a
  // freshly presigned R2 GET.
  const refUrls: string[] = await Promise.all(
    refs.map((r) =>
      r.public_url
        ? Promise.resolve(r.public_url)
        : getDownloadUrlForBucket(r.r2_bucket, r.r2_key, undefined),
    ),
  );
  const refsSent = Math.min(refUrls.length, spec.maxRefs);
  const cappedRefUrls = refUrls.slice(0, refsSent);

  const started = Date.now();
  logger.info('[image-gen atlas-i2i submit]', {
    model: modelValue,
    atlas_model: spec.atlasModel,
    refs_sent: refsSent,
    prompt_slice: trimmedPrompt.slice(0, 80),
  });

  const size = spec.atlasSize ?? '2560x1440';
  const quality = spec.atlasQuality ?? 'low';
  const atlasResult = await generateAtlasI2I({
    prompt: trimmedPrompt,
    images: cappedRefUrls,
    size,
    quality,
  });

  // Native-16:9 fast path mirrors the t2i dispatcher: skip BOTH the
  // crop step and the Recraft upscale when Atlas returned a 16:9
  // source already (2K is the pipeline target — see the comment in
  // image-gen-dispatch.ts). For smaller Atlas sizes (square / 3:2),
  // the crop+upscale path runs as before.
  let preMirrorUrl: string;
  if (ATLAS_NATIVE_16X9_SIZES.has(size)) {
    logger.info('[image-gen atlas-i2i native-16x9 skip-upscale]', {
      size,
      model: modelValue,
    });
    preMirrorUrl = atlasResult.url;
  } else {
    const croppedUrl = await cropTo16x9AndUpload(atlasResult.url, 'i2i-results-atlas-crop');
    const upscale = await upscaleViaRecraft(croppedUrl);
    preMirrorUrl = upscale.url;
  }

  // Final mirror — same shape as the kie i2i path so the result
  // record's `r2Key` / `imageUrl` semantics line up.
  let imageUrl = preMirrorUrl;
  let mirroredR2Key: string | undefined;
  try {
    const res = await fetch(preMirrorUrl);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') ?? 'image/jpeg';
      const ext = contentType.includes('png') ? 'png' : 'jpg';
      const prefix = opts.r2KeyPrefix ?? 'i2i-results';
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const r2Key = `${prefix}/${Date.now()}-${randomSuffix}.${ext}`;
      const bucket = getImagesBucket();
      await uploadToBucket(bucket, r2Key, buffer, contentType);
      imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      mirroredR2Key = r2Key;
    }
  } catch (rehostErr) {
    logger.warn('[image-gen atlas-i2i rehost failed]', {
      detail: rehostErr instanceof Error ? rehostErr.message : String(rehostErr),
    });
  }

  const durationMs = Date.now() - started;
  logger.info('[image-gen atlas-i2i complete]', {
    model: modelValue,
    duration_ms: durationMs,
    prediction_id: atlasResult.predictionId,
    predict_ms: atlasResult.predictTimeMs,
    refs_sent: refsSent,
    has_r2_mirror: Boolean(mirroredR2Key),
  });

  return {
    imageUrl,
    r2Key: mirroredR2Key,
    modelUsed: modelValue,
    durationMs,
    refsSent,
  };
}

/**
 * Detect whether a Kie error message indicates the call was refused
 * for content reasons (NSFW, copyright, safety filter) rather than a
 * transient infrastructure failure. The phrases below come from
 * empirically-observed Kie error responses during the Phase 0 spike
 * (e.g. Flux 2 Pro p06: "The input or output was flagged as
 * sensitive. Please try again with different inputs."). The list is
 * conservative — adding a phrase causes a generic failure to be
 * promoted to a `ReferenceRejectedError`, so false positives waste
 * the user's "Clear rejection" click. False negatives just show a
 * generic error message to the user.
 */
function classifyAsReferenceRejection(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  // Word-boundary anchored regex patterns instead of raw substring
  // matching. Substring matching tripped on:
  //   - URL fragments containing "nsfw" (e.g. cdn-nsfw-block.example)
  //   - "network policy violation" (a K8s egress error, not a content
  //     refusal — would be misclassified as one and silently flag all
  //     refs as rejected)
  //   - "invalid input: image dimensions exceed limit" (a sizing
  //     transient — would also be misclassified).
  // The patterns below use `\b` word boundaries + adjacent context
  // words so each match is unambiguous.
  const patterns = [
    /\bflagged\b[^.]*\bsensitive\b/i,
    /\bsensitive\b[^.]*\b(content|input|output)\b/i,
    /\bcontent\b[^.]*\b(refus(?:ed|al)|moderation|policy)\b/i,
    /\bsafety\b[^.]*\bfilter\b/i,
    /\bnsfw\b[^.]*\b(content|detected|flagged|filter)\b/i,
    /\b(content|usage|moderation)\s+policy\s+violat/i,
    /\bcopyright(?:ed)?\b[^.]*\b(content|material|owner)\b/i,
    /\bunsupported\b[^.]*\b(reference|image|input)\b/i,
    /\b(invalid|inappropriate)\b[^.]*\binput\s+image\b/i,
  ];
  if (patterns.some((p) => p.test(msg))) {
    // Strip the verbose "Kie.ai: " prefix the kie-poll helper adds.
    return msg.replace(/^Kie\.ai:\s*/i, '').slice(0, 500);
  }
  return null;
}
