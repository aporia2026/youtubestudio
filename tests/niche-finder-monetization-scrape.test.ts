/**
 * Pure-helper tests for the monetization on-demand check.
 *
 * The network wrapper (`checkVideoMonetization`) is exercised
 * end-to-end via the API route in manual QA — mocking fetch + the
 * DB cache would be more brittle than running the route.
 *
 * Here we cover the two pure helpers:
 *   - `extractPlayerResponseJson(html)` — brace-counting extractor
 *     over the raw watch-page HTML.
 *   - `detectMonetizationFromPlayerResponse(obj)` — the status
 *     decision tree over a parsed player-response.
 */
import { describe, expect, it } from 'vitest';
import {
  extractPlayerResponseJson,
  extractPlayerResponseFromHtml,
  detectMonetizationFromPlayerResponse,
} from '@/lib/niche-finder/monetization-scrape';

describe('extractPlayerResponseJson', () => {
  it('returns null for empty / non-string input', () => {
    expect(extractPlayerResponseJson('')).toBeNull();
    // @ts-expect-error invalid input on purpose
    expect(extractPlayerResponseJson(null)).toBeNull();
  });

  it('extracts a simple object via the var-style marker', () => {
    const html = `<script>var ytInitialPlayerResponse = {"a":1,"b":2};var other=3;</script>`;
    expect(extractPlayerResponseJson(html)).toBe('{"a":1,"b":2}');
  });

  it('extracts via the JSON-style marker (window assignment)', () => {
    const html = `<script>window.foo={"ytInitialPlayerResponse":{"a":1}};</script>`;
    expect(extractPlayerResponseJson(html)).toBe('{"a":1}');
  });

  it('handles nested braces correctly via brace counting', () => {
    const html = `var ytInitialPlayerResponse = {"a":{"b":{"c":1}},"d":2};`;
    expect(extractPlayerResponseJson(html)).toBe('{"a":{"b":{"c":1}},"d":2}');
  });

  it('ignores braces inside string values', () => {
    const html = `var ytInitialPlayerResponse = {"title":"hi { with } braces","a":1};`;
    expect(extractPlayerResponseJson(html)).toBe(
      '{"title":"hi { with } braces","a":1}',
    );
  });

  it('handles escaped quotes inside string values', () => {
    const html = `var ytInitialPlayerResponse = {"title":"say \\"hi\\" inside","a":1};`;
    const out = extractPlayerResponseJson(html);
    expect(out).toBe('{"title":"say \\"hi\\" inside","a":1}');
  });

  it('returns null when the marker is missing', () => {
    expect(extractPlayerResponseJson('<html>no marker here</html>')).toBeNull();
  });

  it('returns null when braces never balance', () => {
    const html = `var ytInitialPlayerResponse = {"a":1`; // truncated
    expect(extractPlayerResponseJson(html)).toBeNull();
  });
});

describe('extractPlayerResponseFromHtml', () => {
  it('returns null on malformed JSON', () => {
    const html = `var ytInitialPlayerResponse = {"a":1,};`; // trailing comma
    expect(extractPlayerResponseFromHtml(html)).toBeNull();
  });

  it('returns the parsed object on success', () => {
    const html = `var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}};`;
    expect(extractPlayerResponseFromHtml(html)).toEqual({
      playabilityStatus: { status: 'OK' },
    });
  });
});

describe('detectMonetizationFromPlayerResponse', () => {
  it('returns unknown on null / non-object input', () => {
    expect(detectMonetizationFromPlayerResponse(null).status).toBe('unknown');
    expect(detectMonetizationFromPlayerResponse(undefined).status).toBe('unknown');
  });

  it('reports monetized when adPlacements is populated', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      adPlacements: [{ id: 'preroll' }, { id: 'midroll' }],
    });
    expect(r.status).toBe('monetized');
    expect(r.reason).toContain('adPlacements');
    expect(r.reason).toContain('2 slots');
  });

  it('singularises the slot count when adPlacements has one entry', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      adPlacements: [{ id: 'preroll' }],
    });
    expect(r.reason).toContain('1 slot');
    expect(r.reason).not.toContain('1 slots');
  });

  it('falls back to playerAds when adPlacements is empty', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      adPlacements: [],
      playerAds: [{ tag: 'x' }],
    });
    expect(r.status).toBe('monetized');
    expect(r.reason).toContain('playerAds');
  });

  it('reports not-monetized when playability is OK and both ad fields are empty', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      adPlacements: [],
      playerAds: [],
    });
    expect(r.status).toBe('not-monetized');
    expect(r.reason).toContain('no ad placements');
  });

  it('reports not-monetized when playability is OK and ad fields are entirely absent', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
    });
    expect(r.status).toBe('not-monetized');
  });

  it('returns unknown when the video is not playable (private / deleted / restricted)', () => {
    for (const status of ['ERROR', 'LOGIN_REQUIRED', 'UNPLAYABLE']) {
      const r = detectMonetizationFromPlayerResponse({
        playabilityStatus: { status },
      });
      expect(r.status).toBe('unknown');
      expect(r.reason.toLowerCase()).toContain(status.toLowerCase());
    }
  });

  it('returns unknown for live content even with adPlacements present', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      videoDetails: { isLiveContent: true },
      adPlacements: [{ id: 'preroll' }],
    });
    expect(r.status).toBe('unknown');
    expect(r.reason.toLowerCase()).toContain('live');
  });

  it('returns unknown for Shorts (duration <= 60s) since static page lacks signal', () => {
    // Real YouTube watch pages for Shorts don't populate adPlacements
    // regardless of monetization, so we can't tell from a static fetch.
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      videoDetails: { lengthSeconds: '30' },
    });
    expect(r.status).toBe('unknown');
    expect(r.reason.toLowerCase()).toContain('short');
  });

  it('respects the 60s boundary — 61s is treated as regular video', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      videoDetails: { lengthSeconds: '61' },
    });
    expect(r.status).toBe('not-monetized');
  });

  it('handles numeric lengthSeconds (not only string)', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      videoDetails: { lengthSeconds: 45 },
    });
    expect(r.status).toBe('unknown');
    expect(r.reason.toLowerCase()).toContain('short');
  });

  it('ignores non-array adPlacements / playerAds (treats as missing)', () => {
    const r = detectMonetizationFromPlayerResponse({
      playabilityStatus: { status: 'OK' },
      // @ts-expect-error invalid shape on purpose
      adPlacements: 'not-an-array',
      // @ts-expect-error invalid shape on purpose
      playerAds: { also: 'wrong' },
    });
    expect(r.status).toBe('not-monetized');
  });
});
