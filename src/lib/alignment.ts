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
 * Run forced alignment for an assignment's full-audio take, idempotently.
 *
 *   - `skipped` — no full-audio take yet, or another worker already owns
 *                 the run (we claim 'running' atomically).
 *   - `ready`   — alignment_json persisted; UI will pick it up on next read.
 *   - `failed`  — alignment_error persisted; UI shows a retry affordance.
 *
 * Never throws. Internal errors are caught, sanitised, and stored on the
 * take so the reviewer-facing string is short and safe.
 */
export async function runAlignmentForAssignment(assignmentId: string): Promise<AlignmentRunResult> {
  const take = await getFullAudioTakeWithAlignment(assignmentId);
  if (!take) {
    return { status: 'skipped', reason: 'no full-audio take' };
  }
  if (take.alignment_status === 'running') {
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
    return { status: 'skipped', reason: 'lost claim race' };
  }

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      await setTakeAlignmentFailed(take.take_id, 'ElevenLabs API key not configured.');
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

    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      await setTakeAlignmentFailed(
        take.take_id,
        `Audio fetch failed (${audioRes.status}). The narrator may need to re-upload.`,
      );
      return { status: 'failed', reason: 'audio fetch' };
    }
    const audioBlob = await audioRes.blob();

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

    const alignment = await forceAlign(apiKey, {
      audioBlob,
      audioFilename: 'narration.mp3',
      text: script,
    });

    await setTakeAlignmentReady(take.take_id, alignment);
    return { status: 'ready' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('forced alignment failed', { assignmentId, detail });
    // Surface a user-facing string, not the raw exception. Length-capped at
    // the DB write so we don't leak signed URLs even by accident.
    const friendly = detail.includes('ElevenLabs')
      ? 'ElevenLabs alignment service returned an error. Retry in a moment.'
      : 'Alignment failed unexpectedly. Retry in a moment.';
    await setTakeAlignmentFailed(take.take_id, friendly);
    return { status: 'failed', reason: 'exception' };
  }
}
