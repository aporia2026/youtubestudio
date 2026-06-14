/**
 * One-shot cleanup for `render_jobs` rows that are stuck at
 * `status='rendering'` long after the Lambda render would have finished.
 *
 * Why this exists: the GET-poll cron at
 * `src/app/api/cron/run-shorts-assets/route.ts` is responsible for
 * transitioning rows out of `rendering`, but two failure modes leak
 * rows permanently:
 *   1. `pollPendingShortRenders` uses `DISTINCT ON (short_id)`, so when
 *      a short retried and now has multiple `rendering` rows, only the
 *      newest is ever polled.
 *   2. After Lambda's S3 progress file expires (~hours), `pollLambdaProgress`
 *      either throws or returns stale 0.03 forever — the row never
 *      transitions.
 *
 * Either way, those rows pile up against
 * LAMBDA_MAX_CONCURRENT_RENDERS (default 5), and new renders get a
 * 429 from the preflight at `src/lib/remotion-lambda-quotas.ts`.
 *
 * This script:
 *   - Picks any row with `status='rendering'`, non-null `lambda_render_id`,
 *     and `started_at` older than `--min-age-minutes` (default 30).
 *   - Flips it to `status='error'` with a descriptive message + sets
 *     `finished_at`.
 *   - For rows whose `short_id` is non-null and whose linked short still
 *     shows `phase='rendering'`, clears that phase to surface the error
 *     in the UI (mirrors the cron's fatal-error transition).
 *
 * Idempotent: re-running flips nothing new because each pass leaves
 * `status='error'`.
 *
 * Usage:
 *   npx tsx scripts/reap-stuck-renders.ts            # 30 min default
 *   npx tsx scripts/reap-stuck-renders.ts --min-age-minutes 60
 *   npx tsx scripts/reap-stuck-renders.ts --dry-run  # show, don't write
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
import { sql } from '@vercel/postgres';

function parseArgs() {
  const args = process.argv.slice(2);
  let minAgeMinutes = 30;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--min-age-minutes' && args[i + 1]) {
      minAgeMinutes = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }
  if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 5) {
    throw new Error(`--min-age-minutes must be ≥ 5 (got ${minAgeMinutes}) — guardrail against killing live renders`);
  }
  return { minAgeMinutes, dryRun };
}

async function main() {
  const { minAgeMinutes, dryRun } = parseArgs();
  const cutoffMs = Date.now() - minAgeMinutes * 60 * 1000;
  const reason = `Reaped by scripts/reap-stuck-renders.ts at ${new Date().toISOString()}: row was 'rendering' for >${minAgeMinutes} min with no transition. Likely Lambda finished without the cron picking up the result (common after the progress S3 file expires).`;

  const { rows } = await sql<any>`
    SELECT id, short_id, workspace_id, lambda_render_id, started_at,
           ((extract(epoch from now()) * 1000 - started_at) / 1000)::int AS age_seconds
      FROM render_jobs
     WHERE status = 'rendering'
       AND lambda_render_id IS NOT NULL
       AND started_at < ${cutoffMs}
     ORDER BY started_at DESC
  `;

  console.log(`Found ${rows.length} stuck render(s) older than ${minAgeMinutes} min${dryRun ? ' (DRY RUN — no writes)' : ''}`);
  for (const r of rows) {
    console.log(`  ${r.id}  short=${r.short_id}  age=${r.age_seconds}s  lambda=${r.lambda_render_id}`);
  }
  if (dryRun || rows.length === 0) return;

  let updatedJobs = 0;
  let clearedShorts = 0;
  for (const r of rows) {
    const upd = await sql`
      UPDATE render_jobs
         SET status = 'error',
             error = ${reason},
             finished_at = ${Date.now()}
       WHERE id = ${r.id} AND status = 'rendering'
    `;
    if (upd.rowCount && upd.rowCount > 0) updatedJobs += 1;

    if (r.short_id && r.workspace_id) {
      const errorMessage = `Render was stuck in flight for >${minAgeMinutes} min and was reaped. Retry to start a fresh render.`;
      const updatedAt = new Date().toISOString();
      // Explicit ::text casts on every interpolated param so Neon's
      // serverless driver doesn't fall back to "could not determine
      // data type of parameter $N" — jsonb_build_object's `any` accepts
      // anything, but the wire-level type inference still needs a hint.
      const cleared = await sql`
        UPDATE shorts
           SET generation_progress = jsonb_set(
                 COALESCE(generation_progress, '{}'::jsonb),
                 '{phase}', '"error"'::jsonb
               ) || jsonb_build_object(
                 'label', 'Render timed out',
                 'error_message', ${errorMessage}::text,
                 'updated_at', ${updatedAt}::text
               ),
               updated_at = NOW()
         WHERE id = ${r.short_id}::uuid
           AND workspace_id = ${r.workspace_id}::uuid
           AND generation_progress->>'phase' = 'rendering'
      `;
      if (cleared.rowCount && cleared.rowCount > 0) clearedShorts += 1;
    }
  }
  console.log(`Updated ${updatedJobs} render_jobs rows + cleared ${clearedShorts} shorts back from phase='rendering'.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
