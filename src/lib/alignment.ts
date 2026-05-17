/**
 * Forced-alignment orchestrator for the Narration tab's synced player.
 *
 * Lives between the narrator-side upload flow (which kicks alignment off
 * fire-and-forget) and the owner-side retry route (which can call this
 * directly when the reviewer hits "retry sync"). All the side effects
 * — status transitions, budget checks, audio fetching, ElevenLabs call,
 * persistence — flow through `runAlignmentForAssignment` so callers
 * never need to coordinate state themselves.
 */

import { forceAlign } from './elevenlabs';
import {
  claimTakeAlignment,
  getCurrentMonthAlignmentSeconds,
  getFullAudioTakeWithAlignment,
  getRealSectionsForAssignment,
  setTakeAlignmentFailed,
  setTakeAlignmentReady,
} from './narrator-db';
import { buildAlignmentScript } from './narrator-utils';
import { getNarrationDownloadUrl } from './r2';
import { logger } from './logger';

const ELEVENLABS_SCRIBE_USD_PER_HOUR = 0.22;

function getMonthlyBudgetUsd(): number {
  const raw = process.env.ELEVENLABS_ALIGNMENT_BUDGET_USD;
  const parsed = raw ? Number(raw) : NaN;
  // Default $5/mo. At ~$0.22/hr Scribe pricing that's ~22.7 hours of audio —
  // an order of magnitude above the stated <5h/mo volume so legitimate use
  // never trips it.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

export interface AlignmentRunResult {
  status: 'ready' | 'failed' | 'skipped';
  reason?: string;
}

/**
 * Strip URL-like substrings from an error message before it's written to
 * the DB and rendered to the reviewer. Forced-alignment errors can carry
 * pre-signed R2 URLs in their text — never let those reach the browser.
 */
function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 240)
    .trim();
}

/**
 * Run forced alignment for an assignment's full-audio take, idempotently.
 *
 *   - `skipped` — no full-audio take yet, or another worker already owns
 *                 the run (we claim 'running' atomically).
 *   - `ready`   — alignment_json persisted; UI will pick it up on next read.
 *   - `failed`  — alignment_error persisted; UI shows a retry affordance.
 *
 * Never throws. The outer try-catch covers EVERY failure path including
 * the DB queries that run before the inner "actual work" — without that,
 * a busted migration or transient SQL error would leave the take stuck
 * at 'pending' with the orchestrator's exception swallowed by the
 * caller's fire-and-forget catch.
 */
export async function runAlignmentForAssignment(assignmentId: string): Promise<AlignmentRunResult> {
  // Track the take id in closure scope so the outer catch can record the
  // failure even if the throw happened during a pre-claim DB query.
  let takeIdForCatch: string | null = null;

  try {
    logger.info('alignment: starting', { assignmentId });

    const take = await getFullAudioTakeWithAlignment(assignmentId);
    if (!take) {
      logger.info('alignment: skipped — no full-audio take', { assignmentId });
      return { status: 'skipped', reason: 'no full-audio take' };
    }
    takeIdForCatch = take.take_id;

    if (take.alignment_status === 'running') {
      logger.info('alignment: skipped — already running', { assignmentId, takeId: take.take_id });
      return { status: 'skipped', reason: 'already running' };
    }

    // Budget check happens before claim so we don't burn a status transition
    // when over cap. Approximate — adds the new take's duration to the
    // already-aligned monthly total.
    const monthlySeconds = await getCurrentMonthAlignmentSeconds();
    const projectedSeconds = monthlySeconds + (take.duration_seconds || 0);
    const projectedCostUsd = (projectedSeconds / 3600) * ELEVENLABS_SCRIBE_USD_PER_HOUR;
    const budgetUsd = getMonthlyBudgetUsd();
    if (projectedCostUsd > budgetUsd) {
      await setTakeAlignmentFailed(
        take.take_id,
        `Monthly alignment budget exceeded ($${budgetUsd.toFixed(2)}). Try again next month or raise ELEVENLABS_ALIGNMENT_BUDGET_USD.`,
      );
      return { status: 'failed', reason: 'budget' };
    }

    const claimed = await claimTakeAlignment(take.take_id);
    if (!claimed) {
      logger.info('alignment: skipped — lost claim race', { assignmentId, takeId: take.take_id });
      return { status: 'skipped', reason: 'lost claim race' };
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      await setTakeAlignmentFailed(take.take_id, 'ElevenLabs API key not configured on the server.');
      return { status: 'failed', reason: 'no api key' };
    }

    // Resolve a fresh signed URL from the R2 key — the stored audio_url
    // may have expired since the upload. The signed URL never leaves the
    // server; we fetch the bytes here and POST them to ElevenLabs.
    let audioUrl: string;
    if (take.r2_key) {
      audioUrl = await getNarrationDownloadUrl(take.r2_key);
    } else if (take.audio_url) {
      audioUrl = take.audio_url;
    } else {
      await setTakeAlignmentFailed(take.take_id, 'No audio URL for take.');
      return { status: 'failed', reason: 'no audio url' };
    }

    // Bound the R2 download so an unreachable bucket / hung connection
    // can't ride the function to its maxDuration and leave the row stuck
    // at 'running'. 180s is well over the worst-case 60MB-at-modest-
    // bandwidth budget for a 30-min audio file but still inside the
    // function's overall ceiling, so the catch path has room to write a
    // terminal status.
    const AUDIO_FETCH_TIMEOUT_MS = 180_000;
    let audioBlob: Blob;
    try {
      const audioRes = await fetch(audioUrl, {
        signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS),
      });
      if (!audioRes.ok) {
        // 404 means the object isn't reachable at the stored key — could be
        // a stale presigned URL, a bucket misconfig, or genuinely missing.
        // Phrase neutrally so the reviewer isn't pushed to chase down a
        // re-upload before they've decided to.
        const reason = audioRes.status === 404
          ? `Audio file not reachable at the stored key (HTTP 404). Sync will become available once the audio is restored.`
          : `Audio fetch failed (HTTP ${audioRes.status}).`;
        await setTakeAlignmentFailed(take.take_id, reason);
        return { status: 'failed', reason: 'audio fetch' };
      }
      audioBlob = await audioRes.blob();
    } catch (err) {
      // AbortSignal.timeout fires a DOMException with name='TimeoutError'.
      // Record an explicit timeout reason so the reviewer sees a useful
      // message; let other errors fall through to the outer catch for
      // the generic "Alignment failed: …" path.
      if (err instanceof Error && err.name === 'TimeoutError') {
        await setTakeAlignmentFailed(
          take.take_id,
          `Audio download timed out after ${Math.round(AUDIO_FETCH_TIMEOUT_MS / 1000)}s.`,
        );
        return { status: 'failed', reason: 'audio fetch timeout' };
      }
      throw err;
    }
    logger.info('alignment: audio fetched', {
      assignmentId,
      takeId: take.take_id,
      bytes: audioBlob.size,
    });

    // SQL rows from getRealSectionsForAssignment are untyped; we read only
    // script_text, which the narrator_sections schema guarantees is present.
    const sections = (await getRealSectionsForAssignment(assignmentId)) as Array<{
      script_text: string;
    }>;
    const script = buildAlignmentScript(sections);
    if (!script.trim()) {
      await setTakeAlignmentFailed(take.take_id, 'Script is empty — nothing to align.');
      return { status: 'failed', reason: 'empty script' };
    }

    logger.info('alignment: calling ElevenLabs', {
      assignmentId,
      takeId: take.take_id,
      audioBytes: audioBlob.size,
      scriptChars: script.length,
    });

    const alignment = await forceAlign(apiKey, {
      audioBlob,
      audioFilename: 'narration.mp3',
      text: script,
    });

    await setTakeAlignmentReady(take.take_id, alignment);
    logger.info('alignment: ready', { assignmentId, takeId: take.take_id });
    return { status: 'ready' };
  } catch (err) {
    const rawDetail = err instanceof Error ? err.message : String(err);
    const safeDetail = sanitizeErrorDetail(rawDetail);
    logger.error('forced alignment failed', { assignmentId, detail: rawDetail });
    if (takeIdForCatch) {
      try {
        await setTakeAlignmentFailed(takeIdForCatch, `Alignment failed: ${safeDetail}`);
      } catch (writeErr) {
        logger.error('alignment: also failed to record failure', {
          assignmentId,
          detail: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
    return { status: 'failed', reason: 'exception' };
  }
}
