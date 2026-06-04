import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { generateText } from '@/lib/ai';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

/**
 * POST /api/production-doc/thumbnail/auto-regions
 *
 * Identify rectangular regions in a section-divider thumbnail by sending
 * it to a vision-capable model. Used by the production-doc thumbnail
 * region editor's "✨ Auto-detect regions" button so the editor doesn't
 * have to hand-draw every panel of a 2×2 / 3×3 collage thumbnail.
 *
 * Body: { imageUrl: string, width: number, height: number }
 * Returns: { regions: ThumbnailRegion[] } where each region has
 *   { id, label, x, y, w, h } in INTRINSIC PIXEL coordinates.
 *
 * Costs about $0.0005 per call on Claude Haiku 4.5 (current vision pick).
 * Workspace-scoped, rate-limited at 20/min/IP.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Vision-capable model allowlist. Mirrors the competitor-thumbnail-analyser
// route. Any of these accepts an `image: { base64, mimeType }` arg via the
// `generateText` helper. Kie variants are preferred for users without
// direct provider keys.
const VISION_ALLOWED = new Set<string>([
  // Anthropic direct
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  // OpenAI direct
  'gpt-4o', 'gpt-4o-mini',
  // Google direct
  'gemini-2.0-flash', 'gemini-2.0-flash-thinking-exp', 'gemini-2.5-flash',
  // Kie.ai — Gemini variants
  'kie-gemini-2.5-flash', 'kie-gemini-2.5-pro',
  'kie-gemini-3-flash', 'kie-gemini-3-pro', 'kie-gemini-3.1-pro', 'kie-gemini-3-5-flash',
  // Kie.ai — Claude variants
  'kie-claude-opus-4-7', 'kie-claude-opus-4-6', 'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5', 'kie-claude-opus-4-5', 'kie-claude-haiku-4-5',
]);

const DEFAULT_VISION_MODEL = 'kie-gemini-3-flash';

export const maxDuration = 60;

interface RegionShape {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  const { limited } = checkRateLimit(`auto-regions:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: { imageUrl?: string; width?: number; height?: number; modelId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const imageUrl = body.imageUrl?.trim();
  const width = Number(body.width);
  const height = Number(body.height);
  if (!imageUrl || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return NextResponse.json({ error: 'imageUrl, width, height are required' }, { status: 400 });
  }

  // Caller picks the vision model. Fall back to a Kie-routed Gemini Flash
  // for users who don't have direct provider keys configured.
  const requestedModel = typeof body.modelId === 'string' && body.modelId.trim()
    ? body.modelId.trim()
    : DEFAULT_VISION_MODEL;
  if (!VISION_ALLOWED.has(requestedModel)) {
    return NextResponse.json(
      {
        error: `Model "${requestedModel}" can't process images. Pick a vision-capable model (Gemini, Claude, GPT-4o, or any Kie variant of those).`,
      },
      { status: 400 },
    );
  }

  // No SSRF guard here — the imageUrl always points at our own R2-hosted
  // production-doc thumbnail (stored on the doc, set by the upload route).
  // It is server-state, not user-input on this request. We still enforce
  // https + size + content-type below so a misconfigured thumbnail URL
  // can't make us fetch arbitrary bytes.
  if (!/^https:\/\//i.test(imageUrl)) {
    return NextResponse.json({ error: 'imageUrl must be an https URL' }, { status: 400 });
  }
  let imgRes: Response;
  try {
    imgRes = await fetch(imageUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn('Auto-regions thumbnail fetch failed', { detail, imageUrl });
    return NextResponse.json({ error: `Failed to fetch thumbnail: ${detail}` }, { status: 502 });
  }
  if (!imgRes.ok) {
    return NextResponse.json({ error: `Thumbnail fetch failed (${imgRes.status})` }, { status: 502 });
  }
  const declaredLen = Number.parseInt(imgRes.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Thumbnail exceeds 8 MB cap' }, { status: 413 });
  }
  const contentType = (imgRes.headers.get('content-type') || 'image/jpeg').toLowerCase();
  const arrayBuf = await imgRes.arrayBuffer();
  if (arrayBuf.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Thumbnail exceeds 8 MB cap' }, { status: 413 });
  }
  const base64 = Buffer.from(arrayBuf).toString('base64');
  const mimeType: 'image/png' | 'image/jpeg' = contentType.includes('png') ? 'image/png' : 'image/jpeg';

  const system = `You analyse thumbnail images for a video production tool. Each thumbnail is a composite layout (often a 2×2 / 3×3 / Nx1 grid of panels with images + text labels). Your job is to identify each distinct rectangular panel and return its bounding box plus a short label.`;

  const user = `This thumbnail is ${Math.round(width)} × ${Math.round(height)} pixels in its intrinsic coordinate space.

Identify every clearly demarcated rectangular panel. Output ONLY a JSON array — no commentary, no markdown fences — with one object per panel:

[
  {
    "label": "<1-6 words describing the panel; prefer the visible text label of the panel when present>",
    "x": <integer pixel offset from left edge>,
    "y": <integer pixel offset from top edge>,
    "w": <integer pixel width of the panel>,
    "h": <integer pixel height of the panel>
  }
]

Rules:
- Coordinates are integer pixels in the ${Math.round(width)}×${Math.round(height)} image. Do not normalise.
- Cover the panel CONTENT (image area + caption strip if present), not the surrounding background margins.
- Panels must not overlap.
- Skip any solid background area outside the panels.
- If a panel has a visible text label (e.g. "The Escalation"), copy that as the label verbatim.
- If there's no clear text label, describe the panel content in 2-4 words.

Output the JSON array only. Nothing before, nothing after.`;

  let raw: string;
  try {
    raw = await generateText({
      modelId: requestedModel,
      prompt: user,
      systemPrompt: system,
      maxTokens: 1500,
      temperature: 0.1,
      image: { base64, mimeType },
    });
  } catch (err) {
    logger.error('Auto-regions vision call failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Vision call failed' },
      { status: 502 },
    );
  }

  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch {
    logger.warn('Auto-regions: model returned unparseable JSON', { raw: raw.slice(0, 500) });
    return NextResponse.json({ error: 'Model returned invalid JSON', raw: raw.slice(0, 500) }, { status: 502 });
  }
  if (!Array.isArray(parsed)) {
    return NextResponse.json({ error: 'Model output is not an array' }, { status: 502 });
  }

  // Validate each region: must have numeric x/y/w/h within image bounds
  // and a string label. Drop anything that doesn't shape-match — better
  // to return fewer regions than to ship a corrupt one to the editor.
  const validated = parsed
    .map((r: unknown): RegionShape | null => {
      if (!r || typeof r !== 'object') return null;
      const obj = r as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 60) : '';
      const x = Math.round(Number(obj.x));
      const y = Math.round(Number(obj.y));
      const w = Math.round(Number(obj.w));
      const h = Math.round(Number(obj.h));
      if (![x, y, w, h].every(Number.isFinite)) return null;
      if (w <= 0 || h <= 0) return null;
      if (x < 0 || y < 0 || x + w > width || y + h > height) return null;
      return { label: label || 'Region', x, y, w, h };
    })
    .filter((r): r is RegionShape => r !== null);

  const regions = validated.map((r) => ({
    id: randomUUID().slice(0, 8),
    label: r.label,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
  }));

  return NextResponse.json({ regions });
});
