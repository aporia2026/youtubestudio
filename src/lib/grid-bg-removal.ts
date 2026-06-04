/**
 * Background-removal client for the topic-card grid's `cutout` fill style.
 * Sibling to `src/lib/overlay-rmbg.ts` — same shape, different upstream:
 *   - `overlay-rmbg.ts` uses Bria RMBG-2.0 (~$0.058/image, premium quality)
 *     for the production-doc overlay path where edge quality on hair and
 *     fur shows in the final video.
 *   - This module uses `851-labs/background-remover` (~$0.00044/image, ~130×
 *     cheaper) for the topic-card grid where the cutouts render as
 *     200-300px avatars on the YouTube thumbnail. Quality delta is invisible
 *     at that size; cost delta is real (~$0.50/month vs ~$70/month at
 *     100 grids).
 *
 * The `Prefer: wait=30` header tells Replicate to block the HTTP response
 * until the prediction finishes (up to 30 s), so we don't need to poll.
 * The 851-labs model typically completes in ~2 s on T4.
 *
 * Plan: `_plans/2026-06-04-topic-card-grid-circle-parity.md`.
 */
import { logger } from './logger';
import { assertSafePublicUrl } from './url-safety';

const REPLICATE_GRID_RMBG_URL =
  'https://api.replicate.com/v1/models/851-labs/background-remover/predictions';

export interface GridRmbgInput {
  /** Image to RMBG. Either a public HTTPS URL or in-memory bytes —
   *  exactly one must be provided. Bytes take precedence when both are
   *  set (a caller that already has bytes shouldn't round-trip through
   *  R2 just to give Replicate a URL). */
  imageUrl?: string;
  imageBytes?: Buffer;
  imageMimeType?: string;
  replicateToken: string;
}

/**
 * Run the 851-labs/background-remover model. Returns the cutout PNG
 * bytes on success; throws on any failure (auth, timeout, output URL
 * fetch, unsafe response URL). Callers should wrap in try/catch when
 * they want to fall back gracefully so an RMBG hiccup doesn't block
 * the user accepting an uploaded image.
 */
export async function removeGridBackground(input: GridRmbgInput): Promise<Buffer> {
  if (!input.replicateToken) {
    throw new Error('Replicate token is required for grid RMBG');
  }
  let imageField: string;
  if (input.imageBytes) {
    const mime = input.imageMimeType ?? 'image/png';
    imageField = `data:${mime};base64,${input.imageBytes.toString('base64')}`;
  } else if (input.imageUrl) {
    imageField = input.imageUrl;
  } else {
    throw new Error('Grid RMBG requires either imageBytes or imageUrl');
  }

  const create = await fetch(REPLICATE_GRID_RMBG_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${input.replicateToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=30',
    },
    body: JSON.stringify({ input: { image: imageField } }),
  });
  if (!create.ok) {
    // Capture Replicate's actual error body so the caller surfaces a
    // useful message. The 400-char cap keeps log bodies sane.
    const body = await create.text().catch(() => '');
    const snippet = body.slice(0, 400);
    logger.warn('Replicate grid RMBG non-OK', { status: create.status, body: snippet });
    throw new Error(`Replicate grid RMBG failed (${create.status}): ${snippet || 'no body'}`);
  }
  const data = (await create.json()) as {
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (data.error) throw new Error(`Replicate grid RMBG: ${data.error}`);
  if (data.status && data.status !== 'succeeded') {
    throw new Error(`Replicate grid RMBG did not complete (status: ${data.status})`);
  }
  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!outputUrl) throw new Error('Replicate grid RMBG returned no output URL');
  // SSRF guard on Replicate's response — same posture as overlay-rmbg.ts.
  // A tampered model fork could return an internal URL (AWS IMDS,
  // 192.168.x.x, .internal); `assertSafePublicUrl` blocks those. String-only
  // (not DNS-pinned) is fine because Replicate's emitted domain set is stable.
  try {
    assertSafePublicUrl(outputUrl, { allowedProtocols: ['https:'] });
  } catch (err) {
    throw new Error(
      `Replicate grid RMBG returned an unsafe URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const fetched = await fetch(outputUrl);
  if (!fetched.ok) throw new Error(`Failed to fetch grid RMBG output (${fetched.status})`);
  return Buffer.from(await fetched.arrayBuffer());
}
