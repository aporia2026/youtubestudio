import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { domainErrorResponse } from '@/lib/route-helpers';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { generateImageOpenAI } from '@/lib/openai-images';
import { uploadToBucket, getImagesBucket, getImagesDownloadUrl } from '@/lib/r2';
import { generateImageWithUpscale } from '@/lib/image-gen-dispatch';
import { getImageModelSpec } from '@/lib/image-models';
import { getSession } from '@/lib/session';
import { recordIntent, markDelivered, markFailed } from '@/lib/provider-generations';

export const maxDuration = 300;

/**
 * Image generation model configurations.
 *
 * Two provider lanes:
 *  - `kie`: async task on Kie.ai (createKieTask + pollKieResult). The
 *    reference image flows as a URL when image-to-image.
 *  - `openai`: sync OpenAI direct call to /v1/images/edits (i2i) or
 *    /v1/images/generations (t2i). Reference flows as raw bytes via
 *    multipart upload; resulting PNG is mirrored to R2 for a permanent
 *    URL so the response shape matches the Kie path.
 *
 * GPT Image 2 on Kie uses `input_urls` for i2i; everything else on Kie
 * uses `image_urls`. The provider tag below selects the code path.
 */
type ModelConfig =
  | {
      provider: 'kie';
      model: string;
      type: 'text-to-image' | 'image-to-image';
      /** Ideogram v3 routes its tier through the `rendering_speed` field
       *  while all three tiers share one model string, so the speed has
       *  to live alongside `model` instead of being inferred from it. */
      renderingSpeed?: 'QUALITY' | 'BALANCED' | 'TURBO';
    }
  | { provider: 'openai'; type: 'text-to-image' | 'image-to-image' }
  /** Atlas Cloud t2i. Goes through `generateImageWithUpscale`, which
   *  reads the model + size + quality from the shared registry spec
   *  in `src/lib/image-models.ts` (looked up by the request's `model`
   *  id). Kept tagless beyond `provider` because the route doesn't
   *  hand-roll the request shape — the dispatcher does. See
   *  _plans/2026-05-25-atlas-cloud-gpt-image-2.md (Phase 1.B). */
  | { provider: 'atlas'; type: 'text-to-image' };

const MODEL_MAP: Record<string, ModelConfig> = {
  'grok-imagine-t2i': { provider: 'kie', model: 'grok-imagine/text-to-image', type: 'text-to-image' },
  'flux2-pro-t2i': { provider: 'kie', model: 'flux-2/pro-text-to-image', type: 'text-to-image' },
  'flux2-flex-t2i': { provider: 'kie', model: 'flux-2/flex-text-to-image', type: 'text-to-image' },
  // NanoBanana 2 (Gemini 3.1 Flash Image). Replaced the original
  // `google/nano-banana` (Gemini 2.5 Flash) on 2026-05-24. Same `value`
  // id so existing thumbnail rows that picked it still resolve. Model
  // string changed from `google/nano-banana` → `nano-banana-2`.
  'nano-banana': { provider: 'kie', model: 'nano-banana-2', type: 'text-to-image' },
  // GPT Image 2 has two routes through this app: Atlas (cheaper default,
  // ~$0.009/image) and Kie (sibling fallback). Both call the same OpenAI
  // model; routing is purely about which vendor invoice picks up the cost.
  'gpt-image-2-atlas-t2i': { provider: 'atlas', type: 'text-to-image' },
  'gpt-image-2-t2i': { provider: 'kie', model: 'gpt-image-2-text-to-image', type: 'text-to-image' },
  // Ideogram v3 — single model string, tier via renderingSpeed. See
  // the input-building block below for the field translation.
  'ideogram-v3-quality-t2i': { provider: 'kie', model: 'ideogram/v3-text-to-image', type: 'text-to-image', renderingSpeed: 'QUALITY' },
  'ideogram-v3-balanced-t2i': { provider: 'kie', model: 'ideogram/v3-text-to-image', type: 'text-to-image', renderingSpeed: 'BALANCED' },
  'ideogram-v3-turbo-t2i': { provider: 'kie', model: 'ideogram/v3-text-to-image', type: 'text-to-image', renderingSpeed: 'TURBO' },
  'grok-imagine-i2i': { provider: 'kie', model: 'grok-imagine/image-to-image', type: 'image-to-image' },
  'flux2-pro-i2i': { provider: 'kie', model: 'flux-2/pro-image-to-image', type: 'image-to-image' },
  'flux2-flex-i2i': { provider: 'kie', model: 'flux-2/flex-image-to-image', type: 'image-to-image' },
  'gpt-image-2-i2i': { provider: 'kie', model: 'gpt-image-2-image-to-image', type: 'image-to-image' },
  'gpt-image-2-openai-t2i': { provider: 'openai', type: 'text-to-image' },
  'gpt-image-2-openai-i2i': { provider: 'openai', type: 'image-to-image' },
};

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

export async function POST(req: NextRequest) {
  // Tracks the provider_generations row id for the in-flight paid call.
  // The route has three paid lanes (atlas / openai / kie) and they all
  // share the same outer try/catch. Cleared after markDelivered.
  let pendingIntentId: string | null = null;

  try {
    const { limited } = checkRateLimit(`thumb-img:${getClientIP(req)}`, 5, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    // Session is proxy-gated by src/proxy.ts but this route doesn't use
    // apiRoute.authed — we read it explicitly for the provider_generations
    // attribution. Null-safe: the audit row records userId=NULL rather
    // than failing the route, since the proxy already guarantees auth.
    const session = await getSession();
    const userId = session?.uid ?? null;
    const workspaceId = session?.ws ?? null;

    const { model, prompt, referenceImageUrl } = await req.json();

    if (!model || !prompt) {
      return NextResponse.json({ error: 'model and prompt are required' }, { status: 400 });
    }

    const config = MODEL_MAP[model];
    if (!config) {
      return NextResponse.json({ error: `Unknown model: ${model}. Valid: ${Object.keys(MODEL_MAP).join(', ')}` }, { status: 400 });
    }

    if (config.type === 'image-to-image' && !referenceImageUrl) {
      return NextResponse.json({ error: 'Reference image is required for image-to-image models. Upload an image or paste a URL.' }, { status: 400 });
    }

    // Validate reference URL to prevent SSRF
    if (referenceImageUrl) {
      try {
        const refUrl = new URL(referenceImageUrl);
        if (refUrl.protocol !== 'https:') {
          return NextResponse.json({ error: 'referenceImageUrl must use HTTPS' }, { status: 400 });
        }
        // Block private/internal IPs
        const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]', 'metadata.google.internal'];
        const h = refUrl.hostname;
        const isPrivate = blocked.some(b => h === b)
          || h.startsWith('10.')
          || h.startsWith('192.168.')
          || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
          || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
          || h.endsWith('.internal') || h.endsWith('.local');
        if (isPrivate) {
          return NextResponse.json({ error: 'referenceImageUrl points to a private address' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'referenceImageUrl is not a valid URL' }, { status: 400 });
      }
    }

    if (config.provider === 'atlas') {
      // Atlas branch: dispatcher reads atlasModel + size + quality from the
      // shared registry spec. The route's MODEL_MAP only carries the
      // provider tag for Atlas because the dispatcher owns the request
      // shape (matching the dispatcher's contract for any future Atlas
      // entries we add to the registry).
      const spec = getImageModelSpec(model);
      if (!spec || spec.provider !== 'atlas') {
        return NextResponse.json(
          { error: `Atlas model '${model}' is in the route map but missing from src/lib/image-models.ts registry` },
          { status: 500 },
        );
      }
      const atlasIntent = await recordIntent({
        userId,
        workspaceId,
        route: '/api/thumbnails/image',
        provider: 'atlas',
        providerModel: model,
        slot: 'thumbnail',
      });
      pendingIntentId = atlasIntent.id;
      const result = await generateImageWithUpscale(spec, prompt, { r2KeyPrefix: 'thumbnails/freeform-atlas' });
      void markDelivered({
        id: atlasIntent.id,
        providerRequestId: null,
        responseUrl: result.url,
        costUsd: null,
        durationMs: result.durationMs,
      });
      pendingIntentId = null;
      return NextResponse.json({ imageUrl: result.url, taskId: null });
    }

    if (config.provider === 'openai') {
      const openaiIntent = await recordIntent({
        userId,
        workspaceId,
        route: '/api/thumbnails/image',
        provider: 'openai',
        providerModel: model,
        slot: 'thumbnail',
      });
      pendingIntentId = openaiIntent.id;
      const openaiStart = Date.now();
      // Sync OpenAI direct path. For i2i, fetch the reference bytes; for
      // t2i, no reference needed. Upload the returned PNG to R2 so we
      // return a permanent URL (matching the Kie response shape).
      let referenceImage: { bytes: Buffer; mimeType: string; filename: string } | undefined;
      if (config.type === 'image-to-image' && referenceImageUrl) {
        const refRes = await fetch(referenceImageUrl);
        if (!refRes.ok) {
          throw new Error(`Failed to fetch reference image (HTTP ${refRes.status}).`);
        }
        const arrayBuf = await refRes.arrayBuffer();
        if (arrayBuf.byteLength > 8 * 1024 * 1024) {
          throw new Error('Reference image exceeds 8 MB cap for the OpenAI edit path.');
        }
        const ct = refRes.headers.get('content-type') || 'image/png';
        const mimeType = ct.includes('png')
          ? 'image/png'
          : ct.includes('webp')
            ? 'image/webp'
            : ct.includes('gif')
              ? 'image/gif'
              : 'image/jpeg';
        referenceImage = { bytes: Buffer.from(arrayBuf), mimeType, filename: 'reference.png' };
      }
      const result = await generateImageOpenAI({
        prompt,
        size: '2048x1152', // true 16:9 — only OpenAI size matching YouTube thumbnail aspect
        quality: 'medium',
        referenceImage,
      });
      const bytes = Buffer.from(result.base64, 'base64');
      const r2Key = `thumbnails/freeform-openai/${randomUUID()}.png`;
      await uploadToBucket(getImagesBucket(), r2Key, bytes, 'image/png');
      const imageUrl = await getImagesDownloadUrl(r2Key);
      void markDelivered({
        id: openaiIntent.id,
        providerRequestId: null,
        responseUrl: imageUrl,
        costUsd: null,
        durationMs: Date.now() - openaiStart,
      });
      pendingIntentId = null;
      return NextResponse.json({ imageUrl, taskId: null });
    }

    // Kie.ai path (default).
    const apiKey = requireKieKey();

    // Build request body. GPT Image 2, Ideogram v3, and NanoBanana 2
    // don't document an nsfw_checker field — including it risks a 422
    // on stricter validators. Every other Kie image model accepts it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input: Record<string, any> = { prompt };
    if (
      !config.model.startsWith('gpt-image-2')
      && !config.model.startsWith('ideogram/')
      && config.model !== 'nano-banana-2'
    ) {
      input.nsfw_checker = true;
    }

    // Text-to-image models. 1K-only policy (mirrors src/lib/image-models.ts) —
    // every cloud generation flows through the system-wide auto-upscale, so
    // we always pin to 1K at the source. The guard below blocks accidental
    // 2K/4K drift.
    if (config.type === 'text-to-image') {
      if (config.model.startsWith('flux-2')) {
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
      } else if (config.model === 'nano-banana-2') {
        // Gemini 3.1 Flash Image. Same `aspect_ratio` + `resolution` shape
        // as GPT Image 2 — replaces the old `google/nano-banana` (v1) which
        // used `image_size` instead. See docs.kie.ai/market/google/nanobanana2.
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
        input.output_format = 'png';
      } else if (config.model.startsWith('gpt-image-2')) {
        input.aspect_ratio = '16:9';
        input.resolution = '1K';
      } else if (config.model === 'ideogram/v3-text-to-image') {
        // Ideogram uses enum names for aspect (`landscape_16_9`, not the
        // "16:9" string the others take) and routes the tier through
        // `rendering_speed`. Tier is locked on the config from MODEL_MAP.
        input.image_size = 'landscape_16_9';
        input.rendering_speed = config.renderingSpeed ?? 'QUALITY';
      } else {
        input.aspect_ratio = '16:9';
      }

      // 1K-policy enforcement (defence in depth — same guard as
      // src/lib/image-models.ts:buildKieImageInput). If a future branch
      // drifts to 2K/4K, this fires before the request leaves the process.
      if (input.resolution !== undefined && input.resolution !== '1K') {
        throw new Error(
          `[thumbnails 1k-policy] blocked non-1K resolution for ${config.model}: ${String(input.resolution)} — every cloud generation gets auto-upscaled, bumping the source tier wastes money`,
        );
      }
    }

    // Image-to-image models — add reference image. GPT Image 2 expects
    // `input_urls`; everything else uses `image_urls`. Both are arrays.
    if (config.type === 'image-to-image') {
      if (config.model === 'gpt-image-2-image-to-image') {
        input.input_urls = [referenceImageUrl];
      } else {
        input.image_urls = [referenceImageUrl];
      }
    }

    const kieIntent = await recordIntent({
      userId,
      workspaceId,
      route: '/api/thumbnails/image',
      provider: 'kie',
      providerModel: config.model,
      slot: 'thumbnail',
    });
    pendingIntentId = kieIntent.id;
    const kieStart = Date.now();
    const taskId = await createKieTask(apiKey, config.model, input);
    // System-wide auto-upscale runs after poll. See src/lib/upscale.ts.
    const imageUrl = await pollKieResultThenUpscale(taskId, apiKey);
    void markDelivered({
      id: kieIntent.id,
      providerRequestId: taskId,
      responseUrl: imageUrl,
      costUsd: null,
      durationMs: Date.now() - kieStart,
    });
    pendingIntentId = null;

    return NextResponse.json({ imageUrl, taskId });
  } catch (err) {
    if (pendingIntentId) {
      void markFailed({
        id: pendingIntentId,
        failureReason: err instanceof Error ? err.message : String(err),
      });
    }
    return domainErrorResponse(err, {
      op: 'thumbnails: image generate',
      knownPatterns: [
        // requireKieKey throws this when the env var is missing
        { match: /KIE_API_KEY environment variable is not configured/, status: 500 },
        // Kie.ai upstream availability messages thrown explicitly above
        { match: /Kie\.ai is temporarily unavailable/, status: 503 },
      ],
      fallbackMessage: 'Image generation failed — please try again.',
    });
  }
}
