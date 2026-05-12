/**
 * Vercel cron entry — Phase 13.2.W weekly niche watchlist re-score.
 *
 * Runs Sundays 04:00 UTC. For every watchlist row across every
 * workspace:
 *   1. Re-run the v0.5 deep-dive orchestrator (force=true so the
 *      niche_reports row stays fresh too).
 *   2. Append a snapshot to weekly_history; trim to 26 entries.
 *   3. Detect score-spike via detectScoreSpike(history, threshold).
 *   4. When a spike fires, emit the `niche_score_spike` workflow
 *      event into the existing trigger registry and the webhook
 *      fan-out. The event payload carries enough for downstream
 *      consumers to act (slug, name, direction, delta, scores).
 *
 * Auth gate matches other crons (CRON_SECRET bearer token; bypassed
 * in local dev).
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  appendSnapshot,
  detectScoreSpike,
  listAllWatchlistRows,
  snapshotFromScores,
} from '@/lib/niche-finder/watchlist';
import { runDeepDive } from '@/lib/niche-finder/run-deep-dive';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  const isLocal =
    process.env.NODE_ENV !== 'production' &&
    (req.nextUrl.hostname === 'localhost' || req.nextUrl.hostname === '127.0.0.1');

  if (!isLocal) {
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
    }
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const startedAt = Date.now();
  logger.info('cron rescore-niche-watchlist: start');

  const rows = await listAllWatchlistRows();
  let rescored = 0;
  let spikes = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const deepDive = await runDeepDive({
        workspaceId: row.workspace_id,
        nicheText: row.niche_name,
        force: true,
      });
      const snapshot = snapshotFromScores(deepDive.report.scores, new Date().toISOString());
      const updated = await appendSnapshot({
        workspaceId: row.workspace_id,
        nicheSlug: row.niche_slug,
        snapshot,
        nicheName: deepDive.report.name,
      });
      rescored++;

      if (updated) {
        const spike = detectScoreSpike(updated.weekly_history, updated.alarm_threshold);
        if (spike.spike) {
          spikes++;
          await fireScoreSpikeEvent({
            workspaceId: row.workspace_id,
            nicheSlug: row.niche_slug,
            nicheName: deepDive.report.name,
            direction: spike.direction!,
            delta: spike.delta,
            combined: snapshot.combined,
            triggerCapturedAt: spike.trigger_captured_at!,
          });
        }
      }
    } catch (err) {
      errors++;
      logger.warn('cron rescore-niche-watchlist: row failed', {
        workspace_id: row.workspace_id,
        niche_slug: row.niche_slug,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('cron rescore-niche-watchlist: done', {
    duration_ms: Date.now() - startedAt,
    rows: rows.length,
    rescored,
    spikes,
    errors,
  });

  return NextResponse.json({ rows: rows.length, rescored, spikes, errors });
}

interface ScoreSpikePayload {
  workspaceId: string;
  nicheSlug: string;
  nicheName: string;
  direction: 'up' | 'down';
  delta: number;
  combined: number;
  triggerCapturedAt: string;
}

/** Fire the niche_score_spike event into the workflow trigger
 *  registry AND the webhook fan-out. Lazy-imported to keep cold
 *  start fast and to mirror the pattern used by other producers
 *  (e.g. ab-tests, cannibalization). */
async function fireScoreSpikeEvent(payload: ScoreSpikePayload): Promise<void> {
  const eventPayload = {
    niche_slug: payload.nicheSlug,
    niche_name: payload.nicheName,
    direction: payload.direction,
    delta: payload.delta,
    combined: payload.combined,
    captured_at: payload.triggerCapturedAt,
  };

  try {
    const { dispatchWorkflowEvent } = await import('@/lib/workflows');
    await dispatchWorkflowEvent(payload.workspaceId, {
      type: 'niche_score_spike',
      payload: eventPayload,
    });
  } catch (err) {
    logger.warn('cron rescore-niche-watchlist: workflow fan-out failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { dispatchWebhookEvent } = await import('@/lib/webhooks');
    const arrow = payload.direction === 'up' ? '↑' : '↓';
    await dispatchWebhookEvent(payload.workspaceId, {
      type: 'niche_score_spike',
      title: `Niche score ${arrow} for "${payload.nicheName}"`,
      detail:
        `Combined score moved ${(payload.delta * 100).toFixed(1)} points week-over-week ` +
        `(now ${(payload.combined * 100).toFixed(0)}/100).`,
      fields: {
        niche_slug: payload.nicheSlug,
        niche_name: payload.nicheName,
        direction: payload.direction,
        delta: payload.delta,
        combined: payload.combined,
        captured_at: payload.triggerCapturedAt,
      },
    });
  } catch (err) {
    logger.warn('cron rescore-niche-watchlist: webhook fan-out failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
