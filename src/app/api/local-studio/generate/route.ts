/**
 * POST /api/local-studio/generate
 *
 * Run a single local image generation via ComfyUI on localhost:8188.
 * Phase 1 of the local-studio surface — synchronous: the route waits
 * up to `maxDuration` seconds for ComfyUI to finish and returns the
 * output URL in the response.
 *
 * Phase 3 (Wan 2.2) will split this into POST-then-poll because video
 * generations take longer than the route timeout. For Flux at 4–20
 * steps the whole job lands in <30s so blocking is fine.
 *
 * Gated by `LOCAL_STUDIO=1` — when unset the route returns 404 so the
 * deployed Vercel build doesn't accidentally expose the local surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { BUILT_IN_STYLES } from '@/lib/production-doc-styles';
import { isKnownLocalWorkflow, mappingForStyle } from '@/lib/comfyui/style-mapping';
import { ComfyUILocalGenerator } from '@/lib/visual-generator/comfyui-local';

export const maxDuration = 300;

interface GenerateBody {
  prompt?: string;
  styleId?: string | null;
  workflowId?: string | null;
  width?: number;
  height?: number;
  seed?: number;
  /** Reference image filename returned by /api/local-studio/upload-ref.
   *  When set, the backend picks the i2i variant of the chosen model. */
  refImageFilename?: string | null;
  /** 0..1 — see types.ts. Only used when refImageFilename is set. */
  denoise?: number;
}

// Public route — gated by LOCAL_STUDIO=1 env, not by session. See the
// /status route comment for the full rationale: local-studio is local-
// first and shouldn't break when the cloud DB is unavailable.
export const POST = apiRoute.public(async (req: NextRequest) => {
  if (process.env.LOCAL_STUDIO !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { limited } = checkRateLimit(`local-studio:${getClientIP(req)}`, 60, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
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

  // Built-in styles only (no DB lookup). Saved styles will return when
  // production-doc integration ships in Phase 4 with a clear no-session
  // workspace-resolution path.
  const style = body.styleId
    ? BUILT_IN_STYLES.find(s => s.id === body.styleId)
    : null;
  if (body.styleId && !style) {
    return NextResponse.json(
      { error: `Unknown style id: ${body.styleId}` },
      { status: 400 },
    );
  }

  const mapping = mappingForStyle(style?.id);
  const workflowId = body.workflowId ?? mapping.workflow;
  if (!isKnownLocalWorkflow(workflowId)) {
    return NextResponse.json(
      { error: `Unknown workflow id: ${workflowId}` },
      { status: 400 },
    );
  }

  const width = Math.max(256, Math.min(2048, body.width ?? mapping.width));
  const height = Math.max(256, Math.min(2048, body.height ?? mapping.height));

  const generator = new ComfyUILocalGenerator();
  if (!(await generator.isReachable())) {
    return NextResponse.json(
      {
        error:
          'ComfyUI is not reachable on localhost:8188. Start it with run_nvidia_gpu.bat and try again.',
      },
      { status: 503 },
    );
  }

  try {
    const result = await generator.generateImage(prompt, {
      workflowId,
      styleSuffix: style?.ai_image_suffix,
      width,
      height,
      seed: body.seed,
      refImageFilename: body.refImageFilename ?? undefined,
      denoise: body.denoise,
    });
    return NextResponse.json({
      ok: true,
      result,
      style_id: style?.id ?? null,
      style_label: style?.label ?? null,
    });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'local-studio: generate image',
      knownPatterns: [
        { match: /ComfyUI is not reachable/i, status: 503 },
        { match: /ComfyUI URL must be localhost/i, status: 400 },
        { match: /prompt is empty/i, status: 400 },
        { match: /Unknown local workflow/i, status: 400 },
        { match: /timed out after/i, status: 504 },
      ],
      fallbackMessage: 'Local image generation failed — check the console for details.',
    });
  }
});
