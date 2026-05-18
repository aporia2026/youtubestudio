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
export const PROMPT_VERSION = 'v1.4.0';

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
  /**
   * Server-side consistency warnings attached by `normalizeAnalyzedVideo`
   * (see ./normalize.ts). Populated when scene boundaries, pack
   * identities, or pack arithmetic disagree with `meta.duration_seconds`.
   * Optional / absent on a clean payload. Persisted alongside the
   * result so the GET endpoint can surface them without the operator
   * having to grep server logs.
   */
  warnings?: string[];
}

// ─── Structural guard ─────────────────────────────────────────────────

/**
 * Result shape returned by `validateAnalyzedVideo`. On failure, `reason`
 * names the FIRST field that did not match — the route surfaces this
 * back to the operator so a Gemini schema mismatch is debuggable instead
 * of being a black box.
 */
export type AnalyzedVideoValidation =
  | { ok: true; value: AnalyzedVideo }
  | { ok: false; reason: string };

/**
 * Validates `x` against the top-level shape of `AnalyzedVideo` and, on
 * failure, returns the exact field path that broke. This is a SHAPE
 * check, not a deep validator — individual string fields may be empty
 * and individual numbers may be off. The downstream UI must defensively
 * render with sensible fallbacks for empty fields.
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
export function validateAnalyzedVideo(x: unknown): AnalyzedVideoValidation {
  if (!isRecord(x)) return fail('root: expected object');
  if (!isRecord(x.meta)) return fail('meta: expected object');
  const m = x.meta;
  if (typeof m.video_id !== 'string') return fail('meta.video_id: expected string');
  if (typeof m.title !== 'string') return fail('meta.title: expected string');
  if (typeof m.channel !== 'string') return fail('meta.channel: expected string');
  if (typeof m.duration_seconds !== 'number') return fail('meta.duration_seconds: expected number');
  if (typeof m.analyzer_version !== 'string') return fail('meta.analyzer_version: expected string');
  if (typeof m.prompt_version !== 'string') return fail('meta.prompt_version: expected string');
  if (typeof m.analyzed_at !== 'string') return fail('meta.analyzed_at: expected ISO-8601 string');

  if (!isRecord(x.transcript)) return fail('transcript: expected object');
  if (typeof x.transcript.text !== 'string') return fail('transcript.text: expected string');
  if (!Array.isArray(x.transcript.chapters)) return fail('transcript.chapters: expected array');

  if (!Array.isArray(x.scenes)) return fail('scenes: expected array');
  for (let i = 0; i < x.scenes.length; i++) {
    const s = x.scenes[i];
    if (!isRecord(s)) return fail(`scenes[${i}]: expected object`);
    if (typeof s.start !== 'number') return fail(`scenes[${i}].start: expected number`);
    if (typeof s.end !== 'number') return fail(`scenes[${i}].end: expected number`);
    if (typeof s.style_pack_id !== 'string') return fail(`scenes[${i}].style_pack_id: expected string`);
    if (typeof s.summary !== 'string') return fail(`scenes[${i}].summary: expected string`);
    if (typeof s.visual_description !== 'string') return fail(`scenes[${i}].visual_description: expected string`);
    if (typeof s.audio_description !== 'string') return fail(`scenes[${i}].audio_description: expected string`);
    if (typeof s.confidence !== 'number') return fail(`scenes[${i}].confidence: expected number`);
  }

  if (!Array.isArray(x.style_packs)) return fail('style_packs: expected array');
  if (x.style_packs.length === 0) return fail('style_packs: must be non-empty (at least one mode required)');
  for (let i = 0; i < x.style_packs.length; i++) {
    const p = x.style_packs[i];
    if (!isRecord(p)) return fail(`style_packs[${i}]: expected object`);
    if (typeof p.id !== 'string') return fail(`style_packs[${i}].id: expected string`);
    if (typeof p.label !== 'string') return fail(`style_packs[${i}].label: expected string`);
    if (typeof p.occupies_seconds !== 'number') return fail(`style_packs[${i}].occupies_seconds: expected number`);
    if (typeof p.scene_count !== 'number') return fail(`style_packs[${i}].scene_count: expected number`);
    if (typeof p.overall_look !== 'string') return fail(`style_packs[${i}].overall_look: expected string`);
    if (typeof p.lighting !== 'string') return fail(`style_packs[${i}].lighting: expected string`);
    if (typeof p.camera_grammar !== 'string') return fail(`style_packs[${i}].camera_grammar: expected string`);
    if (typeof p.typography_and_overlays !== 'string') return fail(`style_packs[${i}].typography_and_overlays: expected string`);
    if (!Array.isArray(p.color_palette)) return fail(`style_packs[${i}].color_palette: expected array`);
    for (let j = 0; j < p.color_palette.length; j++) {
      if (typeof p.color_palette[j] !== 'string') return fail(`style_packs[${i}].color_palette[${j}]: expected string`);
    }
    if (!isRecord(p.pacing)) return fail(`style_packs[${i}].pacing: expected object`);
    if (typeof p.pacing.avg_scene_seconds !== 'number') return fail(`style_packs[${i}].pacing.avg_scene_seconds: expected number`);
    if (typeof p.pacing.cut_style !== 'string') return fail(`style_packs[${i}].pacing.cut_style: expected string`);
    if (p.voice_style !== null) {
      if (!isRecord(p.voice_style)) return fail(`style_packs[${i}].voice_style: expected null or object`);
      if (typeof p.voice_style.pace !== 'string') return fail(`style_packs[${i}].voice_style.pace: expected string`);
      if (typeof p.voice_style.energy !== 'string') return fail(`style_packs[${i}].voice_style.energy: expected string`);
      if (typeof p.voice_style.register !== 'string') return fail(`style_packs[${i}].voice_style.register: expected string`);
      if (!Array.isArray(p.voice_style.sample_lines)) return fail(`style_packs[${i}].voice_style.sample_lines: expected array`);
      for (let j = 0; j < p.voice_style.sample_lines.length; j++) {
        if (typeof p.voice_style.sample_lines[j] !== 'string') return fail(`style_packs[${i}].voice_style.sample_lines[${j}]: expected string`);
      }
    }
    if (typeof p.music_and_sfx !== 'string') return fail(`style_packs[${i}].music_and_sfx: expected string`);
    if (typeof p.suggested_ai_image_suffix !== 'string') return fail(`style_packs[${i}].suggested_ai_image_suffix: expected string`);
    if (typeof p.suggested_mixing_rules !== 'string') return fail(`style_packs[${i}].suggested_mixing_rules: expected string`);
    if (!isRecord(p.confidence_per_field)) return fail(`style_packs[${i}].confidence_per_field: expected object`);
  }

  if (!isRecord(x.strategic_report)) return fail('strategic_report: expected object');
  const r = x.strategic_report;
  if (!isRecord(r.hook)) return fail('strategic_report.hook: expected object');
  if (typeof r.hook.duration_seconds !== 'number') return fail('strategic_report.hook.duration_seconds: expected number');
  if (typeof r.hook.what_works !== 'string') return fail('strategic_report.hook.what_works: expected string');
  if (typeof r.hook.how_to_replicate !== 'string') return fail('strategic_report.hook.how_to_replicate: expected string');
  if (typeof r.structure !== 'string') return fail('strategic_report.structure: expected string');
  if (typeof r.pacing_analysis !== 'string') return fail('strategic_report.pacing_analysis: expected string');
  if (!Array.isArray(r.standout_techniques)) return fail('strategic_report.standout_techniques: expected array');
  for (let i = 0; i < r.standout_techniques.length; i++) {
    if (typeof r.standout_techniques[i] !== 'string') return fail(`strategic_report.standout_techniques[${i}]: expected string`);
  }
  if (!Array.isArray(r.weaknesses)) return fail('strategic_report.weaknesses: expected array');
  for (let i = 0; i < r.weaknesses.length; i++) {
    if (typeof r.weaknesses[i] !== 'string') return fail(`strategic_report.weaknesses[${i}]: expected string`);
  }
  if (!Array.isArray(r.replication_ideas)) return fail('strategic_report.replication_ideas: expected array');
  for (let i = 0; i < r.replication_ideas.length; i++) {
    if (typeof r.replication_ideas[i] !== 'string') return fail(`strategic_report.replication_ideas[${i}]: expected string`);
  }

  // `warnings` is optional (server-attached after parse), but if
  // present it must be an array of strings — anything else here is a
  // bug in our own code, not a Gemini schema mismatch.
  if (x.warnings !== undefined) {
    if (!Array.isArray(x.warnings)) return fail('warnings: expected array when present');
    for (let i = 0; i < x.warnings.length; i++) {
      if (typeof x.warnings[i] !== 'string') return fail(`warnings[${i}]: expected string`);
    }
  }

  return { ok: true, value: x as unknown as AnalyzedVideo };
}

/**
 * Boolean wrapper around `validateAnalyzedVideo`. Kept so existing
 * callers that only need a type-guard don't have to unpack the result.
 * Prefer `validateAnalyzedVideo` whenever the failure reason matters.
 */
export function isAnalyzedVideo(x: unknown): x is AnalyzedVideo {
  return validateAnalyzedVideo(x).ok;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
