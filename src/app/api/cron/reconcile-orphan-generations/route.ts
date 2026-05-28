/**
 * Hourly reconciliation cron — recovers orphaned provider charges.
 *
 * Phase 2.2 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md).
 *
 * What it does:
 *   Joins `provider_generations` (audit row written before every paid
 *   provider call) against `project_assets` (the user-visible asset
 *   table). For rows that are 'delivered' but have no matching
 *   project_assets entry after 1 hour, attempts to recover by writing
 *   the stored response_url into project_assets. If that succeeds the
 *   row transitions to 'recovered'; if not (FK violation, unsupported
 *   slot, etc.) it transitions to 'refund_pending' for the billing
 *   queue.
 *
 * Why hourly:
 *   The client outbox's exponential backoff peaks at ~10 minutes of
 *   retries; anything still in 'delivered' state after an hour is
 *   genuinely orphaned by the user-side flow (Safari Private Mode
 *   eviction, IDB cleared, browser crash, etc.). Hourly cadence
 *   bounds money exposure to ~$10/hour at worst-case leak rates we
 *   observed in the 2026-05-29 audit; well below the cost of a
 *   tighter schedule.
 *
 * Auth: standard Bearer CRON_SECRET pattern that every other cron in
 * this app uses. Local dev bypasses the check (NODE_ENV !== production
 * AND hostname=localhost) so the route is callable from `curl` while
 * developing.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { reconcileOrphanGenerations } from '@/lib/provider-generations-reconcile';

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

  logger.info('cron reconcile-orphan-generations: start');
  try {
    const result = await reconcileOrphanGenerations();
    return NextResponse.json(result);
  } catch (err) {
    logger.error('cron reconcile-orphan-generations: failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Reconciliation failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
