/**
 * Client-side fan-out helpers for multi-variant thumbnail generation.
 *
 * Phase 1 strategy: fire N parallel POST requests to the existing
 * single-image route (`/api/thumbnails/image`) and collect the results
 * into a `ThumbnailVariant[]`. The existing per-route rate limit
 * (5 req/min/IP) doubles as a variant rate limit — at 3 variants per
 * generate, a user can fire ~5 generates/min = 15 image calls/min,
 * comfortably under any provider's per-minute ceiling.
 *
 * Phase 3 will replace this with a server-side coordinated route once
 * the LLM-driven formats (topic-card-grid, n-levels, flex-icon-grid,
 * doodle-explainer) need partial-failure handling tied to a single
 * provider_generations transaction. Keeping the client-side helper
 * isolated here makes that swap a one-import change.
 *
 * Plan: `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`.
 */

import { buildVariant, type ThumbnailVariant } from './thumbnail-variants';

export interface VariantFanOutInput {
  /** Image model id matching `MODEL_MAP` in
   *  `src/app/api/thumbnails/image/route.ts`. */
  model: string;
  /** Prompt used when `perturbations` is absent / undefined for a
   *  given index. Free-form flow passes the user's prompt here and
   *  leaves `perturbations` undefined, relying on the image model's
   *  inherent variance to produce 3 distinct outputs. */
  basePrompt: string;
  /** Number of variants to generate. Caller is expected to have
   *  already clamped to [MIN_VARIANT_COUNT, MAX_VARIANT_COUNT] via
   *  `clampVariantCount` — the fan-out here trusts the input. */
  variantCount: number;
  /** Optional reference image URL for i2i models. Passed through
   *  verbatim to the API route, which applies its own SSRF guard. */
  referenceImageUrl?: string;
  /** Per-variant prompt override. When set and `perturbations[i]` is
   *  a non-empty string, variant i uses it instead of `basePrompt`.
   *  Phase 2+ (LLM-driven formats) populates this with 3 structurally
   *  distinct prompts. Phase 1 (free-form) leaves this undefined. */
  perturbations?: Array<string | undefined>;
  /** Optional per-variant concept label — surfaced under each variant
   *  in the `VariantPicker`. Same length contract as `perturbations`. */
  conceptLabels?: Array<string | undefined>;
}

export interface VariantFanOutResult {
  variants: ThumbnailVariant[];
  failedCount: number;
}

/**
 * Fan out N parallel image-gen calls. Always returns — partial-failure
 * variants come back with `imageUrl === ''` so the picker can render an
 * empty slot with a retry button. The caller decides whether `failedCount
 * === variantCount` should surface as an error toast or not (typically
 * yes — all-failed means the generate click produced nothing to pick).
 */
export async function fanOutImageVariants(input: VariantFanOutInput): Promise<VariantFanOutResult> {
  const { model, basePrompt, variantCount, referenceImageUrl, perturbations, conceptLabels } = input;
  const prompts = Array.from({ length: variantCount }, (_, i) => {
    const override = perturbations?.[i];
    return override && override.length > 0 ? override : basePrompt;
  });

  console.info('[thumb-variants-client fan-out] start', {
    model,
    variantCount,
    hasRef: !!referenceImageUrl,
    distinctPrompts: new Set(prompts).size,
  });

  const startedAt = Date.now();
  const calls = prompts.map(prompt => callSingleImageRoute({ model, prompt, referenceImageUrl }));
  const results = await Promise.allSettled(calls);

  const variants: ThumbnailVariant[] = results.map((r, idx) => buildVariant({
    index: idx,
    imageUrl: r.status === 'fulfilled' ? r.value.imageUrl : '',
    promptUsed: prompts[idx],
    conceptLabel: conceptLabels?.[idx],
  }));
  const failedCount = variants.filter(v => !v.imageUrl).length;

  console.info('[thumb-variants-client fan-out] done', {
    model,
    variantCount,
    failedCount,
    durationMs: Date.now() - startedAt,
    failures: results
      .map((r, i) => r.status === 'rejected'
        ? { idx: i, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }
        : null)
      .filter(Boolean),
  });

  return { variants, failedCount };
}

/**
 * Regenerate a single variant slot. Called from the `VariantPicker`
 * when the user clicks "Try again" on an empty / unwanted slot. Returns
 * the new variant; caller splices it into the existing array at the
 * given index.
 */
export async function regenerateSingleVariant(input: {
  model: string;
  prompt: string;
  index: number;
  referenceImageUrl?: string;
  conceptLabel?: string;
}): Promise<ThumbnailVariant> {
  console.info('[thumb-variants-client regenerate-slot] start', { model: input.model, index: input.index });
  const startedAt = Date.now();
  const { imageUrl } = await callSingleImageRoute({
    model: input.model,
    prompt: input.prompt,
    referenceImageUrl: input.referenceImageUrl,
  });
  console.info('[thumb-variants-client regenerate-slot] done', {
    model: input.model,
    index: input.index,
    durationMs: Date.now() - startedAt,
  });
  return buildVariant({
    index: input.index,
    imageUrl,
    promptUsed: input.prompt,
    conceptLabel: input.conceptLabel,
  });
}

async function callSingleImageRoute(input: {
  model: string;
  prompt: string;
  referenceImageUrl?: string;
}): Promise<{ imageUrl: string }> {
  const res = await fetch('/api/thumbnails/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      referenceImageUrl: input.referenceImageUrl || undefined,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json() as { imageUrl?: string };
  if (!json.imageUrl) {
    throw new Error('image route returned no imageUrl');
  }
  return { imageUrl: json.imageUrl };
}

/**
 * Fan out an existing format-image route (topic-card-grid, n-levels,
 * flex-icon-grid) N times in parallel with the SAME request body.
 *
 * Phase 3 trade-off (2026-06-09): the LLM step still produces ONE
 * card-list / level-list per generate. The N variants come from
 * image-model variance on identical inputs — so the variants share
 * labels + palette but differ on composition / line-quality / layout
 * jitter. This is an honest partial fulfillment of the user's Q3 spec
 * ("variants differ on label + palette + composition") in exchange for
 * a much lighter Phase 3: no LLM-route refactor, no per-format schema
 * change. A future Phase 5 can extend the LLM step to emit N distinct
 * card-lists for full multi-axis variants.
 *
 * Returns the FIRST result alongside the variants array so the caller
 * can keep its existing single-result code path (it just becomes
 * variants[0]).
 */
export async function fanOutFormatImageRoute<TResponse extends { imageUrl: string }>(input: {
  routeUrl: string;
  body: unknown;
  variantCount: number;
  /** Optional concept labels per variant — surfaced in the picker. */
  conceptLabels?: string[];
}): Promise<{
  variants: ThumbnailVariant[];
  failedCount: number;
  /** The first successful raw response, for callers that need fields
   *  beyond imageUrl (regions, layout, etc.). */
  firstSuccess: TResponse | null;
}> {
  const { routeUrl, body, variantCount, conceptLabels } = input;
  console.info('[thumb-format-variants fan-out] start', { routeUrl, variantCount });
  const startedAt = Date.now();

  const calls = Array.from({ length: variantCount }, () =>
    fetch(routeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      return r.json() as Promise<TResponse>;
    }),
  );

  const results = await Promise.allSettled(calls);
  const variants: ThumbnailVariant[] = results.map((r, idx) => buildVariant({
    index: idx,
    imageUrl: r.status === 'fulfilled' ? r.value.imageUrl : '',
    promptUsed: `(format route: ${routeUrl})`, // routes own the prompt internally
    conceptLabel: conceptLabels?.[idx],
  }));
  const failedCount = variants.filter(v => !v.imageUrl).length;
  const firstSuccess = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<TResponse> | undefined)?.value ?? null;

  console.info('[thumb-format-variants fan-out] done', {
    routeUrl,
    variantCount,
    failedCount,
    durationMs: Date.now() - startedAt,
  });

  return { variants, failedCount, firstSuccess };
}
