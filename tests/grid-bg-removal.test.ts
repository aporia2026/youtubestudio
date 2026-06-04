import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeGridBackground } from '@/lib/grid-bg-removal';

// `removeGridBackground` is a thin Replicate wrapper sibling to
// `overlay-rmbg.ts`, hitting the cheaper 851-labs/background-remover model.
// The three behaviours we pin:
//
//   1. Happy path  — POST shape, auth header, output URL re-fetch.
//   2. SSRF guard  — a tampered model returning an internal URL is
//      rejected before its bytes ever reach the caller.
//   3. Error paths — non-OK status, error in response body, unsafe URL,
//      missing token all throw with a recognisable message so the route
//      can surface it to the user.
//
// `vi.stubGlobal('fetch', mock)` is the same pattern `atlas-cloud-images`
// uses for its Replicate-sibling code. We never need fake timers here —
// the wrapper uses `Prefer: wait=30` and gets a synchronous response,
// no poll loop to drain.

const REPLICATE_URL = 'https://api.replicate.com/v1/models/851-labs/background-remover/predictions';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Builds a fetch mock that scripts a sequence of responses. Mirrors the
 *  pattern in `tests/atlas-cloud-images.test.ts` so the assertions read
 *  the same across Replicate-style helpers. */
function scriptedFetch(scripted: Array<Response | (() => Response)>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    if (i >= scripted.length) {
      throw new Error(`scriptedFetch: ran out of scripted responses at call ${i + 1} for ${String(url)}`);
    }
    const next = scripted[i++];
    return typeof next === 'function' ? next() : next;
  });
  return { mock, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function pngBytesResponse(bytes: Buffer): Response {
  // Wrap the buffer as a Uint8Array so Response's BodyInit accepts it
  // identically to what global fetch's Response would produce for a
  // binary download.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('removeGridBackground — happy path', () => {
  it('POSTs the image URL with bearer auth + Prefer: wait=30, then refetches the output PNG', async () => {
    const cutoutBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const { mock, calls } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/abc/out.png' }),
      pngBytesResponse(cutoutBytes),
    ]);
    vi.stubGlobal('fetch', mock);

    const result = await removeGridBackground({
      imageUrl: 'https://example.com/in.jpg',
      replicateToken: 'test-replicate-key',
    });

    // Returns the bytes from the output URL verbatim — proves the
    // re-fetch step actually ran (not just the prediction response).
    expect(Buffer.compare(result, cutoutBytes)).toBe(0);

    // Step 1 — predictions endpoint.
    expect(calls[0].url).toBe(REPLICATE_URL);
    expect(calls[0].init?.method).toBe('POST');
    const headers0 = calls[0].init?.headers as Record<string, string>;
    expect(headers0.Authorization).toBe('Token test-replicate-key');
    expect(headers0.Prefer).toBe('wait=30');
    expect(headers0['Content-Type']).toBe('application/json');
    const body0 = JSON.parse(String(calls[0].init?.body));
    expect(body0).toEqual({ input: { image: 'https://example.com/in.jpg' } });

    // Step 2 — output URL re-fetch. No auth needed (Replicate's CDN is
    // public for the request duration); plain GET.
    expect(calls[1].url).toBe('https://replicate.delivery/abc/out.png');
  });

  it('handles `output` returned as an array (Replicate sometimes returns ["url"] instead of "url")', async () => {
    const cutoutBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: ['https://replicate.delivery/xyz/out.png'] }),
      pngBytesResponse(cutoutBytes),
    ]);
    vi.stubGlobal('fetch', mock);

    const result = await removeGridBackground({
      imageUrl: 'https://example.com/in.jpg',
      replicateToken: 'test-replicate-key',
    });
    expect(Buffer.compare(result, cutoutBytes)).toBe(0);
  });

  it('sends image bytes as a data URL when imageBytes is provided (skips R2 round-trip)', async () => {
    const inputBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
    const cutoutBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { mock, calls } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/x/out.png' }),
      pngBytesResponse(cutoutBytes),
    ]);
    vi.stubGlobal('fetch', mock);

    await removeGridBackground({
      imageBytes: inputBytes,
      imageMimeType: 'image/jpeg',
      replicateToken: 'test-replicate-key',
    });

    const body0 = JSON.parse(String(calls[0].init?.body));
    // Base64-encoded data URL with the supplied mime type. Default for
    // when callers omit mime is image/png — covered by the next test.
    expect(body0.input.image).toBe(`data:image/jpeg;base64,${inputBytes.toString('base64')}`);
  });
});

describe('removeGridBackground — input validation', () => {
  it('throws when neither imageUrl nor imageBytes is provided', async () => {
    await expect(
      removeGridBackground({ replicateToken: 'test-replicate-key' }),
    ).rejects.toThrow(/requires either imageBytes or imageUrl/i);
  });

  it('throws when the Replicate token is missing', async () => {
    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: '',
      }),
    ).rejects.toThrow(/Replicate token is required/i);
  });
});

describe('removeGridBackground — Replicate error paths', () => {
  it('throws with the Replicate body snippet on a non-OK status (so the route can surface it)', async () => {
    const { mock } = scriptedFetch([
      new Response('insufficient credit', { status: 402 }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/Replicate grid RMBG failed \(402\).*insufficient credit/i);
  });

  it('throws when the prediction returns an explicit error field', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'failed', error: 'model dispatch timed out' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/model dispatch timed out/i);
  });

  it('throws when the prediction completes with a non-`succeeded` status (e.g. starting / processing left in flight)', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'processing' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/did not complete.*processing/i);
  });

  it('throws when the prediction succeeds but the output URL is missing', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/no output URL/i);
  });

  it('throws when the output URL fetch returns non-OK', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'https://replicate.delivery/x/out.png' }),
      new Response('not found', { status: 404 }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/Failed to fetch grid RMBG output \(404\)/i);
  });
});

describe('removeGridBackground — SSRF guard on the output URL', () => {
  // The output URL comes from Replicate; in theory a tampered model fork
  // could return anything. `assertSafePublicUrl` blocks internal hosts,
  // private IPs, file:// schemes, etc. — pinned here so a regression that
  // drops the guard fails the test instead of silently letting internal
  // bytes through to the user.
  it('rejects an output URL on an internal hostname (.internal)', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'https://imds.internal/latest/meta-data/' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/unsafe URL/i);
  });

  it('rejects an output URL on a private IP (RFC 1918 192.168.x.x)', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'https://192.168.1.5/secret.png' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/unsafe URL/i);
  });

  it('rejects a non-HTTPS output URL (http://)', async () => {
    const { mock } = scriptedFetch([
      jsonResponse({ status: 'succeeded', output: 'http://example.com/out.png' }),
    ]);
    vi.stubGlobal('fetch', mock);

    await expect(
      removeGridBackground({
        imageUrl: 'https://example.com/in.jpg',
        replicateToken: 'test-replicate-key',
      }),
    ).rejects.toThrow(/unsafe URL/i);
  });
});
