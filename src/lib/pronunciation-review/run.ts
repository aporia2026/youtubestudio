/**
 * Pronunciation-review orchestrator.
 *
 * Mirrors the shape of `runAlignmentForAssignment` in
 * `src/lib/alignment.ts`. The two pipelines are independent — alignment
 * gives us *where* each script word lives in the audio (forced
 * alignment, script-constrained), pronunciation review gives us *what
 * the narrator actually said* (unconstrained ASR) so we can surface
 * deviations and mispronunciations.
 *
 * Phase 1 (this file): claim → budget check → audio fetch → Whisper →
 * persist transcription → mark 'ready'. No Gemini judge yet, no
 * pronunciation_flags rows written. The smoke script reads
 * `pronunciation_review_whisper_json` directly to verify Whisper plumbing.
 *
 * Phase 2 will insert between the Whisper step and the 'ready' write:
 *   • diff(whisperWords, scriptWords) → candidate list
 *   • tricky-word detection → augment candidates
 *   • dedupe candidates by 2-sec window
 *   • parallel Gemini judge (concurrency=5) over candidates
 *   • filter by confidence threshold
 *   • insert pronunciation_flags rows in one transaction
 *
 * Never throws. Every failure path lands in the outer try/catch and is
 * recorded as 'failed' with a user-safe reason. The route layer's
 * fire-and-forget callers can ignore the return value.
 */

import { getRealSectionsForAssignment } from '../narrator-db';
import { buildAlignmentScript } from '../narrator-utils';
import { getNarrationDownloadUrl } from '../r2';
import { logger } from '../logger';
import {
  cancelPronunciationReview,
  claimPronunciationReview,
  getCurrentMonthPronunciationReviewCostUsd,
  getFullAudioTakeWithPronunciationReview,
  setPronunciationReviewFailed,
  setPronunciationReviewWhisperReady,
} from './db';
import {
  WHISPER_USD_PER_MINUTE,
  WhisperError,
  whisperTranscribeWithWordTimestamps,
} from './whisper';

/**
 * Monthly cap on combined pronunciation-review spend. Default $5/mo
 * mirrors the alignment cap; at the Phase-1 Whisper-only rate
 * ($0.006/min) that's ~14 hours of audio — comfortable headroom. Once
 * Phase 2 lands the Gemini judge cost (~$0.017 per 14-min narration),
 * the same cap covers ~50 narrations/mo before tripping. Override via
 * `PRONUNCIATION_REVIEW_BUDGET_USD`.
 */
function getMonthlyBudgetUsd(): number {
  const raw = process.env.PRONUNCIATION_REVIEW_BUDGET_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/**
 * Bound the R2 download so an unreachable bucket can't burn the
 * function's max duration. Same value as the alignment route.
 */
const AUDIO_FETCH_TIMEOUT_MS = 180_000;

export interface PronunciationReviewRunResult {
  status: 'ready' | 'failed' | 'skipped';
  reason?: string;
}

/**
 * Strip URL-like substrings + cap length. Error messages from the
 * Whisper SDK or R2 fetches can carry pre-signed URLs in their text;
 * never let those reach the browser or be persisted to the DB.
 */
function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 240)
    .trim();
}

/**
 * Idempotent. Two concurrent kicks collapse via `claimPronunciationReview`
 * (atomic CAS). Returns:
 *   - `skipped` — no full-audio take, or another worker owns the run.
 *   - `ready`   — Whisper succeeded; transcription persisted.
 *   - `failed`  — terminal failure; reason recorded in
 *                 narrator_takes.pronunciation_review_error.
 */
export async function runPronunciationReviewForAssignment(
  assignmentId: string,
): Promise<PronunciationReviewRunResult> {
  // Tracked in closure so the outer catch can still record a failure
  // even if the throw happened during a pre-claim DB query.
  let takeIdForCatch: string | null = null;

  try {
    logger.info('[pronunciation-review] starting', { assignmentId });

    const take = await getFullAudioTakeWithPronunciationReview(assignmentId);
    if (!take) {
      logger.info('[pronunciation-review] skipped — no full-audio take', { assignmentId });
      return { status: 'skipped', reason: 'no full-audio take' };
    }
    takeIdForCatch = take.take_id;

    if (take.pronunciation_review_status === 'running') {
      logger.info('[pronunciation-review] skipped — already running', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'skipped', reason: 'already running' };
    }

    // Budget check happens BEFORE the claim so we don't burn a status
    // transition when over cap. Approximate — adds this take's projected
    // Whisper cost to the month-to-date total.
    const monthSpend = await getCurrentMonthPronunciationReviewCostUsd();
    const projectedCost =
      monthSpend +
      ((take.duration_seconds ?? 0) / 60) * WHISPER_USD_PER_MINUTE;
    const budgetUsd = getMonthlyBudgetUsd();
    if (projectedCost > budgetUsd) {
      await setPronunciationReviewFailed(
        take.take_id,
        `Monthly pronunciation-review budget exceeded ($${budgetUsd.toFixed(
          2,
        )}). Try again next month or raise PRONUNCIATION_REVIEW_BUDGET_USD.`,
      );
      return { status: 'failed', reason: 'budget' };
    }

    const claimed = await claimPronunciationReview(take.take_id);
    if (!claimed) {
      logger.info('[pronunciation-review] skipped — lost claim race', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'skipped', reason: 'lost claim race' };
    }

    if (!process.env.OPENAI_API_KEY) {
      await setPronunciationReviewFailed(
        take.take_id,
        'OpenAI API key not configured on the server.',
      );
      return { status: 'failed', reason: 'no api key' };
    }

    // Resolve a fresh signed URL — the stored audio_url may have
    // expired since the upload. Never leaks past this scope.
    let audioUrl: string;
    if (take.r2_key) {
      audioUrl = await getNarrationDownloadUrl(take.r2_key);
    } else if (take.audio_url) {
      audioUrl = take.audio_url;
    } else {
      await setPronunciationReviewFailed(take.take_id, 'No audio URL for take.');
      return { status: 'failed', reason: 'no audio url' };
    }

    let audioBlob: Blob;
    try {
      const audioRes = await fetch(audioUrl, {
        signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS),
      });
      if (!audioRes.ok) {
        const reason =
          audioRes.status === 404
            ? 'Audio file not reachable at the stored key (HTTP 404). Pronunciation review will become available once the audio is restored.'
            : `Audio fetch failed (HTTP ${audioRes.status}).`;
        await setPronunciationReviewFailed(take.take_id, reason);
        return { status: 'failed', reason: 'audio fetch' };
      }
      audioBlob = await audioRes.blob();
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        await setPronunciationReviewFailed(
          take.take_id,
          `Audio download timed out after ${Math.round(
            AUDIO_FETCH_TIMEOUT_MS / 1000,
          )}s.`,
        );
        return { status: 'failed', reason: 'audio fetch timeout' };
      }
      throw err;
    }

    if (audioBlob.size === 0) {
      await setPronunciationReviewFailed(take.take_id, 'Audio file is empty.');
      return { status: 'failed', reason: 'empty audio' };
    }

    // Pick a Whisper-compatible filename based on the blob's content-
    // type. Whisper uses the extension to detect the format. Default to
    // mp3 since that's the format the narrator-upload path produces.
    const filename = pickWhisperFilename(audioBlob.type);

    // Build the priming prompt from the canonical script. Whisper's
    // `prompt` parameter is a soft hint that biases recognition toward
    // the supplied vocabulary — useful for proper nouns like
    // "Viehböck" or "Reaver" that Whisper would otherwise mis-spell.
    // Cap at ~200 characters so the prompt fits Whisper's hint budget
    // and doesn't dominate the model context.
    //
    // sections come from getRealSectionsForAssignment as untyped rows;
    // the narrator_sections schema guarantees script_text exists.
    const sections = (await getRealSectionsForAssignment(assignmentId)) as Array<{
      script_text: string;
    }>;
    const canonicalScript = buildAlignmentScript(sections);
    if (!canonicalScript.trim()) {
      await setPronunciationReviewFailed(
        take.take_id,
        'Script is empty — nothing to compare against.',
      );
      return { status: 'failed', reason: 'empty script' };
    }
    const primingPrompt = canonicalScript.slice(0, 200);

    const durationSeconds = take.duration_seconds ?? 0;

    logger.info('[pronunciation-review] calling Whisper', {
      assignmentId,
      takeId: take.take_id,
      audioBytes: audioBlob.size,
      durationSeconds,
    });

    let whisperJson;
    try {
      whisperJson = await whisperTranscribeWithWordTimestamps({
        audio: audioBlob,
        filename,
        languageCode: 'en',
        primingPrompt,
        durationSeconds,
      });
    } catch (err) {
      if (err instanceof WhisperError) {
        await setPronunciationReviewFailed(take.take_id, err.message);
        return { status: 'failed', reason: err.kind };
      }
      throw err;
    }

    // Re-check that the take is still in 'running' before persisting —
    // a cancel that landed mid-Whisper means we should not overwrite
    // the cancellation. `setPronunciationReviewWhisperReady` enforces
    // this via its WHERE clause and returns false on a no-op.
    const persisted = await setPronunciationReviewWhisperReady({
      takeId: take.take_id,
      whisperJson,
      costUsd: whisperJson.cost_usd,
    });

    if (!persisted) {
      // Most likely the user hit cancel between claim and persist.
      // Don't overwrite — just log and exit.
      logger.info('[pronunciation-review] result discarded — no longer running', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'skipped', reason: 'no longer running' };
    }

    logger.info('[pronunciation-review] ready', {
      assignmentId,
      takeId: take.take_id,
      wordCount: whisperJson.words.length,
      costUsd: whisperJson.cost_usd,
    });
    return { status: 'ready' };
  } catch (err) {
    const rawDetail = err instanceof Error ? err.message : String(err);
    const safeDetail = sanitizeErrorDetail(rawDetail);
    logger.error('[pronunciation-review] failed', { assignmentId, detail: rawDetail });
    if (takeIdForCatch) {
      try {
        await setPronunciationReviewFailed(
          takeIdForCatch,
          `Pronunciation review failed: ${safeDetail}`,
        );
      } catch (writeErr) {
        logger.error('[pronunciation-review] also failed to record failure', {
          assignmentId,
          detail: writeErr instanceof Error ? writeErr.message : String(writeErr),
        });
      }
    }
    return { status: 'failed', reason: 'exception' };
  }
}

/**
 * Map a content-type to a filename Whisper accepts. Whisper sniffs the
 * audio format from the filename extension, so getting this right
 * matters. The narrator-upload path produces MP3 by default; WAV and
 * the rest are best-effort fallbacks for forward compatibility.
 */
function pickWhisperFilename(contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('wav')) return 'narration.wav';
  if (ct.includes('flac')) return 'narration.flac';
  if (ct.includes('m4a') || ct.includes('mp4')) return 'narration.m4a';
  if (ct.includes('ogg')) return 'narration.ogg';
  if (ct.includes('webm')) return 'narration.webm';
  // Default — MP3 is what our upload path generates.
  return 'narration.mp3';
}

/**
 * Re-export for the cancel route. Keeps the route layer's import surface
 * to a single module — `./run` is the public face of the pipeline.
 */
export { cancelPronunciationReview };
