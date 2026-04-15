import { VideoShot, VideoConfig, inferSceneType, DEFAULT_BRAND_KIT, BrandKit } from './types';

// ─── Timecode Parsing ──────────────────────────────────────────────────────────

/**
 * Parse a timecode string like "0:15", "1:23", "0:00–0:15" into milliseconds.
 * Returns start of the range if it's a range.
 */
export function parseTimecodeToMs(timecode: string): number {
  if (!timecode || typeof timecode !== 'string') return 0;
  // Strip range (take the start), handle em-dash, en-dash, hyphen
  const start = timecode.split(/[–\-—]/)[0].trim();
  if (!start) return 0;
  const parts = start.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    if (isNaN(minutes) || isNaN(seconds)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[remotion] Invalid timecode format: "${timecode}" — defaulting to 0ms`);
      }
      return 0;
    }
    return (Math.abs(minutes) * 60 + Math.abs(seconds)) * 1000;
  }
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[remotion] Invalid timecode format: "${timecode}" — defaulting to 0ms`);
      }
      return 0;
    }
    return (Math.abs(hours) * 3600 + Math.abs(minutes) * 60 + Math.abs(seconds)) * 1000;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(`[remotion] Unrecognized timecode format: "${timecode}" — defaulting to 0ms`);
  }
  return 0;
}

/** Convert milliseconds to Remotion frame number */
export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

/** Convert frame number to milliseconds */
export function frameToMs(frame: number, fps: number): number {
  return (frame / fps) * 1000;
}

/** Parse total duration string like "3:45" to milliseconds */
export function parseDurationToMs(duration: string): number {
  return parseTimecodeToMs(duration);
}

// ─── Shot Duration Calculation ─────────────────────────────────────────────────

/**
 * Calculate duration of each shot from sequential timecodes.
 * The last shot extends to the total video duration.
 */
export function calcShotDurations(
  timecodes: string[],
  totalDurationMs: number,
  minShotMs = 1500,
): number[] {
  const starts = timecodes.map(parseTimecodeToMs);
  return starts.map((start, i) => {
    const next = starts[i + 1] ?? totalDurationMs;
    return Math.max(next - start, minShotMs);
  });
}

// ─── Words Per Minute → ms per shot ───────────────────────────────────────────

/**
 * Estimate shot duration from word count and speaking pace.
 */
export function wpmToDurationMs(wordCount: number, wpm: number): number {
  return Math.round((wordCount / wpm) * 60 * 1000);
}

// ─── Production Doc → VideoConfig Conversion ──────────────────────────────────

export interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
}

export interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
}

export interface RowImageState {
  status: string;
  imageUrl?: string;
}

/**
 * Convert a ProductionDoc + its generated image URLs into a VideoConfig
 * ready to pass to the Remotion composition.
 */
export function productionDocToVideoConfig(
  doc: ProductionDoc,
  rowImages: (RowImageState | null)[],
  voiceoverUrl?: string,
  musicUrl?: string,
  brand?: Partial<BrandKit>,
): VideoConfig {
  const fps = 30;
  const totalMs = parseDurationToMs(doc.total_duration) || 60_000;
  const timecodes = doc.rows.map(r => r.timecode);
  const durations = calcShotDurations(timecodes, totalMs);

  const shots: VideoShot[] = doc.rows.map((row, i) => {
    const startMs = parseTimecodeToMs(row.timecode);
    const durationMs = durations[i];
    const imageState = rowImages[i];
    const imageUrl = imageState?.status === 'done' ? imageState.imageUrl : undefined;

    return {
      startMs,
      durationMs,
      sceneType: inferSceneType(row.visual_type),
      imageUrl,
      title: row.on_screen_text || undefined,
      onScreenText: row.on_screen_text || undefined,
      scriptText: row.script_text || undefined,
      floatImage: true,
    };
  });

  return {
    fps,
    width: 1920,
    height: 1080,
    shots,
    voiceoverUrl,
    musicUrl,
    musicVolume: 0.12,
    brand: { ...DEFAULT_BRAND_KIT, ...brand },
    showCaptions: true,
  };
}

/** Total frame count for a VideoConfig */
export function totalFrames(config: VideoConfig): number {
  if (!config.shots.length) return config.fps * 10;
  const last = config.shots[config.shots.length - 1];
  return msToFrame(last.startMs + last.durationMs, config.fps);
}

/** Clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
