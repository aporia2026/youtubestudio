/**
 * Step 2 of the Doodle Explainer pipeline: take N concepts produced
 * by the sibling `concepts/` route and fan out to N parallel image-gen
 * calls. Returns `ThumbnailVariant[]` for the panel's VariantPicker.
 *
 * Server-side fan-out (vs. the Phase-1 client-side free-form fan-out)
 * because:
 *   - one rate-limit budget per generate, not per-image
 *   - a single coordinated set of provider_generations rows
 *   - cleaner partial-failure handling (allSettled + failedCount in
 *     the response, no client-side retry storm)
 *
 * Model scope: Kie t2i lanes. Atlas + OpenAI direct lanes can be
 * added later by extending KIE_T2I_MODELS + the dispatch — for now
 * the doodle format defaults to Kie GPT Image 2 per the user's spec
 * (2026-06-09) and the panel picker exposes the other Kie t2i models.
 *
 * Plan: _plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { logger } from '@/lib/logger';
import { getSession } from '@/lib/session';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';
import {
  buildDoodleImagePrompt,
  type DoodleConcept,
} from '@/lib/thumbnail-formats/doodle-explainer-prompts';
import { resolveBackgroundHint } from '@/lib/thumbnail-formats/doodle-explainer-prompts';
import { resolveThumbnailStyle, DEFAULT_THUMBNAIL_STYLE_ID } from '@/lib/thumbnail-styles';
import {
  buildVariant,
  clampVariantCount,
  type ThumbnailVariant,
} from '@/lib/thumbnail-variants';

export const maxDuration = 300;

/** Per-image timeout. 240s gives 3 parallel calls room to complete
 *  inside the 300s function budget with margin. */
const PER_IMAGE_TIMEOUT_MS = 240_000;

/** Kie t2i model registry for this route. Mirrors the relevant subset
 *  of MODEL_MAP in `src/app/api/thumbnails/image/route.ts` — only the
 *  text-to-image, Kie-provider entries. Mode keys here let us turn the
 *  Ideogram `rendering_speed` tier into the Kie wire field. */
interface KieT2iConfig {
  /** The Kie model string sent to `createKieTask`. */
  model: string;
  /** Ideogram routes its tier through rendering_speed; everything else
   *  ignores this field. */
  renderingSpeed?: 'QUALITY' | 'BALANCED' | 'TURBO';
}

const KIE_T2I_MODELS: Record<string, KieT2iConfig> = {
  'gpt-image-2-t2i': { model: 'gpt-image-2-text-to-image' },
  'grok-imagine-t2i': { model: 'grok-imagine/text-to-image' },
  'flux2-pro-t2i': { model: 'flux-2/pro-text-to-image' },
  'flux2-flex-t2i': { model: 'flux-2/flex-text-to-image' },
  'nano-banana': { model: 'nano-banana-2' },
  'ideogram-v3-quality-t2i': { model: 'ideogram/v3-text-to-image', renderingSpeed: 'QUALITY' },
  'ideogram-v3-balanced-t2i': { model: 'ideogram/v3-text-to-image', renderingSpeed: 'BALANCED' },
  'ideogram-v3-turbo-t2i': { model: 'ideogram/v3-text-to-image', renderingSpeed: 'TURBO' },
};

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-t2i';

interface ReqBody {
  imageModel?: string;
  styleId?: string;
  hookText?: string;
  characterExpression?: string;
  backgroundScene?: string;
  customBackground?: string;
  concepts?: unknown;
  variantCount?: number;
}

interface OkResponse {
  variants: ThumbnailVariant[];
  failedCount: number;
}

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Defensive validator for the user-supplied concepts array. Even when
 * the panel just round-trips concepts from the sibling concepts/ route,
 * an attacker could call this route directly with bogus inputs.
 */
function validateConcepts(raw: unknown, expectedCount: number): { ok: true; value: DoodleConcept[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'concepts must be an array' };
  if (raw.length !== expectedCount) return { ok: false, reason: `concepts must contain exactly ${expectedCount} entries (variantCount mismatch)` };
  const out: DoodleConcept[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (!c || typeof c !== 'object') return { ok: false, reason: `concepts[${i}] is not an object` };
    const row = c as Record<string, unknown>;
    const conceptLabel = typeof row.conceptLabel === 'string' ? row.conceptLabel.trim() : '';
    const compositionHint = typeof row.compositionHint === 'string' ? row.compositionHint.trim() : '';
    if (!conceptLabel) return { ok: false, reason: `concepts[${i}].conceptLabel is empty` };
    if (!compositionHint) return { ok: false, reason: `concepts[${i}].compositionHint is empty` };
    if (conceptLabel.length > 200) return { ok: false, reason: `concepts[${i}].conceptLabel must be ≤ 200 chars` };
    if (compositionHint.length > 2000) return { ok: false, reason: `concepts[${i}].compositionHint must be ≤ 2000 chars` };
    const axes = row.variation_axes;
    if (!axes || typeof axes !== 'object') return { ok: false, reason: `concepts[${i}].variation_axes is missing` };
    const axesRow = axes as Record<string, unknown>;
    const label_axis = typeof axesRow.label_axis === 'string' ? axesRow.label_axis.trim() : '';
    const palette_axis = typeof axesRow.palette_axis === 'string' ? axesRow.palette_axis.trim() : '';
    const composition_axis = typeof axesRow.composition_axis === 'string' ? axesRow.composition_axis.trim() : '';
    if (!label_axis || !palette_axis || !composition_axis) {
      return { ok: false, reason: `concepts[${i}].variation_axes is missing one of label_axis / palette_axis / composition_axis` };
    }
    out.push({
      conceptLabel,
      compositionHint,
      variation_axes: { label_axis, palette_axis, composition_axis },
    });
  }
  return { ok: true, value: out };
}

export async function POST(req: NextRequest) {
  const pendingIntentIds = new Set<string>();
  const startedAt = Date.now();

  try {
    const { limited, resetIn } = checkRateLimit(`thumb-doodle-image:${getClientIP(req)}`, 5, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const session = await getSession();
    const userId = session?.uid ?? null;
    const workspaceId = session?.ws ?? null;

    let body: ReqBody;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const imageModel = body.imageModel || DEFAULT_IMAGE_MODEL;
    const config = KIE_T2I_MODELS[imageModel];
    if (!config) {
      return NextResponse.json(
        {
          error: `imageModel "${imageModel}" is not supported by this route. Supported: ${Object.keys(KIE_T2I_MODELS).join(', ')}`,
        },
        { status: 400 },
      );
    }

    const styleId = body.styleId || DEFAULT_THUMBNAIL_STYLE_ID;
    const style = resolveThumbnailStyle(styleId);
    if (!style) return NextResponse.json({ error: `Unknown styleId: ${styleId}` }, { status: 400 });

    const hookText = typeof body.hookText === 'string' ? body.hookText.trim() : '';
    const characterExpression = typeof body.characterExpression === 'string' ? body.characterExpression.trim() : '';
    const backgroundScene = typeof body.backgroundScene === 'string' ? body.backgroundScene.trim() : '';
    const customBackground = typeof body.customBackground === 'string' ? body.customBackground.trim() : undefined;
    if (!hookText) return NextResponse.json({ error: 'hookText is required' }, { status: 400 });
    if (hookText.length > 60) return NextResponse.json({ error: 'hookText must be ≤ 60 chars' }, { status: 400 });
    if (characterExpression.length > 60) return NextResponse.json({ error: 'characterExpression must be ≤ 60 chars' }, { status: 400 });
    if (backgroundScene.length > 80) return NextResponse.json({ error: 'backgroundScene must be ≤ 80 chars' }, { status: 400 });
    if (customBackground && customBackground.length > 200) return NextResponse.json({ error: 'customBackground must be ≤ 200 chars' }, { status: 400 });

    const variantCount = clampVariantCount(body.variantCount);

    const conceptsValidation = validateConcepts(body.concepts, variantCount);
    if (!conceptsValidation.ok) {
      return NextResponse.json({ error: conceptsValidation.reason }, { status: 400 });
    }
    const concepts = conceptsValidation.value;

    const backgroundHint = resolveBackgroundHint(
      { hookText, characterExpression, backgroundScene, customBackground, variantCount },
      style,
    );

    // Build the N final image prompts deterministically from the concepts.
    const prompts = concepts.map(concept => buildDoodleImagePrompt({
      hookText,
      characterExpression,
      backgroundHint,
      concept,
      styleSuffix: style.ai_image_suffix,
    }));

    logger.info('[thumb-doodle image] start', {
      imageModel,
      styleId,
      variantCount,
      hookLength: hookText.length,
      backgroundScene,
      promptLengths: prompts.map(p => p.length),
    });

    const apiKey = requireKieKey();

    // Fan out — N parallel Kie tasks, each with its own intent row.
    //
    // Intent leak audit (2026-06-10): the structure below is
    // intentionally split into TWO tries so reviewers can see exactly
    // when an id enters / leaves the cleanup set:
    //
    //   1. recordIntent → if it throws BEFORE returning an id, no id
    //      exists, nothing to clean up. We surface a per-variant
    //      rejection so the caller sees a failed slot rather than a
    //      whole-route 500. If the DB row was created but the response
    //      dropped, that row becomes an orphaned `in_progress` — that
    //      class of leak is handled by the maintenance job, not this
    //      route (same trade-off every other recordIntent call site
    //      makes; not specific to this route).
    //   2. body of work (Kie call) → markDelivered/markFailed on
    //      every exit path. pendingIntentIds.delete keeps the outer
    //      catch's "fail-anything-left-pending" loop minimal.
    //
    // The outer catch only fires on a code path that escapes
    // Promise.allSettled (which never rejects). It iterates whatever
    // is left in pendingIntentIds and markFailed's them so no intent
    // gets stuck `in_progress` from a synchronous-error escape.
    const results = await Promise.allSettled(
      prompts.map(async (prompt, idx) => {
        let intent: { id: string };
        try {
          intent = await recordIntent({
            userId,
            workspaceId,
            route: '/api/thumbnails/format/doodle-explainer/image',
            provider: 'kie',
            providerModel: config.model,
            slot: 'thumbnail',
          });
        } catch (err) {
          // No id returned → nothing to add to pendingIntentIds, nothing
          // to markFailed (we don't have a row reference). Surface as
          // a per-variant rejection.
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`recordIntent failed for variant ${idx + 1}: ${reason}`);
        }
        // Id is held; add it to the cleanup set immediately so the outer
        // catch's "fail anything still pending" loop can find it if a
        // synchronous error escapes below.
        pendingIntentIds.add(intent.id);

        try {
          const callStart = Date.now();
          const url = await withTimeout(
            runKieT2i({ apiKey, config, prompt }),
            PER_IMAGE_TIMEOUT_MS,
            `variant ${idx + 1} (${config.model})`,
          );
          void markDelivered({
            id: intent.id,
            providerRequestId: null,
            responseUrl: url,
            costUsd: null,
            durationMs: Date.now() - callStart,
          });
          pendingIntentIds.delete(intent.id);
          return { imageUrl: url };
        } catch (err) {
          void markFailed({
            id: intent.id,
            failureReason: err instanceof Error ? err.message : String(err),
          });
          pendingIntentIds.delete(intent.id);
          throw err;
        }
      }),
    );

    const variants: ThumbnailVariant[] = results.map((r, idx) => buildVariant({
      index: idx,
      imageUrl: r.status === 'fulfilled' ? r.value.imageUrl : '',
      promptUsed: prompts[idx],
      conceptLabel: concepts[idx].conceptLabel,
    }));
    const failedCount = variants.filter(v => !v.imageUrl).length;

    logger.info('[thumb-doodle image] done', {
      imageModel,
      styleId,
      variantCount,
      failedCount,
      durationMs: Date.now() - startedAt,
      failures: results
        .map((r, i) => r.status === 'rejected'
          ? { idx: i, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) }
          : null)
        .filter(Boolean),
    });

    // If 0 succeeded, surface as 502 with the first failure reason.
    if (failedCount === variantCount) {
      const firstFailure = results.find(r => r.status === 'rejected');
      const reason = firstFailure?.status === 'rejected'
        ? (firstFailure.reason instanceof Error ? firstFailure.reason.message : String(firstFailure.reason))
        : 'all variants failed';
      return NextResponse.json({ error: `All variants failed: ${reason}` }, { status: 502 });
    }

    const response: OkResponse = { variants, failedCount };
    return NextResponse.json(response);
  } catch (err) {
    // Fail any pending intents that didn't get a per-variant catch.
    for (const intentId of pendingIntentIds) {
      void markFailed({
        id: intentId,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
    pendingIntentIds.clear();
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[thumb-doodle image] fatal', {
      reason: message,
      durationMs: Date.now() - startedAt,
    });
    const status = /KIE_API_KEY/i.test(message)
      ? 500
      : /temporarily unavailable/i.test(message)
        ? 503
        : 500;
    return NextResponse.json(
      { error: `Doodle image generation failed: ${message}` },
      { status },
    );
  }
}

/** Single-image Kie t2i dispatch. Mirrors the Kie branch of the legacy
 *  free-form image route's MODEL_MAP — same input shape per model, same
 *  upscale chain. Inlined here (rather than reused) because the legacy
 *  route's flow is intertwined with Atlas + OpenAI branches we don't
 *  need; extracting a shared helper is a Phase 3 refactor. */
async function runKieT2i(input: {
  apiKey: string;
  config: KieT2iConfig;
  prompt: string;
}): Promise<string> {
  const { apiKey, config, prompt } = input;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wire: Record<string, any> = { prompt };
  const m = config.model;
  if (
    !m.startsWith('gpt-image-2')
    && !m.startsWith('ideogram/')
    && m !== 'nano-banana-2'
  ) {
    wire.nsfw_checker = true;
  }
  if (m.startsWith('flux-2')) {
    wire.aspect_ratio = '16:9';
    wire.resolution = '1K';
  } else if (m === 'nano-banana-2') {
    wire.aspect_ratio = '16:9';
    wire.resolution = '1K';
    wire.output_format = 'png';
  } else if (m.startsWith('gpt-image-2')) {
    wire.aspect_ratio = '16:9';
    wire.resolution = '1K';
  } else if (m === 'ideogram/v3-text-to-image') {
    wire.image_size = 'landscape_16_9';
    wire.rendering_speed = config.renderingSpeed ?? 'QUALITY';
  } else {
    wire.aspect_ratio = '16:9';
  }
  // 1K-policy guard — every Kie call gets auto-upscaled downstream, so
  // bumping resolution at source wastes money. Matches the guard in
  // `src/app/api/thumbnails/image/route.ts`.
  if (wire.resolution !== undefined && wire.resolution !== '1K') {
    throw new Error(`[thumb-doodle 1k-policy] blocked non-1K resolution for ${m}: ${String(wire.resolution)}`);
  }
  const taskId = await createKieTask(apiKey, m, wire);
  return pollKieResultThenUpscale(taskId, apiKey);
}
