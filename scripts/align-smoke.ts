/**
 * End-to-end smoke test for the voiceover alignment pipeline.
 *
 * Usage:
 *   npm run smoke:align
 *
 * Inputs (env or .env.local — `tsx --env-file-if-exists=.env.local` is
 * already wired up by the npm script):
 *
 *   SMOKE_ALIGN_AUDIO_URL  Absolute http(s) URL to the voiceover audio
 *                          file. The same-origin proxy URL works (e.g.
 *                          http://localhost:3000/api/voiceovers/<uuid>/audio)
 *                          provided the dev server is up.
 *
 *   SMOKE_ALIGN_ROWS_FILE  Path to a JSON file shaped as
 *                            { rowScripts: string[], fps?: number,
 *                              fallbackStartMs?: number[],
 *                              fallbackTotalMs?: number }
 *                          rowScripts is required; the rest are derived
 *                          when omitted (0..N at 5-second intervals,
 *                          total = last+5s, fps=30).
 *
 *   FORCE_REFRESH=1        Skip the cache read and force a fresh
 *                          ElevenLabs call. Use after editing a script
 *                          to validate the new alignment matches what
 *                          you expect.
 *
 * Output: cache hit/miss, USD cost, audio duration, per-row aligned vs
 * estimated breakdown with the drift versus the estimated timecode,
 * and an aggregate ALIGNED/ESTIMATED count. A non-zero exit code
 * signals an outright failure (auth, DB, API key, network); per-row
 * fallbacks DO NOT fail the script — they're the design's safety
 * valve and reading the breakdown is the point.
 *
 * Phase 5 of `_plans/2026-05-13-voiceover-aligned-scene-timing.md`.
 */
import fs from 'fs';
import path from 'path';
import { ensureAlignmentForVoiceover } from '../src/lib/voiceover-alignment-cache';
import {
  alignRowsToWords,
  buildCanonicalScript,
  snapMsToFrame,
} from '../src/lib/voiceover-alignment';
import { stripProductionMarkers } from '../src/lib/script-markers';

interface RowsFile {
  rowScripts: string[];
  fps?: number;
  fallbackStartMs?: number[];
  fallbackTotalMs?: number;
}

function readEnv(name: string): string | null {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw : null;
}

function fatal(msg: string): never {
  process.stderr.write(`align-smoke: ${msg}\n`);
  process.exit(1);
}

function readRowsFile(filePath: string): RowsFile {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) fatal(`rows file does not exist: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fatal(`rows file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object') fatal('rows file root must be an object');
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.rowScripts) || obj.rowScripts.length === 0) {
    fatal('rows file must include a non-empty rowScripts array');
  }
  for (const s of obj.rowScripts) {
    if (typeof s !== 'string') fatal('rowScripts entries must be strings');
  }
  return {
    rowScripts: obj.rowScripts as string[],
    fps: typeof obj.fps === 'number' ? obj.fps : 30,
    fallbackStartMs: Array.isArray(obj.fallbackStartMs)
      ? (obj.fallbackStartMs as number[])
      : undefined,
    fallbackTotalMs: typeof obj.fallbackTotalMs === 'number' ? obj.fallbackTotalMs : undefined,
  };
}

function fmtMs(ms: number): string {
  const s = (ms / 1000).toFixed(3);
  return `${s.padStart(8)}s`;
}

function fmtFrame(ms: number, fps: number): string {
  return String(Math.round((ms / 1000) * fps)).padStart(5);
}

async function main() {
  const audioUrl = readEnv('SMOKE_ALIGN_AUDIO_URL');
  const rowsFile = readEnv('SMOKE_ALIGN_ROWS_FILE');
  const forceRefresh = readEnv('FORCE_REFRESH') === '1';

  if (!audioUrl) fatal('SMOKE_ALIGN_AUDIO_URL is required.');
  if (!rowsFile) fatal('SMOKE_ALIGN_ROWS_FILE is required.');
  if (!/^https?:\/\//.test(audioUrl)) fatal('SMOKE_ALIGN_AUDIO_URL must be an absolute http(s) URL.');

  const rows = readRowsFile(rowsFile);
  const fps = rows.fps ?? 30;

  // Default fallbacks: 5-second spacing per row, total = last + 5s. The
  // estimated-vs-aligned drift report uses these, so when the rows file
  // doesn't provide explicit numbers, the report compares against a
  // uniform baseline (less interesting but still runs the algorithm).
  const fallbackStartMs =
    rows.fallbackStartMs ?? rows.rowScripts.map((_, i) => i * 5000);
  const fallbackTotalMs =
    rows.fallbackTotalMs ?? fallbackStartMs[fallbackStartMs.length - 1] + 5000;

  // Build canonical script the same way `/api/voiceovers/align` does so
  // the cache key matches between this smoke script and the route.
  const stripped = rows.rowScripts.map((s) => stripProductionMarkers(s));
  const canonicalScript = buildCanonicalScript(stripped);
  if (!canonicalScript.trim()) fatal('Canonical script is empty after stripping production markers.');

  process.stdout.write('align-smoke: starting\n');
  process.stdout.write(`  audioUrl       : ${audioUrl}\n`);
  process.stdout.write(`  rowScripts     : ${rows.rowScripts.length}\n`);
  process.stdout.write(`  canonical chars: ${canonicalScript.length}\n`);
  process.stdout.write(`  fps            : ${fps}\n`);
  process.stdout.write(`  forceRefresh   : ${forceRefresh}\n\n`);

  const t0 = Date.now();
  const result = await ensureAlignmentForVoiceover(audioUrl, canonicalScript, { forceRefresh });
  const elapsedMs = Date.now() - t0;

  process.stdout.write(`cache key        : ${result.cacheKey}\n`);
  if (result.status === 'failed') {
    process.stdout.write(`status           : FAILED\n`);
    process.stdout.write(`reason           : ${result.reason}\n`);
    process.exit(1);
  }

  process.stdout.write(`status           : ready\n`);
  process.stdout.write(`cached           : ${result.cached ? 'HIT' : 'MISS'}\n`);
  process.stdout.write(`audio duration   : ${fmtMs(result.durationMs)}\n`);
  process.stdout.write(`cost USD         : $${result.cost.toFixed(4)}\n`);
  process.stdout.write(`elapsed          : ${elapsedMs}ms\n`);
  process.stdout.write(`aligner words    : ${result.alignment.words.length}\n\n`);

  // ── Row-level breakdown ────────────────────────────────────────────
  const aligned = alignRowsToWords({
    rowScripts: stripped,
    fallbackStartMs,
    fallbackTotalMs,
    alignment: result.alignment,
  });

  process.stdout.write('  idx | source    |   start (ms) | frame |     end (ms) | duration | drift vs estimated\n');
  process.stdout.write('  ----+-----------+--------------+-------+--------------+----------+--------------------\n');

  let alignedCount = 0;
  let estimatedCount = 0;
  let cumDriftMs = 0;
  for (const row of aligned) {
    const snappedStart = snapMsToFrame(row.startMs, fps);
    const snappedEnd = snapMsToFrame(row.endMs, fps);
    const duration = snappedEnd - snappedStart;
    const estStart = fallbackStartMs[row.rowIndex];
    const driftMs = snappedStart - estStart;
    if (row.source === 'aligned') {
      alignedCount++;
      cumDriftMs += Math.abs(driftMs);
    } else {
      estimatedCount++;
    }
    const driftStr =
      row.source === 'aligned'
        ? `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)} ms (${(driftMs / 1000).toFixed(2)}s)`
        : '—';
    process.stdout.write(
      `  ${String(row.rowIndex).padStart(3)} | ${row.source.padEnd(9)} | ${fmtMs(snappedStart)} | ${fmtFrame(snappedStart, fps)} | ${fmtMs(snappedEnd)} | ${String(duration.toFixed(0)).padStart(7)}ms | ${driftStr}\n`,
    );
  }

  const avgDriftMs = alignedCount > 0 ? cumDriftMs / alignedCount : 0;
  process.stdout.write('\n');
  process.stdout.write(`aligned rows     : ${alignedCount} / ${aligned.length}\n`);
  process.stdout.write(`estimated rows   : ${estimatedCount} / ${aligned.length}\n`);
  process.stdout.write(`avg |drift|      : ${avgDriftMs.toFixed(0)} ms (${(avgDriftMs / 1000).toFixed(2)}s) over aligned rows\n`);
  process.stdout.write(`frame budget     : ${(1000 / fps).toFixed(2)} ms @ ${fps}fps\n`);

  // Soft-warning if every row fell back. Common cause: the audio
  // doesn't actually match the script (wrong voiceover picked).
  if (alignedCount === 0) {
    process.stdout.write('\nWARNING: zero aligned rows. The audio likely does not match the script.\n');
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`align-smoke: failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
