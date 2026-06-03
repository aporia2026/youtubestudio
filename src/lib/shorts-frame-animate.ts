/**
 * Shorts frame animation — Phase 15.16.
 *
 * Wraps the b-roll i2v wire layer (Kie) so the Shots panel can take
 * any base or variant frame and animate it into a 2-10s motion clip.
 * Deliberately does NOT write a `broll_clips` row: the b-roll system
 * carries production-doc-specific state (row signature, doc id, etc.)
 * that Shorts doesn't need. We poll synchronously inside the route
 * (under the existing `maxDuration = 300` ceiling) and persist the
 * result on `shorts.style_assets` instead.
 *
 * Model choice: the user's `default_broll_i2v_model_id` setting wins
 * when no body override is supplied. The registry from
 * `broll-types.ts` is the source of truth — we filter to
 * `kind === 'image-to-video'` and `supportedAspects.includes('9:16')`
 * for the picker.
 *
 * Failure posture: throws plain Error with the vendor message
 * preserved. No fallback to a different model — the user picked one;
 * surfacing the failure honestly is correct.
 *
 * Observability (rule 14): every call emits `[shorts frame-animate]`
 * lines covering dispatch start, poll attempts, terminal state, and
 * the persisted shape.
 */

import { logger } from './logger';
import {
  kieCreateVideoTask,
  kieFetchVideoStatus,
  mapKieStateToStatus,
  buildBrollPrompt,
} from './broll';
import {
  BROLL_MODELS,
  findBrollModel,
  BROLL_MIN_PROMPT_CHARS,
  type BrollModelDescriptor,
} from './broll-types';
import type {
  ShortFrameAnimation,
  ShortRow,
  ShortStyleAssets,
} from './shorts-types';

/** 3s × 95 = 285s poll ceiling, matching the image dispatchers. The
 *  i2v vendors typically finish 5s clips in 20-60s; Kling 3.0 Pro and
 *  Veo can drift toward 90-120s. The ceiling sits well inside the
 *  route's `maxDuration = 300` budget. */
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 95;

/** Which sub-block + position the caller wants to animate. The
 *  orchestrator routes off this to read the right `*_url` source. */
export type AnimateTarget =
  | { kind: 'base' }
  | { kind: 'variant'; index: number };

export interface AnimateFrameOptions {
  /** B-roll model id (`findBrollModel(id)`-keyed). MUST be an i2v
   *  model that supports 9:16. The route layer validates this. */
  modelId: string;
  /** Optional duration override. The registry's per-model default is
   *  used when omitted. Clamped to [2, 20] like `startBrollGeneration`. */
  durationSeconds?: number;
  /** Optional extra prompt the user typed in the Animate form. The
   *  orchestrator combines this with the frame's stored prompt
   *  (base_prompt or edit_prompt) via the same `buildBrollPrompt`
   *  helper the b-roll system uses, so the motion tail + style hint
   *  pattern stays consistent. */
  animationPrompt?: string;
}

export interface AnimateFrameResult {
  style_assets: ShortStyleAssets;
  /** Persisted on the frame; returned to the route for logging. */
  animation: ShortFrameAnimation;
  durationMs: number;
}

/** List the i2v models suitable for Shorts (kind=image-to-video AND
 *  9:16-capable). Used by the registry endpoint that drives the
 *  picker dropdown. */
export function listShortsI2vModels(): BrollModelDescriptor[] {
  return BROLL_MODELS.filter(
    (m) => m.kind === 'image-to-video' && m.supportedAspects.includes('9:16'),
  );
}

function resolveStyleKey(row: ShortRow): 'doodle' | 'paint' {
  if (row.style_id === 'doodle_explainer_2_short') return 'doodle';
  if (row.style_id === 'paint_explainer_v1_short') return 'paint';
  throw new Error(
    `Animation ops only apply to Doodle or Paint shorts (style_id="${row.style_id ?? 'null'}").`,
  );
}

/** Read the source still URL + the seed prompt for the target frame.
 *  Throws when the frame doesn't exist (back-compat: caller already
 *  gated this in the routes, but server-side defence is cheap). */
function readTarget(
  row: ShortRow,
  target: AnimateTarget,
): { sourceUrl: string; seedPrompt: string | undefined } {
  const key = resolveStyleKey(row);
  const block = row.style_assets?.[key];
  if (!block) {
    throw new Error(
      `Short has style_id="${row.style_id}" but no style_assets.${key} block yet — generate the still first.`,
    );
  }
  if (target.kind === 'base') {
    return { sourceUrl: block.base_url, seedPrompt: block.base_prompt };
  }
  if (target.index < 0 || target.index >= block.variants.length) {
    throw new Error(`Variant index ${target.index} out of range (have ${block.variants.length}).`);
  }
  const v = block.variants[target.index];
  return { sourceUrl: v.url, seedPrompt: v.edit_prompt };
}

/** Build the prompt sent to the i2v model. Combines the frame's
 *  stored still-generation prompt with any extra animation hint the
 *  user typed. The b-roll `buildBrollPrompt` helper appends the
 *  motion tail (e.g. "subtle hand-drawn wiggle, slight zoom") so the
 *  model knows it's producing motion, not a re-rendered still. */
function buildAnimationPrompt(
  seedPrompt: string | undefined,
  animationPrompt: string | undefined,
): string {
  const visualDescription = seedPrompt?.trim() ?? '';
  const styleHint = animationPrompt?.trim() ?? '';
  const prompt = buildBrollPrompt({
    visualDescription,
    aiImagePrompt: visualDescription,
    styleHint,
    mode: 'image-to-video',
  });
  if (prompt.length < BROLL_MIN_PROMPT_CHARS) {
    throw new Error(
      `Animation prompt is too short (${prompt.length} chars) — add detail to the frame's still prompt or the Animate form.`,
    );
  }
  return prompt;
}

/** Persist a fresh animation into the row's `style_assets`. Pure
 *  data — the route layer is responsible for actually writing. */
function mergeAnimation(
  existing: ShortStyleAssets,
  key: 'doodle' | 'paint',
  target: AnimateTarget,
  animation: ShortFrameAnimation,
): ShortStyleAssets {
  const prev = existing[key]!;
  if (target.kind === 'base') {
    return { ...existing, [key]: { ...prev, base_animation: animation } };
  }
  const nextVariants = prev.variants.slice();
  nextVariants[target.index] = { ...nextVariants[target.index], animation };
  return { ...existing, [key]: { ...prev, variants: nextVariants } };
}

/** Same merge with the animation REMOVED. Used by the DELETE routes. */
function clearAnimationOnFrame(
  existing: ShortStyleAssets,
  key: 'doodle' | 'paint',
  target: AnimateTarget,
): ShortStyleAssets {
  const prev = existing[key];
  if (!prev) return existing;
  if (target.kind === 'base') {
    // Spread without `base_animation` so it actually drops out of the JSON.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { base_animation: _drop, ...rest } = prev;
    return { ...existing, [key]: rest };
  }
  if (target.index < 0 || target.index >= prev.variants.length) return existing;
  const nextVariants = prev.variants.slice();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { animation: _dropV, ...restV } = nextVariants[target.index];
  nextVariants[target.index] = restV;
  return { ...existing, [key]: { ...prev, variants: nextVariants } };
}

/** Animate one frame: create + poll the Kie task, persist the result
 *  on the row's `style_assets`. Synchronous (the route holds the
 *  connection open). */
export async function animateFrame(
  row: ShortRow,
  target: AnimateTarget,
  opts: AnimateFrameOptions,
): Promise<AnimateFrameResult> {
  const tStart = Date.now();
  const key = resolveStyleKey(row);
  const { sourceUrl, seedPrompt } = readTarget(row, target);
  const model = findBrollModel(opts.modelId);
  if (!model) throw new Error(`Unknown i2v model: ${opts.modelId}`);
  if (model.kind !== 'image-to-video') {
    throw new Error(`Model ${model.label} is not an image-to-video model.`);
  }
  if (!model.supportedAspects.includes('9:16')) {
    throw new Error(`Model ${model.label} does not support 9:16 portrait.`);
  }
  if (model.provider !== 'kie') {
    throw new Error(
      `Model ${model.label} is provider="${model.provider}" — the Shorts animator only supports Kie-hosted i2v.`,
    );
  }

  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'KIE_API_KEY is not set — cannot animate frames. Pin the env var and retry.',
    );
  }

  const durationSeconds = Math.max(
    2,
    Math.min(20, opts.durationSeconds ?? model.durationSeconds),
  );
  const prompt = buildAnimationPrompt(seedPrompt, opts.animationPrompt);

  logger.info('[shorts frame-animate] start', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    target,
    modelId: model.id,
    modelLabel: model.label,
    durationSeconds,
    promptChars: prompt.length,
    sourceUrl,
  });

  const { taskId } = await kieCreateVideoTask({
    apiKey,
    model,
    prompt,
    aspectRatio: '9:16',
    durationSeconds,
    stillImageUrl: sourceUrl,
  });
  logger.info('[shorts frame-animate] task created', {
    shortId: row.id,
    taskId,
    modelId: model.id,
  });

  // Poll until terminal. We lean on the same `kieFetchVideoStatus` +
  // `mapKieStateToStatus` parsers the b-roll system uses so a Kie
  // schema drift surfaces in one place across both pipelines.
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await kieFetchVideoStatus({
      apiKey,
      taskId,
      endpoint: model.endpoint,
    });
    if (!status) continue; // transient infra error; retry next tick
    const mapped = mapKieStateToStatus(status.state);
    if (mapped === 'ready' && status.videoUrl) {
      const animation: ShortFrameAnimation = {
        video_url: status.videoUrl,
        thumbnail_url: status.thumbnailUrl,
        model_id: model.id,
        cost_usd: model.priceUsd,
        duration_s: durationSeconds,
        generated_at: new Date().toISOString(),
        provider_request_id: taskId,
      };
      const style_assets = mergeAnimation(
        row.style_assets ?? {},
        key,
        target,
        animation,
      );
      const durationMs = Date.now() - tStart;
      logger.info('[shorts frame-animate] done', {
        shortId: row.id,
        modelId: model.id,
        target,
        durationMs,
        costUsd: animation.cost_usd,
        videoUrl: animation.video_url,
      });
      return { style_assets, animation, durationMs };
    }
    if (mapped === 'failed') {
      throw new Error(
        `${model.label} reported failure: ${status.failMsg ?? '(no message)'}`,
      );
    }
    // else: still generating; loop.
  }
  throw new Error(
    `${model.label} did not converge within ${(POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000}s. Retry later.`,
  );
}

/** Pure data op — removes the animation field on the targeted frame.
 *  No vendor call, no cost. Mirrors `deleteVariantFrame` in shape. */
export function clearFrameAnimation(
  row: ShortRow,
  target: AnimateTarget,
): { style_assets: ShortStyleAssets } {
  const key = resolveStyleKey(row);
  const style_assets = clearAnimationOnFrame(row.style_assets ?? {}, key, target);
  logger.info('[shorts frame-animate] cleared', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    target,
  });
  return { style_assets };
}
