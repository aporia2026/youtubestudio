/**
 * R2 helpers for channel-clone templates (Plan 2).
 *
 * Templates own copies of every reference video the operator
 * snapshots, so a template survives the source job being deleted.
 * This module wraps the three R2 operations the templates flow needs:
 *
 *   - `copyR2KeysIntoTemplate` — server-side R2 CopyObject from a
 *     source prefix (typically the upload-staging prefix written by
 *     intake-upload-runner) into the per-template prefix
 *     `channel-clone-templates/<wsId>/<tplId>/`.
 *   - `mintTemplateDownloadUrls` — presigned GET URLs for each key
 *     so the load-from-template flow can hand them straight to the
 *     intake-upload route as already-uploaded video sources.
 *   - `deleteTemplateR2Keys` — best-effort batch delete walked from
 *     the template's `r2_keys[]` manifest. Partial failures swallow
 *     individually so a single 404 doesn't strand the rest.
 *
 * Bytes never transit through Vercel — CopyObject runs entirely on
 * R2's side. See plan
 * `_plans/2026-06-07-channel-clone-preset-templates.md`.
 */

import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { logger } from '@/lib/logger';
import { getDownloadUrlForBucket, getReviewBucket } from '@/lib/r2';

let _r2Client: S3Client | null = null;
function getR2Client(): S3Client {
  if (_r2Client) return _r2Client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  _r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Match the rest of the repo: opt out of mandatory checksums so
    // CopyObject doesn't trip R2's stricter header rules.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return _r2Client;
}

export interface R2CopyInput {
  /** Source R2 keys to copy. Order is preserved in the result. */
  sourceKeys: string[];
  /** Destination prefix WITHOUT the trailing slash. Templates use
   *  `channel-clone-templates/<wsId>/<tplId>`; the intake-upload
   *  runner's staging step uses
   *  `channel-clone-uploads-staging/<wsId>/<jobId>`. */
  destPrefix: string;
  /** Bucket name. Defaults to the review bucket since that's where
   *  channel-clone uploads live. */
  bucket?: string;
}

export interface R2CopyResult {
  /** Map sourceKey → newKey under the destination prefix. Sized to
   *  sourceKeys.length when every copy succeeded. Failed copies are
   *  omitted so the caller can decide whether to roll back. */
  copiedKeys: { sourceKey: string; destKey: string; bytes: number }[];
  /** Indices of sourceKeys that failed to copy — for diagnostics. */
  failedIndices: number[];
}

/** Copy a set of R2 objects to a destination prefix. Returns the new
 *  keys + their per-object bytes. The destination filename is the
 *  source index zero-padded, with the source key's extension
 *  preserved so ffmpeg / other downstream tools still recognise the
 *  container. */
export async function copyR2KeysToPrefix(input: R2CopyInput): Promise<R2CopyResult> {
  const bucket = input.bucket ?? getReviewBucket();
  const client = getR2Client();
  const copiedKeys: R2CopyResult['copiedKeys'] = [];
  const failedIndices: number[] = [];
  const cleanPrefix = input.destPrefix.replace(/\/+$/, '');

  for (const [i, sourceKey] of input.sourceKeys.entries()) {
    const ext = inferExtensionFromKey(sourceKey) ?? 'bin';
    const destKey = `${cleanPrefix}/${String(i).padStart(3, '0')}.${ext}`;

    try {
      // R2 server-side CopyObject. CopySource uses the
      // `{bucket}/{key}` form, URL-encoded so keys with `/` survive
      // intact (S3 spec allows raw slashes; URL encoding is belt-and-
      // braces for clients that double-encode).
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `/${bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
          Key: destKey,
        }),
      );
      // Probe size — best-effort. We never gate on it (the copy itself
      // already succeeded), but we surface bytes per object so the
      // template's `bytes` column reflects reality.
      let bytes = 0;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: destKey }));
        bytes = Number(head.ContentLength ?? 0);
      } catch {
        // Head can fail intermittently right after a copy; if so,
        // skip the size — bytes stays 0 and shows as "size unknown"
        // in the UI rather than a false 0 KB claim.
      }
      copiedKeys.push({ sourceKey, destKey, bytes });
      logger.info('[channel-clone templates r2] copy ok', {
        sourceKey, destKey, bytes,
      });
    } catch (err) {
      failedIndices.push(i);
      logger.warn('[channel-clone templates r2] copy failed', {
        sourceKey, destKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { copiedKeys, failedIndices };
}

/** Mint presigned GET URLs for a template's keys. Used by the load
 *  flow which hands these URLs to the intake-upload runner as
 *  already-staged video sources. */
export async function mintTemplateDownloadUrls(r2Keys: string[]): Promise<{ r2Key: string; url: string }[]> {
  const bucket = getReviewBucket();
  const out: { r2Key: string; url: string }[] = [];
  for (const key of r2Keys) {
    const url = await getDownloadUrlForBucket(bucket, key);
    out.push({ r2Key: key, url });
  }
  return out;
}

/** Per-key existence probe via HeadObject. Used by the "reuse a
 *  previous run's inputs" path to verify each staged video is still
 *  present in R2 (the staging prefix has a 7-day lifecycle so old
 *  jobs' assets eventually disappear). Returns a parallel array so
 *  the caller can decide between full-reuse, partial-reuse, or
 *  surface-clear-error. */
export async function checkR2KeysExist(r2Keys: string[]): Promise<{ r2Key: string; exists: boolean }[]> {
  const bucket = getReviewBucket();
  const client = getR2Client();
  const out: { r2Key: string; exists: boolean }[] = [];
  for (const key of r2Keys) {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      out.push({ r2Key: key, exists: true });
    } catch {
      // 404 / NotFound / network error — treat as "does not exist".
      // The caller surfaces a "videos expired" message when too many
      // misses pile up.
      out.push({ r2Key: key, exists: false });
    }
  }
  return out;
}

/** Best-effort batch delete. Errors are swallowed individually so a
 *  single 404 doesn't strand the rest of the manifest. */
export async function deleteTemplateR2Keys(r2Keys: string[]): Promise<{ deleted: number; failed: number }> {
  const bucket = getReviewBucket();
  const client = getR2Client();
  let deleted = 0;
  let failed = 0;
  for (const key of r2Keys) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      deleted += 1;
    } catch (err) {
      failed += 1;
      logger.warn('[channel-clone templates r2] delete failed', {
        r2Key: key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('[channel-clone templates r2] batch delete done', {
    totalKeys: r2Keys.length, deleted, failed,
  });
  return { deleted, failed };
}

/** Extract the lowercased extension from a key (e.g. "abc/123.MP4"
 *  → "mp4"). Exported for unit tests. */
export function inferExtensionFromKey(r2Key: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(r2Key);
  return m ? m[1].toLowerCase() : null;
}
