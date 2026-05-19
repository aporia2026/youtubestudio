/**
 * Shared Bria RMBG client — extracted from `/api/overlay/fetch` so
 * the Phase 5 edit route can also re-run background removal on the
 * AI-edited overlay output. See
 * `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * Bria's RMBG-2.0 (`bria/remove-background` on Replicate) accepts a
 * public URL OR a base64 data URL in its `image` input field. We
 * support both: callers that already have the bytes in memory avoid
 * a network round-trip; callers that only have a URL pass it through.
 *
 * The `Prefer: wait=30` header tells Replicate to block the HTTP
 * response until the prediction finishes (up to 30 s) so we don't
 * need to poll. Bria typically completes in 1-2 s.
 */
import { logger } from './logger';
import { assertSafePublicUrl } from './url-safety';

const REPLICATE_RMBG_URL =
  'https://api.replicate.com/v1/models/bria/remove-background/predictions';

export interface RmbgInput {
  /** Image to RMBG. Either a public HTTPS URL or a base64 string —
   *  exactly one must be provided. Base64 takes precedence when both
   *  are set (a caller that has bytes shouldn't bounce them through
   *  R2 just to give Bria a URL). */
  imageUrl?: string;
  imageBytes?: Buffer;
  imageMimeType?: string;
  replicateToken: string;
}

/** Run Bria's background-removal model. Returns the cutout PNG bytes
 *  on success; throws on any failure (slug missing, auth, timeout,
 *  output URL fetch). Callers should wrap in try/catch when they want
 *  to fall back gracefully — the Phase 5 edit route does this so an
 *  RMBG hiccup doesn't block the user's accept on a finished edit. */
export async function removeBackground(input: RmbgInput): Promise<Buffer> {
  if (!input.replicateToken) {
    throw new Error('Replicate token is required for RMBG');
  }
  let imageField: string;
  if (input.imageBytes) {
    const mime = input.imageMimeType ?? 'image/png';
    imageField = `data:${mime};base64,${input.imageBytes.toString('base64')}`;
  } else if (input.imageUrl) {
    imageField = input.imageUrl;
  } else {
    throw new Error('RMBG requires either imageBytes or imageUrl');
  }

  const create = await fetch(REPLICATE_RMBG_URL, {
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
    // useful message — a 404 from a missing slug, a 403 from auth, a
    // 422 from input validation each become distinguishable. The
    // 400-char cap keeps log bodies sane.
    const body = await create.text().catch(() => '');
    const snippet = body.slice(0, 400);
    logger.warn('Replicate RMBG non-OK', { status: create.status, body: snippet });
    throw new Error(`Replicate RMBG failed (${create.status}): ${snippet || 'no body'}`);
  }
  const data = (await create.json()) as {
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (data.error) throw new Error(`Replicate RMBG: ${data.error}`);
  if (data.status && data.status !== 'succeeded') {
    throw new Error(`Replicate RMBG did not complete (status: ${data.status})`);
  }
  const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!outputUrl) throw new Error('Replicate RMBG returned no output URL');
  // SSRF guard on Replicate's response — we trust Replicate's infra,
  // but a tampered model fork could return an internal URL (AWS IMDS,
  // 192.168.x.x, .internal). `assertSafePublicUrl` blocks those.
  // String-only check (not DNS-pinned) is fine here because the
  // domain set Replicate emits is stable.
  try {
    assertSafePublicUrl(outputUrl, { allowedProtocols: ['https:'] });
  } catch (err) {
    throw new Error(
      `Replicate RMBG returned an unsafe URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const fetched = await fetch(outputUrl);
  if (!fetched.ok) throw new Error(`Failed to fetch RMBG output (${fetched.status})`);
  return Buffer.from(await fetched.arrayBuffer());
}
