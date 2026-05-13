/**
 * End-to-end smoke test for the Lambda render backend.
 *
 * Usage:
 *   npm run smoke:lambda
 *
 * Kicks off a 1.5-second `YouTubeVideo` render on Lambda, polls until
 * complete, prints the output URL + accrued cost. Validates that the
 * full kickoff → poll → S3 round-trip works without going through the
 * UI or the API route.
 *
 * Cost: approximately $0.001-0.003 per run (very small composition,
 * single Lambda invocation, ~50 KB of MP4 storage).
 *
 * Phase 6 of `_plans/2026-05-13-lambda-render-migration.md`.
 */
import { kickOffLambdaRender, pollLambdaProgress } from '../src/lib/remotion-lambda';
import { DEFAULT_BRAND_KIT, type VideoConfig } from '../src/remotion/types';

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 5 * 60 * 1000; // 5-minute ceiling

const SMOKE_CONFIG: VideoConfig = {
  fps: 30,
  width: 1280,
  height: 720,
  brand: DEFAULT_BRAND_KIT,
  showCaptions: false,
  shots: [
    {
      startMs: 0,
      durationMs: 1500,
      sceneType: 'outro',
      backgroundColor: '#FFFFFF',
    },
  ],
};

function fmtElapsed(startedAt: number): string {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return `${seconds}s`;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  process.stdout.write('Kicking off Lambda render of a 1.5-second smoke composition…\n');

  const startedAt = Date.now();
  const { lambdaRenderId, bucketName } = await kickOffLambdaRender({
    compositionId: 'YouTubeVideo',
    inputProps: { config: SMOKE_CONFIG },
    codec: 'h264',
  });

  process.stdout.write(`  renderId : ${lambdaRenderId}\n`);
  process.stdout.write(`  bucket   : ${bucketName}\n`);
  process.stdout.write('Polling progress…\n');

  let lastReportedPct = -1;
  for (;;) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      throw new Error(`Smoke render timed out after ${TIMEOUT_MS / 1000}s.`);
    }

    const snap = await pollLambdaProgress({ lambdaRenderId, bucketName });
    const pct = Math.floor(snap.overallProgress * 100);
    if (pct !== lastReportedPct && (pct % 10 === 0 || snap.done)) {
      process.stdout.write(
        `  ${pct.toString().padStart(3)}%  cost so far $${snap.costAccrued.toFixed(4)}  ` +
          `[${fmtElapsed(startedAt)}]\n`,
      );
      lastReportedPct = pct;
    }

    if (snap.fatalError) {
      throw new Error(`Lambda reported a fatal error: ${snap.fatalError}`);
    }
    if (snap.done) {
      if (!snap.outputFile) {
        throw new Error('Render marked done but no outputFile present in response.');
      }
      process.stdout.write('\nSmoke render OK.\n');
      process.stdout.write(`  total time : ${fmtElapsed(startedAt)}\n`);
      process.stdout.write(`  total cost : $${snap.costAccrued.toFixed(4)}\n`);
      process.stdout.write(`  outputFile : ${snap.outputFile}\n`);
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main().catch((err) => {
  process.stderr.write(`Lambda smoke test failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.cause) {
    process.stderr.write(`Caused by: ${String(err.cause)}\n`);
  }
  process.exit(1);
});
