import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { triggerShortsAssetDrain } from '@/lib/shorts-asset-cron';
import { getBatchWithShorts } from '@/lib/shorts-batches';

// Bound the manual kick so it returns a prompt toast and can't be
// hard-killed mid-step; the cron + the step-3 run-tick keep draining
// after it. Headroom over the slice budget so the slice finishes clean.
export const maxDuration = 60;
const MANUAL_KICK_DRAIN_BUDGET_MS = 45_000;

/**
 * POST /api/shorts/batches/[id]/kick-assets
 *
 * Manually drive the shorts asset cron for this batch's stuck shorts.
 * Useful when:
 *   - The production cron isn't running (e.g. CRON_SECRET unset).
 *   - The cron lock got stuck and needs a kick from a fresh function.
 *   - The user wants to force progress without waiting for the next
 *     minute-aligned cron tick.
 *
 * Workflow:
 *   1. Defensively clear any stale `generation_claimed_at` / `_by_tick`
 *      on this batch's queued shorts whose lease has expired. (Avoids
 *      the cron picking these up even after the lock releases.)
 *   2. Trigger the drain. The drain is single-flight-locked, so a
 *      concurrent cron run returns 'busy' here — that's fine,
 *      something is making progress.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 */
export const POST = apiRoute.authed(
  async (session, _req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const bundle = await getBatchWithShorts(id, session.ws);
    if (!bundle) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }

    const stuckIds = bundle.shorts
      .filter((s) =>
        s.generation_progress?.phase === 'queued'
        || s.generation_progress?.phase === 'planning'
        || s.generation_progress?.phase === 'base'
        || s.generation_progress?.phase === 'variant',
      )
      .map((s) => s.id);

    // Defensive: clear stale leases on this batch's stuck shorts. Avoids
    // the documented case where a previous crashed tick left non-null
    // claim columns and the cron's WHERE clause was skipping them for
    // the full 90s lease window. Scoped to this batch's queued shorts
    // so we don't disturb leases owned by other batches' in-flight work.
    if (stuckIds.length > 0) {
      await sql`
        UPDATE shorts
           SET generation_claimed_at = NULL,
               generation_claimed_by_tick = NULL,
               updated_at = NOW()
         WHERE workspace_id = ${session.ws}::uuid
           AND batch_id = ${id}::uuid
           AND generation_progress->>'phase' IN ('queued', 'planning', 'base', 'variant')
      `;
    }

    console.info('[shorts-batch kick-assets]', {
      batch_id: id,
      workspace_id: session.ws,
      stuck_count: stuckIds.length,
    });

    const outcome = await triggerShortsAssetDrain('manual-batch-kick', MANUAL_KICK_DRAIN_BUDGET_MS);
    return NextResponse.json({
      stuck_count: stuckIds.length,
      drain: outcome.ran ? { ran: true, ...outcome.result } : { ran: false, reason: 'busy' },
    });
  },
);
