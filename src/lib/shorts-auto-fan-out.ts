/**
 * Auto-fan-out: every long-form script save automatically queues N
 * Short candidates into the project tray + the global Shorts inbox.
 *
 * See `_plans/2026-06-02-shorts-everywhere-v1.md` §7 Phase 1 step 7
 * for the expansion-case rationale (script-extractor as a Shorts
 * factory; 1 long-form = 3–7 Shorts).
 *
 * Phase 1 design:
 *   - Pure-deterministic scoring (no AI call) so this is cheap enough
 *     to fire on every script save.
 *   - Synthetic timecodes — long-form scripts in our DB don't have a
 *     transcript with word-level offsets. We split into sentences and
 *     estimate duration from word count using `WORDS_PER_SECOND` (2.33).
 *     Estimates are good enough for scoring + UI display; the rendered
 *     timecodes get re-derived in Phase 2 when the user clicks
 *     "Make this Short" and the extractor runs for real.
 *   - Idempotency: skipped if rows already exist for this source script
 *     so a script edit doesn't pile up duplicate candidates.
 *   - Persisted as `kind='extracted'`, `medium='short_native'` — these
 *     ARE extracted (just by the auto-fan-out service, not the LLM
 *     extractor), and they're seeds for new Shorts, not pointers to a
 *     YouTube video.
 *
 * Wired from:
 *   - POST /api/projects/[id]/scripts — every new script version that
 *     becomes active.
 *
 * NOT wired from:
 *   - The Remotion render endpoint — render completion is downstream of
 *     script save (the user has already committed by saving the script).
 *     Firing at script-save means even un-rendered projects get
 *     candidate Shorts. The plan's framing ("when a long-form render
 *     completes") was loose; script save is the cleaner semantic.
 */

import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { scoreClips, type ClipScorerSegment } from './clip-scorer';
import { getShortsSettings } from './shorts-workspace-settings-db';
import { WORDS_PER_SECOND } from './shorts-types';

export interface AutoFanOutInput {
  workspaceId: string;
  projectId: string;
  /** The just-saved script's id (used for FK + idempotency). */
  sourceScriptId: string;
  /** The script's content text. */
  scriptText: string;
}

export interface AutoFanOutResult {
  candidatesCreated: number;
  candidatesSkipped: number;
  skipped: boolean;
  reason?: string;
}

/** Split a script into sentence segments with synthetic offset/duration
 *  estimated from word count. Pure helper — exported for testing. */
export function synthesizeSegments(scriptText: string): ClipScorerSegment[] {
  if (!scriptText || typeof scriptText !== 'string') return [];

  // Strip bracketed visual / production markers so they don't count
  // toward spoken word count — matches `stripProductionMarkers` semantics
  // without pulling in the renderer-only module on the lib side.
  const spoken = scriptText.replace(/\[[^\]]*\]/g, ' ').trim();
  if (!spoken) return [];

  // Sentence split — terminal punctuation + whitespace boundary.
  const sentences = spoken
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let offsetMs = 0;
  const segments: ClipScorerSegment[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words === 0) continue;
    const durationMs = Math.max(1000, Math.round((words / WORDS_PER_SECOND) * 1000));
    segments.push({ text: sentence, offset_ms: offsetMs, duration_ms: durationMs });
    offsetMs += durationMs;
  }
  return segments;
}

/** Returns true if shorts rows already exist for this source script.
 *  Idempotency guard — re-running fan-out is a no-op. */
async function alreadyFannedOut(workspaceId: string, sourceScriptId: string): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS(
      SELECT 1 FROM shorts
       WHERE workspace_id = ${workspaceId}::uuid
         AND source_script_id = ${sourceScriptId}::uuid
         AND medium = 'short_native'
         AND kind = 'extracted'
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

export async function runAutoFanOut(input: AutoFanOutInput): Promise<AutoFanOutResult> {
  const { workspaceId, projectId, sourceScriptId, scriptText } = input;

  const settings = await getShortsSettings(workspaceId);
  if (!settings.autoFanOutEnabled || settings.autoFanOutCount === 0) {
    logger.info('[shorts auto-fan-out] skipped — disabled in workspace settings', {
      workspaceId,
      projectId,
      sourceScriptId,
      enabled: settings.autoFanOutEnabled,
      count: settings.autoFanOutCount,
    });
    return { candidatesCreated: 0, candidatesSkipped: 0, skipped: true, reason: 'disabled' };
  }

  // Idempotency.
  if (await alreadyFannedOut(workspaceId, sourceScriptId)) {
    logger.info('[shorts auto-fan-out] skipped — already fanned out for this script', {
      workspaceId,
      projectId,
      sourceScriptId,
    });
    return { candidatesCreated: 0, candidatesSkipped: 0, skipped: true, reason: 'already_fanned_out' };
  }

  const segments = synthesizeSegments(scriptText);
  if (segments.length === 0) {
    logger.info('[shorts auto-fan-out] skipped — script produced no segments', {
      workspaceId,
      projectId,
      sourceScriptId,
    });
    return { candidatesCreated: 0, candidatesSkipped: 0, skipped: true, reason: 'empty_script' };
  }

  const candidates = scoreClips(segments, {
    topN: settings.autoFanOutCount,
    targetSeconds: settings.defaultTargetSecondsModeA,
  });

  if (candidates.length === 0) {
    logger.info('[shorts auto-fan-out] skipped — no candidates above bounds', {
      workspaceId,
      projectId,
      sourceScriptId,
      segments: segments.length,
    });
    return { candidatesCreated: 0, candidatesSkipped: 0, skipped: true, reason: 'no_candidates' };
  }

  let created = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    try {
      const firstSentence = candidate.text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? candidate.text;
      const lastSentence =
        candidate.text.split(/(?<=[.!?])\s+/).slice(-1)[0]?.trim() ?? candidate.text;
      await sql`
        INSERT INTO shorts (
          workspace_id, project_id, source_script_id,
          kind, medium,
          title, short_script, hook, payoff,
          word_count, estimated_duration_seconds,
          hook_score
        ) VALUES (
          ${workspaceId}::uuid,
          ${projectId}::uuid,
          ${sourceScriptId}::uuid,
          'extracted',
          'short_native',
          ${null},
          ${candidate.text},
          ${firstSentence},
          ${lastSentence},
          ${candidate.wordCount},
          ${Math.round(candidate.durationSeconds)},
          ${candidate.hookScore}
        )
      `;
      created++;
    } catch (err) {
      skipped++;
      logger.warn('[shorts auto-fan-out] candidate insert failed', {
        workspaceId,
        projectId,
        sourceScriptId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[shorts auto-fan-out] done', {
    workspaceId,
    projectId,
    sourceScriptId,
    candidatesCreated: created,
    candidatesSkipped: skipped,
    segmentsScored: segments.length,
    topScore: candidates[0]?.score ?? null,
  });

  return {
    candidatesCreated: created,
    candidatesSkipped: skipped,
    skipped: false,
  };
}
