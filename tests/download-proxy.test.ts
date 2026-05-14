/**
 * /api/download-proxy is the same-origin streaming hop that lets the
 * browser save cross-origin assets without needing the upstream (R2,
 * Vercel Blob, AI providers) to send CORS headers. The route is in the
 * public-path allowlist so the editor / narrator portals can hit it
 * without a session cookie, so the security contract leans entirely on
 * the host allowlist below — these tests pin that contract.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isPathPublic } from '@/proxy';

const ORIGINAL_FETCH = global.fetch;

function makeReq(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new Request(url, { headers }));
}

describe('proxy.isPathPublic includes the download proxy', () => {
  it('exempts /api/download-proxy from the session check', () => {
    expect(isPathPublic('/api/download-proxy')).toBe(true);
    expect(isPathPublic('/api/download-proxy/anything')).toBe(true);
  });
});

describe('/api/download-proxy', () => {
  let GET: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    ({ GET } = await import('@/app/api/download-proxy/route'));
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('rejects requests missing the upstream URL', async () => {
    const res = await GET(makeReq('https://app.test/api/download-proxy'));
    expect(res.status).toBe(400);
  });

  it('rejects malformed URLs', async () => {
    const res = await GET(makeReq('https://app.test/api/download-proxy?u=not-a-url'));
    expect(res.status).toBe(400);
  });

  it('rejects non-https schemes (defence against file:/// and http SSRF)', async () => {
    const res = await GET(makeReq('https://app.test/api/download-proxy?u=http%3A%2F%2Fevil.test%2Fa'));
    expect(res.status).toBe(400);
  });

  it('rejects hosts outside the allowlist', async () => {
    const res = await GET(
      makeReq('https://app.test/api/download-proxy?u=https%3A%2F%2Fattacker.test%2Fpayload'),
    );
    expect(res.status).toBe(403);
  });

  it('allows Remotion Lambda virtual-hosted S3 URLs', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      }),
    ) as typeof fetch;

    const upstream =
      'https://remotionlambda-useast1-0iwk2aeoqm.s3.us-east-1.amazonaws.com/renders/abc/out.mp4';
    const res = await GET(
      makeReq(
        `https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}&name=video.mp4`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
  });

  it('allows Remotion Lambda path-style S3 URLs (Lambda outputFile shape)', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      }),
    ) as typeof fetch;

    // Path-style: hostname is s3.<region>.amazonaws.com, bucket is the
    // first path segment. This is the form Lambda's getRenderProgress
    // returns in `outputFile`.
    const upstream =
      'https://s3.us-east-1.amazonaws.com/remotionlambda-useast1-0iwk2aeoqm/renders/m32pxolex0/out.mp4';
    const res = await GET(
      makeReq(
        `https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}&name=video.mp4`,
      ),
    );
    expect(res.status).toBe(200);
  });

  it('rejects S3 buckets NOT prefixed with `remotionlambda-` (virtual-hosted)', async () => {
    const res = await GET(
      makeReq(
        'https://app.test/api/download-proxy?u=https%3A%2F%2Fsomeone-elses-bucket.s3.us-east-1.amazonaws.com%2Fpayload',
      ),
    );
    expect(res.status).toBe(403);
  });

  it('rejects path-style S3 URLs targeting non-Remotion buckets', async () => {
    const res = await GET(
      makeReq(
        'https://app.test/api/download-proxy?u=https%3A%2F%2Fs3.us-east-1.amazonaws.com%2Fsomeone-elses-bucket%2Fpayload',
      ),
    );
    expect(res.status).toBe(403);
  });

  it('proxies R2 presigned URLs and forces Content-Disposition: attachment', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    global.fetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '4',
          'accept-ranges': 'bytes',
        },
      }),
    ) as typeof fetch;

    const upstream = 'https://abc123.r2.cloudflarestorage.com/bucket/key.mp3?sig=...';
    const res = await GET(
      makeReq(
        `https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}&name=${encodeURIComponent('voiceover.mp3')}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    const cd = res.headers.get('content-disposition') || '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('filename="voiceover.mp3"');
    expect(cd).toContain("filename*=UTF-8''voiceover.mp3");
  });

  it('encodes non-ASCII filenames via RFC 5987 filename* and sanitises the ASCII fallback', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([0]), { status: 200 })) as typeof fetch;
    const upstream = 'https://abc.r2.cloudflarestorage.com/x';
    const hebrew = 'דיבוב.mp3';
    const res = await GET(
      makeReq(`https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}&name=${encodeURIComponent(hebrew)}`),
    );
    const cd = res.headers.get('content-disposition') || '';
    expect(cd).toContain("filename*=UTF-8''" + encodeURIComponent(hebrew));
    // ASCII fallback must not contain raw non-ASCII bytes that would break
    // the header per RFC 6266.
    const asciiMatch = cd.match(/filename="([^"]*)"/);
    expect(asciiMatch).not.toBeNull();
    if (asciiMatch) {
      for (const ch of asciiMatch[1]) {
        const code = ch.charCodeAt(0);
        expect(code).toBeGreaterThanOrEqual(0x20);
        expect(code).toBeLessThanOrEqual(0x7e);
      }
    }
  });

  it('rejects header-injection attempts in the filename', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([0]), { status: 200 })) as typeof fetch;
    const upstream = 'https://abc.r2.cloudflarestorage.com/x';
    const evil = 'a"\r\nX-Injected: yes\r\n';
    const res = await GET(
      makeReq(`https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}&name=${encodeURIComponent(evil)}`),
    );
    expect(res.headers.get('x-injected')).toBeNull();
    const cd = res.headers.get('content-disposition') || '';
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
  });

  it('propagates upstream 4xx/5xx status codes', async () => {
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as typeof fetch;
    const upstream = 'https://abc.r2.cloudflarestorage.com/missing';
    const res = await GET(makeReq(`https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}`));
    expect(res.status).toBe(404);
  });

  it('returns 502 when the upstream fetch itself throws', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const upstream = 'https://abc.r2.cloudflarestorage.com/x';
    const res = await GET(makeReq(`https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}`));
    expect(res.status).toBe(502);
  });

  it('forwards a Range header so resumable downloads stay end-to-end', async () => {
    const seen: { range?: string | null } = {};
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.range = headers.get('range');
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-0/100' },
      });
    }) as typeof fetch;
    const upstream = 'https://abc.r2.cloudflarestorage.com/x';
    const res = await GET(
      makeReq(`https://app.test/api/download-proxy?u=${encodeURIComponent(upstream)}`, { range: 'bytes=0-0' }),
    );
    expect(seen.range).toBe('bytes=0-0');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-0/100');
  });
});
