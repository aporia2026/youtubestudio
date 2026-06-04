/**
 * Vendor-agnostic dispatcher for the GPT Image 2 Edit operation.
 *
 * Two backends today, one operation:
 *   - Atlas Cloud's `openai/gpt-image-2/edit` endpoint (~$0.011/call).
 *   - Kie.ai's `gpt-image-2-image-to-image` endpoint (~$0.05/call).
 *     Kie has no dedicated "edit" route in the GPT Image 2 family —
 *     verified against docs.kie.ai 2026-05-29. Their i2i endpoint with
 *     a single `input_urls` entry is the functional equivalent.
 *
 * One helper used by every Atlas-Edit consumer (editor variant button,
 * pipeline variant generation, character-cache continuation,
 * scene-cache continuation, paint_explainer_v1 mouth removal). Reads
 * the user's `gpt_image_2_edit_primary` setting; tries the primary;
 * falls back to the other on failure.
 *
 * See `_plans/2026-05-29-gpt-image-2-edit-provider-fallback.md`.
 *
 * ─── Per-vendor quirks the dispatcher absorbs ────────────────────────
 * - **Output aspect.** Atlas Edit returns 1536×1024 (3:2) and callers
 *   currently center-crop to 16:9 (1536×864) downstream. Kie i2i can
 *   request `aspect_ratio: '16:9'` + `resolution: '1K'` directly and
 *   returns 16:9 already. To keep call-site code identical, the
 *   dispatcher runs the crop step inline for the Atlas branch only.
 *   Callers receive a 16:9 URL regardless of which vendor served.
 * - **Cost.** Reported as `0.011` for Atlas, `0.05` for Kie — the
 *   caller can pass `costUsd` straight into `markDelivered` without
 *   knowing which vendor ran.
 * - **Telemetry.** `vendorUsed` reflects the vendor that actually
 *   served; `fallbackUsed` is true when the primary failed and the
 *   fallback succeeded. `provider_generations` rows should set
 *   `provider` from `vendorUsed`, not from the configured primary, so
 *   the cost dashboard groups by the invoice that will actually arrive.
 *
 * ─── Failure posture ─────────────────────────────────────────────────
 * Primary failure → `warn` log + try fallback. Both fail → `error` log
 * + throw with both error messages preserved. Caller's `markFailed`
 * receives the combined message so the audit row carries the full
 * trace for post-mortem.
 *
 * ─── Observability (rule 14) ─────────────────────────────────────────
 * Every call emits namespaced `[gpt2-edit ...]` lines:
 *   - `[gpt2-edit dispatch] start`
 *   - `[gpt2-edit dispatch] primary-ok` OR
 *   - `[gpt2-edit fallback] primary-failed` (warn)
 *   - `[gpt2-edit fallback] fallback-ok` OR
 *   - `[gpt2-edit dispatch] both-failed` (error)
 */
import { generateAtlasEdit } from './atlas-cloud-images';
import { createKieTask, pollKieResult } from './kie-poll';
import { cropToAspectAndUpload } from './image-gen-dispatch';
import { logger } from './logger';

export type Gpt2EditVendor = 'atlas' | 'kie';

/** Target output aspect for the edit operation.
 *
 *  - `'16:9'` — long-form video pipeline default. Atlas requests
 *    `1536×1024` (3:2) then center-crops to `1536×864`; Kie i2i
 *    requests `aspect_ratio: '16:9'` natively.
 *  - `'9:16'` — Shorts pipeline. Atlas requests `1024×1536` (2:3,
 *    portrait) then center-crops to `864×1536`; Kie i2i requests
 *    `aspect_ratio: '9:16'` natively.
 *
 *  Atlas's GPT Image 2 Edit `size` enum doesn't include native 9:16, so
 *  the 9:16 path always pays for the crop step. The crop loss is ~16%
 *  of width — acceptable since the planner prompt already places the
 *  subject in the middle 60% safe zone. */
export type Gpt2EditAspect = '16:9' | '9:16';

export interface Gpt2EditOpts {
  /** The edit instruction. Vendor-neutral text — the dispatcher does
   *  not append per-vendor prompt suffixes. The pipeline's existing
   *  composer (`composeVariantEditRequest` etc.) owns prompt shape. */
  prompt: string;
  /** Primary source image URL for the edit. This is the image the model
   *  treats as "the image to modify." For most callers this is the only
   *  input; the motion_collage chained-edit path adds `extraImageUrls`
   *  to anchor composition. */
  sourceImageUrl: string;
  /** Optional extra image URLs appended after `sourceImageUrl` in the
   *  vendor's input array. Used by the motion_collage pipeline to pass
   *  the panel-0 composition anchor alongside the previous-panel motion
   *  source: `sourceImageUrl = previousPanelUrl`,
   *  `extraImageUrls = [panel0Url]`. Order matters — both vendors
   *  receive `[sourceImageUrl, ...extraImageUrls]` and the prompt must
   *  spell out which input is which. */
  extraImageUrls?: readonly string[];
  /** User's configured primary vendor. The dispatcher tries this
   *  first; the other vendor is the fallback. Read from
   *  `UserSettings.gpt_image_2_edit_primary` server-side, or from the
   *  editor's localStorage mirror client-side. */
  primary: Gpt2EditVendor;
  /** Target output aspect ratio. Defaults to `'16:9'` for back-compat
   *  with the long-form video pipeline; Shorts callers pass `'9:16'`
   *  so the variant frames don't get cropped 67% wider when dropped
   *  into the 9:16 viewport. See `Gpt2EditAspect` for what each value
   *  does per vendor. */
  aspectRatio?: Gpt2EditAspect;
  /** R2 key prefix for the cropped Atlas intermediate. Only used when
   *  Atlas served the call. Defaults to the same prefix the legacy
   *  callers used so the R2 layout doesn't change. */
  atlasCropR2Prefix?: string;
}

export interface Gpt2EditResult {
  /** Final image URL at 16:9 aspect. Already cropped when Atlas served
   *  (Kie returns 16:9 natively). Callers run their own Recraft upscale
   *  + R2 mirror chain on this URL — the dispatcher deliberately stops
   *  before upscale so the per-call cost stays attributable. */
  url: string;
  /** Which vendor actually served the call. May differ from `primary`. */
  vendorUsed: Gpt2EditVendor;
  /** True iff the primary failed AND the fallback succeeded. False
   *  when the primary served (regardless of how the fallback would
   *  have behaved). */
  fallbackUsed: boolean;
  /** Per-vendor flat cost. Atlas Edit is token-billed but tracked as
   *  $0.011 to match existing audit-row accounting; Kie i2i is $0.05.
   *  Caller passes this into `markDelivered` directly. */
  costUsd: number;
  /** Total time spent in the dispatcher (start to vendor-success), in
   *  ms. Includes the failed primary attempt when fallback fired. */
  durationMs: number;
  /** Atlas prediction id or Kie task id from the successful call. Null
   *  only when we have no id (shouldn't happen on success). */
  providerRequestId: string | null;
}

/** Atlas Edit price per call. Token-billed in practice; this flat
 *  estimate matches the value the existing pipeline call sites pass
 *  into `markDelivered`. See atlas-cloud-images.ts head-of-file. */
const ATLAS_EDIT_COST_USD = 0.011;

/** Kie `gpt-image-2-image-to-image` price per call. Per
 *  image-models-i2i.ts:151 annotation. Kie's docs page omits the
 *  public price; this is the codebase's running estimate. Tracked in
 *  the plan's "open questions" as something to verify against the
 *  live Kie dashboard. */
const KIE_I2I_COST_USD = 0.05;

const DEFAULT_ATLAS_CROP_PREFIX = 'prodoc-images-atlas-crop';

/**
 * Run the GPT Image 2 edit operation via the user's primary vendor;
 * fall back to the other vendor on failure. See file-level doc for
 * design + observability contract.
 *
 * Throws iff BOTH vendors fail. The thrown error message concatenates
 * both failures so the caller's `markFailed` audit row carries the
 * full diagnostic. The original primary/fallback log lines remain
 * grep-able under the `[gpt2-edit ...]` namespace.
 */
export async function generateGptImage2Edit(opts: Gpt2EditOpts): Promise<Gpt2EditResult> {
  const t0 = Date.now();
  const { prompt, sourceImageUrl, primary } = opts;
  const extraImageUrls = opts.extraImageUrls ?? [];
  const aspectRatio: Gpt2EditAspect = opts.aspectRatio ?? '16:9';
  const atlasCropPrefix = opts.atlasCropR2Prefix ?? DEFAULT_ATLAS_CROP_PREFIX;
  const fallback: Gpt2EditVendor = primary === 'atlas' ? 'kie' : 'atlas';

  console.info('[gpt2-edit dispatch] start', {
    primary,
    fallback,
    aspect_ratio: aspectRatio,
    prompt_chars: prompt.length,
    source_url_len: sourceImageUrl.length,
    extra_image_count: extraImageUrls.length,
  });

  let primaryError: string | null = null;
  try {
    const result = await runVendor(primary, { prompt, sourceImageUrl, extraImageUrls, aspectRatio, atlasCropPrefix });
    console.info('[gpt2-edit dispatch] primary-ok', {
      primary,
      duration_ms: Date.now() - t0,
      cost_usd: result.costUsd,
    });
    return {
      url: result.url,
      vendorUsed: primary,
      fallbackUsed: false,
      costUsd: result.costUsd,
      durationMs: Date.now() - t0,
      providerRequestId: result.providerRequestId,
    };
  } catch (err) {
    primaryError = err instanceof Error ? err.message : String(err);
    // warn-level: fallback firing means the primary vendor failed,
    // which costs ~4.5× more per call when Atlas is primary and we
    // shift to Kie. The user needs to see this so a sustained outage
    // is debuggable from the console instead of from the invoice.
    logger.warn('[gpt2-edit fallback] primary-failed', {
      primary,
      reason: primaryError.slice(0, 240),
    });
  }

  try {
    const result = await runVendor(fallback, { prompt, sourceImageUrl, extraImageUrls, aspectRatio, atlasCropPrefix });
    console.info('[gpt2-edit fallback] fallback-ok', {
      fallback,
      duration_ms: Date.now() - t0,
      cost_usd: result.costUsd,
    });
    return {
      url: result.url,
      vendorUsed: fallback,
      fallbackUsed: true,
      costUsd: result.costUsd,
      durationMs: Date.now() - t0,
      providerRequestId: result.providerRequestId,
    };
  } catch (fallbackErr) {
    const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    // error-level: both vendors failing means whatever called us
    // either drops the row or surfaces a hard error to the user. The
    // log line carries both vendor messages so the post-mortem can
    // see what each one said without re-running.
    logger.error('[gpt2-edit dispatch] both-failed', {
      primary,
      fallback,
      primary_reason: primaryError?.slice(0, 240) ?? '(unknown)',
      fallback_reason: fallbackMessage.slice(0, 240),
    });
    throw new Error(
      `GPT Image 2 edit failed on both vendors. ${primary}: ${primaryError ?? '(unknown)'} | ${fallback}: ${fallbackMessage}`,
    );
  }
}

interface VendorRunOpts {
  prompt: string;
  sourceImageUrl: string;
  extraImageUrls: readonly string[];
  aspectRatio: Gpt2EditAspect;
  atlasCropPrefix: string;
}

interface VendorRunResult {
  url: string;
  providerRequestId: string | null;
  costUsd: number;
}

/** Execute a single vendor attempt. Atlas → generateAtlasEdit + aspect
 *  crop. Kie → createKieTask('gpt-image-2-image-to-image') + poll with
 *  native aspect_ratio. Throws on any vendor error; the dispatcher
 *  catches and decides whether to try the other side. */
async function runVendor(
  vendor: Gpt2EditVendor,
  opts: VendorRunOpts,
): Promise<VendorRunResult> {
  if (vendor === 'atlas') {
    // Atlas Edit's documented size enum is 1024x1024 / 1024x1536 /
    // 1536x1024 (see image-edit-pricing.ts for the 2026-05-27
    // verification that wider sizes 404). For 16:9 we ask for the
    // landscape 1536×1024 and crop. For 9:16 we ask for the portrait
    // 1024×1536 — closer to target aspect (2:3 vs 3:2 was for 16:9),
    // so the post-crop loss is ~16% of width instead of ~63%.
    const atlasSize = opts.aspectRatio === '9:16' ? '1024x1536' : '1536x1024';
    const result = await generateAtlasEdit({
      prompt: opts.prompt,
      images: [opts.sourceImageUrl, ...opts.extraImageUrls],
      size: atlasSize,
      quality: 'low',
    });
    const [aspectW, aspectH] = opts.aspectRatio === '9:16' ? [9, 16] : [16, 9];
    const croppedUrl = await cropToAspectAndUpload(
      result.url,
      opts.atlasCropPrefix,
      aspectW,
      aspectH,
    );
    return {
      url: croppedUrl,
      providerRequestId: result.predictionId ?? null,
      costUsd: ATLAS_EDIT_COST_USD,
    };
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    throw new Error('KIE_API_KEY is not configured');
  }
  const taskId = await createKieTask(apiKey, 'gpt-image-2-image-to-image', {
    prompt: opts.prompt,
    input_urls: [opts.sourceImageUrl, ...opts.extraImageUrls],
    aspect_ratio: opts.aspectRatio,
    resolution: '1K',
  });
  const url = await pollKieResult(taskId, apiKey);
  return {
    url,
    providerRequestId: taskId,
    costUsd: KIE_I2I_COST_USD,
  };
}

/** Public cost constants — re-exported for the picker label + cost
 *  dashboards that surface "expected ~$X/edit" before the user clicks. */
export { ATLAS_EDIT_COST_USD, KIE_I2I_COST_USD };
