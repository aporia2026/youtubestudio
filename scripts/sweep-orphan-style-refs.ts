/**
 * R2 orphan sweeper for v2 style refs + test renders.
 *
 * Background: when a style row is deleted, the DB cascades to
 * style_reference_images and style_test_renders rows via FK
 * CASCADE (migration 0080). The R2 blob cleanup is best-effort
 * fire-and-forget from the API routes — a flaky PUT/DELETE can
 * leave orphan blobs behind. Same for test-render eviction past
 * the 6-cap.
 *
 * This script walks the R2 keys we own + queries the DB for
 * matching `r2_key` rows + identifies orphans (R2 has it, DB
 * doesn't). Older than the grace window → delete.
 *
 * Two prefixes covered in v1:
 *
 *   - `style-refs/<workspace_id>/<style_id>/*`
 *       → backed by `style_reference_images.r2_key`
 *   - `style-test-renders/<style_id>/*`
 *       → backed by `style_test_renders.r2_key`
 *
 * NOT covered yet:
 *
 *   - `prodoc-images-i2i/*` + `prodoc-images-i2i-local/*` →
 *     generated per-row images. These land in user_history.payload
 *     as URLs inside a JSONB blob, not in a queryable column.
 *     Sweeping requires walking every user_history row + parsing
 *     payloads for URL matches. Punted to v2; see
 *     `_plans/2026-05-22-v2-styles-onboarding.md`.
 *
 * Defaults to DRY-RUN. Pass `--delete` to actually remove orphans.
 * Pass `--grace-days=N` to override the 30-day grace window.
 *
 * Usage:
 *   npm run sweep:r2                            # dry-run, 30-day grace
 *   npm run sweep:r2 -- --delete                # actually delete
 *   npm run sweep:r2 -- --grace-days=7 --delete # tighter grace
 *
 * Output: per-prefix counts of total / matched / orphan / deleted /
 * skipped-within-grace, plus a sample of orphan keys for spot-checking.
 */
import { sql } from '@vercel/postgres';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

interface SweepArgs {
  dryRun: boolean;
  graceDays: number;
}

function parseArgs(argv: readonly string[]): SweepArgs {
  let dryRun = true;
  let graceDays = 30;
  for (const a of argv) {
    if (a === '--delete') dryRun = false;
    else if (a.startsWith('--grace-days=')) {
      const n = Number.parseInt(a.split('=')[1] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) graceDays = n;
    }
  }
  return { dryRun, graceDays };
}

function getR2Client(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in env');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

interface R2Object {
  key: string;
  lastModified: Date;
}

/** List every object under a given prefix in the bucket, paging until
 *  the listing terminates. Yields `{ key, lastModified }` tuples. */
async function listAll(client: S3Client, bucket: string, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let continuationToken: string | undefined;
  let page = 0;
  do {
    page++;
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.LastModified) {
        out.push({ key: obj.Key, lastModified: obj.LastModified });
      }
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    process.stdout.write(`\r  listing ${prefix}* — page ${page}, ${out.length} keys so far`);
  } while (continuationToken);
  process.stdout.write('\n');
  return out;
}

/** Query the DB for which r2_keys are still referenced in a given
 *  table. Batches via `ANY($1::text[])` so we don't fire one query
 *  per key. */
async function queryKnownKeys(table: 'style_reference_images' | 'style_test_renders', keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  // Postgres handles ~32k params per array comfortably; chunk to be safe.
  const known = new Set<string>();
  const CHUNK = 10_000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const { rows } = await sql.query<{ r2_key: string }>(
      `SELECT r2_key FROM ${table} WHERE r2_key = ANY($1::text[])`,
      [slice],
    );
    for (const r of rows) known.add(r.r2_key);
  }
  return known;
}

interface PrefixResult {
  prefix: string;
  total: number;
  matched: number;
  orphanWithinGrace: number;
  orphanToDelete: number;
  deleted: number;
  deleteFailed: number;
  sampleOrphans: string[];
}

async function sweepPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  table: 'style_reference_images' | 'style_test_renders',
  args: SweepArgs,
): Promise<PrefixResult> {
  console.log(`\n── ${prefix} (table: ${table}) ──`);
  const objects = await listAll(client, bucket, prefix);
  const known = await queryKnownKeys(table, objects.map((o) => o.key));

  const graceCutoff = Date.now() - args.graceDays * 24 * 60 * 60 * 1000;
  const sample: string[] = [];
  let matched = 0;
  let orphanWithinGrace = 0;
  const toDelete: R2Object[] = [];
  for (const obj of objects) {
    if (known.has(obj.key)) {
      matched++;
      continue;
    }
    if (obj.lastModified.getTime() > graceCutoff) {
      orphanWithinGrace++;
      continue;
    }
    toDelete.push(obj);
    if (sample.length < 5) sample.push(obj.key);
  }

  let deleted = 0;
  let deleteFailed = 0;
  if (!args.dryRun && toDelete.length > 0) {
    console.log(`  deleting ${toDelete.length} orphan(s)…`);
    for (const obj of toDelete) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.key }));
        deleted++;
      } catch (err) {
        deleteFailed++;
        console.warn(`    failed: ${obj.key} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    prefix,
    total: objects.length,
    matched,
    orphanWithinGrace,
    orphanToDelete: toDelete.length,
    deleted,
    deleteFailed,
    sampleOrphans: sample,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bucket = process.env.R2_IMAGES_BUCKET_NAME || 'images';

  console.log('R2 orphan sweeper');
  console.log(`  bucket: ${bucket}`);
  console.log(`  mode: ${args.dryRun ? 'DRY-RUN (pass --delete to actually delete)' : 'DELETE'}`);
  console.log(`  grace window: ${args.graceDays} day(s)`);

  const client = getR2Client();

  const results: PrefixResult[] = [];
  results.push(await sweepPrefix(client, bucket, 'style-refs/', 'style_reference_images', args));
  results.push(await sweepPrefix(client, bucket, 'style-test-renders/', 'style_test_renders', args));

  console.log('\n── Summary ──');
  for (const r of results) {
    console.log(`  ${r.prefix}`);
    console.log(`    total in R2:           ${r.total}`);
    console.log(`    matched in DB:         ${r.matched}`);
    console.log(`    orphan (within grace): ${r.orphanWithinGrace}`);
    console.log(`    orphan (to delete):    ${r.orphanToDelete}`);
    if (!args.dryRun) {
      console.log(`    deleted:               ${r.deleted}`);
      console.log(`    delete failed:         ${r.deleteFailed}`);
    }
    if (r.sampleOrphans.length > 0) {
      console.log(`    sample orphan keys:`);
      for (const k of r.sampleOrphans) console.log(`      - ${k}`);
    }
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Sweeper failed:', err);
  process.exit(1);
});
