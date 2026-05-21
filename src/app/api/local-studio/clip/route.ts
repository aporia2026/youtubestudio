/**
 * POST /api/local-studio/clip
 *
 * Generate an image-to-video clip locally via Wan 2.2 TI2V 5B.
 * Takes a first-frame image (already uploaded to ComfyUI/input/ via
 * /api/local-studio/upload-ref) plus a motion prompt.
 *
 * Synchronous like /generate — Wan 2.2 5B Q5 lands in ~3–5 min per
 * clip on RTX 5070 Ti. The route timeout (`maxDuration = 1500` = 25
 * min) is generous because the first-ever generation pays the JIT
 * compile + model load cost on top of the steady-state runtime.
 *
 * Gated by `LOCAL_STUDIO=1`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { BUILT_IN_STYLES } from '@/lib/production-doc-styles';
import { isKnownLocalVideoWorkflow } from '@/lib/comfyui/style-mapping';
import { ComfyUILocalGenerator } from '@/lib/visual-generator/comfyui-local';

// Wan clips can take 5–8 min on 16 GB VRAM with offload + first-time
// JIT compile. 25 min ceiling leaves a safety margin.
export const maxDuration = 1500;

interface ClipBody {
  prompt?: string;
  styleId?: string | null;
  workflowId?: string | null;
  /** Filename returned by /api/local-studio/upload-ref. Required. */
  firstFrameFilename?: string;
  /** 16:9 default 1280x720. Wan snaps to multiples of 32. */
  width?: number;
  height?: number;
  /** Clamp 2..8 seconds. Wan runs at 16 fps so we quantise to its
   *  (4k+1) frame requirement internally. */
  durationSeconds?: number;
  seed?: number;
}

// Public route — same rationale as /generate: gated by LOCAL_STUDIO=1
// env, not session, so it survives DB outages.
export const POST = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Video gens are heavier — lower rate limit ceiling than images so a
  // runaway client can't queue 50 prompts back-to-back and freeze the
  // user's machine. 6 per minute is plenty for human use.
  const { limited } = checkRateLimit(`local-studio-clip:${getClientIP(req)}`, 6, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  let body: ClipBody;
  try {
    body = (await req.json()) as ClipBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }
  if (prompt.length > 2000) {
    return NextResponse.json(
      { error: 'Prompt too long — maximum 2000 characters' },
      { status: 400 },
    );
  }
  if (!body.firstFrameFilename) {
    return NextResponse.json(
      { error: 'firstFrameFilename is required (upload via /api/local-studio/upload-ref first)' },
      { status: 400 },
    );
  }

  // Built-in styles only — no DB. See /generate route for rationale.
  const style = body.styleId
    ? BUILT_IN_STYLES.find(s => s.id === body.styleId)
    : null;
  if (body.styleId && !style) {
    return NextResponse.json(
      { error: `Unknown style id: ${body.styleId}` },
      { status: 400 },
    );
  }

  const workflowId = body.workflowId ?? 'wan-2.2-i2v';
  if (!isKnownLocalVideoWorkflow(workflowId)) {
    return NextResponse.json(
      { error: `Unknown video workflow id: ${workflowId}` },
      { status: 400 },
    );
  }

  // Optimised defaults for 16 GB VRAM: 704×416 + 2 s (33 frames at 16
  // fps) lands in ~5 min. Bigger / longer values are accepted but
  // each step roughly scales with pixel count and frame count.
  const width = Math.max(256, Math.min(1920, body.width ?? 704));
  const height = Math.max(256, Math.min(1088, body.height ?? 416));
  const durationSeconds = Math.max(2, Math.min(8, body.durationSeconds ?? 2));

  const generator = new ComfyUILocalGenerator();
  if (!(await generator.isReachable())) {
    return NextResponse.json(
      { error: 'ComfyUI is not reachable on localhost:8188. Start it and try again.' },
      { status: 503 },
    );
  }

  try {
    if (!generator.generateClip) {
      return NextResponse.json({ error: 'generateClip not available on this backend' }, { status: 501 });
    }
    const result = await generator.generateClip(prompt, {
      workflowId,
      styleSuffix: style?.ai_image_suffix,
      width,
      height,
      seed: body.seed,
      firstFrameUrl: body.firstFrameFilename,
      durationSeconds,
    });
    return NextResponse.json({
      ok: true,
      result,
      style_id: style?.id ?? null,
      style_label: style?.label ?? null,
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'local-studio: generate clip',
      knownPatterns: [
        { match: /ComfyUI is not reachable/i, status: 503 },
        { match: /firstFrameUrl is required/i, status: 400 },
        { match: /Unknown local video workflow/i, status: 400 },
        { match: /prompt is empty/i, status: 400 },
        { match: /timed out after/i, status: 504 },
      ],
      fallbackMessage: 'Local clip generation failed — check the console for details.',
    });
  }
});
