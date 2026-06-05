/**
 * Rolling-caption cleaner for YouTube auto-generated SRT/VTT files.
 *
 * YouTube's auto-captions emit a "rolling" two-line window: every
 * cue contains the *previous* line plus the *new* line. A naive
 * concatenation of all cue text would repeat each sentence 2-3×.
 * The cleaner walks the cues, collapses the rolling window into a
 * single ordered sentence sequence, and returns the cleaned shape
 * the analyze stage feeds to the LLM.
 *
 * Why a dedicated cleaner instead of `--no-write-auto-subs`:
 *   - Auto-captions are the only source of free transcripts for most
 *     channels (no published transcript, no community captions). We
 *     need them, but we need them clean.
 *   - The duplication isn't byte-identical — speaker tags like `>>`,
 *     `[music]`, and slight whitespace drift all break a naive
 *     `Set`-based dedup. The cleaner normalizes per-cue text before
 *     comparing, then preserves the *first* timestamp it saw a given
 *     text under.
 *
 * Behaviour matches the Python reference I built during the
 * channel-clone exploration phase (2026-06-05), now ported with
 * tests so the same logic ships into auto-pipeline runs.
 */

import type { CleanedTranscript, TranscriptLine } from './types';

/** Heuristic: a string looks like an SRT block index (a bare integer
 *  on its own line) when normalized. SRT has these; WebVTT does not. */
const SRT_INDEX_RE = /^\d+$/;

/** Timestamp line in either SRT (`00:00:01,234 --> 00:00:02,345`) or
 *  VTT (`00:00:01.234 --> 00:00:02.345`) shape. The cleaner accepts
 *  both; the comma-vs-dot is the only meaningful difference for our
 *  purposes (we drop the millis part regardless). */
const TIMESTAMP_LINE_RE =
  /^(\d{2}):(\d{2}):(\d{2})[.,]\d{3}\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,]\d{3}/;

export interface CleanCaptionsOptions {
  /** Drop bracketed annotations like `[music]`, `[applause]`. Default
   *  true — these add nothing useful for style/audience analysis. */
  stripAnnotations?: boolean;
  /** Drop leading speaker tags like `>>` that YouTube auto-captions
   *  insert for diarization. Default true. */
  stripSpeakerTags?: boolean;
}

/** Detect the source format from raw text. SRT has WEBVTT-free
 *  preamble plus integer indexes between cues; VTT starts with the
 *  literal "WEBVTT". A few SRT exporters add a BOM. */
export function detectCaptionFormat(raw: string): 'srt' | 'vtt' {
  const head = raw.replace(/^﻿/, '').trimStart().slice(0, 16).toUpperCase();
  return head.startsWith('WEBVTT') ? 'vtt' : 'srt';
}

/** Parse a raw SRT or VTT file into an ordered list of (start, text)
 *  cues. Timestamps are truncated to whole seconds — sufficient for
 *  prompting; we don't seek on these. */
export function parseCaptionsToCues(raw: string): { startSec: number; text: string }[] {
  // Normalize line endings + strip BOM.
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues: { startSec: number; text: string }[] = [];

  let i = 0;
  while (i < lines.length) {
    // Skip blanks.
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    // VTT preamble.
    if (lines[i].trim().toUpperCase().startsWith('WEBVTT')) {
      i++;
      continue;
    }
    // SRT index line: a bare integer. Skip it; the next line is the
    // timestamp.
    if (SRT_INDEX_RE.test(lines[i].trim())) {
      i++;
    }
    if (i >= lines.length) break;
    const tsMatch = TIMESTAMP_LINE_RE.exec(lines[i].trim());
    if (!tsMatch) {
      // Not a timestamp line — skip and resync. Robust to NOTE blocks
      // and stray header lines.
      i++;
      continue;
    }
    const startSec =
      Number(tsMatch[1]) * 3600 + Number(tsMatch[2]) * 60 + Number(tsMatch[3]);
    i++;
    // YouTube's auto-SRT sometimes inserts a blank/whitespace-only
    // line between the timestamp and the body — skip those before
    // we start collecting body lines, otherwise the cue body comes
    // out empty and the actual text gets parsed as if it were a
    // new (timestamp-less) cue.
    while (i < lines.length && lines[i].trim() === '') i++;
    // Collect body lines until blank or another timestamp.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !TIMESTAMP_LINE_RE.test(lines[i].trim())) {
      body.push(lines[i]);
      i++;
    }
    const text = body.join(' ').trim();
    if (text === '') continue;
    cues.push({ startSec, text });
  }

  return cues;
}

/** Normalize a cue body for dedup comparison. Collapses whitespace,
 *  lowercases, strips leading `>>` speaker tags, optionally strips
 *  bracketed annotations. The *original* (non-normalized) text is
 *  preserved on output. */
function normalizeForDedup(text: string, opts: Required<CleanCaptionsOptions>): string {
  let t = text;
  if (opts.stripSpeakerTags) t = t.replace(/^\s*>+\s*/gm, ' ');
  if (opts.stripAnnotations) t = t.replace(/\[[^\]]*\]/g, ' ');
  // Strip punctuation for comparison so trailing-period / case
  // drift between rolling-window cues doesn't defeat dedup
  // ("Hello world." vs "hello world" should collapse).
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Clean rolling auto-captions into a deduplicated transcript.
 *
 *  The algorithm walks cues in order. For each cue it normalizes the
 *  body and emits it only if it differs from the most recently
 *  emitted body — this is the same collapse-rolling-window logic that
 *  worked in the Python reference. The first timestamp at which a
 *  given normalized body appeared is preserved on the emitted
 *  TranscriptLine. */
export function cleanCaptions(
  raw: string,
  opts: CleanCaptionsOptions = {},
): CleanedTranscript {
  const fullOpts: Required<CleanCaptionsOptions> = {
    stripAnnotations: opts.stripAnnotations ?? true,
    stripSpeakerTags: opts.stripSpeakerTags ?? true,
  };
  const sourceFormat = detectCaptionFormat(raw);
  const cues = parseCaptionsToCues(raw);
  const lines: TranscriptLine[] = [];
  let lastNorm = '';
  let durationSec = 0;
  for (const cue of cues) {
    durationSec = Math.max(durationSec, cue.startSec);
    const norm = normalizeForDedup(cue.text, fullOpts);
    if (norm === '' || norm === lastNorm) continue;
    // Build the user-facing line: same body but with the same
    // strip-annotations / strip-speaker-tags applied, preserving
    // casing and punctuation otherwise.
    let display = cue.text;
    if (fullOpts.stripSpeakerTags) display = display.replace(/^\s*>+\s*/gm, ' ');
    if (fullOpts.stripAnnotations) display = display.replace(/\[[^\]]*\]/g, ' ');
    display = display.replace(/\s+/g, ' ').trim();
    if (display === '') continue;
    lines.push({ startSec: cue.startSec, text: display });
    lastNorm = norm;
  }
  const wordCount = lines.reduce((acc, l) => acc + l.text.split(/\s+/).filter(Boolean).length, 0);
  return { sourceFormat, wordCount, durationSec, lines };
}
