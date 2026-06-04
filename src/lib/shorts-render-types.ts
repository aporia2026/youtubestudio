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
  /** Per-word boundaries within the chunk. Attached by
   *  `attachWordTimingsToChunks` when ElevenLabs forced-alignment is
   *  available. Drives the karaoke / word-highlight effects in the
   *  renderer; when undefined the renderer falls back to chunk-level
   *  styling (the pre-word-highlight behavior).
   *
   *  Each word's start/end is in ms relative to the audio track, same
   *  reference frame as `start_ms` / `end_ms`. */
  words?: Array<{ text: string; start_ms: number; end_ms: number }>;
}

/** Phase 15.11 — caption style + per-chunk overrides.
 *
 *  Every field is optional. The renderer applies defaults that match the
 *  Phase 5.5 Minimal renderer when fields are missing so existing rendered
 *  Shorts don't visually change unless the user explicitly overrides.
 *
 *  Persisted on `shorts.captions_config` (migration 0112) as JSONB. The
 *  editor reads and writes the whole blob via PATCH /api/shorts/[id]. */
export interface ShortsCaptionsStyle {
  /** Google Fonts family name. Must match one of the 8 families loaded
   *  by `src/remotion/fonts.ts` so the renderer can find it. */
  fontFamily?: 'Inter' | 'Anton' | 'Bebas Neue' | 'Archivo Black' | 'Patrick Hand' | 'Caveat' | 'Source Serif 4' | 'JetBrains Mono';
  /** Multiplier on the auto-computed font size. 1 = default. Useful range 0.5–1.8. */
  sizeScale?: number;
  /** Font weight 100–900. Default depends on family. */
  fontWeight?: number;
  /** Vertical position of the caption band, 0.0 (top) – 1.0 (bottom). Default 0.5. */
  positionY?: number;
  /** Horizontal padding from the frame edges in px (at 1080×1920). Default 80. */
  paddingX?: number;
  /** Fill color (hex or any CSS color). Default '#ffffff'. */
  color?: string;
  /** Highlight color used on the LAST word of each chunk (Minimal style's
   *  payoff focal point). Default = the row's accent_color. */
  highlightColor?: string;
  /** Outline (text-stroke) color. Default 'transparent' = no outline. */
  outlineColor?: string;
  /** Outline width in px. Default 0. */
  outlineWidth?: number;
  /** Drop shadow string (CSS text-shadow value). Default = a soft glow. */
  shadow?: string;
  /** Text transform applied at render time. */
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Letter spacing in px. Default -1.5 (tight). */
  letterSpacing?: number;
  /** Line height multiplier. Default 1.05. */
  lineHeight?: number;
  /** Background pill behind the chunk text. */
  background?: 'none' | 'solid' | 'blur';
  /** Background color when `background === 'solid'`. Default 'rgba(0,0,0,0.6)'. */
  backgroundColor?: string;
  /** Effect applied on chunk change. */
  entryEffect?: 'none' | 'fade' | 'pop' | 'slide-up';
  /** Per-word highlight strategy as the audio plays. Requires word
   *  boundaries on the caption chunk (attached when ElevenLabs
   *  forced-alignment is available). When alignment isn't available,
   *  the renderer falls back to chunk-level styling regardless of this
   *  value.
   *
   *  - `'none'` — every word renders identically (pre-2026-06-05 default).
   *  - `'color'` — current word switches to `activeWordColor` only.
   *  - `'scale'` — current word scales 1.15× briefly.
   *  - `'background'` — current word gets a colored background pill.
   *  - `'karaoke'` — past words dim to `spokenWordColor`, current word
   *    pops to `activeWordColor`, future words stay in `color`.
   *    Classic TikTok / Reels caption look. Default for Doodle + Paint. */
  wordHighlight?: 'none' | 'color' | 'scale' | 'background' | 'karaoke';
  /** Color applied to the currently-spoken word when `wordHighlight`
   *  uses color (i.e. `'color'` or `'karaoke'`). Defaults to
   *  `highlightColor`. */
  activeWordColor?: string;
  /** Color for already-spoken words in `'karaoke'` mode (dimmed past
   *  text). Defaults to a desaturated variant of `color`. */
  spokenWordColor?: string;
}

/** Per-chunk override. When the user edits a chunk's text or timing in the
 *  editor, the override sits here. Indexed by chunk position (0-based) in
 *  the auto-chunked caption array. */
export interface ShortsCaptionChunkOverride {
  /** Replacement text. When set, overrides the auto-chunked word group. */
  text?: string;
  /** Replacement start time in milliseconds. */
  start_ms?: number;
  /** Replacement end time in milliseconds. */
  end_ms?: number;
  /** Hide this chunk entirely from the render. Lets the user kill a stray
   *  chunk without re-editing the script. */
  hidden?: boolean;
}

export interface ShortsCaptionsConfig {
  style?: ShortsCaptionsStyle;
  chunks?: ShortsCaptionChunkOverride[];
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
  /** Phase 15.3 / 15.4 — sibling-frame URLs ordered, with the caption
   *  chunk index each frame swaps in at. Honored for any image-driven
   *  style (`doodle_explainer_2_short`, `paint_explainer_v1_short`);
   *  ignored for minimal. The same array shape is reused across styles
   *  because the renderer just walks frames by chunk index — the visual
   *  difference is in the source images, not the data shape. */
  doodle_frames?: Array<{
    url: string;
    caption_chunk_start_index: number;
    /** Phase 15.17 — i2v animation generated from `url`. When present
     *  the renderer plays the mp4 in place of the still during the
     *  frame's window. The still stays as the OffthreadVideo poster
     *  so any frame the video doesn't render (cold start, error) falls
     *  back cleanly. */
    animation_url?: string;
    /** Phase 15.17 — vendor thumbnail for the animation, used as the
     *  poster. Falls back to `url` when absent. */
    animation_thumbnail_url?: string;
  }>;
  /** Phase 15.11 — caption style + per-chunk overrides. When present, the
   *  composition's caption renderer applies these on top of the defaults.
   *  Threaded through `buildShortVideoConfig` from the row's
   *  `captions_config` JSONB column. */
  captions_config?: ShortsCaptionsConfig;
}

/** Vertical-Shorts canonical dimensions. */
export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
export const SHORT_FPS = 30;

/**
 * The Short's composition is now exactly the voiceover length — no
 * padded tail. Previously a 800ms tail was added "defensively" so a
 * closing card wouldn't get cut off during MediaRecorder/Blob streaming,
 * but it leaves blank time at the end of every preview and confuses
 * the editor's duration math. If a future closing-card need surfaces,
 * the renderer should add its own padding internally instead of the
 * composition-level constant leaking into every consumer's math.
 */
export const SHORT_OUTRO_TAIL_MS = 0;

/** Default background — deep purple-to-black gradient that doesn't
 *  fight the captions. */
export const DEFAULT_SHORT_BACKGROUND = 'linear-gradient(180deg, #1a1033 0%, #050510 100%)';
export const DEFAULT_SHORT_ACCENT = '#a78bfa';
