/**
 * Client-safe types for the Short → MP4 renderer. Shape that the
 * Remotion `ShortVideo` composition consumes; same shape persisted as
 * `inputProps` to the render route.
 *
 * Kept separate from src/remotion/types.ts so the /shorts page can
 * import it without dragging the full horizontal-video infrastructure
 * into the Shorts UI bundle.
 */

export interface ShortCaptionChunk {
  /** Start time relative to the audio track, in milliseconds. */
  start_ms: number;
  /** End time, in milliseconds. */
  end_ms: number;
  /** The chunk's spoken text — typically 1-3 short phrases. */
  text: string;
}

export interface ShortVideoConfig {
  fps: number;
  width: number;
  height: number;
  /** Public URL to the voiceover MP3 (Vercel Blob). */
  voiceover_url: string;
  /** Total duration of the audio + a 250ms tail for the outro card. */
  duration_ms: number;
  /** Pre-chunked captions, ordered by start_ms. */
  captions: ShortCaptionChunk[];
  /** Optional title shown for the first ~1s. Pulled from short.title. */
  title?: string;
  /** Solid background colour or "linear-gradient(...)" string.
   *  Ignored by the Doodle style (which renders frame images full-bleed). */
  background?: string;
  /** Optional accent colour for the caption highlight word. */
  accent_color?: string;
  /** Optional channel name shown as a small badge at the bottom. */
  channel_name?: string;
  /** Phase 15.3 — which style to render with. Composition dispatches:
   *   - 'minimal_gradient_v1' (default) → gradient + caption-only renderer
   *   - 'doodle_explainer_2_short'      → Doodle vertical (full-bleed
   *     image base + sibling-frame variants timed to caption chunks,
   *     captions overlaid in the middle 60% safe zone with yellow comic
   *     bold styling matching the doodle reference)
   *   - 'paint_explainer_v1_short'      → Paint vertical (Phase 15.4 stub)
   *  Unknown / missing falls through to minimal so a malformed config
   *  can't break the render.  */
  style_id?: string;
  /** Phase 15.3 — Doodle frame URLs ordered, with the caption chunk
   *  index each frame swaps in at. Only honored when style_id is
   *  'doodle_explainer_2_short'; ignored for minimal. */
  doodle_frames?: Array<{
    url: string;
    caption_chunk_start_index: number;
  }>;
}

/** Vertical-Shorts canonical dimensions. */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
export const SHORT_FPS = 30;

/**
 * Trailing silence after the last word so the closing card doesn't get
 * cut off when MediaRecorder / Vercel Blob streaming gets impatient.
 */
export const SHORT_OUTRO_TAIL_MS = 800;

/** Default background — deep purple-to-black gradient that doesn't
 *  fight the captions. */
export const DEFAULT_SHORT_BACKGROUND = 'linear-gradient(180deg, #1a1033 0%, #050510 100%)';
export const DEFAULT_SHORT_ACCENT = '#a78bfa';
