/**
 * Single-row motion-collage generation — the manual / page-driven
 * counterpart to the auto-pipeline's `generateMotionCollage` call.
 *
 * Why a dedicated route: motion_collage rows leave `ai_image_prompt`
 * empty and carry their content in `motion_collage_panel_prompts`, so
 * the single-shot `/api/generate/production-doc/image` route — which
 * builds its prompt from `ai_image_prompt` — cannot handle them. And
 * the 4-up cost-optimization collage route (`/collage`) generates
 * 4 DIFFERENT shots in one image, not the SAME shot's N keyframes,
 * so it's also the wrong tool. This route wraps the existing
 * `generateMotionCollage` server-side helper with a thin HTTP / auth
 * layer.
 *
 * Pipeline:
 *   1. Validate the request body (grid, panel prompts, optional settings).
 *   2. Resolve the style → ai_image_suffix is appended automatically by
 *      generateMotionCollage's composer.
 *   3. Build minimal PipelineImageRow + PipelineImageDoc shapes from the
 *      request and call `generateMotionCollage`.
 *   4. Return { imageUrl, panelUrls, collageImageUrl, costUsd } —
 *      `imageUrl` mirrors panel 0 so the page's existing image-state
 *      machine sees a populated row.
 *
 * Rate limits + intent recording happen inside generateMotionCollage
 * via the existing `recordIntent` / `markDelivered` / `markFailed`
 * provider-generations audit. The wrapper does NOT add its own audit
 * row — that would double-count this single paid call.
 *
 * See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` and
 * the follow-up commit that adds this route after smoke-testing
 * surfaced that the manual path was unwired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { apiRoute } from '@/lib/route-helpers';
import {
  generateMotionCollage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '@/lib/auto-pipeline/production-doc-image-gen';

export const maxDuration = 300;

interface MotionCollageRequestBody {
  /** Grid layout. cols × rows ≤ 16 (server-side enforced inside
   *  generateMotionCollage via MAX_COLLAGE_CELLS). */
  grid?: { cols?: number; rows?: number };
  /** Per-panel prompts. Length MUST equal grid.cols × grid.rows. */
  panelPrompts?: string[];
  /** Optional doc-level style — used by the server to resolve the
   *  style's ai_image_suffix so panel prompts inherit the doodle
   *  vocabulary. Defaults to "no style" when omitted. */
  stylePreset?: string;
  /** Doc-level motion-collage settings — gates allow_motion_collage and
   *  max_grid_panels. Omitted ⇒ pipeline defaults. */
  motionCollageSettings?: {
    allow_motion_collage?: boolean;
    max_grid_panels?: number;
    min_per_frame_ms?: number;
    max_per_frame_ms?: number;
  };
  /** Doc-level character bible. Passed through so recurring characters
   *  stay consistent across the grid. Same shape as
   *  `ProductionDoc.doodle_explainer_2_character_descriptions`. */
  characterDescriptions?: Record<string, string>;
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  // Rate limit: same key shape and limits as the single-shot image
  // route — one row per call, one paid Atlas T2I + one paid Recraft
  // upscale. The cost ceiling lives inside generateMotionCollage's
  // intent / mark-delivered flow.
  const { limited, resetIn } = checkRateLimit(`prodoc-motion-collage:${getClientIP(req)}`, 25, 60_000);
  if (limited) {
    return NextResponse.json(
      { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
      { status: 429 },
    );
  }

  let body: MotionCollageRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Defensive client-side validation — the helper validates again with
  // the same checks, but failing here gives a cleaner 4xx than the
  // helper's `{ error: 'validation_failed:...' }` shape.
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
  const N = (grid.cols as number) * (grid.rows as number);
  if (!Array.isArray(body.panelPrompts) || body.panelPrompts.length !== N) {
    return NextResponse.json(
      { error: `panelPrompts.length must equal cols × rows (= ${N})` },
      { status: 400 },
    );
  }
  if (body.panelPrompts.some((p) => typeof p !== 'string' || p.trim().length === 0)) {
    return NextResponse.json(
      { error: 'Every panel prompt must be a non-empty string' },
      { status: 400 },
    );
  }

  // Build the minimal row + doc shapes generateMotionCollage expects.
  // The helper reads `shot_kind`, `motion_collage_grid`, and
  // `motion_collage_panel_prompts` off the row, and `style_preset` +
  // `doodle_explainer_2_motion_collage_settings` +
  // `doodle_explainer_2_character_descriptions` off the doc.
  const row: PipelineImageRow = {
    shot_kind: 'motion_collage',
    motion_collage_grid: { cols: grid.cols as number, rows: grid.rows as number },
    motion_collage_panel_prompts: body.panelPrompts,
  };
  const doc: PipelineImageDoc = {
    rows: [row],
    style_preset: body.stylePreset,
    doodle_explainer_2_motion_collage_settings: body.motionCollageSettings,
    doodle_explainer_2_character_descriptions: body.characterDescriptions,
  };

  logger.info('[motion-collage manual] start', {
    user_id: session.uid,
    workspace_id: session.ws,
    grid: `${grid.cols}x${grid.rows}`,
    panel_count: N,
    style_preset: body.stylePreset,
  });

  try {
    const result = await generateMotionCollage({
      row,
      doc,
      workspaceId: session.ws,
      ownerId: session.uid,
    });

    if (!result.panelUrls || result.panelUrls.length === 0) {
      // Classified failure from the helper. Surface the reason so the
      // editor inspector can show a useful message instead of a
      // generic 500.
      logger.warn('[motion-collage manual] failed', {
        user_id: session.uid,
        error: result.error,
        cost_usd: result.costUsd,
      });
      const status = result.error?.startsWith('validation_failed') ? 400
        : result.error === 'kill_switch' ? 503
        : result.error === 'settings_disabled' ? 409
        : 502;
      return NextResponse.json(
        {
          error: result.error ?? 'motion_collage generation failed',
          collageImageUrl: result.collageImageUrl,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        },
        { status },
      );
    }

    logger.info('[motion-collage manual] success', {
      user_id: session.uid,
      grid: `${grid.cols}x${grid.rows}`,
      panel_count: result.panelUrls.length,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    return NextResponse.json({
      // Mirror panel 0 into `imageUrl` so the page's existing
      // ImageState machine sees a populated row without per-row
      // special-casing on the response shape.
      imageUrl: result.panelUrls[0],
      panelUrls: result.panelUrls,
      collageImageUrl: result.collageImageUrl,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'motion_collage generation failed';
    logger.error('[motion-collage manual] threw', {
      user_id: session.uid,
      detail: detail.slice(0, 200),
    });
    return NextResponse.json({ error: detail }, { status: 500 });
  }
});
