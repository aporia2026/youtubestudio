import { describe, expect, it } from 'vitest';
import {
  validatePublishRequest,
  buildVideosInsertSnippet,
  buildVideosInsertStatus,
  nextStatusFor,
  isTerminalStatus,
  buildYoutubeUrl,
  PUBLISH_LIMITS,
  type PublishRequest,
} from '@/lib/publishing-types';

function baseReq(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: 'ws-1',
    channelDbId: 'ch-1',
    sourceVideoUrl: 'https://blob.vercel-storage.com/foo.mp4',
    title: 'My great video',
    ...overrides,
  };
}

describe('validatePublishRequest', () => {
  it('accepts a minimal valid request', () => {
    const r = validatePublishRequest(baseReq());
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('requires workspaceId, channelDbId, sourceVideoUrl, title', () => {
    const r = validatePublishRequest({
      workspaceId: '',
      channelDbId: '',
      sourceVideoUrl: '',
      title: '   ',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('workspaceId'))).toBe(true);
    expect(r.errors.some((e) => e.includes('channelDbId'))).toBe(true);
    expect(r.errors.some((e) => e.includes('sourceVideoUrl'))).toBe(true);
    expect(r.errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('rejects non-http(s) sourceVideoUrl', () => {
    const r = validatePublishRequest(baseReq({ sourceVideoUrl: 'file:///etc/passwd' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('http(s)'))).toBe(true);
  });

  it('rejects oversize title', () => {
    const r = validatePublishRequest(baseReq({ title: 'x'.repeat(PUBLISH_LIMITS.TITLE_MAX + 1) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(`${PUBLISH_LIMITS.TITLE_MAX} chars`))).toBe(true);
  });

  it('rejects oversize description', () => {
    const r = validatePublishRequest(baseReq({ description: 'x'.repeat(PUBLISH_LIMITS.DESCRIPTION_MAX + 1) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('rejects too many tags', () => {
    const r = validatePublishRequest(baseReq({ tags: Array.from({ length: PUBLISH_LIMITS.TAGS_MAX_COUNT + 1 }, (_, i) => `t${i}`) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(`${PUBLISH_LIMITS.TAGS_MAX_COUNT} tags`))).toBe(true);
  });

  it('rejects oversize total tag length even when individual tags are short', () => {
    // 50 tags of 12 chars = 600 chars, exceeds TAGS_MAX_TOTAL_LEN=500.
    const r = validatePublishRequest(baseReq({ tags: Array.from({ length: 50 }, () => 'aaaaaaaaaaaa') }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Combined tag length'))).toBe(true);
  });

  it('rejects an individual tag exceeding TAG_MAX_LEN', () => {
    const r = validatePublishRequest(baseReq({ tags: ['ok', 'x'.repeat(PUBLISH_LIMITS.TAG_MAX_LEN + 1)] }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(`${PUBLISH_LIMITS.TAG_MAX_LEN} chars`))).toBe(true);
  });

  it('rejects unknown privacyStatus', () => {
    const r = validatePublishRequest(baseReq({ privacyStatus: 'open' as never }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('privacyStatus'))).toBe(true);
  });

  it('rejects publishAt set with non-private privacyStatus (YouTube would silently ignore)', () => {
    const r = validatePublishRequest(baseReq({
      privacyStatus: 'public',
      publishAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('publishAt') && e.includes('private'))).toBe(true);
  });

  it('rejects publishAt in the past', () => {
    const r = validatePublishRequest(baseReq({
      privacyStatus: 'private',
      publishAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('future'))).toBe(true);
  });

  it('accepts publishAt in the future when privacyStatus is private', () => {
    const r = validatePublishRequest(baseReq({
      privacyStatus: 'private',
      publishAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    expect(r.ok).toBe(true);
  });

  it('rejects non-http(s) thumbnailUrl', () => {
    const r = validatePublishRequest(baseReq({ thumbnailUrl: 'data:image/jpg;base64,xxx' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('thumbnailUrl'))).toBe(true);
  });

  it('treats null thumbnailUrl as absent (no error)', () => {
    const r = validatePublishRequest(baseReq({ thumbnailUrl: null }));
    expect(r.ok).toBe(true);
  });
});

describe('buildVideosInsertSnippet', () => {
  it('trims title and tags, drops empty tags, defaults categoryId to 22', () => {
    const out = buildVideosInsertSnippet(baseReq({
      title: '  Hey there  ',
      tags: [' react ', '', '  ', 'next.js'],
    }));
    expect(out.title).toBe('Hey there');
    expect(out.tags).toEqual(['react', 'next.js']);
    expect(out.categoryId).toBe('22');
  });

  it('respects an explicit categoryId', () => {
    const out = buildVideosInsertSnippet(baseReq({ categoryId: '27' }));
    expect(out.categoryId).toBe('27');
  });

  it('omits defaultLanguage when not set', () => {
    const out = buildVideosInsertSnippet(baseReq());
    expect('defaultLanguage' in out).toBe(false);
  });

  it('includes defaultLanguage when set', () => {
    const out = buildVideosInsertSnippet(baseReq({ defaultLanguage: 'es' }));
    expect(out.defaultLanguage).toBe('es');
  });

  it('description defaults to empty string', () => {
    const out = buildVideosInsertSnippet(baseReq());
    expect(out.description).toBe('');
  });
});

describe('buildVideosInsertStatus', () => {
  it('defaults to private + selfDeclaredMadeForKids=false', () => {
    const out = buildVideosInsertStatus(baseReq());
    expect(out).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false });
  });

  it('includes publishAt when private + future', () => {
    const ts = new Date(Date.now() + 3_600_000).toISOString();
    const out = buildVideosInsertStatus(baseReq({ privacyStatus: 'private', publishAt: ts }));
    expect(out.publishAt).toBe(new Date(ts).toISOString());
  });

  it('drops publishAt when privacy is unlisted (YouTube would ignore it)', () => {
    const ts = new Date(Date.now() + 3_600_000).toISOString();
    const out = buildVideosInsertStatus(baseReq({ privacyStatus: 'unlisted', publishAt: ts }));
    expect('publishAt' in out).toBe(false);
  });

  it('drops publishAt when in the past', () => {
    const ts = new Date(Date.now() - 60_000).toISOString();
    const out = buildVideosInsertStatus(baseReq({ privacyStatus: 'private', publishAt: ts }));
    expect('publishAt' in out).toBe(false);
  });

  it('honours madeForKids', () => {
    const out = buildVideosInsertStatus(baseReq({ madeForKids: true }));
    expect(out.selfDeclaredMadeForKids).toBe(true);
  });
});

describe('nextStatusFor — state machine', () => {
  it('queued → uploading on start_upload', () => {
    expect(nextStatusFor('queued', 'start_upload')).toBe('uploading');
  });

  it('queued → failed on upload_failed', () => {
    expect(nextStatusFor('queued', 'upload_failed')).toBe('failed');
  });

  it('uploading → processing on upload_succeeded', () => {
    expect(nextStatusFor('uploading', 'upload_succeeded')).toBe('processing');
  });

  it('uploading → failed on upload_failed', () => {
    expect(nextStatusFor('uploading', 'upload_failed')).toBe('failed');
  });

  it('processing → live on processing_complete', () => {
    expect(nextStatusFor('processing', 'processing_complete')).toBe('live');
  });

  it('processing → failed on processing_failed', () => {
    expect(nextStatusFor('processing', 'processing_failed')).toBe('failed');
  });

  it('throws on illegal transitions', () => {
    expect(() => nextStatusFor('live', 'start_upload')).toThrow(/Illegal/);
    expect(() => nextStatusFor('failed', 'upload_succeeded')).toThrow(/Illegal/);
    expect(() => nextStatusFor('queued', 'processing_complete')).toThrow(/Illegal/);
    expect(() => nextStatusFor('uploading', 'processing_complete')).toThrow(/Illegal/);
  });
});

describe('isTerminalStatus', () => {
  it('is true for live and failed only', () => {
    expect(isTerminalStatus('live')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('uploading')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
  });
});

describe('buildYoutubeUrl', () => {
  it('builds the canonical short URL', () => {
    expect(buildYoutubeUrl('dQw4w9WgXcQ')).toBe('https://youtu.be/dQw4w9WgXcQ');
  });
});
