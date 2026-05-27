import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { createKieTask, pollKieResultThenUpscale } from '@/lib/kie-poll';
import { generateImageOpenAI } from '@/lib/openai-images';
import { uploadToBucket, getImagesBucket, getImagesDownloadUrl } from '@/lib/r2';
import {
  topicCardGridImagePrompt,
  validateCardList,
  makeDefaultLayout,
  computeRegionsFor,
  DEFAULT_CANVAS,
  type CardShape,
  type TopicCard,
  type GlobalPalette,
} from '@/lib/thumbnail-formats/topic-card-grid';
import {
  applyCellUploads,
  SHARP_INPUT_PIXEL_CAP,
  type CellUpload,
} from '@/lib/thumbnail-formats/topic-card-grid-composite';
import sharp from 'sharp';
import { assertSafePublicUrl } from '@/lib/url-safety';
import type { ThumbnailRegion } from '@/remotion/types';

const BUNDLED_REFERENCE_FILENAME = 'topic-card-grid-default.png';
const BUNDLED_REFERENCE_PATH = path.join(
  process.cwd(),
  'public/thumbnail-formats',
  BUNDLED_REFERENCE_FILENAME,
);

/** Stable R2 key for the bundled default reference image. Same key on
 *  every deploy so we don't accumulate orphaned copies, and so the
 *  upload-if-missing call below is idempotent. */
const BUNDLED_REFERENCE_R2_KEY = `thumbnails/format-grid-defaults/${BUNDLED_REFERENCE_FILENAME}`;

/** Module-scoped cache flag — once we've staged the bundled default to
 *  R2 within this Function instance we don't need to re-upload on every
 *  request. Cold starts repeat the upload; that's fine, R2 PUT is
 *  idempotent and adds ~100ms only on the first request per instance. */
let bundledReferenceStagedToR2 = false;

/**
 * Returns the public URL of the bundled curated default reference image
 * IFF it exists on disk in this deployment.
 *
 * Background: Kie fetches the reference URL from its own servers. If we
 * hand it `${getAppUrl()}/thumbnail-formats/...`, that URL goes through
 * Vercel Deployment Protection on preview deploys (and even on production
 * deploys that have protection enabled), so Kie's fetch returns 401 and
 * Kie surfaces "Image fetch failed. Check access settings or use our File
 * Upload API instead." The fix: stage the PNG to R2 with a stable key and
 * hand Kie the R2 presigned URL, which is publicly fetchable.
 *
 * Returns null when the PNG hasn't been generated and committed yet, so
 * the API can fall back to "reference upload required" cleanly.
 */
async function bundledReferenceUrlIfPresent(): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(BUNDLED_REFERENCE_PATH);
  } catch {
    return null;
  }
  if (!bundledReferenceStagedToR2) {
    try {
      await uploadToBucket(getImagesBucket(), BUNDLED_REFERENCE_R2_KEY, buf, 'image/png');
      bundledReferenceStagedToR2 = true;
      logger.info('[thumb-format-grid image] bundled reference staged to r2', {
        r2_key: BUNDLED_REFERENCE_R2_KEY,
        bytes: buf.byteLength,
      });
    } catch (err) {
      // Surface — without R2 access the route cannot produce a Kie-
      // accessible URL for the bundled default. Caller will return a
      // clear 400 to the user.
      logger.warn('[thumb-format-grid image] bundled reference r2 stage failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return await getImagesDownloadUrl(BUNDLED_REFERENCE_R2_KEY);
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
  cardShape?: 'square' | 'circle';
  /** Per-cell uploads. Each entry pairs a 1-based `cardIndex` with the R2
   *  download URL of the user's uploaded image. The server fetches the
   *  bytes (with SSRF + size guards), then hands them to the composite
   *  module which paints them over the AI-rendered cell. See
   *  `_plans/2026-05-19-topic-card-grid-circles-and-uploads.md`. */
  uploads?: Array<{ cardIndex: number; imageUrl: string }>;
}

/** Hard cap on uploaded image bytes per cell. Matches the presign route's
 *  `MAX_FILE_SIZE` so a presigned upload that slipped past the browser
 *  check still fails here. Pixel-bomb protection is handled separately
 *  inside the composite module via sharp's `limitInputPixels`. */
const MAX_CELL_UPLOAD_BYTES = 8 * 1024 * 1024;

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

    // Card shape — defaults to 'square' so older clients that don't send
    // the field keep working unchanged.
    const cardShape: CardShape = body.cardShape === 'circle' ? 'circle' : 'square';

    // Per-cell uploads. Each entry's URL passes the same SSRF guard the
    // reference URL passes; out-of-range cardIndex values are dropped
    // server-side so a stale client can't smuggle in extras. The bytes
    // themselves are fetched below, after the AI image lands — we don't
    // want to pay the egress on a request that will fail validation later.
    const totalCards = gridRows * gridCols;
    const uploadRequests: Array<{ cardIndex: number; safeUrl: URL }> = [];
    if (Array.isArray(body.uploads)) {
      const seen = new Set<number>();
      for (const entry of body.uploads) {
        if (!entry || typeof entry !== 'object') continue;
        const cardIndex = Number((entry as { cardIndex?: unknown }).cardIndex);
        const rawUrl = String((entry as { imageUrl?: unknown }).imageUrl ?? '').trim();
        if (!Number.isInteger(cardIndex) || cardIndex < 1 || cardIndex > totalCards) continue;
        if (seen.has(cardIndex)) continue;
        if (!rawUrl) continue;
        let safeUrl: URL;
        try {
          safeUrl = assertSafePublicUrl(rawUrl, { allowedProtocols: ['https:'] });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return NextResponse.json(
            { error: `Cell upload URL for card ${cardIndex} was rejected: ${reason}` },
            { status: 400 },
          );
        }
        seen.add(cardIndex);
        uploadRequests.push({ cardIndex, safeUrl });
      }
    }
    const uploadedCellIndexes = uploadRequests.map((u) => u.cardIndex).sort((a, b) => a - b);

    // Layout + regions are computed AFTER the AI image lands so they're
    // keyed off the actual canvas dimensions of `aiBytes`, not the
    // 1280×720 default. Kie upscales to ~4K; OpenAI returns 2048×1152.
    // If we computed layout against DEFAULT_CANVAS and then composited
    // onto the (much larger) AI image, every overlay would land in the
    // top-left quadrant at miniature size — which is the
    // "uploads-not-where-they-should-be" bug 2026-05-26. `outputWidth`/
    // `outputHeight` from the body are kept as DEFAULTS for the rare
    // case the AI image lacks readable dimensions; the actual probe
    // overrides them downstream.
    const fallbackOutputWidth = Number.isInteger(body.outputWidth) ? Number(body.outputWidth) : DEFAULT_CANVAS.width;
    const fallbackOutputHeight = Number.isInteger(body.outputHeight) ? Number(body.outputHeight) : DEFAULT_CANVAS.height;
    const labels = cards.map((c) => c.label);

    const prompt = topicCardGridImagePrompt({
      cards,
      palette,
      gridRows,
      gridCols,
      notesForImageModel: body.notesForImageModel,
      cardShape,
      uploadedCellIndexes: uploadedCellIndexes.length > 0 ? uploadedCellIndexes : undefined,
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
      card_shape: cardShape,
      uploads_count: uploadRequests.length,
    });

    // Each provider branch produces `aiBytes` (the raw AI output) plus a
    // few diagnostic fields. A single R2 upload happens at the end so the
    // composite step (if any) runs in one place and we don't pay double
    // storage for the pre- and post-composite artifacts.
    let aiBytes: Buffer;
    let taskId: string | undefined;
    let providerDetailLog: Record<string, unknown> = {};

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
      // System-wide auto-upscale runs after poll. See src/lib/upscale.ts.
      const kieImageUrl = await pollKieResultThenUpscale(taskId, apiKey);

      // Kie's hosted resultUrls expire after hours/days AND live on a host
      // outside our download-proxy allowlist, so we always fetch the bytes
      // here and let the unified R2 upload at the end produce the canonical
      // permanent URL.
      const kieRes = await fetch(kieImageUrl);
      if (!kieRes.ok) {
        throw new Error(`Failed to fetch Kie result image (HTTP ${kieRes.status}).`);
      }
      const kieArrayBuf = await kieRes.arrayBuffer();
      aiBytes = Buffer.from(kieArrayBuf);
      providerDetailLog = {
        kie_host: (() => { try { return new URL(kieImageUrl).hostname; } catch { return 'unknown'; } })(),
        ai_bytes: aiBytes.byteLength,
      };
    } else {
      // OpenAI direct path. Fetch the reference image bytes (Kie passed a
      // URL, OpenAI's edits endpoint expects a multipart file upload), call
      // /v1/images/edits synchronously. Bytes flow into the shared
      // composite + R2 upload below. This is the emergency fast-path — no
      // polling, returns in 20-60s typically.
      let referenceBytes: Buffer | undefined;
      let referenceMime: string | undefined;
      if (config.mode === 'i2i') {
        if (usedBundledDefault) {
          // The reference is the curated PNG that ships in /public. Read
          // it from disk directly — HTTP-fetching our own preview URL
          // hits Vercel's Deployment Protection (401) because server-to-
          // server requests don't carry the protection-bypass cookie, and
          // it's a pointless round-trip even when public.
          const buf = await fs.readFile(BUNDLED_REFERENCE_PATH);
          referenceBytes = buf;
          referenceMime = 'image/png';
        } else {
          // User-supplied reference URL — HTTP fetch with the existing
          // SSRF-guarded `safeRefUrl`.
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
      }

      const result = await generateImageOpenAI({
        prompt,
        size: '2048x1152', // true 16:9 — the only OpenAI size that matches YouTube's thumbnail aspect
        quality: 'medium',
        referenceImage: referenceBytes && referenceMime
          ? { bytes: referenceBytes, mimeType: referenceMime, filename: 'reference.png' }
          : undefined,
      });

      aiBytes = Buffer.from(result.base64, 'base64');
      providerDetailLog = {
        ai_bytes: aiBytes.byteLength,
        revised_prompt_chars: result.revisedPrompt?.length ?? 0,
      };
    }

    // Probe the actual AI image dimensions so the layout we use for
    // composite + regions matches the pixel grid of `aiBytes`. Kie's
    // post-upscale output lands around 4K; OpenAI returns 2048×1152;
    // the 1280×720 DEFAULT_CANVAS guess is essentially never right.
    // sharp.metadata is cheap (<10ms) — no decode of the full image.
    const aiMeta = await sharp(aiBytes, { limitInputPixels: SHARP_INPUT_PIXEL_CAP }).metadata();
    const canvasW = aiMeta.width && aiMeta.width > 0 ? aiMeta.width : fallbackOutputWidth;
    const canvasH = aiMeta.height && aiMeta.height > 0 ? aiMeta.height : fallbackOutputHeight;
    const layout = makeDefaultLayout(gridRows, gridCols, canvasW, canvasH, cardShape);
    const regions: ThumbnailRegion[] = computeRegionsFor(layout, labels, () => randomUUID(), cardShape);
    logger.info('[thumb-format-grid image] layout from ai dims', {
      ai_width: aiMeta.width,
      ai_height: aiMeta.height,
      canvas_w: canvasW,
      canvas_h: canvasH,
      fallback_used: !(aiMeta.width && aiMeta.height),
      outer_margin: layout.outerMargin,
      gutter: layout.gutter,
      card_w: regions[0]?.w,
      card_h: regions[0]?.h,
      card_shape: cardShape,
      regions_count: regions.length,
    });

    // Composite step — ALWAYS runs in square mode so every cell gets
    // a deterministic label rendered at the same font size, regardless
    // of whether the user attached an upload for it. AI's per-cell
    // label autoscaling was blowing short labels (e.g. "UVB-76") up to
    // ~1.5× the size of longer labels in the same grid; the composite
    // overpaints the AI's label band with a uniform-sized label and
    // leaves the AI's illustration intact for non-upload cells.
    //
    // Circle mode currently skips non-upload label uniformisation —
    // see applyCellUploads. Uploaded cells still get composited in both
    // shapes.
    const cellUploads: CellUpload[] = [];
    if (uploadRequests.length > 0) {
      logger.info('[thumb-format-grid image] composite uploads fetch start', {
        cell_count: uploadRequests.length,
        card_shape: cardShape,
      });
      for (const req of uploadRequests) {
        const upRes = await fetch(req.safeUrl);
        if (!upRes.ok) {
          throw new Error(
            `Failed to fetch upload for card ${req.cardIndex} (HTTP ${upRes.status}). Re-upload the image and try again.`,
          );
        }
        const declaredLen = Number.parseInt(upRes.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(declaredLen) && declaredLen > MAX_CELL_UPLOAD_BYTES) {
          throw new Error(
            `Upload for card ${req.cardIndex} exceeds the 8 MB cap. Pick a smaller image.`,
          );
        }
        const upArrayBuf = await upRes.arrayBuffer();
        if (upArrayBuf.byteLength > MAX_CELL_UPLOAD_BYTES) {
          throw new Error(
            `Upload for card ${req.cardIndex} exceeds the 8 MB cap. Pick a smaller image.`,
          );
        }
        cellUploads.push({ cardIndex: req.cardIndex, bytes: Buffer.from(upArrayBuf) });
      }
    }
    const compositeStart = Date.now();
    const finalBytes = await applyCellUploads({
      baseImage: aiBytes,
      layout,
      cards,
      cardShape,
      uploads: cellUploads,
    });
    const compositorMs = Date.now() - compositeStart;
    const uploadsApplied = cellUploads.length;
    const labelsUniformized = cardShape === 'square' ? cards.length : cellUploads.length;
    logger.info('[thumb-format-grid image] composite done', {
      duration_ms: compositorMs,
      uploads_applied: uploadsApplied,
      labels_uniformized: labelsUniformized,
      card_shape: cardShape,
      output_bytes: finalBytes.byteLength,
    });

    // Single R2 upload — prefix records the AI provider and whether the
    // composite step ran so a future audit can tell the AI's raw output
    // from a user-composited result by R2 key alone.
    const r2Prefix =
      uploadsApplied > 0
        ? 'thumbnails/format-grid-composite'
        : config.provider === 'kie'
          ? 'thumbnails/format-grid-kie'
          : 'thumbnails/format-grid-openai';
    const r2Key = `${r2Prefix}/${randomUUID()}.png`;
    await uploadToBucket(getImagesBucket(), r2Key, finalBytes, 'image/png');
    const imageUrl = await getImagesDownloadUrl(r2Key);

    logger.info('[thumb-format-grid image] persisted to r2', {
      ...providerDetailLog,
      r2_key: r2Key,
      final_bytes: finalBytes.byteLength,
      uploads_applied: uploadsApplied,
      compositor_ms: compositorMs,
    });

    logger.info('[thumb-format-grid image] done', {
      duration_ms: Date.now() - startedAt,
      task_id: taskId,
      provider: config.provider,
      uploads_applied: uploadsApplied,
      compositor_ms: compositorMs,
      card_shape: cardShape,
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
        cardShape,
      },
      cardShape,
      uploadsApplied,
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
