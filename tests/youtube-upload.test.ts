import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSnippetBody,
  buildStatusBody,
  combinedTagsLength,
  resolveShortYoutubeStatus,
  uploadVideo,
  YoutubeUploadValidationError,
  YoutubeUploadApiError,
  YOUTUBE_DESCRIPTION_MAX,
  YOUTUBE_TAGS_COMBINED_MAX,
  YOUTUBE_TITLE_MAX,
} from '@/lib/youtube-upload';
import type { YoutubeUploadMetadata } from '@/lib/shorts-batches-types';

function baseMetadata(overrides: Partial<YoutubeUploadMetadata> = {}): YoutubeUploadMetadata {
  return {
    title: 'A perfectly fine title',
    description: 'A perfectly fine description.',
    categoryId: '27',
    madeForKids: false,
    aiContentDisclosure: true,
    privacy: 'public',
    ...overrides,
  };
}

describe('buildSnippetBody', () => {
  it('builds the minimum required snippet', () => {
    const snip = buildSnippetBody(baseMetadata());
    expect(snip.title).toBe('A perfectly fine title');
    expect(snip.categoryId).toBe('27');
    expect(snip.description).toBe('A perfectly fine description.');
    expect(snip.tags).toBeUndefined();
  });

  it('includes tags + defaultLanguage when provided', () => {
    const snip = buildSnippetBody(
      baseMetadata({ tags: ['cool', 'video'], defaultLanguage: 'en' }),
    );
    expect(snip.tags).toEqual(['cool', 'video']);
    expect(snip.defaultLanguage).toBe('en');
  });

  it('throws when title is missing or blank', () => {
    expect(() => buildSnippetBody(baseMetadata({ title: '' }))).toThrow(YoutubeUploadValidationError);
    expect(() => buildSnippetBody(baseMetadata({ title: '   ' }))).toThrow(/Title is required/);
  });

  it('throws when title exceeds YouTube max', () => {
    expect(() =>
      buildSnippetBody(baseMetadata({ title: 'x'.repeat(YOUTUBE_TITLE_MAX + 1) })),
    ).toThrow(/Title is 101 chars/);
  });

  it('throws when description exceeds YouTube max', () => {
    expect(() =>
      buildSnippetBody(baseMetadata({ description: 'x'.repeat(YOUTUBE_DESCRIPTION_MAX + 1) })),
    ).toThrow(/Description is 5001 chars/);
  });

  it('falls back to default category when none provided', () => {
    const snip = buildSnippetBody(baseMetadata({ categoryId: undefined }));
    expect(snip.categoryId).toBe('27');
  });

  it('rejects an invalid (non-assignable) category id', () => {
    expect(() => buildSnippetBody(baseMetadata({ categoryId: '999' }))).toThrow(/not assignable/);
  });

  it('rejects tags whose combined length exceeds the YouTube cap (commas count)', () => {
    // 5 tags × 100 chars + 4 separators = 504 chars > 500
    const tags = Array.from({ length: 5 }, () => 'x'.repeat(100));
    expect(combinedTagsLength(tags)).toBe(504);
    expect(() => buildSnippetBody(baseMetadata({ tags }))).toThrow(/Combined tag length is 504/);
  });

  it('accepts tags right at the cap', () => {
    // 5 tags × 99 chars + 4 separators = 499 chars
    const tags = Array.from({ length: 5 }, () => 'x'.repeat(99));
    expect(combinedTagsLength(tags)).toBe(499);
    expect(combinedTagsLength(tags)).toBeLessThanOrEqual(YOUTUBE_TAGS_COMBINED_MAX);
    expect(() => buildSnippetBody(baseMetadata({ tags }))).not.toThrow();
  });
});

describe('buildStatusBody', () => {
  it('builds the minimum required status', () => {
    const status = buildStatusBody({ metadata: baseMetadata() });
    expect(status.privacyStatus).toBe('public');
    expect(status.publishAt).toBeUndefined();
    expect(status.selfDeclaredMadeForKids).toBe(false);
    expect(status.containsSyntheticMedia).toBe(true);
    expect(status.embeddable).toBe(true);
    expect(status.publicStatsViewable).toBe(true);
  });

  it('forces privacyStatus=private when scheduled', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const status = buildStatusBody({
      metadata: baseMetadata({ privacy: 'public' }),
      publishAtUtc: future,
    });
    expect(status.privacyStatus).toBe('private');
    expect(status.publishAt).toBe(future);
  });

  it('refuses a past publishAt', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() =>
      buildStatusBody({ metadata: baseMetadata(), publishAtUtc: past }),
    ).toThrow(/publishAt must be in the future/);
  });

  it('refuses a malformed publishAt', () => {
    expect(() =>
      buildStatusBody({ metadata: baseMetadata(), publishAtUtc: 'not-a-date' }),
    ).toThrow(/not a valid ISO timestamp/);
  });

  it('refuses upload when madeForKids is undefined (COPPA)', () => {
    const meta = baseMetadata();
    delete (meta as Partial<YoutubeUploadMetadata>).madeForKids;
    expect(() => buildStatusBody({ metadata: meta })).toThrow(/Made-for-kids must be set/);
  });

  it('defaults containsSyntheticMedia to true when undefined', () => {
    const meta = baseMetadata();
    delete (meta as Partial<YoutubeUploadMetadata>).aiContentDisclosure;
    const status = buildStatusBody({ metadata: meta });
    expect(status.containsSyntheticMedia).toBe(true);
  });

  it('respects an explicit aiContentDisclosure=false (stylised content)', () => {
    const status = buildStatusBody({ metadata: baseMetadata({ aiContentDisclosure: false }) });
    expect(status.containsSyntheticMedia).toBe(false);
  });

  it('does NOT emit ageRestricted or paidPromotion fields (API gap)', () => {
    const status = buildStatusBody({
      metadata: baseMetadata({ ageRestricted: true, paidPromotion: true }),
    });
    // Cast to any to assert absence of the read-only API fields.
    expect((status as Record<string, unknown>).ageRestricted).toBeUndefined();
    expect((status as Record<string, unknown>).paidPromotion).toBeUndefined();
    expect((status as Record<string, unknown>).hasPaidProductPlacement).toBeUndefined();
    expect((status as Record<string, unknown>).ytRating).toBeUndefined();
  });
});

describe('resolveShortYoutubeStatus', () => {
  it("returns 'scheduled' when publishAt is set", () => {
    expect(resolveShortYoutubeStatus('2026-12-01T00:00:00Z')).toBe('scheduled');
  });
  it("returns 'uploaded' when publishAt is null", () => {
    expect(resolveShortYoutubeStatus(null)).toBe('uploaded');
  });
});

describe('uploadVideo wire (mocked fetch)', () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('initiates resumable session and PUTs bytes on the Location URL', async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init: RequestInit | undefined) => {
      const u = url.toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method: init?.method ?? 'GET', headers });
      if (u.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        return new Response(null, {
          status: 200,
          headers: { Location: 'https://example.upload/session-xyz' },
        });
      }
      if (u === 'https://example.upload/session-xyz') {
        return new Response(JSON.stringify({ id: 'VID_123', status: {} }), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await uploadVideo({
      accessToken: 'token-1',
      metadata: baseMetadata(),
      videoBytes: Buffer.from('hello-video-bytes'),
    });

    expect(result).toEqual({ videoId: 'VID_123', status: 'uploaded', publishAtUtc: null });
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Authorization']).toBe('Bearer token-1');
    expect(calls[0].headers['X-Upload-Content-Type']).toBe('video/mp4');
    expect(calls[0].headers['X-Upload-Content-Length']).toBe('17');
    expect(calls[1].method).toBe('PUT');
    expect(calls[1].url).toBe('https://example.upload/session-xyz');

    globalThis.fetch = origFetch;
  });

  it('throws YoutubeUploadApiError when init fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(
      uploadVideo({
        accessToken: 't',
        metadata: baseMetadata(),
        videoBytes: Buffer.from('x'),
      }),
    ).rejects.toThrowError(YoutubeUploadApiError);

    globalThis.fetch = origFetch;
  });

  it('throws YoutubeUploadValidationError before any network call for bad metadata', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      uploadVideo({
        accessToken: 't',
        metadata: baseMetadata({ title: '' }),
        videoBytes: Buffer.from('x'),
      }),
    ).rejects.toThrowError(YoutubeUploadValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();

    globalThis.fetch = origFetch;
  });
});
