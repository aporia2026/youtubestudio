/**
 * Integration tests for the voiceover-aligned scene timing pipeline.
 *
 * These tests are intentionally one level above the unit tests in
 * `tests/voiceover-alignment.test.ts`:
 *
 *   - `realignVideoConfig` is driven end-to-end against a realistic
 *     recorded alignment fixture (six rows, mixed easy and hard
 *     cases) so the full cursor-walk → frame-snap → shot-rebuild
 *     chain is exercised together. Catches regressions that a pure
 *     unit test wouldn't see (e.g. accidental fps-bypass on the
 *     frame snap).
 *
 *   - The `/api/voiceovers/align` route's auth gate is asserted
 *     directly. Mirrors the pattern from
 *     `tests/niche-finder-auth-gates.test.ts` so an accidental
 *     `apiRoute.public` regression on this billable route fails CI.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { VideoConfig } from '@/remotion/types';
import { realignVideoConfig } from '@/remotion/utils';
import { snapMsToFrame } from '@/lib/voiceover-alignment';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

// ─── Shared fixture: 6-row production-doc with mixed alignment cases ──────────
//
// Row 0 — happy path, two sentences.
// Row 1 — contains "don't" so prefix-merge has to fire.
// Row 2 — title-card row (empty script_text) → estimated fallback.
// Row 3 — hyphenated compound "state-of-the-art".
// Row 4 — Unicode curly quotes.
// Row 5 — outro, last row gets endMs stretched to fallbackTotalMs.
//
// Aligner words intentionally diverge from estimated timecodes by
// 200-900 ms per boundary so the test asserts the alignment is
// actually doing work — frame-snap precision wouldn't matter if
// the data was already close.

const FIXTURE_SHOTS = [
  { startMs: 0,     durationMs: 4000, scriptText: 'Welcome to the show. Today we talk about worms.' },
  { startMs: 4000,  durationMs: 4000, scriptText: "Don't underestimate them." },
  { startMs: 8000,  durationMs: 2000, scriptText: '' /* title card */ },
  { startMs: 10_000, durationMs: 4000, scriptText: 'Truly state-of-the-art design.' },
  { startMs: 14_000, durationMs: 4000, scriptText: 'She said “hello” — politely.' },
  { startMs: 18_000, durationMs: 4000, scriptText: 'Subscribe and goodbye.' },
];

const FIXTURE_ALIGNMENT: ForcedAlignmentResponse = {
  words: [
    // Row 0: aligner says the narrator started at 0.4s (intro silence)
    // and finished at 3.2s. Drifts 800ms early on the boundary vs the
    // estimated row[1].startMs = 4000.
    { text: 'Welcome',     start: 0.40, end: 0.85 },
    { text: 'to',          start: 0.85, end: 1.00 },
    { text: 'the',         start: 1.00, end: 1.15 },
    { text: 'show',        start: 1.15, end: 1.55 },
    { text: 'Today',       start: 1.80, end: 2.20 },
    { text: 'we',          start: 2.20, end: 2.35 },
    { text: 'talk',        start: 2.35, end: 2.65 },
    { text: 'about',       start: 2.65, end: 2.95 },
    { text: 'worms',       start: 2.95, end: 3.45 },
    // Row 1: aligner over-segmented "Don't" into "Don" + "t". Three
    // script words → four aligner words. Prefix-merge in
    // alignRowsToWords must absorb the extra "t" token.
    { text: 'Don',         start: 3.80, end: 4.05 },
    { text: 't',           start: 4.05, end: 4.10 },
    { text: 'underestimate', start: 4.10, end: 4.95 },
    { text: 'them',        start: 4.95, end: 5.35 },
    // Row 2: title card with no narration. Cursor must NOT advance.
    // Row 3: hyphenated compound. "state-of-the-art" is one script
    // word, aligner emits four tokens. Loose-comparison prefix merge
    // strips hyphens for the match.
    { text: 'Truly',       start: 9.20, end: 9.55 },
    { text: 'state',       start: 9.55, end: 9.85 },
    { text: 'of',          start: 9.85, end: 9.95 },
    { text: 'the',         start: 9.95, end: 10.10 },
    { text: 'art',         start: 10.10, end: 10.45 },
    { text: 'design',      start: 10.45, end: 11.05 },
    // Row 4: curly quote + em-dash. Aligner emits ASCII tokens; the
    // script normaliser must collapse "—" → "-" → empty word, so the
    // cursor walk skips it without burning an aligner token.
    { text: 'She',         start: 13.20, end: 13.40 },
    { text: 'said',        start: 13.40, end: 13.70 },
    { text: 'hello',       start: 13.70, end: 14.20 },
    { text: 'politely',    start: 14.40, end: 15.05 },
    // Row 5: outro, three words. endMs gets stretched to fallback
    // total (= 22_000) for the trailing-silence rule.
    { text: 'Subscribe',   start: 16.80, end: 17.40 },
    { text: 'and',         start: 17.40, end: 17.55 },
    { text: 'goodbye',     start: 17.55, end: 18.20 },
  ],
};

const FIXTURE_TOTAL_MS = 22_000;
const FPS = 30;

function buildFixtureConfig(): VideoConfig {
  return {
    fps: FPS,
    width: 1920,
    height: 1080,
    brand: {
      primaryColor: '#000', secondaryColor: '#000', backgroundColor: '#fff',
      textColor: '#000', titleColor: '#000', fontFamily: 'Inter', titleFontFamily: 'Inter',
    },
    shots: FIXTURE_SHOTS.map((s) => ({
      startMs: s.startMs,
      durationMs: s.durationMs,
      sceneType: 'b-roll' as const,
      scriptText: s.scriptText || undefined,
    })),
  };
}

// ─── End-to-end re-timing assertions ──────────────────────────────────────────

describe('realignVideoConfig: end-to-end on a 6-row fixture', () => {
  const config = buildFixtureConfig();
  const result = realignVideoConfig(config, FIXTURE_ALIGNMENT);

  it('reports per-row source: 5 aligned + 1 estimated (the title card)', () => {
    const aligned = result.alignedRows.filter((r) => r.source === 'aligned');
    const estimated = result.alignedRows.filter((r) => r.source === 'estimated');
    expect(aligned).toHaveLength(5);
    expect(estimated).toHaveLength(1);
    expect(estimated[0].rowIndex).toBe(2); // title card
  });

  it('produces frame-snapped startMs values (multiples of 1/fps seconds)', () => {
    const frameMs = 1000 / FPS;
    for (const shot of result.config.shots) {
      // Every snapped value must be ~exactly an integer multiple of
      // (1/fps)*1000. floating-point tolerance ε << half a frame.
      const frames = shot.startMs / frameMs;
      expect(frames).toBeCloseTo(Math.round(frames), 6);
      const durationFrames = shot.durationMs / frameMs;
      expect(durationFrames).toBeCloseTo(Math.round(durationFrames), 6);
    }
  });

  it('moves boundaries enough to matter — aligned drift > one frame budget', () => {
    // Sanity: alignment isn't a no-op against the estimated timecodes.
    // Row 0's estimated end = 4000 ms; aligner says row 1 starts at
    // 3.8 s (the "Don" token's start). Difference is 200 ms, six
    // frames at 30 fps.
    const row1Start = result.config.shots[1].startMs;
    expect(Math.abs(row1Start - 4000)).toBeGreaterThan(1000 / FPS);
  });

  it('stretches the last aligned row to cover trailing silence', () => {
    const lastShot = result.config.shots[result.config.shots.length - 1];
    // Aligner's last word ends at 18.20 s, but fallbackTotalMs is
    // 22_000 ms. The stretch rule extends the last aligned row's
    // endMs to fallbackTotalMs so the audio's tail isn't cut off.
    expect(lastShot.startMs + lastShot.durationMs).toBeCloseTo(FIXTURE_TOTAL_MS, -1);
  });

  it('preserves the title-card row at its estimated [start, end] span', () => {
    const titleCard = result.config.shots[2];
    expect(titleCard.startMs).toBe(snapMsToFrame(FIXTURE_SHOTS[2].startMs, FPS));
    // Estimated end = next row's estimated start = 10_000.
    expect(titleCard.startMs + titleCard.durationMs).toBeCloseTo(snapMsToFrame(10_000, FPS), 5);
  });

  it('never emits a zero-duration shot (would crash the render validator)', () => {
    for (const shot of result.config.shots) {
      expect(shot.durationMs).toBeGreaterThan(0);
    }
  });
});

// ─── Pin-duration: alignment respects manual pins ────────────────────────────
//
// 2026-05-23 pin-duration architecture. The fixture above is shared:
// non-pinned rows use alignment values (legacy behavior, identical to
// today). When `pinnedShots[i] === true`, that row's cascade values
// win over alignment. Downstream non-pinned rows cascade-forward when
// they would otherwise overlap the pinned shot — preserving their
// ALIGNED DURATION (not extending it indefinitely).

describe('realignVideoConfig — pinnedShots option', () => {
  it('pinned row keeps cascade durationMs even when alignment would shorten it', () => {
    const config = buildFixtureConfig();
    // Cascade duration for row 0 = 4_000 ms. Alignment would normally
    // shrink to ~3.45 s (last spoken word at 3.45 s). With pin, the
    // 4_000 ms survives.
    const pinnedShots = config.shots.map((_, i) => i === 0);
    const result = realignVideoConfig(config, FIXTURE_ALIGNMENT, { pinnedShots });
    const row0 = result.config.shots[0];
    expect(row0.startMs).toBe(snapMsToFrame(0, FPS));
    expect(row0.durationMs).toBe(snapMsToFrame(4_000, FPS));
  });

  it('extending a pinned row past alignment cascade-forwards the immediate next row', () => {
    const config = buildFixtureConfig();
    // Pin row 0 with a 6_000 ms cascade (vs alignment ~3.45 s).
    config.shots[0] = { ...config.shots[0], durationMs: 6_000 };
    const pinnedShots = config.shots.map((_, i) => i === 0);
    const result = realignVideoConfig(config, FIXTURE_ALIGNMENT, { pinnedShots });
    const row0End = result.config.shots[0].startMs + result.config.shots[0].durationMs;
    const row1Start = result.config.shots[1].startMs;
    // Row 1 was aligned to ~3.8 s; row 0's pinned end is 6 s. Without
    // cascade-forward, row 1 would overlap. With cascade-forward, row 1
    // starts exactly at row 0's end.
    expect(row1Start).toBe(row0End);
  });

  it('cascade-forward preserves aligned DURATION (does not extend)', () => {
    const config = buildFixtureConfig();
    // Compute the baseline (no pins) so we know what aligned values
    // `applySceneTimingRules` actually produced for row 1 — its real
    // duration may differ from the bare "last word minus first word"
    // because the scene-timing rules can extend rows into following
    // gaps. The cascade-forward shift must preserve THAT duration,
    // not arbitrarily inflate it.
    const baseline = realignVideoConfig(buildFixtureConfig(), FIXTURE_ALIGNMENT);
    const baselineRow1Dur = baseline.config.shots[1].durationMs;
    // Now pin row 0 with a 6_000 ms cascade.
    config.shots[0] = { ...config.shots[0], durationMs: 6_000 };
    const pinnedShots = config.shots.map((_, i) => i === 0);
    const result = realignVideoConfig(config, FIXTURE_ALIGNMENT, { pinnedShots });
    const row1 = result.config.shots[1];
    // Row 1's duration after pin should match the baseline (only
    // its start shifted forward, end shifted by the same amount).
    expect(row1.durationMs).toBe(baselineRow1Dur);
  });

  it('legacy unpinned rows behave EXACTLY as before this feature (no regression)', () => {
    const config = buildFixtureConfig();
    // Empty pinnedShots ⇒ every row is unpinned ⇒ alignment dominates.
    const withEmpty = realignVideoConfig(config, FIXTURE_ALIGNMENT, { pinnedShots: [] });
    const withoutOptions = realignVideoConfig(config, FIXTURE_ALIGNMENT);
    expect(withEmpty.config.shots).toEqual(withoutOptions.config.shots);
  });

  it('omitting the options argument is identical to the legacy no-option signature', () => {
    const config = buildFixtureConfig();
    const withOptions = realignVideoConfig(config, FIXTURE_ALIGNMENT, {});
    const withoutOptions = realignVideoConfig(config, FIXTURE_ALIGNMENT);
    expect(withOptions.config.shots).toEqual(withoutOptions.config.shots);
  });
});

// ─── Auth gate on /api/voiceovers/align ───────────────────────────────────────

// Mock next/headers BEFORE importing the route module, mirroring the
// pattern in tests/niche-finder-auth-gates.test.ts.
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: () => undefined,
      getAll: () => [],
      has: () => false,
    }),
}));

import * as alignRoute from '@/app/api/voiceovers/align/route';

describe('/api/voiceovers/align auth gate', () => {
  it('returns 401 with no session', async () => {
    const POST = (
      alignRoute as unknown as {
        POST: (
          req: NextRequest,
          ctx: { params: Promise<Record<string, string>> },
        ) => Promise<Response>;
      }
    ).POST;
    const req = new NextRequest('http://localhost/api/voiceovers/align', {
      method: 'POST',
      body: JSON.stringify({
        audioPath: '/api/voiceovers/00000000-0000-0000-0000-000000000000/audio',
        rowScripts: ['anything'],
      }),
    });
    const res = await POST(req, { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
  });
});
