/**
 * Post-process preview endpoint — r2.8+ live-tweak feedback.
 *
 * Takes an already-rendered base image URL plus a post-process / title-bar
 * config and returns the COMPOSITED result without going through any AI
 * model. The panel calls this on every slider change (debounced ~400 ms)
 * so the user sees overlay tweaks land in under a second without paying
 * the 30–300 s AI re-render cost.
 *
 * Response shape: `{ imageUrl: string }` where `imageUrl` is a `data:` URL
 * carrying the PNG bytes inline. The panel sets `<img src={imageUrl}>`
 * directly — no R2 round-trip, no presigned URL, no extra request. The
 * preview is transient by design; the caller does NOT replace the rendered
 * thumbnail with it until the user clicks "Render again" or sets the
 * preview as the rendered result.
 *
 * Security:
 *  - `baseImageUrl` flows through `assertSafePublicUrl` (HTTPS only) so a
 *    stale or malicious client can't smuggle a private host.
 *  - The fetched bytes are capped at 25 MB — well above any legitimate
 *    Topic Card Grid / N Levels render.
 *  - Pixel-bomb protection is handled by sharp's `limitInputPixels`
 *    inside `applySharedOverlays`.
 *  - Rate limited at 30/min per client IP (slider drags can fire bursts).
 *
 * Why one shared endpoint instead of format-specific routes: the post-
 * process pipeline is the same shape for every thumbnail format that
 * already wires `applySharedOverlays` — the input is a PNG + config and
 * the output is a PNG. Forking per-format would duplicate the SSRF guard
 * + fetch + sharp dance four times for zero behavioural difference.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  applySharedOverlays,
  parsePostProcessConfig,
  parseTitleBarRequestPayload,
  type FontRef,
  type PostProcessConfig,
  type TitleBarConfig,
} from '@/lib/thumbnail-formats/shared-overlay-pipeline';
import {
  DEFAULT_FONT_ID,
  findFontById,
} from '@/lib/thumbnail-formats/topic-card-grid-fonts';
import { fontFilePath } from '@/lib/thumbnail-formats/topic-card-grid-fonts-server';
import { assertSafePublicUrl } from '@/lib/url-safety';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import sharp from 'sharp';

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const RATE_LIMIT_PER_MIN = 30;

export const maxDuration = 30;

interface ReqBody {
  baseImageUrl?: string;
  postProcess?: unknown;
  titleBar?: unknown;
  /** Optional canvas dimensions override — used when the panel hasn't
   *  yet probed the base image's true dimensions. Falls back to a
   *  sharp metadata probe when absent. */
  canvasWidth?: number;
  canvasHeight?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(
      `thumb-post-process-preview:${getClientIP(req)}`,
      RATE_LIMIT_PER_MIN,
      60_000,
    );
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    let body: ReqBody;
    try {
      body = (await req.json()) as ReqBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const baseImageUrl = (body.baseImageUrl ?? '').trim();
    if (!baseImageUrl) {
      return NextResponse.json({ error: 'baseImageUrl is required' }, { status: 400 });
    }

    // SSRF guard — same posture as the format routes' reference-image
    // guard. https only so we don't leak metadata via DNS / proxy chains.
    let safeUrl: URL;
    try {
      safeUrl = assertSafePublicUrl(baseImageUrl, { allowedProtocols: ['https:'] });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `baseImageUrl was rejected: ${reason}` },
        { status: 400 },
      );
    }

    // Fetch the base image. R2 presigned URLs typically respond in
    // 50-200 ms so this stays well under the 30 s function timeout.
    const baseRes = await fetch(safeUrl);
    if (!baseRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch base image (HTTP ${baseRes.status})` },
        { status: 502 },
      );
    }
    const declaredLen = Number.parseInt(baseRes.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_INPUT_BYTES) {
      return NextResponse.json(
        { error: `Base image exceeds the ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB cap.` },
        { status: 413 },
      );
    }
    const arrayBuf = await baseRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_INPUT_BYTES) {
      return NextResponse.json(
        { error: `Base image exceeds the ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB cap.` },
        { status: 413 },
      );
    }
    const baseBytes = Buffer.from(arrayBuf);

    // Probe canvas dimensions. Caller can override (saves the probe when
    // the panel already has them); otherwise sharp.metadata is cheap.
    let canvasW = Number.isInteger(body.canvasWidth) ? Number(body.canvasWidth) : 0;
    let canvasH = Number.isInteger(body.canvasHeight) ? Number(body.canvasHeight) : 0;
    if (!canvasW || !canvasH) {
      const meta = await sharp(baseBytes).metadata();
      canvasW = meta.width ?? 1280;
      canvasH = meta.height ?? 720;
    }

    // Parse the two payloads with the same tolerant parsers the format
    // routes use. Either can be null / undefined (no overlay → returns
    // the base re-encoded).
    const postProcess: PostProcessConfig | null = parsePostProcessConfig(body.postProcess);
    const titleBarPayload = parseTitleBarRequestPayload(body.titleBar);
    let titleBar: TitleBarConfig | undefined;
    if (titleBarPayload) {
      const resolveFont = (id: string): FontRef => {
        const f = findFontById(id) ?? findFontById(DEFAULT_FONT_ID)!;
        return { family: f.family, filePath: fontFilePath(f) };
      };
      titleBar = {
        text: titleBarPayload.text,
        subtitle: titleBarPayload.subtitle,
        position: titleBarPayload.position,
        heightFraction: titleBarPayload.heightFraction,
        align: titleBarPayload.align,
        subtitleAlign: titleBarPayload.subtitleAlign,
        backgroundColor: titleBarPayload.backgroundColor,
        backgroundOpacity: titleBarPayload.backgroundOpacity,
        textColor: titleBarPayload.textColor,
        subtitleColor: titleBarPayload.subtitleColor,
        font: resolveFont(titleBarPayload.fontId),
        subtitleFont: titleBarPayload.subtitleFontId
          ? resolveFont(titleBarPayload.subtitleFontId)
          : undefined,
        shadow: titleBarPayload.shadow,
      };
    }

    const finalBytes = await applySharedOverlays({
      baseImage: baseBytes,
      canvas: { width: canvasW, height: canvasH },
      postProcess: postProcess ?? undefined,
      titleBar,
    });

    // Return as a data URL so the panel can <img src=...> it without
    // touching R2. ~500 KB-2 MB base64 string per preview at full size.
    // Caller is expected to debounce so we don't pay this cost on every
    // pixel of slider drag.
    const dataUrl = `data:image/png;base64,${finalBytes.toString('base64')}`;

    logger.info('[thumb-post-process-preview] done', {
      duration_ms: Date.now() - startedAt,
      canvas_w: canvasW,
      canvas_h: canvasH,
      post_process_applied: !!postProcess,
      title_bar_applied: !!titleBar,
      input_bytes: baseBytes.byteLength,
      output_bytes: finalBytes.byteLength,
      base_url_host: safeUrl.hostname,
    });

    return NextResponse.json({ imageUrl: dataUrl });
  } catch (err) {
    logger.error('[thumb-post-process-preview] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Preview render failed' },
      { status: 500 },
    );
  }
}
