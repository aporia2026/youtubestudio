/**
 * End-to-end smoke test for the pronunciation-review pipeline (Phase 1).
 *
 * Drives `runPronunciationReviewForAssignment` against a real
 * narrator_assignment whose full-audio take has been uploaded. Prints
 * a summary of the Whisper transcription so we can sanity-check the
 * recognizer's output against the script before Phase 2 (diff +
 * Gemini judge) gets built on top of it.
 *
 * Usage:
 *   set SMOKE_PR_ASSIGNMENT_ID=<assignment-uuid>
 *   npm exec tsx --env-file-if-exists=.env.local scripts/pronunciation-review-smoke.ts
 *
 * Or one-liner on POSIX:
 *   SMOKE_PR_ASSIGNMENT_ID=<uuid> npm exec tsx -- ...
 *
 * Inputs:
 *   SMOKE_PR_ASSIGNMENT_ID  Required. UUID of the narrator_assignments
 *                            row whose full-audio take should be
 *                            transcribed. The assignment must already
 *                            have full_audio_take_id populated (i.e.
 *                            the narrator uploaded the full audio).
 *   OPENAI_API_KEY          Required (read from .env.local).
 *   POSTGRES_URL[_NON_POOLING]  Required.
 *
 * Output: cost, word count, first 10 + last 5 words with timestamps,
 * detected language. Exit code 0 on ready, 1 on failed, 2 on
 * "skipped — no full-audio take" or similar pre-flight skips.
 *
 * Cost: ~$0.006 per minute of audio (whisper-1). A 14-min narration
 * costs ~$0.084. Re-running on the same take re-pays the bill — there's
 * no client-side caching in v1 (the assumption is that the reviewer
 * triggers the review at most a few times per take).
 *
 * Phase 1 of _plans/2026-06-01-pronunciation-review.md.
 */

import { sql } from '@vercel/postgres';
import { runPronunciationReviewForAssignment } from '../src/lib/pronunciation-review/run';

function readEnv(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw : null;
}

function fatal(msg: string): never {
  process.stderr.write(`pronunciation-review-smoke: ${msg}\n`);
  process.exit(1);
}

function fmtSec(s: number): string {
  return `${s.toFixed(2).padStart(7)}s`;
}

async function main() {
  const assignmentId = readEnv('SMOKE_PR_ASSIGNMENT_ID');
  if (!assignmentId) fatal('SMOKE_PR_ASSIGNMENT_ID is required.');

  process.stdout.write('pronunciation-review-smoke: starting\n');
  process.stdout.write(`  assignmentId  : ${assignmentId}\n\n`);

  const t0 = Date.now();
  const result = await runPronunciationReviewForAssignment(assignmentId);
  const elapsedMs = Date.now() - t0;

  process.stdout.write(`status           : ${result.status}\n`);
  if (result.reason) process.stdout.write(`reason           : ${result.reason}\n`);
  process.stdout.write(`elapsed          : ${elapsedMs}ms\n\n`);

  if (result.status !== 'ready') {
    // Pull the recorded error message out of the DB so we get the same
    // user-facing string the UI would render.
    const { rows } = await sql`
      SELECT t.pronunciation_review_status, t.pronunciation_review_error
      FROM narrator_assignments a
      JOIN narrator_takes t ON t.id = a.full_audio_take_id
      WHERE a.id = ${assignmentId}
      LIMIT 1
    `;
    if (rows[0]) {
      process.stdout.write(`db status        : ${rows[0].pronunciation_review_status}\n`);
      if (rows[0].pronunciation_review_error) {
        process.stdout.write(`db error         : ${rows[0].pronunciation_review_error}\n`);
      }
    }
    // skipped is non-fatal (just means the take wasn't ready); failed is
    // a real problem worth a non-zero exit.
    process.exit(result.status === 'failed' ? 1 : 2);
  }

  // ── Read back the transcription for a sanity check ──────────────────
  const { rows } = await sql`
    SELECT t.pronunciation_review_whisper_json AS whisper,
           t.pronunciation_review_cost_usd AS cost,
           t.duration_seconds AS duration
    FROM narrator_assignments a
    JOIN narrator_takes t ON t.id = a.full_audio_take_id
    WHERE a.id = ${assignmentId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !row.whisper) {
    process.stderr.write(
      'pronunciation-review-smoke: status=ready but whisper_json is empty — bug in the orchestrator?\n',
    );
    process.exit(1);
  }

  const whisper = row.whisper as {
    text: string;
    duration_seconds: number;
    language: string;
    model: string;
    cost_usd: number;
    words: Array<{ text: string; start_sec: number; end_sec: number }>;
  };

  process.stdout.write(`audio duration  : ${fmtSec(Number(row.duration ?? 0))}\n`);
  process.stdout.write(`whisper duration: ${fmtSec(whisper.duration_seconds)}\n`);
  process.stdout.write(`detected lang   : ${whisper.language}\n`);
  process.stdout.write(`model           : ${whisper.model}\n`);
  process.stdout.write(`word count      : ${whisper.words.length}\n`);
  process.stdout.write(`cost USD        : $${Number(row.cost ?? 0).toFixed(4)}\n`);
  process.stdout.write(`text chars      : ${whisper.text.length}\n\n`);

  const previewHead = whisper.words.slice(0, 10);
  const previewTail = whisper.words.slice(-5);
  process.stdout.write('  first 10 words:\n');
  for (const w of previewHead) {
    process.stdout.write(
      `    ${fmtSec(w.start_sec)} → ${fmtSec(w.end_sec)}   "${w.text}"\n`,
    );
  }
  if (whisper.words.length > 15) {
    process.stdout.write('  …\n');
    process.stdout.write('  last 5 words:\n');
    for (const w of previewTail) {
      process.stdout.write(
        `    ${fmtSec(w.start_sec)} → ${fmtSec(w.end_sec)}   "${w.text}"\n`,
      );
    }
  }

  process.stdout.write('\nfull transcript (first 500 chars):\n');
  process.stdout.write(`  ${whisper.text.slice(0, 500)}${whisper.text.length > 500 ? '…' : ''}\n`);

  // ── Phase 2 — flags produced by the diff + Gemini judge ──────────────
  const flagRows = await sql<{
    id: string;
    category: string;
    confidence: string | number;
    start_sec: string | number;
    end_sec: string | number;
    word_index: string | number;
    ai_explanation: string;
    suggested_comment: string;
    user_status: string;
  }>`
    SELECT f.id, f.category, f.confidence, f.start_sec, f.end_sec,
           f.word_index, f.ai_explanation, f.suggested_comment, f.user_status
    FROM pronunciation_flags f
    JOIN narrator_takes t ON t.id = f.take_id
    JOIN narrator_assignments a ON a.full_audio_take_id = t.id
    WHERE a.id = ${assignmentId}
    ORDER BY f.start_sec ASC
  `;

  process.stdout.write(`\nflags persisted   : ${flagRows.rows.length}\n`);
  if (flagRows.rows.length > 0) {
    process.stdout.write('  time     | conf | category          | explanation\n');
    process.stdout.write('  ---------+------+-------------------+----------------------------------\n');
    for (const f of flagRows.rows) {
      const t = Number(f.start_sec);
      const tStr = `${fmtSec(t)}`;
      const cat = String(f.category).padEnd(17);
      const conf = Number(f.confidence).toFixed(2);
      process.stdout.write(`  ${tStr} | ${conf} | ${cat} | ${f.ai_explanation}\n`);
      process.stdout.write(`           |      |                   | → ${f.suggested_comment}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(
    `pronunciation-review-smoke: failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
