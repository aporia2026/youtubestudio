import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import {
  nLevelsImagePrompt,
  validateLevelList,
  makeDefaultLayout,
  computeRegions,
  DEFAULT_CANVAS,
  type NLevel,
} from '@/lib/thumbnail-formats/n-levels';
import { assertSafePublicUrl } from '@/lib/url-safety';
import type { ThumbnailRegion } from '@/remotion/types';

export const maxDuration = 300;

/**
 * Step 2 of the N Levels Explained pipeline: render the final composite via
 * GPT Image 2 i2i (default) and return it alongside deterministic per-slice
 * region rectangles. Mirrors the sibling topic-card-grid/image endpoint.
 */

const MAX_LEVEL_COUNT = 20;

const IMAGE_MODEL_MAP: Record<string, { model: string; refKey: 'input_urls' | 'image_urls' }> = {
  'gpt-image-2-i2i': { model: 'gpt-image-2-image-to-image', refKey: 'input_urls' },
  'grok-imagine-i2i': { model: 'grok-imagine/image-to-image', refKey: 'image_urls' },
  'flux2-pro-i2i': { model: 'flux-2/pro-image-to-image', refKey: 'image_urls' },
  'flux2-flex-i2i': { model: 'flux-2/flex-image-to-image', refKey: 'image_urls' },
};

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-i2i';

interface ReqBody {
  imageModelId?: string;
  levels?: NLevel[];
  count?: number;
  titleTopic?: string;
  titleTagline?: string;
  notesForImageModel?: string;
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
    const { limited, resetIn } = checkRateLimit(`thumb-fmt-n-levels-image:${getClientIP(req)}`, 5, 60_000);
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
    const count = Number(body.count);
    const levels = body.levels;
    const titleTopic = (body.titleTopic || '').trim();
    const titleTagline = body.titleTagline === undefined ? 'EXPLAINED' : String(body.titleTagline);
    const referenceImageUrl = (body.referenceImageUrl || '').trim();

    if (!Number.isInteger(count) || count < 2 || count > MAX_LEVEL_COUNT) {
      return NextResponse.json(
        { error: `count must be an integer between 2 and ${MAX_LEVEL_COUNT}` },
        { status: 400 },
      );
    }
    if (!titleTopic) {
      return NextResponse.json({ error: 'titleTopic is required' }, { status: 400 });
    }
    if (!levels || !Array.isArray(levels)) {
      return NextResponse.json({ error: 'levels array is required' }, { status: 400 });
    }
    if (!referenceImageUrl) {
      return NextResponse.json(
        { error: 'A reference image is required for this format.' },
        { status: 400 },
      );
    }
    const config = IMAGE_MODEL_MAP[imageModelId];
    if (!config) {
      return NextResponse.json(
        { error: `Unknown image model: ${imageModelId}. Use one of: ${Object.keys(IMAGE_MODEL_MAP).join(', ')}` },
        { status: 400 },
      );
    }

    // Re-validate level list server-side.
    const validation = validateLevelList(levels, count);
    if (!validation.ok) {
      return NextResponse.json({ error: `Level list validation failed: ${validation.reason}` }, { status: 400 });
    }

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

    // Deterministic region math BEFORE the image call.
    const outputWidth = Number.isInteger(body.outputWidth) ? Number(body.outputWidth) : DEFAULT_CANVAS.width;
    const outputHeight = Number.isInteger(body.outputHeight) ? Number(body.outputHeight) : DEFAULT_CANVAS.height;
    const layout = makeDefaultLayout(count, outputWidth, outputHeight);
    const labels = levels.map((l) => l.label);
    const regions: ThumbnailRegion[] = computeRegions(layout, labels, () => randomUUID());
    logger.info('[thumb-format-n-levels image] regions computed', {
      regions_count: regions.length,
      bottom_band_height: layout.bottomBandHeight,
      slice_w: regions[0]?.w,
      slice_h: regions[0]?.h,
    });

    const prompt = nLevelsImagePrompt({
      levels,
      count,
      titleTopic,
      titleTagline,
      notesForImageModel: body.notesForImageModel,
    });

    logger.info('[thumb-format-n-levels image] start', {
      imageModelId,
      count,
      levels_count: levels.length,
      prompt_chars: prompt.length,
      has_user_reference: true,
      ref_host: safeRefUrl.hostname,
    });

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
    const taskId = await createKieTask(apiKey, config.model, input);
    const imageUrl = await pollKieResult(taskId, apiKey);

    logger.info('[thumb-format-n-levels image] done', {
      duration_ms: Date.now() - startedAt,
      task_id: taskId,
      image_url_host: (() => {
        try { return new URL(imageUrl).hostname; } catch { return 'unknown'; }
      })(),
    });

    return NextResponse.json({
      imageUrl,
      taskId,
      regions,
      layout: {
        width: layout.width,
        height: layout.height,
        bottomBandHeight: layout.bottomBandHeight,
        gutter: layout.gutter,
      },
    });
  } catch (err) {
    logger.error('[thumb-format-n-levels image] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
