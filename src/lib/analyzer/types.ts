/**
 * Result-shape definitions for the deep YouTube video analyzer
 * (`_plans/2026-05-18-youtube-deep-analyzer.md`).
 *
 * The analyzer asks Gemini for a single JSON object matching
 * `AnalyzedVideo`. The structural guard `isAnalyzedVideo` validates the
 * top-level shape after parsing — we do not use Zod here because the
 * rest of the codebase doesn't (the established pattern is
 * `parseLlmJson` + a hand-written guard).
 *
 * Multi-style is first-class: a typical video has several visual modes
 * (talking-head, B-roll, animated-explainer). The analyzer emits a
 * `style_packs` array, and each scene carries the `style_pack_id` it
 * belongs to. The operator can save any single pack as a
 * `production_doc_styles` (ResolvedStyle) preset independently — the
 * Style-Pack tab on the result page lists packs as cards with their
 * own "Save as preset" button.
 *
 * Versioning: `ANALYZER_VERSION` + `PROMPT_VERSION` together form the
 * cache key alongside `(workspace_id, video_id)`. Bump
 * `PROMPT_VERSION` whenever `buildAnalyzerPrompt` changes in a way
 * that materially alters the output schema or quality. Bump
 * `ANALYZER_VERSION` for a wider-scope change (model swap, new
 * post-processing pass). Both are read by the POST route to write the
 * cache key and by the GET route's "stale" badge.
 */

export const ANALYZER_VERSION = 'v1';
export const PROMPT_VERSION = 'v1.0.0';

/** Stage of a row in `youtube_analyses`. The route flips it through
 *  these states during a single inline POST: 'analyzing' on insert,
 *  then 'done' or 'failed' on completion. */
export type AnalysisStage = 'analyzing' | 'done' | 'failed';

export interface AnalyzedVideoMeta {
  video_id: string;
  title: string;
  channel: string;
  duration_seconds: number;
  analyzer_version: string;
  prompt_version: string;
  analyzed_at: string;
}

export interface TranscriptChapter {
  start: number;
  end: number;
  title: string;
}

export interface AnalyzedTranscript {
  text: string;
  chapters: TranscriptChapter[];
}

export interface AnalyzedScene {
  start: number;
  end: number;
  style_pack_id: string;
  summary: string;
  visual_description: string;
  audio_description: string;
  confidence: number;
}

export type VoicePace = 'slow' | 'medium' | 'fast';
export type VoiceEnergy = 'low' | 'medium' | 'high';

export interface VoiceStyle {
  pace: VoicePace;
  energy: VoiceEnergy;
  register: string;
  sample_lines: string[];
}

export interface ScenePacing {
  avg_scene_seconds: number;
  cut_style: string;
}

export interface StylePack {
  id: string;
  label: string;
  occupies_seconds: number;
  scene_count: number;
  overall_look: string;
  color_palette: string[];
  lighting: string;
  camera_grammar: string;
  typography_and_overlays: string;
  pacing: ScenePacing;
  /** Null when this pack covers segments without narration (pure music interludes, etc). */
  voice_style: VoiceStyle | null;
  music_and_sfx: string;
  suggested_ai_image_suffix: string;
  suggested_mixing_rules: string;
  confidence_per_field: Record<string, number>;
}

export interface StrategicHook {
  duration_seconds: number;
  what_works: string;
  how_to_replicate: string;
}

export interface StrategicReport {
  hook: StrategicHook;
  structure: string;
  pacing_analysis: string;
  standout_techniques: string[];
  weaknesses: string[];
  replication_ideas: string[];
}

export interface AnalyzedVideo {
  meta: AnalyzedVideoMeta;
  transcript: AnalyzedTranscript;
  scenes: AnalyzedScene[];
  style_packs: StylePack[];
  strategic_report: StrategicReport;
}

// ─── Structural guard ─────────────────────────────────────────────────

/**
 * Returns true when `x` has the top-level shape `AnalyzedVideo`. This is
 * a SHAPE check, not a deep validator — individual string fields may be
 * empty and individual numbers may be off. The downstream UI must
 * defensively render with sensible fallbacks for empty fields.
 *
 * What is enforced:
 *   - All five top-level keys present.
 *   - `meta` has the expected primitives.
 *   - `transcript.chapters` is an array (may be empty).
 *   - `scenes` is an array. Each scene has start/end numbers + a
 *     `style_pack_id` string.
 *   - `style_packs` is a NON-EMPTY array. Each pack has the required
 *     fields, including `color_palette` as a string array and `pacing`
 *     as the right object shape. `voice_style` is either null or an
 *     object with `pace`/`energy`/`register`/`sample_lines`.
 *   - `strategic_report` has the expected nested objects.
 *
 * What is NOT enforced (left to the UI):
 *   - Cross-references between `scene.style_pack_id` and the
 *     `style_packs[].id` set. The /analyze result page surfaces
 *     "orphaned" scenes (id not in pack list) as ungrouped at the
 *     bottom rather than failing the analysis.
 *   - Numeric ranges (durations >= 0, confidences in [0, 1]).
 *   - `voice_style.pace` / `energy` being in their literal unions.
 */
export function isAnalyzedVideo(x: unknown): x is AnalyzedVideo {
  if (!isRecord(x)) return false;
  if (!isRecord(x.meta)) return false;
  const m = x.meta;
  if (typeof m.video_id !== 'string' || typeof m.title !== 'string' || typeof m.channel !== 'string') return false;
  if (typeof m.duration_seconds !== 'number') return false;
  if (typeof m.analyzer_version !== 'string' || typeof m.prompt_version !== 'string') return false;
  if (typeof m.analyzed_at !== 'string') return false;

  if (!isRecord(x.transcript)) return false;
  if (typeof x.transcript.text !== 'string') return false;
  if (!Array.isArray(x.transcript.chapters)) return false;

  if (!Array.isArray(x.scenes)) return false;
  for (const s of x.scenes) {
    if (!isRecord(s)) return false;
    if (typeof s.start !== 'number' || typeof s.end !== 'number') return false;
    if (typeof s.style_pack_id !== 'string') return false;
    if (typeof s.summary !== 'string' || typeof s.visual_description !== 'string' || typeof s.audio_description !== 'string') return false;
    if (typeof s.confidence !== 'number') return false;
  }

  if (!Array.isArray(x.style_packs) || x.style_packs.length === 0) return false;
  for (const p of x.style_packs) {
    if (!isRecord(p)) return false;
    if (typeof p.id !== 'string' || typeof p.label !== 'string') return false;
    if (typeof p.occupies_seconds !== 'number' || typeof p.scene_count !== 'number') return false;
    if (typeof p.overall_look !== 'string' || typeof p.lighting !== 'string') return false;
    if (typeof p.camera_grammar !== 'string' || typeof p.typography_and_overlays !== 'string') return false;
    if (!Array.isArray(p.color_palette) || !p.color_palette.every((c: unknown) => typeof c === 'string')) return false;
    if (!isRecord(p.pacing)) return false;
    if (typeof p.pacing.avg_scene_seconds !== 'number' || typeof p.pacing.cut_style !== 'string') return false;
    if (p.voice_style !== null) {
      if (!isRecord(p.voice_style)) return false;
      if (typeof p.voice_style.pace !== 'string' || typeof p.voice_style.energy !== 'string' || typeof p.voice_style.register !== 'string') return false;
      if (!Array.isArray(p.voice_style.sample_lines) || !p.voice_style.sample_lines.every((s: unknown) => typeof s === 'string')) return false;
    }
    if (typeof p.music_and_sfx !== 'string') return false;
    if (typeof p.suggested_ai_image_suffix !== 'string' || typeof p.suggested_mixing_rules !== 'string') return false;
    if (!isRecord(p.confidence_per_field)) return false;
  }

  if (!isRecord(x.strategic_report)) return false;
  const r = x.strategic_report;
  if (!isRecord(r.hook)) return false;
  if (typeof r.hook.duration_seconds !== 'number' || typeof r.hook.what_works !== 'string' || typeof r.hook.how_to_replicate !== 'string') return false;
  if (typeof r.structure !== 'string' || typeof r.pacing_analysis !== 'string') return false;
  if (!Array.isArray(r.standout_techniques) || !r.standout_techniques.every((s: unknown) => typeof s === 'string')) return false;
  if (!Array.isArray(r.weaknesses) || !r.weaknesses.every((s: unknown) => typeof s === 'string')) return false;
  if (!Array.isArray(r.replication_ideas) || !r.replication_ideas.every((s: unknown) => typeof s === 'string')) return false;

  return true;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
