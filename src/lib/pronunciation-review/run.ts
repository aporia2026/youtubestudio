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
 * Full pipeline (Phase 2):
 *
 *   1. claim → budget check → audio fetch (existing).
 *   2. Whisper → unconstrained ASR with word timestamps (existing).
 *   3. Cache Whisper output on the take row so a downstream failure
 *      doesn't lose the transcription.
 *   4. Tokenize the canonical script.
 *   5. Diff (Needleman-Wunsch) between script words and Whisper words.
 *   6. Select candidates: every diff substitution/omission/insertion
 *      plus every tricky-word match (proper nouns, acronyms, non-ASCII).
 *      Dedupe within a 2-sec window, cap at MAX_CANDIDATES.
 *   7. Prepare the audio source (write to /tmp once).
 *   8. For each candidate (5-way parallel): slice → judge.
 *   9. Filter verdicts by confidence threshold + is_real_issue=true.
 *   10. Delete prior 'pending' flags, insert new flags.
 *   11. Flip status to 'ready', roll the judge cost into the take row.
 *   12. Cleanup the audio temp file.
 *
 * Never throws to the caller. Every failure path lands in the outer
 * try/catch and records 'failed' with a user-safe reason. Fire-and-
 * forget callers can ignore the return value.
 */

import { getRealSectionsForAssignment } from '../narrator-db';
import { buildAlignmentScript } from '../narrator-utils';
import { getNarrationDownloadUrl } from '../r2';
import { logger } from '../logger';
import {
  cancelPronunciationReview,
  claimPronunciationReview,
  deletePendingPronunciationFlags,
  getCurrentMonthPronunciationReviewCostUsd,
  getFullAudioTakeWithPronunciationReview,
  getWorkspaceIdForAssignment,
  insertPronunciationFlags,
  setPronunciationReviewFailed,
  setPronunciationReviewReady,
  setPronunciationReviewWhisperCache,
  type FlagCategory,
  type PronunciationFlagInsert,
  type WhisperTranscriptionCache,
} from './db';
import {
  WHISPER_USD_PER_MINUTE,
  WhisperError,
  whisperTranscribeWithWordTimestamps,
} from './whisper';
import { diffScriptVsWhisper, tokenizeScript, type DiffWord } from './diff';
import { selectCandidates, type Candidate } from './candidates';
import {
  cleanupSliceSource,
  prepareSliceSource,
  sliceAudioToWav,
  type SliceSource,
} from './audio-slice';
import { GeminiJudgeError, judgeCandidate, type JudgeVerdictCategory } from './gemini-judge';

/**
 * Monthly cap on combined pronunciation-review spend. Default $5/mo
 * mirrors the alignment cap. At Phase-2 cost (~$0.10/14-min narration
 * including Whisper + judge) that's ~50 narrations/mo before tripping —
 * comfortable headroom for normal use, low enough to catch a runaway
 * loop. Override via `PRONUNCIATION_REVIEW_BUDGET_USD`.
 */
function getMonthlyBudgetUsd(): number {
  const raw = process.env.PRONUNCIATION_REVIEW_BUDGET_USD;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

/** Bound the R2 download so an unreachable bucket can't burn the
 *  function's max duration. Same value as the alignment route. */
const AUDIO_FETCH_TIMEOUT_MS = 180_000;

/** Confidence threshold for keeping a Gemini verdict. Verdicts below
 *  this are dropped silently — they don't appear as flags. Tuning
 *  knob: lower = more flags + more noise, higher = fewer + cleaner.
 *  0.75 errs toward false-negatives per the plan's UX guidance. */
const CONFIDENCE_THRESHOLD = 0.75;

/** Maximum number of concurrent Gemini judge calls. Each call ~2 s, so
 *  60 candidates at 5-way fan-out is ~24 s wall-clock. */
const JUDGE_CONCURRENCY = 5;

export interface PronunciationReviewRunResult {
  status: 'ready' | 'failed' | 'skipped';
  reason?: string;
  /** Phase 2: number of flags persisted. Useful for the smoke script
   *  + return payload of the kick route. */
  flagCount?: number;
  /** Phase 2: number of candidates that were truncated by MAX_CANDIDATES.
   *  Surfaces as a soft UI warning when > 0. */
  candidatesDroppedByCap?: number;
}

function sanitizeErrorDetail(detail: string): string {
  return detail
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 240)
    .trim();
}

/**
 * Idempotent. Two concurrent kicks collapse via `claimPronunciationReview`
 * (atomic CAS).
 *
 *   - `skipped` — no full-audio take, or another worker owns the run.
 *   - `ready`   — Whisper + judge complete, flags persisted.
 *   - `failed`  — terminal failure; reason recorded on the take row.
 */
export async function runPronunciationReviewForAssignment(
  assignmentId: string,
): Promise<PronunciationReviewRunResult> {
  // Tracked in closure so the outer catch can still record a failure
  // even if the throw happened during a pre-claim DB query.
  let takeIdForCatch: string | null = null;
  let sliceSource: SliceSource | null = null;

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

    // ── Budget guard (Whisper-side only — judge cost is bounded by
    // MAX_CANDIDATES so it's a known small additive). ─────────────────
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
      return { status: 'failed', reason: 'no api key (openai)' };
    }
    if (!process.env.GOOGLE_AI_API_KEY) {
      await setPronunciationReviewFailed(
        take.take_id,
        'Google AI API key not configured on the server.',
      );
      return { status: 'failed', reason: 'no api key (google)' };
    }

    // ── Audio fetch ────────────────────────────────────────────────────
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

    const filename = pickWhisperFilename(audioBlob.type);

    // ── Script + priming prompt ────────────────────────────────────────
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

    // ── Whisper ────────────────────────────────────────────────────────
    logger.info('[pronunciation-review] calling Whisper', {
      assignmentId,
      takeId: take.take_id,
      audioBytes: audioBlob.size,
      durationSeconds,
    });
    let whisperJson: WhisperTranscriptionCache;
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

    // Cache the Whisper output as soon as we have it. If the judge
    // step fails downstream, a re-run starts from this cached value
    // rather than re-paying Whisper. (Phase 3 may extend the route
    // to skip Whisper when whisperJson is fresh enough.)
    const cached = await setPronunciationReviewWhisperCache({
      takeId: take.take_id,
      whisperJson,
      costUsd: whisperJson.cost_usd,
    });
    if (!cached) {
      logger.info('[pronunciation-review] cancelled mid-Whisper', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'skipped', reason: 'cancelled mid-Whisper' };
    }

    // ── Diff + candidates ──────────────────────────────────────────────
    const scriptWords: DiffWord[] = tokenizeScript(canonicalScript);
    const whisperWords: DiffWord[] = whisperJson.words.map((w) => ({
      text: w.text,
      startSec: w.start_sec,
      endSec: w.end_sec,
    }));
    const diff = diffScriptVsWhisper(scriptWords, whisperWords);
    logger.info('[pronunciation-review] diff complete', {
      assignmentId,
      takeId: take.take_id,
      matches: diff.matches,
      substitutions: diff.substitutions,
      omissions: diff.omissions,
      insertions: diff.insertions,
    });

    const { candidates, droppedByDedupe, droppedByCap } = selectCandidates(
      diff,
      scriptWords,
    );
    logger.info('[pronunciation-review] candidates selected', {
      assignmentId,
      takeId: take.take_id,
      candidates: candidates.length,
      droppedByDedupe,
      droppedByCap,
    });

    // ── Workspace lookup for flag rows ─────────────────────────────────
    const workspaceId = await getWorkspaceIdForAssignment(assignmentId);
    if (!workspaceId) {
      await setPronunciationReviewFailed(
        take.take_id,
        'Could not resolve workspace for this assignment.',
      );
      return { status: 'failed', reason: 'no workspace' };
    }

    // ── Early exit: no candidates → mark ready, no flags ───────────────
    if (candidates.length === 0) {
      await deletePendingPronunciationFlags(take.take_id);
      const flipped = await setPronunciationReviewReady({
        takeId: take.take_id,
        judgeCostUsd: 0,
      });
      if (!flipped) {
        return { status: 'skipped', reason: 'cancelled before judge' };
      }
      logger.info('[pronunciation-review] ready — no candidates', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'ready', flagCount: 0, candidatesDroppedByCap: droppedByCap };
    }

    // ── Audio source for slicing ───────────────────────────────────────
    const ext = filename.split('.').pop() ?? 'mp3';
    sliceSource = await prepareSliceSource(audioBlob, take.take_id, ext);

    // ── Parallel judge ─────────────────────────────────────────────────
    const verdicts = await runJudgeBatch({
      candidates,
      scriptWords,
      source: sliceSource,
      concurrency: JUDGE_CONCURRENCY,
    });

    const totalJudgeCost = verdicts.reduce((sum, v) => sum + (v?.costUsd ?? 0), 0);

    // ── Filter + map to flag inserts ───────────────────────────────────
    const flagsToInsert: PronunciationFlagInsert[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const r = verdicts[i];
      if (!r) continue;
      const v = r.verdict;
      if (!v.is_real_issue) continue;
      if (v.confidence < CONFIDENCE_THRESHOLD) continue;
      if (v.category === 'ok') continue;
      flagsToInsert.push({
        word_index: pickWordIndex(c),
        start_sec: c.startSec,
        end_sec: c.endSec,
        category: mapVerdictCategoryToFlag(v.category),
        confidence: v.confidence,
        ai_explanation: v.explanation,
        suggested_comment: v.suggested_comment,
      });
    }

    // ── Persist flags ──────────────────────────────────────────────────
    const dropped = await deletePendingPronunciationFlags(take.take_id);
    if (dropped > 0) {
      logger.info('[pronunciation-review] dropped stale pending flags', {
        assignmentId,
        takeId: take.take_id,
        dropped,
      });
    }
    if (flagsToInsert.length > 0) {
      await insertPronunciationFlags({
        takeId: take.take_id,
        workspaceId,
        flags: flagsToInsert,
      });
    }

    // ── Flip to ready ──────────────────────────────────────────────────
    const flipped = await setPronunciationReviewReady({
      takeId: take.take_id,
      judgeCostUsd: totalJudgeCost,
    });
    if (!flipped) {
      logger.info('[pronunciation-review] cancelled mid-flip', {
        assignmentId,
        takeId: take.take_id,
      });
      return { status: 'skipped', reason: 'cancelled mid-flip' };
    }

    logger.info('[pronunciation-review] ready', {
      assignmentId,
      takeId: take.take_id,
      candidateCount: candidates.length,
      flagCount: flagsToInsert.length,
      judgeCostUsd: totalJudgeCost,
      totalCostUsd: whisperJson.cost_usd + totalJudgeCost,
    });
    return {
      status: 'ready',
      flagCount: flagsToInsert.length,
      candidatesDroppedByCap: droppedByCap,
    };
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
  } finally {
    if (sliceSource) {
      await cleanupSliceSource(sliceSource);
    }
  }
}

interface JudgeOutcome {
  verdict: { is_real_issue: boolean; confidence: number; category: JudgeVerdictCategory; explanation: string; suggested_comment: string };
  costUsd: number;
}

/**
 * Run Gemini judge calls in parallel with a concurrency cap. Returns
 * an array with one slot per candidate; failed judgements land as
 * `null` (orchestrator drops them silently — one flaky call shouldn't
 * tank the whole review). Order matches the input candidates.
 *
 * Pure in spirit (no DB writes) — every failure is logged, never
 * thrown past the function boundary.
 */
async function runJudgeBatch(args: {
  candidates: ReadonlyArray<Candidate>;
  scriptWords: ReadonlyArray<DiffWord>;
  source: SliceSource;
  concurrency: number;
}): Promise<Array<JudgeOutcome | null>> {
  const out: Array<JudgeOutcome | null> = new Array(args.candidates.length).fill(null);
  let nextIndex = 0;
  const workers: Array<Promise<void>> = [];

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= args.candidates.length) return;
      const c = args.candidates[i];
      try {
        const slice = await sliceAudioToWav({
          source: args.source,
          startSec: c.startSec,
          endSec: c.endSec,
        });
        const scriptContext = buildScriptContext(args.scriptWords, c);
        const result = await judgeCandidate({
          audioWav: slice,
          scriptContext,
          candidate: c,
        });
        out[i] = { verdict: result.verdict, costUsd: result.costUsd };
      } catch (err) {
        // Per-candidate failure: log and drop. Other candidates still
        // get judged.
        if (err instanceof GeminiJudgeError) {
          logger.warn('[pronunciation-review judge] candidate failed', {
            candidateIndex: i,
            kind: c.kind,
            scriptWord: c.scriptWord,
            errorKind: err.kind,
            detail: err.message,
          });
        } else {
          logger.warn('[pronunciation-review judge] candidate failed (slice or unknown)', {
            candidateIndex: i,
            kind: c.kind,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  };

  const k = Math.max(1, Math.min(args.concurrency, args.candidates.length));
  for (let i = 0; i < k; i++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/**
 * Build a ~1-sentence-ish context window around the candidate's
 * script position. Used by the judge to disambiguate "WPA" (letters)
 * from "WPA" (word). Falls back to a label when the candidate is a
 * pure insertion (no scriptIndex).
 */
function buildScriptContext(
  scriptWords: ReadonlyArray<DiffWord>,
  candidate: Candidate,
): string {
  const idx = candidate.scriptIndex;
  if (idx < 0 || idx >= scriptWords.length) {
    return '(no script word at this position — narrator may have inserted a word)';
  }
  const start = Math.max(0, idx - 8);
  const end = Math.min(scriptWords.length, idx + 9);
  return scriptWords
    .slice(start, end)
    .map((w, j) => (start + j === idx ? `«${w.text}»` : w.text))
    .join(' ');
}

/**
 * Stable `word_index` for the flag row. Substitutions / omissions /
 * tricky-word candidates use the script index; insertions use the
 * Whisper index negated to -N-1 so the UI can detect "no script
 * anchor here" without losing the temporal locator. The renderer
 * decides whether to underline a script word (positive) or to draw an
 * inter-word marker (negative).
 */
function pickWordIndex(candidate: Candidate): number {
  if (candidate.scriptIndex >= 0) return candidate.scriptIndex;
  // pure insertion — encode whisperIndex as -1 - whisperIndex so the
  // value is unambiguously negative and the original index is
  // recoverable. Used by the UI to render a between-words marker.
  return -1 - Math.max(0, candidate.whisperIndex);
}

/**
 * Gemini's verdict.category enum is a superset of the flag table's
 * category enum (it includes 'ok' for "no issue here"). The
 * orchestrator filters out 'ok' before calling this, so the input is
 * already narrowed to the four flag-table values. Centralizing the
 * mapping here makes that contract explicit.
 */
function mapVerdictCategoryToFlag(category: JudgeVerdictCategory): FlagCategory {
  if (category === 'script_deviation') return 'script_deviation';
  if (category === 'mispronunciation') return 'mispronunciation';
  if (category === 'omission') return 'omission';
  if (category === 'insertion') return 'insertion';
  // Defensive fallback. Should be unreachable because the orchestrator
  // pre-filters 'ok'. If it ever lands here we surface as
  // script_deviation since that's the most neutral category for a
  // non-OK judgement.
  return 'script_deviation';
}

/**
 * Map content-type to a Whisper-friendly filename. Whisper sniffs the
 * format from the extension. The narrator-upload path produces MP3 by
 * default; the rest are forward-compatibility fallbacks.
 */
function pickWhisperFilename(contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('wav')) return 'narration.wav';
  if (ct.includes('flac')) return 'narration.flac';
  if (ct.includes('m4a') || ct.includes('mp4')) return 'narration.m4a';
  if (ct.includes('ogg')) return 'narration.ogg';
  if (ct.includes('webm')) return 'narration.webm';
  return 'narration.mp3';
}

// Re-export for the cancel route. Keeps the route layer's import
// surface to a single module — `./run` is the public face of the
// pipeline.
export { cancelPronunciationReview };
