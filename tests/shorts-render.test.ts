import { describe, expect, it } from 'vitest';
import {
  buildShortVideoConfig,
  chunkBoundariesFromAlignment,
  countWords,
  splitScriptIntoCaptions,
  stripScriptMarkers,
} from '@/lib/shorts-render';
import { SHORT_FPS, SHORT_HEIGHT, SHORT_OUTRO_TAIL_MS, SHORT_WIDTH } from '@/lib/shorts-render-types';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

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
    // Phase 15.3 — these are required on the Pick<ShortRow>. Old test
    // rows default to the minimal style with no assets.
    style_id: null,
    style_assets: {},
    // Phase 15.11 — captions_config defaults to {} (no overrides).
    captions_config: {},
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

describe('chunkBoundariesFromAlignment — robust word-matching (Phase 15.16)', () => {
  function buildAlignment(words: Array<{ text: string; start: number; end: number }>): ForcedAlignmentResponse {
    return { words };
  }

  it('returns null when alignment is missing / empty', () => {
    expect(chunkBoundariesFromAlignment(['hook'], [0], 10000, null)).toBeNull();
    expect(chunkBoundariesFromAlignment(['hook'], [0], 10000, undefined)).toBeNull();
    expect(chunkBoundariesFromAlignment(['hook'], [0], 10000, { words: [] })).toBeNull();
  });

  it('maps each chunk to its spoken word boundaries', () => {
    const align = buildAlignment([
      { text: 'Hook', start: 0, end: 0.5 },
      { text: 'line', start: 0.5, end: 1.0 },
      { text: 'here', start: 1.0, end: 1.4 },
      { text: 'Body', start: 1.6, end: 2.0 },
      { text: 'words', start: 2.0, end: 2.5 },
    ]);
    const result = chunkBoundariesFromAlignment(['Hook line here', 'Body words'], [0, 1600], 5000, align);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual({ start_ms: 0, end_ms: 1400 });
    // chunk 1 starts exactly on "Body" (1.6s) — the sync that matters; its end
    // extends to the duration to cover the audio tail (trailing-row rule).
    expect(result![1]).toEqual({ start_ms: 1600, end_ms: 5000 });
  });

  it('handles the interleaved space tokens ElevenLabs actually returns', () => {
    // The real payload alternates word, " ", word, " " — ~2x the script's
    // token count. The old index mapping drifted immediately on this; the
    // cursor walk filters spacing tokens and matches by text.
    const align = buildAlignment([
      { text: 'Incognito', start: 0, end: 0.5 },
      { text: ' ', start: 0.5, end: 0.5 },
      { text: 'mode', start: 0.5, end: 1.0 },
      { text: ' ', start: 1.0, end: 1.0 },
      { text: 'lies', start: 1.0, end: 1.5 },
      { text: ' ', start: 1.5, end: 1.6 },
      { text: 'to', start: 1.8, end: 2.0 },
      { text: ' ', start: 2.0, end: 2.0 },
      { text: 'you', start: 2.0, end: 2.6 },
    ]);
    const result = chunkBoundariesFromAlignment(['Incognito mode lies', 'to you'], [0, 1700], 5000, align);
    expect(result).not.toBeNull();
    // chunk 0 maps cleanly past the interleaved spaces; chunk 1 starts on
    // "to" (1.8s) — the index mapping would have drifted here.
    expect(result![0]).toEqual({ start_ms: 0, end_ms: 1500 });
    expect(result![1]!.start_ms).toBe(1800);
  });

  it('absorbs aligner over-segmentation of contractions', () => {
    // "doesn't" → ["doesn", "t"] in the aligner; the cursor walk merges it.
    // A trailing chunk follows so the first chunk's end is the real word end.
    const align = buildAlignment([
      { text: 'It', start: 0, end: 0.3 },
      { text: 'doesn', start: 0.3, end: 0.6 },
      { text: 't', start: 0.6, end: 0.7 },
      { text: 'hide', start: 0.7, end: 1.1 },
      { text: 'anything', start: 1.3, end: 1.8 },
    ]);
    const result = chunkBoundariesFromAlignment(["It doesn't hide", 'anything'], [0, 1200], 5000, align);
    expect(result).not.toBeNull();
    expect(result![0]).toEqual({ start_ms: 0, end_ms: 1100 });
    expect(result![1]!.start_ms).toBe(1300);
  });

  it('clamps boundaries to the duration', () => {
    const align = buildAlignment([
      { text: 'A', start: 0, end: 0.5 },
      { text: 'B', start: 0.5, end: 999 },
    ]);
    const result = chunkBoundariesFromAlignment(['A', 'B'], [0, 500], 1000, align);
    expect(result![1]!.end_ms).toBe(1000);
  });
});

describe('splitScriptIntoCaptions — Phase 15.11 alignment path', () => {
  it('uses alignment timing when supplied', () => {
    const script = 'One two three. Four five six.';
    const align: ForcedAlignmentResponse = {
      words: [
        { text: 'One', start: 0, end: 0.4 },
        { text: 'two', start: 0.4, end: 0.7 },
        { text: 'three', start: 0.7, end: 1.2 },
        { text: 'Four', start: 2.5, end: 2.8 },
        { text: 'five', start: 2.8, end: 3.1 },
        { text: 'six', start: 3.1, end: 3.6 },
      ],
    };
    const chunks = splitScriptIntoCaptions(script, 5000, 4, align);
    expect(chunks[0]!.start_ms).toBe(0);
    expect(chunks[0]!.end_ms).toBe(1200);
    expect(chunks[1]!.start_ms).toBe(2500);
    // Trailing caption extends to the duration to cover the audio tail.
    expect(chunks[1]!.end_ms).toBe(5000);
  });

  it('falls back to proportional timing when alignment is null', () => {
    const script = 'One two three. Four five six.';
    const chunks = splitScriptIntoCaptions(script, 6000, 4, null);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Proportional path: first chunk starts at 0, last ends at duration.
    expect(chunks[0]!.start_ms).toBe(0);
    expect(chunks[chunks.length - 1]!.end_ms).toBe(6000);
  });

  it('falls back when alignment is shorter than the script word count', () => {
    const script = 'One two three four five six seven eight nine.';
    const align: ForcedAlignmentResponse = {
      words: [
        { text: 'One', start: 0, end: 0.5 },
        { text: 'two', start: 0.5, end: 1.0 },
      ],
    };
    const chunks = splitScriptIntoCaptions(script, 5000, 4, align);
    // Proportional fallback last chunk should end at the duration.
    expect(chunks[chunks.length - 1]!.end_ms).toBe(5000);
  });
});

describe('buildShortVideoConfig — Phase 15.3 style dispatch', () => {
  const baseShort = {
    id: 'short-doodle-1',
    short_script: 'Hook line. Body content explains the takeaway. Payoff lands clean.',
    voiceover_audio_url: 'https://example.com/audio.mp3',
    voiceover_duration_seconds: 12,
    estimated_duration_seconds: 14,
    title: 'A Doodle Short',
    captions_config: {},
  } as const;

  it('threads style_id through when set on the row', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'minimal_gradient_v1',
        style_assets: {},
      },
    });
    expect(cfg.style_id).toBe('minimal_gradient_v1');
    expect(cfg.doodle_frames).toBeUndefined();
  });

  it('throws an actionable message when doodle is selected but assets are missing', () => {
    expect(() =>
      buildShortVideoConfig({
        short: {
          ...baseShort,
          style_id: 'doodle_explainer_2_short',
          style_assets: {},
        },
      }),
    ).toThrow(/style assets not generated/i);
  });

  it('throws when doodle assets exist but base_url is missing', () => {
    expect(() =>
      buildShortVideoConfig({
        short: {
          ...baseShort,
          style_id: 'doodle_explainer_2_short',
          // @ts-expect-error — missing base_url, defensive test
          style_assets: { doodle: { variants: [] } },
        },
      }),
    ).toThrow(/style assets not generated/i);
  });

  it('prepends the base frame as chunk-index-0 and appends variants by chunk index', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'doodle_explainer_2_short',
        style_assets: {
          doodle: {
            base_url: 'https://atlas.example.com/base.png',
            variants: [
              { url: 'https://atlas.example.com/v3.png', caption_chunk_start_index: 3 },
              { url: 'https://atlas.example.com/v1.png', caption_chunk_start_index: 1 },
              { url: 'https://atlas.example.com/v2.png', caption_chunk_start_index: 2 },
            ],
          },
        },
      },
    });
    expect(cfg.doodle_frames).toBeDefined();
    const frames = cfg.doodle_frames!;
    // First frame is the base at chunk 0.
    expect(frames[0].url).toBe('https://atlas.example.com/base.png');
    expect(frames[0].caption_chunk_start_index).toBe(0);
    // Variants land sorted by chunk index.
    expect(frames.slice(1).map((f) => f.caption_chunk_start_index)).toEqual([1, 2, 3]);
  });

  it('threads base + variant animation_url onto doodle_frames when present (Phase 15.17)', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'doodle_explainer_2_short',
        style_assets: {
          doodle: {
            base_url: 'https://atlas.example.com/base.png',
            base_animation: {
              video_url: 'https://kie.example.com/base.mp4',
              thumbnail_url: 'https://kie.example.com/base-thumb.jpg',
              model_id: 'runway-i2v-5s-720p',
              cost_usd: 0.06,
              duration_s: 5,
              generated_at: '2026-06-03T00:00:00Z',
              provider_request_id: 't-base',
            },
            variants: [
              {
                url: 'https://atlas.example.com/v1.png',
                caption_chunk_start_index: 1,
                animation: {
                  video_url: 'https://kie.example.com/v1.mp4',
                  model_id: 'runway-i2v-5s-720p',
                  cost_usd: 0.06,
                  duration_s: 5,
                  generated_at: '2026-06-03T00:00:01Z',
                  provider_request_id: 't-v1',
                },
              },
              {
                url: 'https://atlas.example.com/v2.png',
                caption_chunk_start_index: 2,
                // No animation on v2 — the renderer should fall back to the still.
              },
            ],
          },
        },
      },
    });
    const frames = cfg.doodle_frames!;
    expect(frames[0].animation_url).toBe('https://kie.example.com/base.mp4');
    expect(frames[0].animation_thumbnail_url).toBe('https://kie.example.com/base-thumb.jpg');
    expect(frames[1].animation_url).toBe('https://kie.example.com/v1.mp4');
    expect(frames[2].animation_url).toBeUndefined();
  });

  it('also threads animation_url for Paint shorts (Phase 15.17)', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'paint_explainer_v1_short',
        style_assets: {
          paint: {
            base_url: 'https://atlas.example.com/p-base.png',
            base_animation: {
              video_url: 'https://kie.example.com/p-base.mp4',
              model_id: 'kling-v2-5-turbo-i2v-pro-5s',
              cost_usd: 0.21,
              duration_s: 5,
              generated_at: '2026-06-03T00:00:00Z',
              provider_request_id: 't-pbase',
            },
            variants: [],
          },
        },
      },
    });
    expect(cfg.doodle_frames?.[0].animation_url).toBe('https://kie.example.com/p-base.mp4');
  });

  it('emits the same base + variant array shape the renderer iterates with most-recent-frame logic', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'doodle_explainer_2_short',
        style_assets: {
          doodle: {
            base_url: 'https://atlas.example.com/base.png',
            variants: [
              { url: 'https://atlas.example.com/v2.png', caption_chunk_start_index: 2 },
            ],
          },
        },
      },
    });
    expect(cfg.style_id).toBe('doodle_explainer_2_short');
    expect(cfg.doodle_frames).toEqual([
      { url: 'https://atlas.example.com/base.png', caption_chunk_start_index: 0 },
      { url: 'https://atlas.example.com/v2.png', caption_chunk_start_index: 2 },
    ]);
  });

  it('routes paint_explainer_v1_short through doodle_frames (shared renderer)', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'paint_explainer_v1_short',
        style_assets: {
          paint: {
            base_url: 'https://atlas.example.com/paint-base.png',
            variants: [
              { url: 'https://atlas.example.com/paint-v2.png', caption_chunk_start_index: 2 },
              { url: 'https://atlas.example.com/paint-v1.png', caption_chunk_start_index: 1 },
            ],
          },
        },
      },
    });
    expect(cfg.style_id).toBe('paint_explainer_v1_short');
    expect(cfg.doodle_frames).toEqual([
      { url: 'https://atlas.example.com/paint-base.png', caption_chunk_start_index: 0 },
      { url: 'https://atlas.example.com/paint-v1.png', caption_chunk_start_index: 1 },
      { url: 'https://atlas.example.com/paint-v2.png', caption_chunk_start_index: 2 },
    ]);
  });

  it('throws actionable message when paint is selected but assets are missing', () => {
    expect(() =>
      buildShortVideoConfig({
        short: {
          ...baseShort,
          style_id: 'paint_explainer_v1_short',
          style_assets: {},
        },
      }),
    ).toThrow(/Paint Short.*style assets not generated/i);
  });

  it('threads captions_config through onto the output config', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: null,
        style_assets: {},
        captions_config: {
          style: { fontFamily: 'Anton', sizeScale: 1.2 },
          chunks: [{ text: 'overridden' }],
        },
      },
    });
    expect(cfg.captions_config?.style?.fontFamily).toBe('Anton');
    expect(cfg.captions_config?.chunks?.[0]?.text).toBe('overridden');
  });

  it('applies per-chunk text + timing overrides from captions_config', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: null,
        style_assets: {},
        captions_config: {
          chunks: [
            { text: 'New first chunk text' },
            { start_ms: 5000, end_ms: 6500 },
          ],
        },
      },
    });
    expect(cfg.captions[0]!.text).toBe('New first chunk text');
    expect(cfg.captions[1]!.start_ms).toBe(5000);
    expect(cfg.captions[1]!.end_ms).toBe(6500);
  });

  it('drops chunks marked hidden in captions_config', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: null,
        style_assets: {},
        captions_config: {
          chunks: [{ hidden: true }],
        },
      },
    });
    const totalRaw = baseShort.short_script.split(/\s+/).filter(Boolean).length;
    expect(cfg.captions.length).toBeGreaterThan(0);
    expect(cfg.captions.every((c) => c.text !== baseShort.short_script.split('.')[0])).toBe(true);
    expect(totalRaw).toBeGreaterThan(0); // sanity
  });

  it('omits doodle_frames entirely for the minimal style', () => {
    const cfg = buildShortVideoConfig({
      short: {
        ...baseShort,
        style_id: 'minimal_gradient_v1',
        style_assets: {
          // Stray doodle assets are ignored when the style is minimal —
          // user may have switched styles after the doodle generation.
          doodle: {
            base_url: 'https://atlas.example.com/base.png',
            variants: [],
          },
        },
      },
    });
    expect(cfg.doodle_frames).toBeUndefined();
  });
});
