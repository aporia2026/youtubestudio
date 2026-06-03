/**
 * Pure helpers for converting a `shorts` row into the
 * `ShortVideoConfig` shape that the Remotion `ShortVideo` composition
 * consumes. Exported for unit tests so caption timing + chunking
 * stay honest as the heuristics evolve.
 *
 * The render orchestrator (POST /api/render/short/route.ts) calls
 * `buildShortVideoConfig` after fetching the shorts row + the
 * channel metadata; it doesn't touch the DB itself so it stays
 * pure and easy to test.
 */
import {
  DEFAULT_SHORT_ACCENT,
  DEFAULT_SHORT_BACKGROUND,
  SHORT_FPS,
  SHORT_HEIGHT,
  SHORT_OUTRO_TAIL_MS,
  SHORT_WIDTH,
  type ShortCaptionChunk,
  type ShortVideoConfig,
} from './shorts-render-types';
import type { ShortRow } from './shorts-types';
import type { ForcedAlignmentResponse } from './elevenlabs';
import { alignRowsToWords } from './voiceover-alignment';

export type {
  ShortCaptionChunk,
  ShortVideoConfig,
} from './shorts-render-types';

// Re-export under the legacy name so existing call sites in this file
// continue to work. New code should import `stripProductionMarkers`
// directly from `./script-markers`.
import { stripProductionMarkers } from './script-markers';
export { stripProductionMarkers as stripScriptMarkers };

/** Approximate word count. Used for proportional caption timing. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Split a script into N caption chunks of roughly equal word count, then
 * map each chunk's start/end onto the audio timeline proportionally.
 *
 * Strategy:
 *   - Target ~3-5 words per chunk (vertical-format captions read fast)
 *   - Respect sentence boundaries when possible — never split on a
 *     clause boundary if the run would land mid-sentence
 *   - Chunks are assigned timestamps by cumulative word index, scaled
 *     to durationMs. So word #N starts at (N / total) * durationMs.
 *
 * Pure function — exported for tests.
 */
/**
 * The exact text the shorts forced-alignment must run on: production markers
 * stripped. This matters because the spoken audio is already stripped — see
 * `synthesizeShortVoiceover` in `shorts.ts`, which removes `[VISUAL: ...]`
 * before TTS — so aligning on the RAW script hands the aligner text the audio
 * never speaks (a `[VISUAL: ...]` block as "word" zero), desyncing every
 * caption from the first frame. Aligning on this stripped text keeps the
 * alignment word stream matched to both the audio and the caption words.
 *
 * The alignment route and the render route both build their cache key from
 * this, so the editor preview and the final render resolve the SAME alignment.
 */
export function shortAlignmentScript(shortScript: string): string {
  return stripProductionMarkers(shortScript);
}

/**
 * Map each caption chunk onto real audio time using the ElevenLabs forced
 * alignment, via the same robust cursor walk the long-form pipeline uses
 * (`alignRowsToWords`). That walk filters the aligner's interleaved spacing
 * tokens, normalises unicode, and absorbs over-segmentation ("don't" → "don"
 * + "t") — none of which a naive script-index → alignment-index mapping can
 * handle (ElevenLabs returns ~2× the tokens, one space between every word, so
 * index mapping drifts immediately). Any chunk the walk can't match falls
 * back to its proportional estimate per-row, so partial alignment degrades
 * gracefully instead of dropping the whole doc.
 *
 * Returns null only when there's no alignment at all — caller then uses the
 * pure proportional scheme. Exported for tests.
 */
export function chunkBoundariesFromAlignment(
  chunkTexts: string[],
  fallbackStartMs: number[],
  durationMs: number,
  alignment: ForcedAlignmentResponse | null | undefined,
): Array<{ start_ms: number; end_ms: number }> | null {
  if (!alignment?.words || alignment.words.length === 0) return null;
  const aligned = alignRowsToWords({
    rowScripts: chunkTexts,
    fallbackStartMs,
    fallbackTotalMs: durationMs,
    alignment,
  });
  return aligned.map((r) => ({
    // Floor start, ceil end — keeps every spoken word covered by SOME
    // caption frame even when boundaries fall mid-frame.
    start_ms: Math.max(0, Math.min(durationMs, Math.floor(r.startMs))),
    end_ms: Math.max(0, Math.min(durationMs, Math.ceil(r.endMs))),
  }));
}

export function splitScriptIntoCaptions(
  script: string,
  durationMs: number,
  targetWordsPerChunk = 4,
  /** Phase 15.11 — when present, caption timing snaps to real word
   *  boundaries from the ElevenLabs forced alignment payload instead of
   *  the proportional words-per-second estimate. Falls back to the
   *  proportional scheme when alignment is null/missing or its word count
   *  is shorter than the script's. */
  alignment?: ForcedAlignmentResponse | null,
): ShortCaptionChunk[] {
  const cleaned = stripProductionMarkers(script);
  if (!cleaned || durationMs <= 0) return [];

  // 1. Word stream with whether each word ends a sentence.
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const sentenceEnders = new Set(['.', '!', '?']);
  const isEndOfSentence = words.map((w) => {
    const last = w.slice(-1);
    return sentenceEnders.has(last);
  });

  // 2. Greedy chunker — accumulate words until we hit a sentence
  //    boundary (with a 3-word minimum so single-word "Yes." doesn't
  //    flash by alone) OR until we reach targetWordsPerChunk and no
  //    sentence boundary is coming up in the next 3 words.
  //    Hard-caps each chunk at 8 words to avoid wall-of-text flashes.
  const chunks: number[][] = []; // arrays of word indexes per chunk
  let buf: number[] = [];
  const MIN_FOR_SENTENCE_END = 3;
  const HARD_CAP = 8;
  for (let i = 0; i < words.length; i++) {
    buf.push(i);
    const overCap = buf.length >= HARD_CAP;
    const endsSentence = isEndOfSentence[i];
    const isLastWord = i === words.length - 1;
    const atTarget = buf.length >= targetWordsPerChunk;
    let endNow = false;
    if (overCap) endNow = true;
    else if (endsSentence && buf.length >= MIN_FOR_SENTENCE_END) endNow = true;
    else if (isLastWord) endNow = true;
    else if (atTarget) {
      // Look ahead: if the next 3 words contain a sentence end, wait
      // for it (more natural). If not, end now to prevent the chunk
      // from growing arbitrarily long.
      const lookahead = isEndOfSentence.slice(i + 1, i + 1 + 3);
      if (!lookahead.some(Boolean)) endNow = true;
    }
    if (endNow) {
      chunks.push(buf);
      buf = [];
    }
  }
  if (buf.length > 0) chunks.push(buf);

  // 3. Time scaling. Prefer real word boundaries from the alignment payload
  //    via the robust cursor walk (Phase 15.11 / 15.16). Build the
  //    proportional baseline first — it's the answer when there's no
  //    alignment, and it's also the per-chunk fallback the walk uses for any
  //    chunk it can't match.
  const totalWords = words.length;
  const chunkTexts = chunks.map((chunkIndexes) => chunkIndexes.map((i) => words[i]!).join(' '));
  const proportionalStartMs = chunks.map((chunkIndexes) =>
    Math.round((chunkIndexes[0]! / totalWords) * durationMs),
  );
  const alignmentBoundaries = chunkBoundariesFromAlignment(
    chunkTexts,
    proportionalStartMs,
    durationMs,
    alignment,
  );

  const result: ShortCaptionChunk[] = chunks.map((chunkIndexes, chunkIdx) => {
    let start_ms: number;
    let end_ms: number;
    if (alignmentBoundaries) {
      start_ms = alignmentBoundaries[chunkIdx]!.start_ms;
      end_ms = alignmentBoundaries[chunkIdx]!.end_ms;
    } else {
      const lastWordIdx = chunkIndexes[chunkIndexes.length - 1]!;
      start_ms = proportionalStartMs[chunkIdx]!;
      // End at the start of the next word (or audio end for the last chunk).
      const nextWordIdx = lastWordIdx + 1;
      end_ms =
        nextWordIdx >= totalWords
          ? durationMs
          : Math.round((nextWordIdx / totalWords) * durationMs);
    }
    return {
      start_ms,
      end_ms,
      text: chunkTexts[chunkIdx]!,
    };
  });
  return result;
}

export interface BuildShortVideoConfigArgs {
  short: Pick<
    ShortRow,
    | 'id'
    | 'short_script'
    | 'voiceover_audio_url'
    | 'voiceover_duration_seconds'
    | 'estimated_duration_seconds'
    | 'title'
    | 'style_id'
    | 'style_assets'
    | 'captions_config'
  >;
  channelName?: string | null;
  background?: string;
  accentColor?: string;
  /** Phase 15.11 — ElevenLabs forced alignment payload for the row's
   *  voiceover. When supplied, caption timing snaps to real word
   *  boundaries instead of proportional-WPM estimates. The render route
   *  fetches this via `ensureAlignmentForVoiceover`; the editor preview
   *  fetches it via `GET /api/shorts/[id]/alignment`. */
  alignment?: ForcedAlignmentResponse | null;
}

/**
 * Compose the full ShortVideoConfig from a shorts row + optional channel
 * branding. Throws when the row has no voiceover URL — render needs
 * audio.
 *
 * Style dispatch (Phase 15.3):
 *   - When `short.style_id === 'doodle_explainer_2_short'`, validates
 *     that `style_assets.doodle.{base_url,variants}` are present and
 *     threads them into `doodle_frames`. The renderer swaps frames at
 *     each variant's caption_chunk_start_index.
 *   - For other styles (minimal default, paint placeholder), no extra
 *     wiring is needed.
 */
export function buildShortVideoConfig(args: BuildShortVideoConfigArgs): ShortVideoConfig {
  const { short } = args;
  if (!short.voiceover_audio_url) {
    throw new Error('Cannot render Short — voiceover not generated yet. Click Voiceover first.');
  }
  if (!short.short_script) {
    // Only extracted Shorts (which always carry a script) are renderable;
    // external SEO-only Shorts have no script to caption.
    throw new Error('Cannot render Short — this Short has no script to caption.');
  }
  // Prefer the actually-measured voiceover duration; fall back to the
  // word-count estimate. Either way add the outro tail so the closing
  // card renders for a beat after the last word.
  const baseSeconds = short.voiceover_duration_seconds ?? short.estimated_duration_seconds ?? 30;
  const durationMs = Math.max(3000, Math.round(baseSeconds * 1000)) + SHORT_OUTRO_TAIL_MS;
  const rawCaptions = splitScriptIntoCaptions(
    short.short_script,
    durationMs - SHORT_OUTRO_TAIL_MS,
    /* targetWordsPerChunk */ 4,
    args.alignment,
  );
  // Apply per-chunk overrides from captions_config (Phase 15.11).
  // Hidden chunks drop from the output entirely; text/timing overrides
  // win over the auto-chunked values.
  const captionsCfg = short.captions_config;
  const chunkOverrides = captionsCfg?.chunks ?? [];
  const captions = rawCaptions
    .map((c, i) => {
      const ov = chunkOverrides[i];
      if (!ov) return c;
      if (ov.hidden) return null;
      return {
        text: typeof ov.text === 'string' && ov.text.trim().length > 0 ? ov.text : c.text,
        start_ms: typeof ov.start_ms === 'number' && Number.isFinite(ov.start_ms) ? ov.start_ms : c.start_ms,
        end_ms: typeof ov.end_ms === 'number' && Number.isFinite(ov.end_ms) ? ov.end_ms : c.end_ms,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const styleId = short.style_id ?? undefined;

  // Image-style dispatch — both Doodle and Paint vertical use the same
  // base+variants asset shape and the same renderer (most-recent-frame
  // walk by chunk index). Only the source images differ. When assets
  // aren't ready we throw with an actionable message; the render dialog
  // must show the "Generate style assets" button first.
  let doodleFrames: ShortVideoConfig['doodle_frames'] | undefined;
  if (styleId === 'doodle_explainer_2_short') {
    const doodle = short.style_assets?.doodle;
    if (!doodle || !doodle.base_url) {
      throw new Error(
        'Cannot render Doodle Short — style assets not generated yet. Click "Generate style assets" first.',
      );
    }
    doodleFrames = [
      {
        url: doodle.base_url,
        caption_chunk_start_index: 0,
        animation_url: doodle.base_animation?.video_url,
        animation_thumbnail_url: doodle.base_animation?.thumbnail_url,
      },
      ...doodle.variants
        .map((v) => ({
          url: v.url,
          caption_chunk_start_index: v.caption_chunk_start_index,
          animation_url: v.animation?.video_url,
          animation_thumbnail_url: v.animation?.thumbnail_url,
        }))
        .sort((a, b) => a.caption_chunk_start_index - b.caption_chunk_start_index),
    ];
  } else if (styleId === 'paint_explainer_v1_short') {
    const paint = short.style_assets?.paint;
    if (!paint || !paint.base_url) {
      throw new Error(
        'Cannot render Paint Short — style assets not generated yet. Click "Generate style assets" first.',
      );
    }
    doodleFrames = [
      {
        url: paint.base_url,
        caption_chunk_start_index: 0,
        animation_url: paint.base_animation?.video_url,
        animation_thumbnail_url: paint.base_animation?.thumbnail_url,
      },
      ...paint.variants
        .map((v) => ({
          url: v.url,
          caption_chunk_start_index: v.caption_chunk_start_index,
          animation_url: v.animation?.video_url,
          animation_thumbnail_url: v.animation?.thumbnail_url,
        }))
        .sort((a, b) => a.caption_chunk_start_index - b.caption_chunk_start_index),
    ];
  }

  return {
    fps: SHORT_FPS,
    width: SHORT_WIDTH,
    height: SHORT_HEIGHT,
    voiceover_url: short.voiceover_audio_url,
    duration_ms: durationMs,
    captions,
    title: short.title?.trim() || undefined,
    background: args.background || DEFAULT_SHORT_BACKGROUND,
    accent_color: args.accentColor || DEFAULT_SHORT_ACCENT,
    channel_name: args.channelName?.trim() || undefined,
    style_id: styleId,
    doodle_frames: doodleFrames,
    captions_config: short.captions_config,
  };
}
