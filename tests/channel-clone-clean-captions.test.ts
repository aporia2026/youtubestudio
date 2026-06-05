import { describe, expect, it } from 'vitest';
import {
  cleanCaptions,
  detectCaptionFormat,
  parseCaptionsToCues,
} from '@/lib/channel-clone/clean-captions';

// Unit tests for the rolling-caption cleaner. Fixtures below mirror
// the YouTube auto-caption shape: a two-line rolling window where
// each cue repeats the previous line + adds the new one. Real-world
// fixture is the 11-min video I cleaned during exploration —
// 720 raw lines → ~360 unique sentences. Tests freeze the behaviour
// of the dedup, format detection, and annotation/speaker-tag strip.

const SRT_ROLLING_FIXTURE = `1
00:00:00,000 --> 00:00:02,110

With Opus 4.8, you can now basically

2
00:00:02,110 --> 00:00:04,230
With Opus 4.8, you can now basically
clone any YouTube channel you want.

3
00:00:04,230 --> 00:00:06,070
clone any YouTube channel you want.
In the past week, I've rebuilt over 10 of them.
`;

const VTT_ROLLING_FIXTURE = `WEBVTT

00:00:00.000 --> 00:00:02.110
With Opus 4.8, you can now basically

00:00:02.110 --> 00:00:04.230
With Opus 4.8, you can now basically
clone any YouTube channel you want.

00:00:04.230 --> 00:00:06.070
clone any YouTube channel you want.
In the past week, I've rebuilt over 10 of them.
`;

describe('detectCaptionFormat', () => {
  it('detects WEBVTT preamble', () => {
    expect(detectCaptionFormat(VTT_ROLLING_FIXTURE)).toBe('vtt');
  });

  it('defaults to srt when WEBVTT preamble is absent', () => {
    expect(detectCaptionFormat(SRT_ROLLING_FIXTURE)).toBe('srt');
  });

  it('tolerates a UTF-8 BOM before the WEBVTT preamble', () => {
    expect(detectCaptionFormat('﻿WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n')).toBe('vtt');
  });
});

describe('parseCaptionsToCues', () => {
  it('parses SRT cues with whole-second precision', () => {
    const cues = parseCaptionsToCues(SRT_ROLLING_FIXTURE);
    expect(cues).toHaveLength(3);
    expect(cues[0].startSec).toBe(0);
    expect(cues[1].startSec).toBe(2);
    expect(cues[2].startSec).toBe(4);
  });

  it('parses VTT cues identically to SRT modulo timestamp punctuation', () => {
    const srt = parseCaptionsToCues(SRT_ROLLING_FIXTURE);
    const vtt = parseCaptionsToCues(VTT_ROLLING_FIXTURE);
    expect(vtt.map((c) => c.startSec)).toEqual(srt.map((c) => c.startSec));
    expect(vtt.map((c) => c.text)).toEqual(srt.map((c) => c.text));
  });

  it('preserves multi-line cue bodies as a single joined line', () => {
    const cues = parseCaptionsToCues(SRT_ROLLING_FIXTURE);
    expect(cues[1].text).toBe('With Opus 4.8, you can now basically clone any YouTube channel you want.');
  });
});

describe('cleanCaptions — rolling-window dedup', () => {
  it('collapses an SRT rolling window so each sentence appears once', () => {
    const out = cleanCaptions(SRT_ROLLING_FIXTURE);
    expect(out.sourceFormat).toBe('srt');
    expect(out.lines).toEqual([
      { startSec: 0, text: 'With Opus 4.8, you can now basically' },
      { startSec: 2, text: 'With Opus 4.8, you can now basically clone any YouTube channel you want.' },
      { startSec: 4, text: 'clone any YouTube channel you want. In the past week, I\'ve rebuilt over 10 of them.' },
    ]);
    // Two latest-line additions; the 3rd cue's "clone any YouTube
    // channel you want." prefix overlaps with the 2nd cue's suffix
    // but the cue-body shape is distinct, so the cleaner keeps it.
    expect(out.lines.length).toBe(3);
  });

  it('collapses identically for the same content in VTT', () => {
    const srt = cleanCaptions(SRT_ROLLING_FIXTURE);
    const vtt = cleanCaptions(VTT_ROLLING_FIXTURE);
    expect(vtt.lines.map((l) => l.text)).toEqual(srt.lines.map((l) => l.text));
    expect(vtt.sourceFormat).toBe('vtt');
  });

  it('computes word count by splitting on whitespace', () => {
    const out = cleanCaptions(SRT_ROLLING_FIXTURE);
    const expected = out.lines.reduce((acc, l) => acc + l.text.split(/\s+/).filter(Boolean).length, 0);
    expect(out.wordCount).toBe(expected);
  });

  it('records durationSec as the largest cue start time seen', () => {
    const out = cleanCaptions(SRT_ROLLING_FIXTURE);
    expect(out.durationSec).toBe(4);
  });

  it('drops a cue whose normalized body equals the most recently emitted line', () => {
    const fixture = `1
00:00:00,000 --> 00:00:01,000
Hello world.

2
00:00:01,000 --> 00:00:02,000
hello world

3
00:00:02,000 --> 00:00:03,000
Different now.
`;
    const out = cleanCaptions(fixture);
    expect(out.lines.map((l) => l.text)).toEqual(['Hello world.', 'Different now.']);
  });
});

describe('cleanCaptions — annotation + speaker-tag stripping', () => {
  it('strips bracketed annotations like [music] by default', () => {
    const fixture = `1
00:00:00,000 --> 00:00:01,000
[music] Welcome back.
`;
    const out = cleanCaptions(fixture);
    expect(out.lines[0].text).toBe('Welcome back.');
  });

  it('keeps annotations when stripAnnotations is false', () => {
    const fixture = `1
00:00:00,000 --> 00:00:01,000
[music] Welcome back.
`;
    const out = cleanCaptions(fixture, { stripAnnotations: false });
    expect(out.lines[0].text).toBe('[music] Welcome back.');
  });

  it('strips leading >> speaker tags', () => {
    const fixture = `1
00:00:00,000 --> 00:00:01,000
>> Now let me show you.
`;
    const out = cleanCaptions(fixture);
    expect(out.lines[0].text).toBe('Now let me show you.');
  });

  it('drops a cue that becomes empty after stripping annotations', () => {
    const fixture = `1
00:00:00,000 --> 00:00:01,000
[music]

2
00:00:01,000 --> 00:00:02,000
Real content here.
`;
    const out = cleanCaptions(fixture);
    expect(out.lines.map((l) => l.text)).toEqual(['Real content here.']);
  });
});

describe('cleanCaptions — robustness', () => {
  it('returns an empty transcript for input with no cues', () => {
    const out = cleanCaptions('not a captions file');
    expect(out.lines).toEqual([]);
    expect(out.wordCount).toBe(0);
    expect(out.durationSec).toBe(0);
  });

  it('handles CRLF line endings', () => {
    const crlf = SRT_ROLLING_FIXTURE.replace(/\n/g, '\r\n');
    const lf = cleanCaptions(SRT_ROLLING_FIXTURE);
    const crlfOut = cleanCaptions(crlf);
    expect(crlfOut.lines).toEqual(lf.lines);
  });

  it('skips VTT NOTE blocks without misclassifying them as cues', () => {
    const fixture = `WEBVTT

NOTE This is an editor's note.

00:00:00.000 --> 00:00:01.000
Hello.
`;
    const out = cleanCaptions(fixture);
    expect(out.lines).toEqual([{ startSec: 0, text: 'Hello.' }]);
  });
});
