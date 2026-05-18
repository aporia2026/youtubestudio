import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResult } from '@/lib/kie-poll';
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
const IMAGE_MODEL_MAP: Record<string, { model: string; refKey: 'input_urls' | 'image_urls' }> = {
  'gpt-image-2-i2i': { model: 'gpt-image-2-image-to-image', refKey: 'input_urls' },
  'grok-imagine-i2i': { model: 'grok-imagine/image-to-image', refKey: 'image_urls' },
  'flux2-pro-i2i': { model: 'flux-2/pro-image-to-image', refKey: 'image_urls' },
  'flux2-flex-i2i': { model: 'flux-2/flex-image-to-image', refKey: 'image_urls' },
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
    const referenceImageUrl = (body.referenceImageUrl || '').trim();

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
      gridRows,
      gridCols,
      cards_count: cards.length,
      prompt_chars: prompt.length,
      has_user_reference: true,
      ref_host: safeRefUrl.hostname,
    });

    // Build Kie input. Match the existing /api/thumbnails/image patterns:
    // gpt-image-2 uses `input_urls`, every other i2i model uses `image_urls`.
    // nsfw_checker is on for everything except gpt-image-2 (which 422's on it
    // per Kie's market spec).
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

    logger.info('[thumb-format-grid image] done', {
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
