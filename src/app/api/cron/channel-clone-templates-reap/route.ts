/**
 * Daily reap — Plan 2 channel-clone templates (Phase 2 of soft-delete).
 *
 * Walks `channel_clone_templates` rows whose `deleted_at` is older
 * than 24h, runs a best-effort R2 batch delete against each row's
 * `r2_keys` manifest, then hard-deletes the SQL row. The user-facing
 * DELETE endpoint (`/api/channel-clone/templates/[id]`) already
 * kicked an async R2 cleanup at soft-delete time, so this is a
 * backstop for keys that failed individually (R2 transient errors,
 * etc.) AND for the SQL row itself.
 *
 * Idempotent: a previously-cleaned manifest returns
 * `{ deleted: N, failed: 0 }` from R2 (404 isn't surfaced as a
 * failure by `deleteTemplateR2Keys`). The SQL hard-delete is a
 * single statement.
 *
 * Auth gate matches every other cron in the repo (Bearer CRON_SECRET;
 * bypassed in local dev).
 *
 * See _plans/2026-06-07-channel-clone-preset-templates.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  hardDeleteChannelCloneTemplate,
  listChannelCloneTemplatesPendingReap,
} from '@/lib/channel-clone/templates-store';
import { deleteTemplateR2Keys } from '@/lib/channel-clone/templates-r2';

export const maxDuration = 60;

/** How long a soft-deleted row sits before the reap runs. 24h is the
 *  documented grace window — the soft-delete UI shows the template
 *  vanishing immediately so 24h is plenty of headroom for any
 *  in-flight R2 batch-delete to settle before we drop the SQL row. */
const REAP_AFTER_HOURS = 24;

/** Hard cap per cron tick. Soft-deleted batches are small (operators
 *  rarely bulk-delete) so 100 is a generous ceiling that keeps the
 *  cron well under maxDuration. */
const REAP_BATCH_CAP = 100;

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
  logger.info('[cron channel-clone-templates-reap] start');

  let candidates: Awaited<ReturnType<typeof listChannelCloneTemplatesPendingReap>>;
  try {
    candidates = await listChannelCloneTemplatesPendingReap(REAP_AFTER_HOURS);
  } catch (err) {
    logger.error('[cron channel-clone-templates-reap] list failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'List failed' }, { status: 502 });
  }
  const batch = candidates.slice(0, REAP_BATCH_CAP);
  logger.info('[cron channel-clone-templates-reap] batch picked', {
    total: candidates.length, batch: batch.length,
  });

  let rowsReaped = 0;
  let r2KeysDeleted = 0;
  let r2KeysFailed = 0;
  let rowsFailed = 0;
  for (const row of batch) {
    try {
      // Per-row R2 sweep. The soft-delete handler kicked one of these
      // off optimistically; on this cron pass we cover any failures.
      const r2Result = await deleteTemplateR2Keys(row.r2_keys);
      r2KeysDeleted += r2Result.deleted;
      r2KeysFailed += r2Result.failed;
      if (r2Result.failed > 0) {
        logger.warn('[cron channel-clone-templates-reap] R2 partial failure; leaving SQL row for next pass', {
          templateId: row.id, failed: r2Result.failed, total: row.r2_keys.length,
        });
        // Don't hard-delete the SQL row when R2 still has objects we
        // failed to remove — next cron pass picks the row back up via
        // `listChannelCloneTemplatesPendingReap`.
        continue;
      }
      await hardDeleteChannelCloneTemplate(row.id);
      rowsReaped += 1;
      logger.info('[cron channel-clone-templates-reap] row reaped', {
        templateId: row.id, workspaceId: row.workspace_id, r2KeyCount: row.r2_keys.length, bytes: row.bytes,
      });
    } catch (err) {
      rowsFailed += 1;
      logger.warn('[cron channel-clone-templates-reap] row reap failed; will retry next pass', {
        templateId: row.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const duration_ms = Date.now() - startedAt;
  logger.info('[cron channel-clone-templates-reap] done', {
    duration_ms, rowsReaped, r2KeysDeleted, r2KeysFailed, rowsFailed,
    backlogRemaining: candidates.length - batch.length,
  });
  return NextResponse.json({
    rowsReaped, r2KeysDeleted, r2KeysFailed, rowsFailed,
    backlogRemaining: candidates.length - batch.length,
    duration_ms,
  });
}

// Vercel cron invokes the scheduled path with GET; alias to POST so this
// cron actually runs in production. Reads no body, so GET is safe.
export const GET = POST;
