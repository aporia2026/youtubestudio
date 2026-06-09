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
  /** Optional per-variant body override. Receives the variant index
   *  (0..variantCount-1) and returns the body for that call. When
   *  omitted, every call uses `body` verbatim. Used by the TCG / NL
   *  panels to perturb the palette per variant (palette axis variance). */
  bodyPerVariant?: (index: number) => unknown;
}): Promise<{
  variants: ThumbnailVariant[];
  failedCount: number;
  /** The first successful raw response, for callers that need fields
   *  beyond imageUrl (regions, layout, etc.). */
  firstSuccess: TResponse | null;
}> {
  const { routeUrl, body, variantCount, conceptLabels, bodyPerVariant } = input;
  console.info('[thumb-format-variants fan-out] start', {
    routeUrl,
    variantCount,
    perVariantBody: !!bodyPerVariant,
  });
  const startedAt = Date.now();

  const calls = Array.from({ length: variantCount }, (_, idx) => {
    // Resolve the per-variant body once and defensively — a thrown
    // callback or a non-serializable return value would otherwise
    // crash the whole fan-out before any request fires. Treat
    // resolution failure as a per-variant failure (empty url) so
    // sibling variants still get their chance.
    let resolvedBody: unknown;
    try {
      resolvedBody = bodyPerVariant ? bodyPerVariant(idx) : body;
      // JSON.stringify catches circular refs / BigInt up-front so the
      // failure mode is "this variant fails" not "all variants fail".
      JSON.stringify(resolvedBody);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return Promise.reject(new Error(`bodyPerVariant(${idx}) failed: ${reason}`));
    }
    return fetch(routeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolvedBody),
    }).then(async r => {
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      return r.json() as Promise<TResponse>;
    });
  });

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

/**
 * Produces a deterministic perturbation of a 3-color palette based on
 * variant index. Used by the TCG / N-Levels fan-out so each variant
 * goes to the image model with a structurally different palette.
 *
 *   - index 0: original palette (no change)
 *   - index 1: swap primary_accent ↔ secondary_accent
 *   - index 2: rotate every color's HSL hue by 180° (complement)
 *
 * Deterministic so re-running the same generate produces the same
 * palette set — useful when debugging "why did variant 2 look like
 * that" via the saved promptUsed field.
 */
export function perturbPalette(
  base: { background: string; primary_accent: string; secondary_accent: string },
  index: number,
): { background: string; primary_accent: string; secondary_accent: string } {
  switch (index) {
    case 0:
      return base;
    case 1:
      return {
        background: base.background,
        primary_accent: base.secondary_accent,
        secondary_accent: base.primary_accent,
      };
    case 2:
      return {
        background: rotateHexHue(base.background, 180),
        primary_accent: rotateHexHue(base.primary_accent, 180),
        secondary_accent: rotateHexHue(base.secondary_accent, 180),
      };
    default:
      // VariantCount is clamped to [1,3] elsewhere; defensive fallback.
      return base;
  }
}

/**
 * Rotates a hex color's HSL hue by `degrees`. Returns the lowercased
 * hex (#rrggbb). Falls back to the input unchanged when the hex can't
 * be parsed — defensive against legacy entries with malformed palette
 * strings.
 */
export function rotateHexHue(hex: string, degrees: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const n = parseInt(match[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const { h, s, l } = rgbToHsl(r, g, b);
  const nextH = ((h + degrees) % 360 + 360) % 360;
  const { r: nr, g: ng, b: nb } = hslToRgb(nextH, s, l);
  return `#${[nr, ng, nb].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (h < 60) { rp = c; gp = x; bp = 0; }
  else if (h < 120) { rp = x; gp = c; bp = 0; }
  else if (h < 180) { rp = 0; gp = c; bp = x; }
  else if (h < 240) { rp = 0; gp = x; bp = c; }
  else if (h < 300) { rp = x; gp = 0; bp = c; }
  else { rp = c; gp = 0; bp = x; }
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}
