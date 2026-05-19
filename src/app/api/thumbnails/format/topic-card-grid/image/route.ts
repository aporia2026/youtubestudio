import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { getAppUrl } from '@/lib/email';
import { generateImageOpenAI, isOpenAIDirectImageModel } from '@/lib/openai-images';
import { uploadToBucket, getImagesBucket, getImagesDownloadUrl } from '@/lib/r2';
import {
  topicCardGridImagePrompt,
  validateCardList,
  makeDefaultLayout,
  computeRegions,
  DEFAULT_CANVAS,
  type TopicCard,
  type GlobalPalette,
} from '@/lib/thumbnail-formats/topic-card-grid';
import { assertSafePublicUrl } from '@/lib/url-safety';
import type { ThumbnailRegion } from '@/remotion/types';

const BUNDLED_REFERENCE_FILENAME = 'topic-card-grid-default.png';
const BUNDLED_REFERENCE_PATH = path.join(
  process.cwd(),
  'public/thumbnail-formats',
  BUNDLED_REFERENCE_FILENAME,
);

/**
 * Returns the public URL of the bundled curated default reference image
 * IFF it exists on disk in this deployment. Kie needs a public URL to
 * fetch the reference, so we hand it `${getAppUrl()}/thumbnail-formats/
 * topic-card-grid-default.png` — same file Next.js serves from /public.
 *
 * Returns null when the PNG hasn't been generated and committed yet, so
 * the API can fall back to "reference upload required" cleanly.
 */
async function bundledReferenceUrlIfPresent(): Promise<string | null> {
  try {
    await fs.access(BUNDLED_REFERENCE_PATH);
    const base = getAppUrl().replace(/\/$/, '');
    return `${base}/thumbnail-formats/${BUNDLED_REFERENCE_FILENAME}`;
  } catch {
    return null;
  }
}

export const maxDuration = 300;

/**
 * Step 2 of the Topic Card Grid pipeline: render the final composite image
 * via GPT Image 2 i2i (default) and return it alongside deterministic region
 * rectangles so production-doc can pick them up without an "Auto-detect
 * regions" vision pass.
 *
 * See `_plans/2026-05-19-thumbnail-format-topic-card-grid.md` for the
 * pipeline overview, the layout math (outer margin = inter-card gutter), and
 * the recommended-model rationale (GPT Image 2's autoregressive text
 * rendering is what makes the multi-card typography reliable).
 */

const MAX_GRID_DIM = 50;

/**
 * Kie.ai model map for image generators usable in this format. Mirrors the
 * smaller set the existing /api/thumbnails/image route exposes — only the
 * i2i variants, since the reference image is mandatory for the format's
 * typography lock.
 */
/**
 * Image-generation routing map. Two providers:
 *  - `kie`: async task on Kie.ai (createKieTask + pollKieResult). The
 *    reference image flows as a URL.
 *  - `openai`: sync OpenAI direct call to /v1/images/edits (i2i) or
 *    /v1/images/generations (t2i). The reference image flows as raw bytes
 *    via multipart upload; the resulting image bytes are uploaded to R2 to
 *    produce a permanent URL on parity with the Kie path.
 *
 * `openai-direct` was added 2026-05-19 as an emergency fast-path because
 * Kie's gpt-image-2 i2i task occasionally exceeds the function timeout.
 * OpenAI direct returns synchronously in 20-60s.
 */
type ImageModelConfig =
  | { provider: 'kie'; model: string; refKey: 'input_urls' | 'image_urls' }
  | { provider: 'openai'; mode: 'i2i' | 't2i' };

const IMAGE_MODEL_MAP: Record<string, ImageModelConfig> = {
  'gpt-image-2-i2i': { provider: 'kie', model: 'gpt-image-2-image-to-image', refKey: 'input_urls' },
  'grok-imagine-i2i': { provider: 'kie', model: 'grok-imagine/image-to-image', refKey: 'image_urls' },
  'flux2-pro-i2i': { provider: 'kie', model: 'flux-2/pro-image-to-image', refKey: 'image_urls' },
  'flux2-flex-i2i': { provider: 'kie', model: 'flux-2/flex-image-to-image', refKey: 'image_urls' },
  'gpt-image-2-openai-i2i': { provider: 'openai', mode: 'i2i' },
  'gpt-image-2-openai-t2i': { provider: 'openai', mode: 't2i' },
};

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-i2i';

interface ReqBody {
  imageModelId?: string;
  cards?: TopicCard[];
  globalPalette?: GlobalPalette;
  notesForImageModel?: string;
  gridRows?: number;
  gridCols?: number;
  referenceImageUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
}

function requireKieKey(): string {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured');
  return key;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(`thumb-fmt-grid-image:${getClientIP(req)}`, 5, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    let body: ReqBody;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const imageModelId = (body.imageModelId || DEFAULT_IMAGE_MODEL).trim();
    const gridRows = Number(body.gridRows);
    const gridCols = Number(body.gridCols);
    const cards = body.cards;
    const palette = body.globalPalette;
    let referenceImageUrl = (body.referenceImageUrl || '').trim();
    let usedBundledDefault = false;

    if (!Number.isInteger(gridRows) || gridRows < 1 || gridRows > MAX_GRID_DIM) {
      return NextResponse.json(
        { error: `gridRows must be an integer between 1 and ${MAX_GRID_DIM}` },
        { status: 400 },
      );
    }
    if (!Number.isInteger(gridCols) || gridCols < 1 || gridCols > MAX_GRID_DIM) {
      return NextResponse.json(
        { error: `gridCols must be an integer between 1 and ${MAX_GRID_DIM}` },
        { status: 400 },
      );
    }
    if (!cards || !Array.isArray(cards)) {
      return NextResponse.json({ error: 'cards array is required' }, { status: 400 });
    }
    if (!palette || typeof palette !== 'object') {
      return NextResponse.json({ error: 'globalPalette is required' }, { status: 400 });
    }
    if (!referenceImageUrl) {
      // Try the bundled curated default before failing.
      const bundledUrl = await bundledReferenceUrlIfPresent();
      if (!bundledUrl) {
        return NextResponse.json(
          {
            error: 'A reference image is required for this format. Upload one or run scripts/generate-default-grid-reference.ts to bundle the curated default.',
          },
          { status: 400 },
        );
      }
      referenceImageUrl = bundledUrl;
      usedBundledDefault = true;
    }
    const config = IMAGE_MODEL_MAP[imageModelId];
    if (!config) {
      return NextResponse.json(
        { error: `Unknown image model: ${imageModelId}. Use one of: ${Object.keys(IMAGE_MODEL_MAP).join(', ')}` },
        { status: 400 },
      );
    }

    // Re-validate the card list server-side so a tampered client (or a
    // history-restore with stale data) can't bypass the banlist.
    const validation = validateCardList(cards, gridRows * gridCols);
    if (!validation.ok) {
      return NextResponse.json({ error: `Card list validation failed: ${validation.reason}` }, { status: 400 });
    }

    // Reference URL SSRF check (string-based; same rationale as the
    // multimodal reference fetch in /api/thumbnails/generate).
    let safeRefUrl: URL;
    try {
      safeRefUrl = assertSafePublicUrl(referenceImageUrl, { allowedProtocols: ['https:'] });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Reference image URL was rejected: ${reason}` },
        { status: 400 },
      );
    }

    // Compute regions deterministically from the layout BEFORE the image
    // call so they're returned even if the model itself drifts.
    const outputWidth = Number.isInteger(body.outputWidth) ? Number(body.outputWidth) : DEFAULT_CANVAS.width;
    const outputHeight = Number.isInteger(body.outputHeight) ? Number(body.outputHeight) : DEFAULT_CANVAS.height;
    const layout = makeDefaultLayout(gridRows, gridCols, outputWidth, outputHeight);
    const labels = cards.map((c) => c.label);
    const regions: ThumbnailRegion[] = computeRegions(layout, labels, () => randomUUID());
    logger.info('[thumb-format-grid image] regions computed', {
      regions_count: regions.length,
      outer_margin: layout.outerMargin,
      gutter: layout.gutter,
      card_w: regions[0]?.w,
      card_h: regions[0]?.h,
    });

    const prompt = topicCardGridImagePrompt({
      cards,
      palette,
      gridRows,
      gridCols,
      notesForImageModel: body.notesForImageModel,
    });

    logger.info('[thumb-format-grid image] start', {
      imageModelId,
      provider: config.provider,
      gridRows,
      gridCols,
      cards_count: cards.length,
      prompt_chars: prompt.length,
      has_user_reference: !usedBundledDefault,
      used_bundled_default: usedBundledDefault,
      ref_host: safeRefUrl.hostname,
    });

    let imageUrl: string;
    let taskId: string | undefined;

    if (config.provider === 'kie') {
      // Build Kie input. Match the existing /api/thumbnails/image patterns:
      // gpt-image-2 uses `input_urls`, every other i2i model uses `image_urls`.
      // nsfw_checker is on for everything except gpt-image-2 (which 422's on
      // it per Kie's market spec).
      const input: Record<string, unknown> = {
        prompt,
        aspect_ratio: '16:9',
        resolution: '1K',
      };
      if (!config.model.startsWith('gpt-image-2')) {
        input.nsfw_checker = true;
      }
      input[config.refKey] = [referenceImageUrl];

      const apiKey = requireKieKey();
      taskId = await createKieTask(apiKey, config.model, input);
      imageUrl = await pollKieResult(taskId, apiKey);
    } else {
      // OpenAI direct path. Fetch the reference image bytes (Kie passed a
      // URL, OpenAI's edits endpoint expects a multipart file upload), call
      // /v1/images/edits synchronously, then upload the returned PNG bytes
      // to R2 so the rest of the app sees a permanent URL just like the
      // Kie path. This is the emergency fast-path — no polling, returns in
      // 20-60s typically.
      let referenceBytes: Buffer | undefined;
      let referenceMime: string | undefined;
      if (config.mode === 'i2i') {
        const refRes = await fetch(safeRefUrl);
        if (!refRes.ok) {
          throw new Error(`Failed to fetch reference image for OpenAI edit (HTTP ${refRes.status}).`);
        }
        const arrayBuf = await refRes.arrayBuffer();
        if (arrayBuf.byteLength > 8 * 1024 * 1024) {
          throw new Error('Reference image exceeds 8 MB cap for the OpenAI edit path.');
        }
        referenceBytes = Buffer.from(arrayBuf);
        const ct = refRes.headers.get('content-type') || 'image/png';
        referenceMime = ct.includes('png')
          ? 'image/png'
          : ct.includes('webp')
            ? 'image/webp'
            : ct.includes('gif')
              ? 'image/gif'
              : 'image/jpeg';
      }

      const result = await generateImageOpenAI({
        prompt,
        size: '1536x1024', // 16:9 landscape preset; matches our 1280×720 layout aspect
        quality: 'medium',
        referenceImage: referenceBytes && referenceMime
          ? { bytes: referenceBytes, mimeType: referenceMime, filename: 'reference.png' }
          : undefined,
      });

      // Upload to R2 so the URL is permanent (parity with the Kie path).
      const bytes = Buffer.from(result.base64, 'base64');
      const r2Key = `thumbnails/format-grid-openai/${randomUUID()}.png`;
      await uploadToBucket(getImagesBucket(), r2Key, bytes, 'image/png');
      imageUrl = await getImagesDownloadUrl(r2Key);

      logger.info('[thumb-format-grid image] openai direct done', {
        bytes: bytes.byteLength,
        r2_key: r2Key,
        revised_prompt_chars: result.revisedPrompt?.length ?? 0,
      });
    }

    logger.info('[thumb-format-grid image] done', {
      duration_ms: Date.now() - startedAt,
      task_id: taskId,
      provider: config.provider,
      image_url_host: (() => {
        try { return new URL(imageUrl).hostname; } catch { return 'unknown'; }
      })(),
    });

    return NextResponse.json({
      imageUrl,
      taskId: taskId ?? null,
      regions,
      layout: {
        width: layout.width,
        height: layout.height,
        outerMargin: layout.outerMargin,
        gutter: layout.gutter,
      },
    });
  } catch (err) {
    logger.error('[thumb-format-grid image] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
