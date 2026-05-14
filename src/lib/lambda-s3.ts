import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * AWS S3 helpers for Remotion Lambda render outputs.
 *
 * Companion to `r2.ts` — same shape, different bucket / different cloud.
 * Remotion Lambda writes finished renders to a per-region S3 bucket
 * named `remotionlambda-<region-stripped>-<random>`. To serve those bytes
 * as a forced-download attachment without routing through our Vercel
 * function (which would hit the 300s `maxDuration` cap), we mint a
 * presigned GET URL with `response-content-disposition` baked into the
 * signature and let the browser fetch direct from S3.
 *
 * Trust boundary: this helper uses the same AWS creds that
 * `kickOffLambdaRender` already uses (`REMOTION_AWS_*`, falling back to
 * `AWS_*`). The URL allowlist regex below is the SAME shape as
 * `/api/download-proxy`'s allowlist — only `remotionlambda-*` buckets
 * pass, so a forged `outputFile` cannot make us presign access to an
 * arbitrary S3 object under our creds.
 */

// Bucket shape: `remotionlambda-<region-no-dashes>-<random>` (matches the
// allowlist in `/api/download-proxy/route.ts`). Keep these in sync — they
// are the security boundary that stops a malformed `output_url` from
// being used to mint signed access to an arbitrary S3 object under our
// credentials.
/** Remotion Lambda virtual-hosted URL: `<bucket>.s3.<region>.amazonaws.com/<key>`. */
const VHOST_RE = /^(remotionlambda-[a-z0-9]+-[a-z0-9]+)\.s3\.([a-z0-9-]+)\.amazonaws\.com$/;
/** Remotion Lambda path-style URL: `s3.<region>.amazonaws.com/<bucket>/<key>`. */
const PATH_HOST_RE = /^s3\.([a-z0-9-]+)\.amazonaws\.com$/;
/** Sanity check: only buckets matching the Remotion-Lambda naming shape. */
const LAMBDA_BUCKET_RE = /^remotionlambda-[a-z0-9]+-[a-z0-9]+$/;

export interface ParsedLambdaOutput {
  bucket: string;
  region: string;
  key: string;
}

/** Parse a Remotion Lambda output URL into bucket/region/key. Returns
 *  null if the URL doesn't match either S3 URL style or the bucket name
 *  doesn't have the `remotionlambda-` prefix. */
export function parseLambdaOutputUrl(url: string): ParsedLambdaOutput | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase();
  const vhost = host.match(VHOST_RE);
  if (vhost) {
    const bucket = vhost[1];
    const region = vhost[2];
    const key = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!key) return null;
    return { bucket, region, key };
  }
  const pathHost = host.match(PATH_HOST_RE);
  if (pathHost) {
    const region = pathHost[1];
    const parts = u.pathname.replace(/^\//, '').split('/');
    const bucket = parts.shift();
    if (!bucket || !LAMBDA_BUCKET_RE.test(bucket)) return null;
    const key = decodeURIComponent(parts.join('/'));
    if (!key) return null;
    return { bucket, region, key };
  }
  return null;
}

const _clients = new Map<string, S3Client>();

function getS3Client(region: string): S3Client {
  const cached = _clients.get(region);
  if (cached) return cached;
  const accessKeyId =
    process.env.REMOTION_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.REMOTION_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing AWS credentials (REMOTION_AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY ' +
        'or AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY) — required to presign Lambda output URLs.',
    );
  }
  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  _clients.set(region, client);
  return client;
}

/** Build the `Content-Disposition: attachment` value per RFC 5987.
 *  Kept local to avoid a cross-file dependency on r2.ts — the two helpers
 *  produce the same value, but they belong to different clouds. */
function buildAttachmentDisposition(filename: string): string {
  const safeAscii =
    filename
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 200) || 'download';
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

/** Mint a 24h presigned GET URL for a Remotion Lambda output, with the
 *  given filename baked into a signed `response-content-disposition`
 *  override. Returns null if the URL doesn't parse as a Lambda S3 URL —
 *  caller should fall through (no download link rendered). */
export async function getLambdaOutputDownloadUrl(
  outputUrl: string,
  filename: string,
): Promise<string | null> {
  const parsed = parseLambdaOutputUrl(outputUrl);
  if (!parsed) return null;
  const client = getS3Client(parsed.region);
  const command = new GetObjectCommand({
    Bucket: parsed.bucket,
    Key: parsed.key,
    ResponseContentDisposition: buildAttachmentDisposition(filename),
  });
  return getSignedUrl(client, command, { expiresIn: 60 * 60 * 24 });
}
