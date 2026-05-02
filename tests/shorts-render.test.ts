import { describe, expect, it } from 'vitest';
import {
  buildShortVideoConfig,
  countWords,
  splitScriptIntoCaptions,
  stripScriptMarkers,
} from '@/lib/shorts-render';
import { SHORT_FPS, SHORT_HEIGHT, SHORT_OUTRO_TAIL_MS, SHORT_WIDTH } from '@/lib/shorts-render-types';

describe('stripScriptMarkers', () => {
  it('removes [VISUAL: ...] / [PAUSE] / [SFX: ...] markers', () => {
    const out = stripScriptMarkers('Hook line. [VISUAL: phone close-up] Body. [PAUSE] Payoff. [SFX: ding]');
    expect(out).toBe('Hook line. Body. Payoff.');
  });
  it('collapses internal whitespace', () => {
    expect(stripScriptMarkers('  spaced\nout\ttext  ')).toBe('spaced out text');
  });
  it('returns "" for empty / marker-only input', () => {
    expect(stripScriptMarkers('')).toBe('');
    expect(stripScriptMarkers('[VISUAL: empty]')).toBe('');
  });
});

describe('countWords', () => {
  it('counts simple word strings', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('  one   two\nthree\t')).toBe(3);
  });
  it('returns 0 for empty input', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   ')).toBe(0);
  });
});

describe('splitScriptIntoCaptions', () => {
  const script = 'One two three. Four five six. Seven eight nine ten eleven twelve.';

  it('returns [] for empty / zero-duration input', () => {
    expect(splitScriptIntoCaptions('', 30000)).toEqual([]);
    expect(splitScriptIntoCaptions(script, 0)).toEqual([]);
    expect(splitScriptIntoCaptions(script, -10)).toEqual([]);
  });

  it('respects sentence boundaries when at the target word count', () => {
    const chunks = splitScriptIntoCaptions(script, 12_000, 4);
    // First chunk should land on the period after "three".
    expect(chunks[0]!.text).toBe('One two three.');
  });

  it('caps each chunk at 8 words even when no sentence boundary appears', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(' ');
    const chunks = splitScriptIntoCaptions(long, 30_000, 4);
    for (const c of chunks) {
      const words = c.text.split(/\s+/).filter(Boolean);
      expect(words.length).toBeLessThanOrEqual(8);
    }
  });

  it('chunks span the full duration (first starts at 0, last ends at duration)', () => {
    const chunks = splitScriptIntoCaptions(script, 12_000, 4);
    expect(chunks[0]!.start_ms).toBe(0);
    expect(chunks[chunks.length - 1]!.end_ms).toBe(12_000);
  });

  it('chunk timestamps are monotonically non-decreasing', () => {
    const chunks = splitScriptIntoCaptions(script, 12_000, 4);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start_ms).toBeGreaterThanOrEqual(chunks[i - 1]!.end_ms);
    }
  });

  it('strips [VISUAL] markers before chunking (timing is for spoken text only)', () => {
    const withMarkers = 'Hook. [VISUAL: phone] Body. [PAUSE] Payoff.';
    const chunks = splitScriptIntoCaptions(withMarkers, 9_000, 3);
    const all = chunks.map((c) => c.text).join(' ');
    expect(all).not.toMatch(/\[VISUAL/);
    expect(all).not.toMatch(/\[PAUSE/);
    expect(all).toContain('Hook.');
  });
});

describe('buildShortVideoConfig', () => {
  const baseShort = {
    id: 'short-1',
    short_script: 'Hook line. Body content explains the takeaway. Payoff lands.',
    voiceover_audio_url: 'https://example.com/audio.mp3',
    voiceover_duration_seconds: 12,
    estimated_duration_seconds: 14,
    title: 'My short',
  };

  it('throws when voiceover URL is missing', () => {
    expect(() =>
      buildShortVideoConfig({ short: { ...baseShort, voiceover_audio_url: null } }),
    ).toThrow(/voiceover not generated/);
  });

  it('uses canonical Short dimensions + fps', () => {
    const cfg = buildShortVideoConfig({ short: baseShort });
    expect(cfg.width).toBe(SHORT_WIDTH);
    expect(cfg.height).toBe(SHORT_HEIGHT);
    expect(cfg.fps).toBe(SHORT_FPS);
  });

  it('prefers measured voiceover duration over the estimate', () => {
    const cfg = buildShortVideoConfig({ short: baseShort });
    expect(cfg.duration_ms).toBe(12 * 1000 + SHORT_OUTRO_TAIL_MS);
  });

  it('falls back to estimated_duration_seconds when voiceover_duration_seconds is null', () => {
    const cfg = buildShortVideoConfig({
      short: { ...baseShort, voiceover_duration_seconds: null },
    });
    expect(cfg.duration_ms).toBe(14 * 1000 + SHORT_OUTRO_TAIL_MS);
  });

  it('clamps duration to at least 3 seconds + tail', () => {
    const cfg = buildShortVideoConfig({
      short: { ...baseShort, voiceover_duration_seconds: 1 },
    });
    expect(cfg.duration_ms).toBeGreaterThanOrEqual(3000 + SHORT_OUTRO_TAIL_MS);
  });

  it('strips empty title (no title chip rendered)', () => {
    const cfg = buildShortVideoConfig({ short: { ...baseShort, title: '   ' } });
    expect(cfg.title).toBeUndefined();
  });

  it('includes channel_name when provided', () => {
    const cfg = buildShortVideoConfig({ short: baseShort, channelName: 'AI Tools Daily' });
    expect(cfg.channel_name).toBe('AI Tools Daily');
  });

  it('captions cover only the audio span (excluding the outro tail)', () => {
    const cfg = buildShortVideoConfig({ short: baseShort });
    const lastCap = cfg.captions[cfg.captions.length - 1]!;
    // Last caption should end at duration_ms - outro_tail (= the actual audio end).
    expect(lastCap.end_ms).toBeLessThanOrEqual(cfg.duration_ms - SHORT_OUTRO_TAIL_MS);
  });
});
