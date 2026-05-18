import { describe, expect, it } from 'vitest';
import { isAnalyzedVideo, validateAnalyzedVideo } from '@/lib/analyzer/types';

/**
 * Coverage for `validateAnalyzedVideo` — the structural guard the deep
 * video analyzer route uses to decide whether a Gemini response is
 * usable. Before this validator existed the guard returned a bare
 * boolean, so a schema mismatch left the operator with no way to know
 * which field broke. These tests pin the "which field" contract.
 */

function validBase(): unknown {
  return {
    meta: {
      video_id: 'h6fcK_fRYaI',
      title: 'The Egg',
      channel: 'Kurzgesagt',
      duration_seconds: 480,
      analyzer_version: 'v1',
      prompt_version: 'v1.0.0',
      analyzed_at: '2026-05-18T12:00:00Z',
    },
    transcript: { text: '', chapters: [] },
    scenes: [
      {
        start: 0,
        end: 30,
        style_pack_id: 'animated',
        summary: 's',
        visual_description: 'v',
        audio_description: 'a',
        confidence: 0.9,
      },
    ],
    style_packs: [
      {
        id: 'animated',
        label: 'Animated',
        occupies_seconds: 480,
        scene_count: 1,
        overall_look: 'flat 2d animation',
        color_palette: ['#0b3954'],
        lighting: 'painted',
        camera_grammar: 'animated parallax',
        typography_and_overlays: 'none',
        pacing: { avg_scene_seconds: 30, cut_style: 'slow' },
        voice_style: {
          pace: 'slow',
          energy: 'medium',
          register: 'contemplative',
          sample_lines: ['line one'],
        },
        music_and_sfx: 'orchestral',
        suggested_ai_image_suffix: 'flat 2d kurzgesagt',
        suggested_mixing_rules: 'AI for all',
        confidence_per_field: { overall_look: 0.9 },
      },
    ],
    strategic_report: {
      hook: { duration_seconds: 12, what_works: 'w', how_to_replicate: 'h' },
      structure: 's',
      pacing_analysis: 'p',
      standout_techniques: ['t'],
      weaknesses: [],
      replication_ideas: ['idea'],
    },
  };
}

describe('validateAnalyzedVideo — happy path', () => {
  it('accepts a fully-formed payload', () => {
    const r = validateAnalyzedVideo(validBase());
    expect(r.ok).toBe(true);
  });

  it('accepts voice_style === null (pure music or silent animation pack)', () => {
    const x = validBase() as { style_packs: { voice_style: unknown }[] };
    x.style_packs[0].voice_style = null;
    expect(validateAnalyzedVideo(x).ok).toBe(true);
  });
});

describe('validateAnalyzedVideo — top-level failures', () => {
  it('rejects non-object root with a reason', () => {
    expect(validateAnalyzedVideo(null)).toEqual({ ok: false, reason: 'root: expected object' });
    expect(validateAnalyzedVideo('hello')).toEqual({ ok: false, reason: 'root: expected object' });
    expect(validateAnalyzedVideo([])).toEqual({ ok: false, reason: 'root: expected object' });
  });

  it('points at the missing meta field', () => {
    const x = validBase() as { meta: Record<string, unknown> };
    delete x.meta.duration_seconds;
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('meta.duration_seconds: expected number');
  });

  it('points at a malformed transcript', () => {
    const x = validBase() as { transcript: Record<string, unknown> };
    x.transcript.chapters = 'not-an-array';
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('transcript.chapters: expected array');
  });

  it('points at the specific scene index that broke', () => {
    const x = validBase() as { scenes: unknown[] };
    x.scenes.push({
      start: 30,
      end: 60,
      style_pack_id: 42, // wrong type
      summary: 's',
      visual_description: 'v',
      audio_description: 'a',
      confidence: 0.5,
    });
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scenes[1].style_pack_id: expected string');
  });

  it('rejects empty style_packs with the dedicated reason', () => {
    const x = validBase() as { style_packs: unknown[] };
    x.style_packs = [];
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('style_packs: must be non-empty (at least one mode required)');
  });

  it('points at a malformed style_pack nested field', () => {
    const x = validBase() as { style_packs: { color_palette: unknown }[] };
    x.style_packs[0].color_palette = ['#fff', 42];
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('style_packs[0].color_palette[1]: expected string');
  });

  it('points at a malformed voice_style sub-field when voice_style is non-null', () => {
    const x = validBase() as { style_packs: { voice_style: Record<string, unknown> }[] };
    x.style_packs[0].voice_style = {
      pace: 'slow',
      energy: 'medium',
      register: 'contemplative',
      sample_lines: ['ok', 99],
    };
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('style_packs[0].voice_style.sample_lines[1]: expected string');
  });

  it('points at a malformed strategic_report nested field', () => {
    const x = validBase() as { strategic_report: { hook: Record<string, unknown> } };
    x.strategic_report.hook.duration_seconds = 'twelve';
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('strategic_report.hook.duration_seconds: expected number');
  });
});

describe('validateAnalyzedVideo — optional warnings field', () => {
  it('accepts a payload with no warnings field', () => {
    const x = validBase() as Record<string, unknown>;
    expect('warnings' in x).toBe(false);
    expect(validateAnalyzedVideo(x).ok).toBe(true);
  });

  it('accepts warnings as a string[] when present', () => {
    const x = validBase() as Record<string, unknown>;
    x.warnings = ['scenes[last].end overflow: 437s vs 277s', 'scenes[0..1]: gap of 1.5s'];
    expect(validateAnalyzedVideo(x).ok).toBe(true);
  });

  it('accepts empty warnings array (the normalizer never writes this, but the shape is valid)', () => {
    const x = validBase() as Record<string, unknown>;
    x.warnings = [];
    expect(validateAnalyzedVideo(x).ok).toBe(true);
  });

  it('rejects warnings when it is not an array', () => {
    const x = validBase() as Record<string, unknown>;
    x.warnings = 'not-an-array';
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('warnings: expected array when present');
  });

  it('points at the specific warnings index that is not a string', () => {
    const x = validBase() as Record<string, unknown>;
    x.warnings = ['ok', 42];
    const r = validateAnalyzedVideo(x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('warnings[1]: expected string');
  });
});

describe('isAnalyzedVideo (boolean wrapper)', () => {
  it('mirrors validateAnalyzedVideo on the happy path', () => {
    expect(isAnalyzedVideo(validBase())).toBe(true);
  });

  it('mirrors validateAnalyzedVideo on the unhappy path', () => {
    expect(isAnalyzedVideo(null)).toBe(false);
    const x = validBase() as { style_packs: unknown[] };
    x.style_packs = [];
    expect(isAnalyzedVideo(x)).toBe(false);
  });
});
