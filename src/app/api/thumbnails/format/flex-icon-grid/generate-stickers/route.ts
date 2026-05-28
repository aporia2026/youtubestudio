import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { buildKieImageInput, getImageModelSpec } from '@/lib/image-models';
import { sliceCollage } from '@/lib/collage-slicer';

export const maxDuration = 300;

/**
 * Flex Icon Grid — AI sticker batch generation (2×2 collage).
 *
 * Generates four sticker images in a single image-gen call, slices
 * the result into four per-cell URLs, returns them keyed by cell
 * index. ~75% cost reduction vs four separate calls — matches the
 * "Generate 4 shots at once (collage mode)" pattern your existing
 * thumbnail flow already proved out.
 *
 * Request shape:
 *   {
 *     model?: string;  // Kie model id; defaults to gpt-image-2-t2i
 *     stickers: Array<{ cellIndex: number; prompt: string }>;  // exactly 4
 *   }
 *
 * Response shape:
 *   { stickers: Record<number, string>; }  // cellIndex → sticker URL
 *
 * Cost flag (rule 8): one image-gen call per request, ~$0.04–0.10
 * depending on the model. The client surfaces this estimate before
 * the user clicks generate.
 */

const DEFAULT_IMAGE_MODEL = 'gpt-image-2-t2i';

interface ReqBody {
  model?: string;
  stickers?: Array<{ cellIndex?: unknown; prompt?: unknown }>;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const ipLimit = checkRateLimit(`flex-icon-grid-stickers:${getClientIP(req)}`, 10, 60_000);
  if (ipLimit.limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }
  const userLimit = checkRateLimit(`flex-icon-grid-stickers-uid:${session.uid}`, 30, 60_000);
  if (userLimit.limited) {
    return NextResponse.json(
      { error: 'Rate limited (account)' },
      { status: 429 },
    );
  }

  let body: ReqBody;
  try {
    body = (await req.json()) as ReqBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Normalise input. Exactly four stickers per batch — anything else
  // is rejected so the slicing math stays simple.
  const raw = Array.isArray(body.stickers) ? body.stickers : [];
  if (raw.length !== 4) {
    return NextResponse.json(
      { error: `stickers must be exactly 4 entries (got ${raw.length})` },
      { status: 400 },
    );
  }
  const stickers: { cellIndex: number; prompt: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const cellIndex = Number(entry.cellIndex);
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    if (!Number.isInteger(cellIndex) || cellIndex < 1) {
      return NextResponse.json({ error: `sticker ${i + 1} missing cellIndex` }, { status: 400 });
    }
    if (!prompt) {
      return NextResponse.json({ error: `sticker ${i + 1} missing prompt` }, { status: 400 });
    }
    stickers.push({ cellIndex, prompt });
  }

  const modelId = String(body.model || DEFAULT_IMAGE_MODEL).trim();
  const spec = getImageModelSpec(modelId);
  if (!spec) {
    return NextResponse.json({ error: `Unknown image model: ${modelId}` }, { status: 400 });
  }
  if (spec.provider !== 'kie') {
    return NextResponse.json(
      { error: `Sticker generation currently requires a Kie model (got ${spec.provider})` },
      { status: 400 },
    );
  }
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: 'KIE_API_KEY environment variable is not configured' },
      { status: 503 },
    );
  }

  // Compose the sticker-style collage prompt. Distinct from the
  // production-doc collage prompt: emphasis on flat illustration,
  // single iconic subject per cell, no backgrounds, no text — exactly
  // the aesthetic the reference channels' icons hit.
  const composedPrompt = composeStickerCollagePrompt(stickers.map((s) => s.prompt));
  const t0 = Date.now();
  let upscaledUrl: string;
  try {
    const taskId = await createKieTask(apiKey, spec.kieModel!, buildKieImageInput(spec.value, composedPrompt));
    upscaledUrl = await pollKieResultThenUpscale(taskId, apiKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('[flex-icon-grid stickers] generation failed', { reason });
    return NextResponse.json(
      { error: `Sticker generation failed: ${reason}`, code: 'GEN_FAILED' },
      { status: 502 },
    );
  }

  let slice: Awaited<ReturnType<typeof sliceCollage>>;
  try {
    slice = await sliceCollage(upscaledUrl, { r2KeyPrefix: 'flex-icon-grid/stickers' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('[flex-icon-grid stickers] slice failed', { reason });
    return NextResponse.json(
      { error: `Sticker slice failed: ${reason}`, code: 'SLICE_FAILED' },
      { status: 500 },
    );
  }

  const stickerMap: Record<number, string> = {};
  for (let i = 0; i < 4; i++) {
    stickerMap[stickers[i].cellIndex] = slice.quadrantUrls[i];
  }

  logger.info('[flex-icon-grid stickers] success', {
    model: modelId,
    cell_count: stickers.length,
    total_ms: Date.now() - t0,
    cell_indexes: stickers.map((s) => s.cellIndex),
  });

  return NextResponse.json({ stickers: stickerMap }, { status: 201 });
});

/**
 * Compose the 4 sticker prompts into a 2×2 collage instruction. Same
 * 2×2 structure as the production-doc collage but with sticker-
 * specific style language — the difference matters because image
 * models will gladly render a "cinematic scene with a virus icon"
 * when the prompt says "scene" but a flat sticker when it says
 * "flat vector sticker".
 */
function composeStickerCollagePrompt(prompts: readonly string[]): string {
  const LABELS = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'] as const;
  const cellLines = prompts.map((p, i) => `${LABELS[i]}: ${p}`).join('\n');
  return (
    'A 2x2 grid collage of 4 flat-vector sticker illustrations, separated by a thin neutral grey border (10px). '
    + 'Each sticker is a single iconic subject centred in its cell with a clean white or off-white background, '
    + 'bold outlines, saturated flat colours, no photoreal rendering, no text, no shadows beyond a subtle drop. '
    + 'Sticker style — like an explainer-channel asset, not a movie poster.\n\n'
    + cellLines
    + '\n\nIMPORTANT: each cell must contain ONLY its own sticker with no visual elements bleeding between cells. '
    + 'No text inside the stickers. No background scenes.'
  );
}
