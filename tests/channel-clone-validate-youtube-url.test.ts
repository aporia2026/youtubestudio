import { describe, expect, it } from 'vitest';
import { validateYoutubeUrl } from '@/lib/channel-clone/validate-youtube-url';

// Unit tests for the channel-clone URL validator. The validator is
// the security gate in front of the yt-dlp subprocess (per the
// 2026-06-05 channel-clone-pipeline plan §Security), so the
// rejection cases below double as the threat-model checklist.

describe('validateYoutubeUrl — channel URLs', () => {
  it('accepts a /@handle URL and canonicalizes to www.youtube.com', () => {
    const r = validateYoutubeUrl('https://youtube.com/@Zenn');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('channel');
    expect(r.parsed.canonical).toBe('https://www.youtube.com/@Zenn');
    expect(r.parsed.identifier).toBe('@Zenn');
    expect(r.parsed.identifierType).toBe('handle');
  });

  it('accepts a /channel/UCxxxx URL', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/channel/UC7fmAPpkLm2oBdOg-YPt1Iw');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('channel');
    expect(r.parsed.identifier).toBe('UC7fmAPpkLm2oBdOg-YPt1Iw');
    expect(r.parsed.identifierType).toBe('id');
  });

  it('accepts a legacy /c/CustomName URL', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/c/SomeCreator');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('channel');
    expect(r.parsed.identifierType).toBe('custom');
  });

  it('accepts a legacy /user/Username URL', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/user/legacyAccount');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.identifierType).toBe('user');
  });

  it('rejects a /channel/ URL whose id is not a real UC… shape', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/channel/notarealchannelid');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Invalid channel id/);
  });

  it('rejects a /@handle that is too short to be real', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/@xy');
    expect(r.ok).toBe(false);
  });

  it('trims surrounding whitespace before parsing', () => {
    const r = validateYoutubeUrl('   https://www.youtube.com/@Zenn   ');
    expect(r.ok).toBe(true);
  });
});

describe('validateYoutubeUrl — video URLs', () => {
  it('accepts a standard /watch?v= URL', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/watch?v=UOmGx8pmf_I');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('video');
    expect(r.parsed.identifier).toBe('UOmGx8pmf_I');
    expect(r.parsed.canonical).toBe('https://www.youtube.com/watch?v=UOmGx8pmf_I');
  });

  it('canonicalizes a youtu.be short URL to /watch?v= form', () => {
    const r = validateYoutubeUrl('https://youtu.be/UOmGx8pmf_I');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('video');
    expect(r.parsed.canonical).toBe('https://www.youtube.com/watch?v=UOmGx8pmf_I');
  });

  it('accepts /shorts/ URLs and canonicalizes to /watch?v=', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/shorts/UOmGx8pmf_I');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.kind).toBe('video');
    expect(r.parsed.canonical).toBe('https://www.youtube.com/watch?v=UOmGx8pmf_I');
  });

  it('rejects /watch when the v parameter is malformed', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/watch?v=tooShort');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/missing a valid `v`/);
  });

  it('rejects youtu.be without a video id', () => {
    const r = validateYoutubeUrl('https://youtu.be/');
    expect(r.ok).toBe(false);
  });

  it('ignores extra query params like ?list= and ?t= on /watch', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/watch?v=UOmGx8pmf_I&list=WL&t=42s');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parsed.canonical).toBe('https://www.youtube.com/watch?v=UOmGx8pmf_I');
  });
});

describe('validateYoutubeUrl — security rejection cases', () => {
  it('rejects non-string input', () => {
    expect(validateYoutubeUrl(null).ok).toBe(false);
    expect(validateYoutubeUrl(undefined).ok).toBe(false);
    expect(validateYoutubeUrl(42).ok).toBe(false);
    expect(validateYoutubeUrl({}).ok).toBe(false);
  });

  it('rejects empty / whitespace-only input', () => {
    expect(validateYoutubeUrl('').ok).toBe(false);
    expect(validateYoutubeUrl('   ').ok).toBe(false);
  });

  it('rejects javascript: scheme', () => {
    const r = validateYoutubeUrl('javascript:alert(1)//youtube.com');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Unsupported URL scheme/);
  });

  it('rejects data: URI', () => {
    const r = validateYoutubeUrl('data:text/plain,hello');
    expect(r.ok).toBe(false);
  });

  it('rejects file: URI', () => {
    const r = validateYoutubeUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('rejects URLs with embedded credentials', () => {
    const r = validateYoutubeUrl('https://user:pass@www.youtube.com/@Zenn');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/credentials/);
  });

  it('rejects non-YouTube hosts even on https', () => {
    const r = validateYoutubeUrl('https://evil.example.com/@Zenn');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/Unsupported host/);
  });

  it('rejects m.youtube.com and music.youtube.com per allowlist', () => {
    expect(validateYoutubeUrl('https://m.youtube.com/@Zenn').ok).toBe(false);
    expect(validateYoutubeUrl('https://music.youtube.com/@Zenn').ok).toBe(false);
  });

  it('rejects URLs containing other C0 controls (e.g. CR, LF)', () => {
    expect(validateYoutubeUrl('https://www.youtube.com/@Zenn\r\nevil').ok).toBe(false);
    expect(validateYoutubeUrl('https://www.youtube.com/@Zenn\x1f').ok).toBe(false);
  });

  it('rejects URLs containing NULL byte', () => {
    const r = validateYoutubeUrl(`https://www.youtube.com/@Zenn${String.fromCharCode(0)}.evil`);
    expect(r.ok).toBe(false);
  });

  it('rejects URLs over 2048 chars', () => {
    const stuffing = 'a'.repeat(3000);
    const r = validateYoutubeUrl(`https://www.youtube.com/@Zenn?ref=${stuffing}`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/2048 character limit/);
  });

  it('rejects garbage strings that are not URLs at all', () => {
    expect(validateYoutubeUrl('not a url').ok).toBe(false);
    expect(validateYoutubeUrl('youtube.com/@Zenn').ok).toBe(false); // no scheme
  });

  it('rejects youtube.com paths that do not match any known shape', () => {
    const r = validateYoutubeUrl('https://www.youtube.com/about');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/does not look like/);
  });
});
