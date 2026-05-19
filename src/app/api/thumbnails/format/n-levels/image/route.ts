import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
import { generateImageOpenAI } from '@/lib/openai-images';
import { uploadToBucket, getImagesBucket, getImagesDownloadUrl } from '@/lib/r2';
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
  levels?: NLevel[];
  count?: number;
  titleTopic?: string;
  titleTagline?: string;
  /** Whether the rendered thumbnail will include the grunge bottom title
   *  bar. Defaults false. */
  showBottomTitle?: boolean;
  /** Whether per-slice labels render under each LEVEL N. Defaults true.
   *  When false, every slice renders as just "LEVEL N" regardless of any
   *  label text in the levels list. */
  showLevelLabels?: boolean;
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
    const showBottomTitle = body.showBottomTitle === true;
    // Default true: backwards-compatible with old clients that don't send
    // the field. Explicitly false strips labels globally at render time.
    const showLevelLabels = body.showLevelLabels !== false;
    const titleTopic = (body.titleTopic || '').trim();
    const titleTagline = body.titleTagline === undefined ? 'EXPLAINED' : String(body.titleTagline);
    const referenceImageUrl = (body.referenceImageUrl || '').trim();

    if (!Number.isInteger(count) || count < 2 || count > MAX_LEVEL_COUNT) {
      return NextResponse.json(
        { error: `count must be an integer between 2 and ${MAX_LEVEL_COUNT}` },
        { status: 400 },
      );
    }
    if (showBottomTitle && !titleTopic) {
      return NextResponse.json({
        error: 'titleTopic is required when the bottom title bar is enabled.',
      }, { status: 400 });
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

    // Re-validate level list server-side. Pass null for expectedCount —
    // the user may have deleted slices in the review step (e.g. dropped
    // levels 2-6 from a 7-level run to render only "LEVEL 1" and
    // "LEVEL 7"). The image step just needs at least one well-formed
    // slice and uses levels.length as the actual slice count.
    const validation = validateLevelList(levels, null);
    if (!validation.ok) {
      return NextResponse.json({ error: `Level list validation failed: ${validation.reason}` }, { status: 400 });
    }
    const renderedCount = levels.length;

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

    // Deterministic region math BEFORE the image call. Use the ACTUAL
    // count of surviving slices (renderedCount) — not the user's original
    // requested `count`, which may differ if slices were deleted.
    const outputWidth = Number.isInteger(body.outputWidth) ? Number(body.outputWidth) : DEFAULT_CANVAS.width;
    const outputHeight = Number.isInteger(body.outputHeight) ? Number(body.outputHeight) : DEFAULT_CANVAS.height;
    const layout = makeDefaultLayout(renderedCount, outputWidth, outputHeight, showBottomTitle);
    // Region labels for production-doc — label may be empty (the slice
    // is rendered with just LEVEL N then), so fall back to that string.
    const labels = levels.map((l) => l.label?.trim() || `Level ${l.level}`);
    const regions: ThumbnailRegion[] = computeRegions(layout, labels, () => randomUUID());
    logger.info('[thumb-format-n-levels image] regions computed', {
      regions_count: regions.length,
      bottom_band_height: layout.bottomBandHeight,
      slice_w: regions[0]?.w,
      slice_h: regions[0]?.h,
    });

    const prompt = nLevelsImagePrompt({
      levels,
      count: renderedCount,
      titleTopic: showBottomTitle ? titleTopic : undefined,
      titleTagline: showBottomTitle ? titleTagline : undefined,
      showBottomTitle,
      showLevelLabels,
      notesForImageModel: body.notesForImageModel,
    });

    // Per-slice accent color lock distribution — surfaces in logs the
    // single biggest driver of "the colors came out darker than I picked"
    // complaints. `locked` slices get authoritative prompt language;
    // `hint` slices get the soft suggestion; `none` skip color guidance
    // entirely.
    const colorLockStats = levels.reduce(
      (acc, l) => {
        if (!l.accent_color) acc.none += 1;
        else if (l.accent_color_locked) acc.locked += 1;
        else acc.hint += 1;
        return acc;
      },
      { locked: 0, hint: 0, none: 0 },
    );
    logger.info('[thumb-format-n-levels image] color lock distribution', {
      total: levels.length,
      ...colorLockStats,
    });

    logger.info('[thumb-format-n-levels image] start', {
      imageModelId,
      provider: config.provider,
      count,
      levels_count: levels.length,
      prompt_chars: prompt.length,
      has_user_reference: true,
      ref_host: safeRefUrl.hostname,
    });

    let imageUrl: string;
    let taskId: string | undefined;

    if (config.provider === 'kie') {
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
      // OpenAI direct path — sync /v1/images/edits or /v1/images/generations.
      // Same shape as the topic-card-grid image endpoint's OpenAI branch.
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
        size: '2048x1152', // true 16:9 — the only OpenAI size that matches YouTube's thumbnail aspect
        quality: 'medium',
        referenceImage: referenceBytes && referenceMime
          ? { bytes: referenceBytes, mimeType: referenceMime, filename: 'reference.png' }
          : undefined,
      });

      const bytes = Buffer.from(result.base64, 'base64');
      const r2Key = `thumbnails/format-n-levels-openai/${randomUUID()}.png`;
      await uploadToBucket(getImagesBucket(), r2Key, bytes, 'image/png');
      imageUrl = await getImagesDownloadUrl(r2Key);

      logger.info('[thumb-format-n-levels image] openai direct done', {
        bytes: bytes.byteLength,
        r2_key: r2Key,
        revised_prompt_chars: result.revisedPrompt?.length ?? 0,
      });
    }

    logger.info('[thumb-format-n-levels image] done', {
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
