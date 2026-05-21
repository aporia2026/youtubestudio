/**
 * POST /api/generate/style-sheet
 *
 * Generates the per-doc style sheet — a single image that every per-row
 * generation chains against (via img-to-img at moderate denoise) so the
 * whole video looks like it's from the same world. See
 * `_plans/2026-05-21-phase-7-style-sheet.md`.
 *
 * Request body:
 *   {
 *     stylePrompt: string;            // doc's resolved style suffix
 *     hasProtagonist: boolean;
 *     protagonistDescription?: string; // optional free-text context
 *     model?: 'flux-schnell-local' | 'qwen-image-local'; // default flux
 *     docId?: string;                 // used in the R2 key for traceability
 *   }
 *
 * Response:
 *   {
 *     imageUrl: string;               // R2-hosted permanent URL
 *     model: string;
 *     prompt: string;                 // the prompt used (for re-roll)
 *     hasProtagonist: boolean;
 *     width: number;
 *     height: number;
 *   }
 *
 * Local-only — returns 503 when LOCAL_STUDIO=1 is unset. Cloud-Kie style
 * sheets are out of scope for v1 (Kie models can't be reference-image
 * chained at the latent level; the per-doc text description is used as
 * a fallback in the production-doc image route).
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import {
  buildSheetPrompt,
  PROTAGONIST_SHEET_DIMENSIONS,
  SCENE_SHEET_DIMENSIONS,
  type StyleSheetModel,
} from '@/lib/style-sheet';
import { ComfyUIClient } from '@/lib/comfyui/client';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

const SUPPORTED_MODELS: ReadonlyArray<{ value: StyleSheetModel; workflowId: 'flux-schnell-t2i' | 'qwen-image-t2i' }> = [
  { value: 'flux-schnell-local', workflowId: 'flux-schnell-t2i' },
  { value: 'qwen-image-local', workflowId: 'qwen-image-t2i' },
];

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json(
      { error: 'Style-sheet generation requires LOCAL_STUDIO=1 (local ComfyUI).' },
      { status: 503 },
    );
  }
  // Sheets are heavy (≤ 5 minutes each) so the ceiling is lower than the
  // per-row image generation rate limit. A user shouldn't be re-rolling
  // dozens of sheets per minute — if they are, something is wrong.
  const { limited } = checkRateLimit(`style-sheet:${getClientIP(req)}`, 10, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: {
    stylePrompt?: string;
    hasProtagonist?: boolean;
    protagonistDescription?: string;
    model?: string;
    docId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const stylePrompt = (body.stylePrompt ?? '').trim();
  if (!stylePrompt) {
    return NextResponse.json({ error: 'stylePrompt is required' }, { status: 400 });
  }
  const hasProtagonist = body.hasProtagonist === true;
  const protagonistDescription = body.protagonistDescription?.trim() || undefined;

  const modelValue = body.model || 'flux-schnell-local';
  const modelEntry = SUPPORTED_MODELS.find(m => m.value === modelValue);
  if (!modelEntry) {
    return NextResponse.json(
      {
        error: `Unsupported style-sheet model '${modelValue}'. Valid: ${SUPPORTED_MODELS.map(m => m.value).join(', ')}`,
      },
      { status: 400 },
    );
  }

  const dims = hasProtagonist ? PROTAGONIST_SHEET_DIMENSIONS : SCENE_SHEET_DIMENSIONS;
  const fullPrompt = buildSheetPrompt({
    stylePrompt,
    hasProtagonist,
    protagonistDescription,
  });

  const t0 = Date.now();
  logger.info('[style-sheet gen] start', {
    doc_id: body.docId ?? null,
    model: modelEntry.value,
    has_protagonist: hasProtagonist,
    width: dims.width,
    height: dims.height,
    prompt_preview: fullPrompt.slice(0, 120),
  });

  const { ComfyUILocalGenerator } = await import('@/lib/visual-generator/comfyui-local');
  const generator = new ComfyUILocalGenerator();
  if (!(await generator.isReachable())) {
    return NextResponse.json(
      { error: 'ComfyUI not reachable on localhost:8188 — start it and try again.' },
      { status: 503 },
    );
  }

  let result;
  try {
    result = await generator.generateImage(fullPrompt, {
      workflowId: modelEntry.workflowId,
      width: dims.width,
      height: dims.height,
    });
  } catch (err) {
    logger.error('[style-sheet gen] generator failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 },
    );
  }

  // Mirror to R2 so the URL survives across ComfyUI restarts and is
  // reachable from the Remotion render (which doesn't talk to localhost).
  // R2 path mirrors the per-row image-gen pattern at
  // `src/app/api/generate/production-doc/image/route.ts`.
  let imageUrl = result.url;
  try {
    const comfy = new ComfyUIClient();
    const m = result.url.match(
      /\bfilename=([^&]+).*?subfolder=([^&]*).*?type=([^&]+)/,
    );
    if (m) {
      const { bytes } = await comfy.fetchOutputBytes({
        filename: decodeURIComponent(m[1]),
        subfolder: decodeURIComponent(m[2]),
        type: decodeURIComponent(m[3]) as 'output' | 'temp' | 'input',
      });
      const buffer = Buffer.from(bytes);
      const docId = (body.docId ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'no-doc';
      const r2Key = `style-sheets/${docId}-${Date.now()}.png`;
      const bucket = getImagesBucket();
      await uploadToBucket(bucket, r2Key, buffer, 'image/png');
      imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
    } else {
      logger.warn('[style-sheet gen] could not parse generator URL for R2 mirror', {
        url: result.url,
      });
    }
  } catch (uploadErr) {
    logger.warn('[style-sheet gen] R2 mirror failed, returning ComfyUI proxy URL', {
      detail: uploadErr instanceof Error ? uploadErr.message : String(uploadErr),
    });
  }

  const ms = Date.now() - t0;
  logger.info('[style-sheet gen] done', {
    doc_id: body.docId ?? null,
    model: modelEntry.value,
    has_protagonist: hasProtagonist,
    ms,
    image_url_preview: imageUrl.slice(0, 100),
  });

  return NextResponse.json({
    imageUrl,
    model: modelEntry.value,
    prompt: fullPrompt,
    hasProtagonist,
    width: dims.width,
    height: dims.height,
  });
});
