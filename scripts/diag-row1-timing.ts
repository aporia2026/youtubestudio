/**
 * One-shot diagnostic: given a scheduleItemId, find the production doc
 * + the latest ready narrator alignment, run alignRowsToWords, and
 * print row 0's true end time + what timecode row 1 needs.
 *
 * Usage:
 *   npx tsx --env-file-if-exists=.env.local scripts/diag-row1-timing.ts <scheduleItemId>
 *
 * Read-only. No writes. Delete after use.
 */
import { neon } from '@neondatabase/serverless';
import { alignRowsToWords } from '../src/lib/voiceover-alignment';
import { stripProductionMarkers } from '../src/lib/script-markers';
import type { ForcedAlignmentResponse } from '../src/lib/elevenlabs';
import {
  realignVideoConfig,
  DEFAULT_MIN_SCENE_MS,
  DEFAULT_TAIL_BUFFER_MS,
} from '../src/remotion/utils';
import type { VideoConfig, VideoShot } from '../src/remotion/types';
import { DEFAULT_BRAND_KIT } from '../src/remotion/types';

function fatal(msg: string): never {
  process.stderr.write(`[diag-row1] ${msg}\n`);
  process.exit(1);
}

function parseTimecodeToMs(tc: string): number {
  const parts = tc.split(':').map((p) => parseInt(p, 10));
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return 0;
}

function fmtMs(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

async function main() {
  const scheduleItemId = process.argv[2];
  if (!scheduleItemId) fatal('usage: diag-row1-timing.ts <scheduleItemId>');

  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) fatal('DATABASE_URL not set');

  const sql = neon(url);

  console.info('[diag-row1] schedule item', { scheduleItemId });

  // 1. Resolve project_id + history pointers from schedule_items.custom_fields
  const scheduleRows = (await sql`
    SELECT id, project_id, custom_fields
      FROM schedule_items
     WHERE id = ${scheduleItemId}::uuid
  `) as Array<{ id: string; project_id: string | null; custom_fields: Record<string, unknown> | null }>;

  if (scheduleRows.length === 0) fatal(`schedule item ${scheduleItemId} not found`);
  const projectId = scheduleRows[0].project_id;
  const customFields = scheduleRows[0].custom_fields || {};
  const latestProdDoc = (customFields.latest_production_doc as Record<string, unknown> | undefined) || {};
  const historyEntryId = latestProdDoc.history_entry_id as string | undefined;
  const narratorAssignmentId = customFields.narrator_assignment_id as string | undefined;
  console.info('[diag-row1] project resolved', { projectId, historyEntryId, narratorAssignmentId });
  if (!projectId) fatal('schedule item has no project_id');
  if (!historyEntryId) fatal('no latest_production_doc.history_entry_id in custom_fields');

  // 2. Fetch the production doc from user_history
  const docRows = (await sql`
    SELECT id, payload, created_at
      FROM user_history
     WHERE id = ${historyEntryId}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `) as Array<{ id: string; payload: Record<string, unknown>; created_at: string }>;

  if (docRows.length === 0) fatal(`production doc history entry ${historyEntryId} not found`);
  const entry = docRows[0];
  console.info('[diag-row1] history entry found', { entryId: entry.id, createdAt: entry.created_at, payloadKeys: Object.keys(entry.payload) });

  // The payload shape: see ProductionDocHistoryEntry. The doc itself is
  // usually under `doc` (or sometimes `production_doc`).
  const payload = entry.payload;
  const doc =
    (payload.doc as Record<string, unknown> | undefined) ||
    (payload.production_doc as Record<string, unknown> | undefined) ||
    payload;
  const rows = (doc?.rows as Array<Record<string, unknown>> | undefined) || undefined;
  const totalDuration = (doc?.total_duration as string | undefined) || '0:00';
  const wpm = (doc?.speaking_pace_wpm as number | undefined) ?? 130;
  if (!Array.isArray(rows) || rows.length === 0) {
    console.info('[diag-row1] doc keys', { keys: Object.keys(doc as Record<string, unknown>) });
    fatal('production doc rows not found in history payload');
  }
  console.info('[diag-row1] production doc', {
    rowCount: rows.length,
    totalDuration,
    wpm,
    row0: { timecode: rows[0].timecode, script_text: rows[0].script_text },
    row1: rows[1] ? { timecode: rows[1].timecode, script_text: rows[1].script_text } : null,
  });

  // 3. Find the latest READY narrator alignment via the assignment pointer
  const alignRows = (await sql`
    SELECT na.id AS assignment_id,
           nt.id AS take_id,
           nt.alignment_status,
           nt.alignment_json,
           nt.created_at AS take_created_at
      FROM narrator_assignments na
      JOIN narrator_takes nt ON nt.id = na.full_audio_take_id
     WHERE na.id = ${narratorAssignmentId}::uuid
       AND nt.alignment_status = 'ready'
     LIMIT 1
  `) as Array<{
    assignment_id: string;
    take_id: string;
    alignment_status: string;
    alignment_json: ForcedAlignmentResponse | null;
    take_created_at: string;
  }>;

  if (alignRows.length === 0) {
    console.info('[diag-row1] NO READY ALIGNMENT for this assignment', { narratorAssignmentId });
    console.info('[diag-row1] fallback: would need to estimate by audio duration / WPM');

    // Show take state for triage
    const tryAny = (await sql`
      SELECT na.id, nt.id AS take_id, nt.alignment_status, nt.alignment_error, nt.created_at
        FROM narrator_assignments na
        LEFT JOIN narrator_takes nt ON nt.id = na.full_audio_take_id
       WHERE na.id = ${narratorAssignmentId}::uuid
    `) as Array<Record<string, unknown>>;
    console.info('[diag-row1] narrator assignment status', tryAny);
    process.exit(0);
  }

  const align = alignRows[0];
  console.info('[diag-row1] alignment found', {
    assignmentId: align.assignment_id,
    takeId: align.take_id,
    createdAt: align.take_created_at,
    wordCount: align.alignment_json?.words?.length,
  });

  // Pull the actual audio URL so the user can listen.
  const audioRows = (await sql`
    SELECT id, audio_url, created_at
      FROM narrator_takes
     WHERE id = ${align.take_id}::uuid
  `) as Array<{ id: string; audio_url: string | null; created_at: string }>;
  console.info('[diag-row1] audio metadata', audioRows[0]);

  // 4. Run alignRowsToWords with the doc's fallback timecodes
  const rowScripts = rows.map((r) => stripProductionMarkers((r.script_text as string) || ''));
  const fallbackStartMs = rows.map((r) => parseTimecodeToMs((r.timecode as string) || '0:00'));
  const fallbackTotalMs = parseTimecodeToMs(totalDuration) || fallbackStartMs[fallbackStartMs.length - 1] + 5000;

  const aligned = alignRowsToWords({
    rowScripts,
    fallbackStartMs,
    fallbackTotalMs,
    alignment: align.alignment_json!,
  });

  console.info('[diag-row1] aligned row 0:', aligned[0]);
  console.info('[diag-row1] aligned row 1:', aligned[1]);

  if (aligned[0]?.source === 'aligned') {
    const row0EndMs = aligned[0].endMs;
    const tailBufferMs = 400;
    const desiredRow1StartMs = row0EndMs + tailBufferMs;
    console.info('[diag-row1] ─── VERDICT ─────────────────────────────────');
    console.info(`[diag-row1] row 0 ("${rowScripts[0]}") actually ends at ${fmtMs(row0EndMs)} in the audio`);
    console.info(`[diag-row1] row 0 currently allocated [${fmtMs(fallbackStartMs[0])}, ${fmtMs(fallbackStartMs[1])}) = ${(fallbackStartMs[1] - fallbackStartMs[0])}ms`);
    console.info(`[diag-row1] with 400ms tail buffer, row 1 should start at ${fmtMs(desiredRow1StartMs)}`);
    console.info(`[diag-row1] current row 1 timecode is ${rows[1]?.timecode}; new value would be ${fmtMs(desiredRow1StartMs)}`);
  } else {
    console.info('[diag-row1] row 0 is ESTIMATED, not aligned. The aligner could not match row 0.');
  }

  // Also dump the first 10 words of the alignment so we can sanity-check
  const firstWords = align.alignment_json?.words?.slice(0, 12) || [];
  console.info('[diag-row1] first words in alignment:');
  for (const w of firstWords) {
    console.info(`  "${w.text}" [${w.start.toFixed(3)}s, ${w.end.toFixed(3)}s]`);
  }

  // ── NEW LOGIC VERIFICATION ──────────────────────────────────────────
  // Build a minimal VideoConfig the same way productionDocToVideoConfig
  // would, then call realignVideoConfig and report row 0/row 1 timings
  // with the new scene-timing rules applied.
  console.info('\n[diag-row1] ─── NEW LOGIC (realignVideoConfig) ────────────');
  const fps = 30;
  const totalMsFromDoc = parseTimecodeToMs(totalDuration);
  const synthShots: VideoShot[] = rows.map((r, i) => {
    const start = parseTimecodeToMs((r.timecode as string) || '0:00');
    const nextStart = i + 1 < rows.length
      ? parseTimecodeToMs((rows[i + 1].timecode as string) || '0:00')
      : totalMsFromDoc;
    return {
      startMs: start,
      durationMs: Math.max(nextStart - start, DEFAULT_MIN_SCENE_MS),
      sceneType: 'b-roll',
      scriptText: stripProductionMarkers((r.script_text as string) || ''),
    } as VideoShot;
  });
  const synthConfig: VideoConfig = {
    fps,
    width: 1920,
    height: 1080,
    shots: synthShots,
    brand: DEFAULT_BRAND_KIT,
    minSceneMs: DEFAULT_MIN_SCENE_MS,
    tailBufferMs: DEFAULT_TAIL_BUFFER_MS,
  };
  const realigned = realignVideoConfig(synthConfig, align.alignment_json!);
  console.info('[diag-row1] post-rules row 0:', realigned.config.shots[0]);
  console.info('[diag-row1] post-rules row 1:', realigned.config.shots[1]);
  console.info('[diag-row1] post-rules row 2:', realigned.config.shots[2]);
  const r0 = realigned.config.shots[0];
  const r1 = realigned.config.shots[1];
  if (r0 && r1) {
    console.info(
      `[diag-row1] verdict: row 0 plays [${fmtMs(r0.startMs)}, ${fmtMs(r0.startMs + r0.durationMs)}) ` +
        `→ ${(r0.durationMs / 1000).toFixed(3)}s on screen`,
    );
    console.info(
      `[diag-row1] verdict: row 1 visual cut at ${fmtMs(r1.startMs)} (was 0:01.000 estimated / 0:01.160 aligned)`,
    );
  }
}

main().catch((err) => {
  console.error('[diag-row1] failed:', err);
  process.exit(1);
});
