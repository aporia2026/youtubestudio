import 'dotenv/config';
import { sql } from '@vercel/postgres';
import { pollLambdaProgress } from '../src/lib/remotion-lambda';

/**
 * Query Lambda directly for each stuck render_job, update the DB with
 * the actual current state, and (if done) write the output URL back
 * onto the shorts row.
 *
 * Diagnoses a real architectural gap: the bulk batch UI polls batch
 * state but never the per-render Lambda status. Renders may have
 * actually completed on Lambda while the DB stays stale.
 */
(async () => {
  const batchId = process.argv[2] || '41808d2a-47f1-4a97-a01c-852e17ffb02c';

  const { rows: shorts } = await sql<{ id: string }>`
    SELECT id FROM shorts WHERE batch_id = ${batchId}::uuid
  `;

  // Latest in-flight render_job per short. @vercel/postgres tagged
  // template doesn't accept array params; use sql.query with the
  // ANY pattern instead.
  const shortIdList = shorts.map(s => s.id);
  const result = await sql.query<any>(
    `SELECT DISTINCT ON (short_id) id, short_id, lambda_render_id, lambda_bucket, status, progress, title
       FROM render_jobs
      WHERE short_id = ANY($1::text[])
        AND status NOT IN ('done', 'error')
        AND lambda_render_id IS NOT NULL
      ORDER BY short_id, started_at DESC`,
    [shortIdList],
  );
  const jobs = result.rows;
  console.log('stuck render_jobs:', jobs.length);

  for (const job of jobs) {
    console.log('\n---', job.id, '(', job.title, ')');
    try {
      const snap = await pollLambdaProgress({
        lambdaRenderId: job.lambda_render_id,
        bucketName: job.lambda_bucket,
      });
      console.log('  lambda says: progress=', snap.overallProgress, 'done=', snap.done, 'fatalError=', snap.fatalError, 'outputFile=', snap.outputFile?.slice(-60));

      if (snap.fatalError) {
        await sql`
          UPDATE render_jobs SET status = 'error', error = ${snap.fatalError},
                 finished_at = ${Date.now()}, progress = ${snap.overallProgress}
           WHERE id = ${job.id}
        `;
        console.log('  → marked job error');
      } else if (snap.done && snap.outputFile) {
        await sql`
          UPDATE render_jobs SET status = 'done', progress = 1,
                 output_url = ${snap.outputFile}, finished_at = ${Date.now()}
           WHERE id = ${job.id}
        `;
        await sql`
          UPDATE shorts SET rendered_video_url = ${snap.outputFile}, updated_at = NOW()
           WHERE id = ${job.short_id}::uuid
        `;
        console.log('  → marked job done + wrote rendered_video_url onto shorts');
      } else {
        await sql`UPDATE render_jobs SET progress = ${snap.overallProgress} WHERE id = ${job.id}`;
        console.log('  → still rendering, progress updated');
      }
    } catch (err: any) {
      console.log('  POLL FAILED:', err.message?.slice(0, 200));
    }
  }
  process.exit(0);
})();
