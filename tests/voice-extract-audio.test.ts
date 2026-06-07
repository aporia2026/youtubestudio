/**
 * Unit tests for the voice-extract helpers (Plan 1A).
 *
 * Covers the pure pieces — argument validation, silence-detect
 * parsing, "which video to pick" heuristic — without booting a
 * Vercel Sandbox or invoking real ffmpeg. The ffmpeg integration is
 * tested live during the channel-clone end-to-end QA pass.
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { describe, expect, it } from 'vitest';
import { parseSilenceDurationsFromStderr } from '@/lib/channel-clone/extract-audio';
import { pickDensestNarrationVideo } from '@/lib/channel-clone/voice-extract-during-intake';
import type { ChannelCloneSampleVideo } from '@/lib/channel-clone/types';

function makeSample(
  overrides: Partial<ChannelCloneSampleVideo> & { videoId: string; wordCount?: number },
): ChannelCloneSampleVideo {
  const wordCount = overrides.wordCount;
  return {
    videoUrl: `https://www.youtube.com/watch?v=${overrides.videoId}`,
    videoId: overrides.videoId,
    title: overrides.title ?? `Sample ${overrides.videoId}`,
    durationSec: overrides.durationSec ?? 600,
    frameCount: overrides.frameCount ?? 60,
    frameR2Keys: overrides.frameR2Keys ?? [],
    representativeFrameBase64: overrides.representativeFrameBase64 ?? null,
    representativeFrameMimeType: overrides.representativeFrameMimeType ?? null,
    transcript:
      wordCount === undefined
        ? overrides.transcript ?? null
        : {
            sourceFormat: 'srt',
            wordCount,
            durationSec: overrides.durationSec ?? 600,
            lines: [{ startSec: 0, text: 'x'.repeat(wordCount) }],
          },
  };
}

describe('extract-audio: parseSilenceDurationsFromStderr', () => {
  it('returns an empty array on a stderr blob with no silence_duration lines', () => {
    expect(parseSilenceDurationsFromStderr('')).toEqual([]);
    expect(parseSilenceDurationsFromStderr('ffmpeg version 5.1 …\nframe= 30')).toEqual([]);
  });

  it('parses a single silence_duration entry', () => {
    const stderr = `
      [silencedetect @ 0x7f] silence_start: 3.2
      [silencedetect @ 0x7f] silence_end: 7.8 | silence_duration: 4.6
    `;
    expect(parseSilenceDurationsFromStderr(stderr)).toEqual([4.6]);
  });

  it('parses multiple silence_duration entries in order', () => {
    const stderr = `
      [silencedetect] silence_end: 5.0 | silence_duration: 2.0
      [silencedetect] silence_end: 11.5 | silence_duration: 3.25
      [silencedetect] silence_end: 18.0 | silence_duration: 5.5
    `;
    expect(parseSilenceDurationsFromStderr(stderr)).toEqual([2.0, 3.25, 5.5]);
  });

  it('skips malformed durations (non-numeric)', () => {
    const stderr = `
      [silencedetect] silence_duration: 1.5
      [silencedetect] silence_duration: NaN
      [silencedetect] silence_duration: 2.5
    `;
    // The regex requires [\d.]+ so the NaN line doesn't match, but
    // the test guards against a regression that loosens the regex.
    const result = parseSilenceDurationsFromStderr(stderr);
    expect(result).toEqual([1.5, 2.5]);
  });
});

describe('voice-extract: pickDensestNarrationVideo', () => {
  it('returns null when there are no sample videos', () => {
    expect(pickDensestNarrationVideo([])).toBeNull();
  });

  it('picks the only video when there is just one', () => {
    const only = makeSample({ videoId: 'only-1', wordCount: 1500 });
    expect(pickDensestNarrationVideo([only])).toBe(only);
  });

  it('prefers the video with the highest transcript word count', () => {
    const a = makeSample({ videoId: 'a', wordCount: 800 });
    const b = makeSample({ videoId: 'b', wordCount: 2400 });
    const c = makeSample({ videoId: 'c', wordCount: 1200 });
    expect(pickDensestNarrationVideo([a, b, c])).toBe(b);
  });

  it('falls back to the first video when no transcripts have words', () => {
    const a = makeSample({ videoId: 'a', wordCount: 0 });
    const b = makeSample({ videoId: 'b', wordCount: 0 });
    const result = pickDensestNarrationVideo([a, b]);
    expect(result).not.toBeNull();
    // Tie-break is alphabetical by videoId (deterministic).
    expect(result?.videoId).toBe('a');
  });

  it('treats null transcripts as 0 words but still picks SOMETHING', () => {
    const a = makeSample({ videoId: 'a' }); // no transcript
    const b = makeSample({ videoId: 'b' }); // no transcript
    const result = pickDensestNarrationVideo([a, b]);
    expect(result).not.toBeNull();
  });

  it('mixes-and-matches: prefers a video with a transcript over one without', () => {
    const a = makeSample({ videoId: 'a' }); // no transcript
    const b = makeSample({ videoId: 'b', wordCount: 100 });
    expect(pickDensestNarrationVideo([a, b])).toBe(b);
  });
});
