/**
 * Job-scoped logger for the channel-clone pipeline.
 *
 * Every call writes the line BOTH to the server-side `logger` (Vercel
 * function logs) AND to the job row's `state_jsonb.progressLog` array
 * (via fire-and-forget DB append). The panel polls the job and renders
 * the array as a live console — so the user sees every step in
 * real time instead of staring at "intake_running" for 90 s.
 *
 * Fire-and-forget on the DB write: a slow / failed log append must
 * never block pipeline progress. We catch + log the failure inside
 * the callback so silent drops don't go undetected.
 *
 * Use:
 *   const log = makeJobLogger(jobId, workspaceId, 'intake');
 *   log.info('sandbox', 'create start');
 *   log.warn('yt-dlp', 'caption read failed', { videoId, error: msg });
 *   log.error('intake', 'all videos failed download');
 */

import { logger } from '@/lib/logger';
import { appendChannelCloneJobLog } from './job-store';
import type { ProgressLogEntry } from './types';

export interface JobLogger {
  info: (step: string, msg: string, data?: Record<string, unknown>) => void;
  warn: (step: string, msg: string, data?: Record<string, unknown>) => void;
  error: (step: string, msg: string, data?: Record<string, unknown>) => void;
}

/** `stagePrefix` namespaces the server-log line ("intake", "analyze",
 *  etc.) so a grep across stages stays clean; `step` is the inner
 *  subsystem ("sandbox", "yt-dlp", "ffmpeg") and lands on the
 *  ProgressLogEntry as a separate field for UI colouring. */
export function makeJobLogger(jobId: string, workspaceId: string, stagePrefix: string): JobLogger {
  const append = (entry: ProgressLogEntry) => {
    // Fire-and-forget. Catch is here, not at the call site, because
    // every call site would otherwise need an unused `void` + try.
    appendChannelCloneJobLog(jobId, workspaceId, entry).catch((err) => {
      logger.warn(`[channel-clone ${stagePrefix} job-log-append-failed]`, {
        jobId,
        step: entry.step,
        msg: entry.msg,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  return {
    info: (step, msg, data) => {
      logger.info(`[channel-clone ${stagePrefix} ${step}] ${msg}`, data ?? {});
      append({ ts: new Date().toISOString(), level: 'info', step, msg, data });
    },
    warn: (step, msg, data) => {
      logger.warn(`[channel-clone ${stagePrefix} ${step}] ${msg}`, data ?? {});
      append({ ts: new Date().toISOString(), level: 'warn', step, msg, data });
    },
    error: (step, msg, data) => {
      logger.error(`[channel-clone ${stagePrefix} ${step}] ${msg}`, data ?? {});
      append({ ts: new Date().toISOString(), level: 'error', step, msg, data });
    },
  };
}
