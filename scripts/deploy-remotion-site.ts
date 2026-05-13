/**
 * CLI entrypoint for redeploying the Remotion site bundle to S3.
 *
 * Usage:
 *   npm run deploy:remotion
 *
 * Bundles `src/remotion/Root.tsx` and uploads the result into the
 * Remotion-managed S3 site under the fixed `siteName` 'youtubestudio-prod'.
 * Overwrite-in-place: the `serveUrl` returned is stable across deploys,
 * so already-running Lambda renderers don't need to be reconfigured.
 *
 * Run after any change to `src/remotion/**` or shared types reachable
 * from `Root.tsx` (most notably `src/remotion/types.ts`,
 * `src/lib/shorts-render-types.ts`).
 *
 * Reads from env:
 *   REMOTION_AWS_ACCESS_KEY_ID     — required (or AWS_ACCESS_KEY_ID)
 *   REMOTION_AWS_SECRET_ACCESS_KEY — required (or AWS_SECRET_ACCESS_KEY)
 *   REMOTION_LAMBDA_REGION         — optional, defaults to 'us-east-1'
 *
 * Phase 4 of `_plans/2026-05-13-lambda-render-migration.md`.
 */
import path from 'path';
import { deploySite, getOrCreateBucket } from '@remotion/lambda';
import type { AwsRegion } from '@remotion/lambda/client';
import { remotionWebpackOverride } from '../src/lib/remotion-bundler';

const SITE_NAME = 'youtubestudio-prod';
const DEFAULT_REGION: AwsRegion = 'us-east-1';

async function main() {
  const region = (process.env.REMOTION_LAMBDA_REGION?.trim() || DEFAULT_REGION) as AwsRegion;
  const entryPoint = path.join(process.cwd(), 'src', 'remotion', 'Root.tsx');

  process.stdout.write(`Resolving Remotion bucket in ${region}…\n`);
  const { bucketName, alreadyExisted } = await getOrCreateBucket({ region });
  process.stdout.write(
    `  ${alreadyExisted ? '·' : '+'} ${bucketName}${alreadyExisted ? '' : ' (created)'}\n`,
  );

  process.stdout.write(`Bundling ${path.relative(process.cwd(), entryPoint)} → ${SITE_NAME}…\n`);
  const lastBundlePct = { v: -1 };
  const lastUploadPct = { v: -1 };

  const { serveUrl, stats } = await deploySite({
    entryPoint,
    bucketName,
    region,
    siteName: SITE_NAME,
    options: {
      webpackOverride: remotionWebpackOverride,
      onBundleProgress: (p) => {
        const pct = Math.floor(p);
        if (pct !== lastBundlePct.v && pct % 10 === 0) {
          process.stdout.write(`  bundle ${pct}%\n`);
          lastBundlePct.v = pct;
        }
      },
      onUploadProgress: ({ totalSize, sizeUploaded }) => {
        const pct = totalSize > 0 ? Math.floor((sizeUploaded / totalSize) * 100) : 0;
        if (pct !== lastUploadPct.v && pct % 25 === 0) {
          process.stdout.write(`  upload ${pct}%\n`);
          lastUploadPct.v = pct;
        }
      },
    },
  });

  process.stdout.write(
    `Done. ${stats.uploadedFiles} uploaded, ${stats.untouchedFiles} unchanged, ${stats.deletedFiles} deleted.\n`,
  );
  process.stdout.write(`serveUrl: ${serveUrl}\n`);
}

main().catch((err) => {
  process.stderr.write(`Remotion site deploy failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.cause) {
    process.stderr.write(`Caused by: ${String(err.cause)}\n`);
  }
  process.exit(1);
});
