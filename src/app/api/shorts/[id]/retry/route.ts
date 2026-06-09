import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { DEFAULT_BASE_T2I_MODEL_ID } from '@/lib/shorts-base-t2i-types';

/**
 * POST /api/shorts/[id]/retry
 *
 * Re-queue a stuck or failed short. Two recovery shapes depending on
 * what the row's observable state looks like at retry time:
 *
 *   1. "Mid-asset" (script + voiceover + seo done, style_id set,
 *      style_assets has a doodle/paint block but variants are empty):
 *      the asset cron was likely interrupted. Clearing
 *      `generation_progress` alone would leave the row in
 *      'awaiting_render' forever (Bug A's gate requires variants).
 *      Instead we re-enqueue a fresh 'queued' state so the asset
 *      cron picks the short up and finishes generating variants.
 *
 *   2. Anything else: clear `generation_progress` to '{}' and let
 *      `nextStageFor` re-derive from observable columns. The
 *      orchestrator's next tick claims it and re-runs whatever
 *      stage is incomplete (extract / voiceover / seo / trigger_render).
 *
 * Found by QA review pass (H4): the original implementation only did
 * #2, which trapped users whose shorts failed mid-asset-pipeline.
 *
 * Intentionally permissive: re-triggering a non-failed short is
 * harmless because `nextStageFor` returns 'terminal' for already-done
 * shorts and the orchestrator skips them.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    // Read enough of the row to decide recovery shape. JSONB array
    // length is server-side so a huge variants array doesn't ship.
    const { rows } = await sql<{
      style_id: string | null;
      doodle_variants: number;
      paint_variants: number;
      short_script_present: boolean;
      voiceover_url_present: boolean;
      seo_present: boolean;
      generation_progress: any;
    }>`
      SELECT style_id,
             COALESCE(jsonb_array_length(style_assets->'doodle'->'variants'), 0) AS doodle_variants,
             COALESCE(jsonb_array_length(style_assets->'paint'->'variants'), 0) AS paint_variants,
             short_script IS NOT NULL AS short_script_present,
             voiceover_audio_url IS NOT NULL AS voiceover_url_present,
             seo_result IS NOT NULL AS seo_present,
             generation_progress
        FROM shorts
       WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Short not found' }, { status: 404 });
    }
    const row = rows[0]!;

    // Recovery shape #1: stuck mid-asset-pipeline. The orchestrator's
    // `nextStageFor` gate (per Bug A fix) requires at least one
    // variant before triggering render — so a row in this state would
    // never advance under plain progress-clearing.
    const styleId = row.style_id;
    const hasAnyVariants = row.doodle_variants > 0 || row.paint_variants > 0;
    const isStuckMidAsset =
      styleId !== null
      && (styleId === 'doodle_explainer_2_short' || styleId === 'paint_explainer_v1_short')
      && row.short_script_present
      && row.voiceover_url_present
      && row.seo_present
      && !hasAnyVariants;

    if (isStuckMidAsset) {
      const priorJob = (row.generation_progress?.job ?? {}) as Record<string, unknown>;
      const now = new Date().toISOString();
      const queued = {
        phase: 'queued' as const,
        label: 'Re-queued for asset cron (retry recovery)',
        style_id: styleId,
        started_at: now,
        updated_at: now,
        job: {
          niche: priorJob.niche ?? 'general',
          base_t2i_model_id: priorJob.base_t2i_model_id ?? DEFAULT_BASE_T2I_MODEL_ID,
          variant_edit_primary: priorJob.variant_edit_primary ?? 'atlas',
          max_variants: priorJob.max_variants ?? 8,
        },
      };
      await sql`
        UPDATE shorts
           SET generation_progress = ${JSON.stringify(queued)}::jsonb,
               generation_claimed_at = NULL,
               generation_claimed_by_tick = NULL,
               updated_at = NOW()
         WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
      `;
      console.info('[shorts-batch retry-short]', {
        short_id: id, workspace_id: session.ws, mode: 'asset-requeue', style_id: styleId,
      });
      return NextResponse.json({ ok: true, mode: 'asset-requeue' });
    }

    // Recovery shape #2: clear progress, let nextStageFor re-derive.
    await sql`
      UPDATE shorts
         SET generation_progress = '{}'::jsonb,
             generation_claimed_at = NULL,
             generation_claimed_by_tick = NULL,
             updated_at = NOW()
       WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
    `;
    console.info('[shorts-batch retry-short]', {
      short_id: id, workspace_id: session.ws, mode: 'progress-clear',
    });
    return NextResponse.json({ ok: true, mode: 'progress-clear' });
  },
);
