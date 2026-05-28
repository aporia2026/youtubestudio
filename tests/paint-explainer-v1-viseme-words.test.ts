import { describe, expect, it } from 'vitest';
import { attachPaintExplainerV1VisemeWords } from '@/remotion/utils';
import type { VideoConfig, VideoShot } from '@/remotion/types';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

// ─── attachPaintExplainerV1VisemeWords ───────────────────────────────
//
// Pure function. Takes a VideoConfig + an alignment payload, produces
// a VideoConfig with `visemeWords` populated on every motion shot
// whose time window overlaps any aligner word. Constant-rate fallback
// in MotionScene kicks in when this returns no slice for a shot.

function shot(startMs: number, durationMs: number, shotKind?: 'motion' | 'static'): VideoShot {
  return {
    startMs,
    durationMs,
    sceneType: 'b-roll',
    shotKind,
  };
}

function alignment(
  ...words: Array<{ text: string; start: number; end: number }>
): ForcedAlignmentResponse {
  return { words };
}

function configWith(shots: VideoShot[]): VideoConfig {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    shots,
    brand: {} as VideoConfig['brand'],
    showCaptions: false,
    suppressLowerThirds: false,
  };
}

// ─── Fast-path: no motion shots ──────────────────────────────────────

describe('attachPaintExplainerV1VisemeWords — fast path', () => {
  it('returns the input config reference-equal when there are no motion shots', () => {
    const cfg = configWith([shot(0, 1000, 'static'), shot(1000, 1000)]);
    const out = attachPaintExplainerV1VisemeWords(cfg, alignment({ text: 'hi', start: 0, end: 0.5 }));
    expect(out).toBe(cfg);
  });

  it('returns the input config reference-equal when the alignment has zero words', () => {
    const cfg = configWith([shot(0, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(cfg, { words: [] });
    expect(out).toBe(cfg);
  });

  it('does not touch shots that are not motion (mixed-style docs)', () => {
    const cfg = configWith([shot(0, 1000, 'static'), shot(1000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'static-row', start: 0.2, end: 0.4 }, { text: 'motion-row', start: 1.2, end: 1.4 }),
    );
    // Static shot remains unchanged (no visemeWords).
    expect(out.shots[0]).toBe(cfg.shots[0]);
    // Motion shot gets the second word.
    expect(out.shots[1].visemeWords).toHaveLength(1);
    expect(out.shots[1].visemeWords?.[0].text).toBe('motion-row');
  });
});

// ─── Slicing ─────────────────────────────────────────────────────────

describe('attachPaintExplainerV1VisemeWords — slicing', () => {
  it("attaches words that fall inside a motion shot's window", () => {
    const cfg = configWith([shot(1000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment(
        { text: 'before', start: 0.1, end: 0.5 },   // before shot — skipped
        { text: 'inside-a', start: 1.1, end: 1.4 }, // inside — kept
        { text: 'inside-b', start: 1.6, end: 1.9 }, // inside — kept
        { text: 'after', start: 2.2, end: 2.5 },    // after — skipped
      ),
    );
    expect(out.shots[0].visemeWords).toHaveLength(2);
    expect(out.shots[0].visemeWords?.map((w) => w.text)).toEqual(['inside-a', 'inside-b']);
  });

  it('converts seconds → milliseconds, rounded to the nearest integer ms', () => {
    const cfg = configWith([shot(0, 2000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'precise', start: 0.123, end: 0.4567 }),
    );
    const w = out.shots[0].visemeWords?.[0];
    expect(w?.startMs).toBe(123);
    expect(w?.endMs).toBe(457); // 456.7 rounds up
  });

  it('includes a word that starts before the shot and extends into it', () => {
    // Word from 800..1200ms; shot starts at 1000ms. Should be included
    // because endMs (1200) > shot.startMs (1000).
    const cfg = configWith([shot(1000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'straddle', start: 0.8, end: 1.2 }),
    );
    expect(out.shots[0].visemeWords).toHaveLength(1);
  });

  it('includes a word that starts inside the shot and extends past', () => {
    // Word from 1900..2300ms; shot ends at 2000ms. Should be included
    // because startMs (1900) < shotEndMs (2000).
    const cfg = configWith([shot(1000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'straddle-end', start: 1.9, end: 2.3 }),
    );
    expect(out.shots[0].visemeWords).toHaveLength(1);
  });

  it("leaves visemeWords undefined when no words fall in the shot's window", () => {
    const cfg = configWith([shot(5000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'far-before', start: 0.1, end: 0.5 }),
    );
    expect(out.shots[0].visemeWords).toBeUndefined();
  });
});

// ─── Defense in depth ────────────────────────────────────────────────

describe('attachPaintExplainerV1VisemeWords — defense in depth', () => {
  it('skips words with non-numeric start/end (malformed aligner output)', () => {
    const cfg = configWith([shot(0, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      // @ts-expect-error — intentional malformed payload
      alignment({ text: 'bad', start: 'oops', end: 0.5 }, { text: 'good', start: 0.2, end: 0.4 }),
    );
    expect(out.shots[0].visemeWords).toHaveLength(1);
    expect(out.shots[0].visemeWords?.[0].text).toBe('good');
  });

  it('skips zero-duration words (start === end)', () => {
    const cfg = configWith([shot(0, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'empty', start: 0.5, end: 0.5 }, { text: 'real', start: 0.2, end: 0.4 }),
    );
    expect(out.shots[0].visemeWords).toHaveLength(1);
    expect(out.shots[0].visemeWords?.[0].text).toBe('real');
  });

  it('handles a config with multiple motion shots — each gets its own slice', () => {
    const cfg = configWith([shot(0, 1000, 'motion'), shot(1000, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment(
        { text: 'first', start: 0.2, end: 0.4 },
        { text: 'second', start: 1.3, end: 1.5 },
      ),
    );
    expect(out.shots[0].visemeWords?.map((w) => w.text)).toEqual(['first']);
    expect(out.shots[1].visemeWords?.map((w) => w.text)).toEqual(['second']);
  });

  it('preserves the rest of the config (brand, fps, dimensions)', () => {
    const cfg = configWith([shot(0, 1000, 'motion')]);
    const out = attachPaintExplainerV1VisemeWords(
      cfg,
      alignment({ text: 'hi', start: 0.2, end: 0.5 }),
    );
    expect(out.fps).toBe(cfg.fps);
    expect(out.width).toBe(cfg.width);
    expect(out.height).toBe(cfg.height);
    expect(out.brand).toBe(cfg.brand);
  });
});
