/**
 * Auto-fill the per-panel keyframe prompts for a motion_collage row.
 *
 * The manual "↯ Convert to motion collage" button and the editor's grid
 * picker leave `motion_collage_panel_prompts` empty, which makes the
 * feature useless as a manual action — the user would have to hand-type
 * every keyframe, and an empty-panel row fails generation with
 * `validation_failed:panel_prompt_empty`. This route decomposes the
 * row's narration beat into N keyframe prompts so the panels arrive
 * pre-filled (editable afterward).
 *
 * It's the auto-fill counterpart to the sibling `/motion-collage` route
 * (which RENDERS the panels). This one only writes TEXT: one cheap LLM
 * call on the model the `production-doc` feature already resolves to
 * (default gpt-5.4-mini). No paid image generation happens here.
 *
 * Pipeline:
 *   1. Validate the request body (grid + at least one content field).
 *   2. Resolve the per-workspace production-doc model + the style suffix.
 *   3. Build the prompt (motion-collage-panel-fill.ts), call generateText.
 *   4. Parse to exactly cols×rows strings → { panelPrompts }.
 *
 * See `_plans/2026-06-01-motion-collage-panel-autofill.md`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { resolveStyle } from '@/lib/production-doc-styles';
import { buildPanelFillPrompt, parsePanelFillResponse } from '@/lib/motion-collage-panel-fill';

// One LLM text call — fast. 60s is ample headroom over the model latency.
export const maxDuration = 60;

interface PanelFillRequestBody {
  /** Grid layout. cols × rows ≤ 16 (matches MAX_COLLAGE_CELLS). */
  grid?: { cols?: number; rows?: number };
  /** The row's narration beat — the motion to depict. */
  scriptText?: string;
  /** The row's visual_description, if any. */
  visualDescription?: string;
  /** The row's pre-existing ai_image_prompt (captured before the convert
   *  handler wiped it), if any. */
  baseImagePrompt?: string;
  /** Existing panel prompts — filled ones are preserved, blanks filled. */
  existingPanels?: string[];
  /** Doc-level style preset — resolves the ai_image_suffix vocabulary. */
  stylePreset?: string;
  /** Doc-level character bible. */
  characterDescriptions?: Record<string, string>;
}

// Mirror the slicer's hard cap (MAX_COLLAGE_CELLS) so we reject oversized
// grids before the LLM call rather than after.
const MAX_COLLAGE_CELLS = 16;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Same key shape as the sibling motion-collage route; this call is
  // cheaper (one mini LLM call, no image gen) so a generous limit is fine.
  const { limited, resetIn } = checkRateLimit(`prodoc-mc-panels:${getClientIP(req)}`, 40, 60_000);
  if (limited) {
    return NextResponse.json(
      { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
      { status: 429 },
    );
  }

  let body: PanelFillRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const grid = body.grid;
  if (
    !grid
    || !Number.isInteger(grid.cols)
    || !Number.isInteger(grid.rows)
    || (grid.cols ?? 0) < 1
    || (grid.rows ?? 0) < 1
  ) {
    return NextResponse.json(
      { error: '`grid` must be { cols: int >= 1, rows: int >= 1 }' },
      { status: 400 },
    );
  }
  const cols = grid.cols as number;
  const rows = grid.rows as number;
  const N = cols * rows;
  if (N > MAX_COLLAGE_CELLS) {
    return NextResponse.json(
      { error: `Grid too large: ${N} panels exceeds the ${MAX_COLLAGE_CELLS}-panel cap` },
      { status: 400 },
    );
  }

  // Need SOMETHING to decompose. With no narration / visual / base prompt
  // the model has nothing to work from — fail clearly instead of emitting
  // generic filler.
  const hasContent = [body.scriptText, body.visualDescription, body.baseImagePrompt]
    .some((s) => typeof s === 'string' && s.trim().length > 0);
  if (!hasContent) {
    return NextResponse.json(
      { error: 'Add some narration or a visual description to this row first — there is nothing to turn into keyframes yet.' },
      { status: 400 },
    );
  }

  // Resolve the model + style suffix off the workspace, mirroring how the
  // main doc generation + the image pipeline resolve them.
  const [modelId, style] = await Promise.all([
    getEffectiveModelId(session.ws, 'production-doc'),
    body.stylePreset ? resolveStyle(body.stylePreset, session.ws, session.uid) : Promise.resolve(null),
  ]);

  const { system, user, expected } = buildPanelFillPrompt({
    scriptText: body.scriptText ?? '',
    visualDescription: body.visualDescription,
    baseImagePrompt: body.baseImagePrompt,
    cols,
    rows,
    existingPanels: body.existingPanels,
    styleSuffix: style?.ai_image_suffix,
    characterDescriptions: body.characterDescriptions,
  });

  logger.info('[motion-collage panels] start', {
    user_id: session.uid,
    workspace_id: session.ws,
    grid: `${cols}x${rows}`,
    panel_count: expected,
    model_id: modelId,
    style_preset: body.stylePreset,
    has_existing: (body.existingPanels ?? []).some((p) => p?.trim()),
  });

  try {
    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      // ~150 chars/panel × 16 panels ≈ 600 tokens of content; 1200 gives
      // headroom for JSON punctuation + the occasional verbose model.
      maxTokens: 1200,
      temperature: 0.7,
      spend: {
        workspaceId: session.ws,
        featureArea: 'production-doc-motion-collage-panels',
        metadata: { grid: `${cols}x${rows}`, panel_count: expected },
      },
    });

    const panelPrompts = parsePanelFillResponse(raw, expected);
    if (!panelPrompts.some((p) => p.trim())) {
      logger.warn('[motion-collage panels] empty result', {
        user_id: session.uid,
        grid: `${cols}x${rows}`,
      });
      return NextResponse.json(
        { error: 'The model returned no usable panel prompts — try again or fill the panels manually.' },
        { status: 502 },
      );
    }

    logger.info('[motion-collage panels] success', {
      user_id: session.uid,
      grid: `${cols}x${rows}`,
      filled: panelPrompts.filter((p) => p.trim()).length,
    });

    return NextResponse.json({ panelPrompts });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'panel auto-fill failed';
    logger.error('[motion-collage panels] threw', {
      user_id: session.uid,
      detail: detail.slice(0, 200),
    });
    return NextResponse.json({ error: detail }, { status: 502 });
  }
});
