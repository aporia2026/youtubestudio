import { describe, expect, it } from 'vitest';
import { normalizeAnalyzedVideo, rescaleScenesToChapters } from '@/lib/analyzer/normalize';
import type { AnalyzedVideo, StylePack, AnalyzedScene } from '@/lib/analyzer/types';

/**
 * Coverage for the server-side normalizer that ships alongside the
 * Phase 0 eval-surfaced fixes. The normalizer (a) recomputes
 * style_packs[].occupies_seconds from scene durations — closing the
 * Reference A "occupies-sum mismatch" finding — and (b) collects
 * scene-boundary consistency warnings without mutating Gemini's
 * source-of-truth scene timings.
 */

function scene(start: number, end: number, packId: string): AnalyzedScene {
  return {
    start,
    end,
    style_pack_id: packId,
    summary: 's',
    visual_description: 'v',
    audio_description: 'a',
    confidence: 0.9,
  };
}

function pack(id: string, occupies: number): StylePack {
  return {
    id,
    label: id,
    occupies_seconds: occupies,
    scene_count: 0,
    overall_look: 'o',
    color_palette: ['#000000'],
    lighting: 'l',
    camera_grammar: 'c',
    typography_and_overlays: 't',
    pacing: { avg_scene_seconds: 0, cut_style: 'cs' },
    voice_style: null,
    music_and_sfx: 'm',
    suggested_ai_image_suffix: 's',
    suggested_mixing_rules: 'r',
    confidence_per_field: {},
  };
}

function buildVideo(opts: {
  duration: number;
  scenes: AnalyzedScene[];
  packs: StylePack[];
  chapters?: Array<{ start: number; end: number; title: string }>;
}): AnalyzedVideo {
  return {
    meta: {
      video_id: 'abcdefghijk',
      title: 't',
      channel: 'c',
      duration_seconds: opts.duration,
      analyzer_version: 'v1',
      prompt_version: 'v1.5.0',
      analyzed_at: '2026-05-19T00:00:00Z',
    },
    transcript: { text: '', chapters: opts.chapters ?? [] },
    scenes: opts.scenes,
    style_packs: opts.packs,
    strategic_report: {
      hook: { duration_seconds: 0, what_works: 'w', how_to_replicate: 'h' },
      structure: 's',
      pacing_analysis: 'p',
      standout_techniques: [],
      weaknesses: [],
      replication_ideas: [],
    },
  };
}

describe('normalizeAnalyzedVideo — occupies_seconds recomputation', () => {
  it('overwrites Gemini-supplied occupies_seconds with the summed scene durations', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 40, 'a'), scene(40, 60, 'b'), scene(60, 100, 'a')],
      packs: [pack('a', 999), pack('b', 1)],
    });
    const out = normalizeAnalyzedVideo(input);
    const a = out.video.style_packs.find((p) => p.id === 'a');
    const b = out.video.style_packs.find((p) => p.id === 'b');
    expect(a?.occupies_seconds).toBe(80);
    expect(b?.occupies_seconds).toBe(20);
  });

  it('leaves the rest of the AnalyzedVideo shape untouched', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.video.meta).toEqual(input.meta);
    expect(out.video.scenes).toEqual(input.scenes);
    expect(out.video.transcript).toEqual(input.transcript);
    expect(out.video.strategic_report).toEqual(input.strategic_report);
  });

  it('keeps the same pack-object reference when occupies_seconds was already correct', () => {
    const exactPack = pack('a', 100);
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [exactPack],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.video.style_packs[0]).toBe(exactPack);
  });

  it('counts a pack at 0 seconds when no scene references it', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 100), pack('orphan', 50)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.video.style_packs.find((p) => p.id === 'orphan')?.occupies_seconds).toBe(0);
  });
});

describe('normalizeAnalyzedVideo — scene-boundary warnings', () => {
  it('emits zero warnings on a clean payload', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 50, 'a'), scene(50, 100, 'a')],
      packs: [pack('a', 100)],
    });
    expect(normalizeAnalyzedVideo(input).warnings).toEqual([]);
  });

  it('warns when the last scene overflows meta.duration_seconds (the Reference B defect)', () => {
    const input = buildVideo({
      duration: 277,
      scenes: [scene(0, 150, 'a'), scene(150, 437, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('overflow') && w.includes('437') && w.includes('277'))).toBe(true);
  });

  it('warns when the last scene underflows meta.duration_seconds', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 50, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('underflow'))).toBe(true);
  });

  it('warns when scenes[0].start is not 0', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(10, 100, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('scenes[0].start'))).toBe(true);
  });

  it('tolerates ±2s rounding at the start and end', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(1, 101, 'a')],
      packs: [pack('a', 0)],
    });
    expect(normalizeAnalyzedVideo(input).warnings).toEqual([]);
  });

  it('warns on a gap between consecutive scenes', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 40, 'a'), scene(50, 100, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('gap'))).toBe(true);
  });

  it('warns on overlapping consecutive scenes', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 60, 'a'), scene(50, 100, 'a')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('overlap'))).toBe(true);
  });

  it('warns about unknown style_pack_id references', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'ghost')],
      packs: [pack('a', 0)],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('ghost'))).toBe(true);
  });

  it('warns about an empty scenes array', () => {
    const input = buildVideo({ duration: 100, scenes: [], packs: [pack('a', 0)] });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('scenes: empty array'))).toBe(true);
  });
});

describe('normalizeAnalyzedVideo — chapter-boundary warnings (v1.5.0)', () => {
  it('emits zero chapter warnings when chapters are absent', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
      // chapters defaults to []
    });
    const chapterWarnings = normalizeAnalyzedVideo(input).warnings.filter((w) => w.startsWith('chapters'));
    expect(chapterWarnings).toEqual([]);
  });

  it('emits zero chapter warnings on a clean payload', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 50, title: 'Intro' },
        { start: 50, end: 100, title: 'Outro' },
      ],
    });
    const chapterWarnings = normalizeAnalyzedVideo(input).warnings.filter((w) => w.startsWith('chapters'));
    expect(chapterWarnings).toEqual([]);
  });

  it('warns when chapters[last].end overflows duration (the v1.4.0 Casey defect)', () => {
    const input = buildVideo({
      duration: 277,
      scenes: [scene(0, 277, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 200, title: 'A' },
        { start: 200, end: 437, title: 'B' },
      ],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('chapters[last].end overflow') && w.includes('437') && w.includes('277'))).toBe(true);
  });

  it('warns when chapters[0].start is not 0', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
      chapters: [{ start: 10, end: 100, title: 'Late' }],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('chapters[0].start'))).toBe(true);
  });

  it('warns on a gap between consecutive chapters', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 40, title: 'A' },
        { start: 50, end: 100, title: 'B' },
      ],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('chapters[0..1]') && w.includes('gap'))).toBe(true);
  });

  it('warns on overlapping consecutive chapters', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 60, title: 'A' },
        { start: 50, end: 100, title: 'B' },
      ],
    });
    const out = normalizeAnalyzedVideo(input);
    expect(out.warnings.some((w) => w.includes('chapters[0..1]') && w.includes('overlap'))).toBe(true);
  });
});

describe('rescaleScenesToChapters — pure helper', () => {
  it('no-ops when no chapters', () => {
    const input = buildVideo({
      duration: 277,
      scenes: [scene(0, 200, 'a'), scene(200, 437, 'a')],
      packs: [pack('a', 0)],
    });
    const out = rescaleScenesToChapters(input, 277);
    expect(out.warnings).toEqual([]);
    expect(out.scenes).toEqual(input.scenes);
  });

  it("no-ops when chapters themselves overflow (don't trust unreliable anchors)", () => {
    const input = buildVideo({
      duration: 277,
      scenes: [scene(0, 200, 'a'), scene(200, 437, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 200, title: 'A' },
        { start: 200, end: 437, title: 'B' },
      ],
    });
    const out = rescaleScenesToChapters(input, 277);
    expect(out.warnings).toEqual([]);
    expect(out.scenes).toEqual(input.scenes);
  });

  it('no-ops when scenes already fit duration_seconds', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 50, 'a'), scene(50, 100, 'a')],
      packs: [pack('a', 0)],
      chapters: [
        { start: 0, end: 50, title: 'A' },
        { start: 50, end: 100, title: 'B' },
      ],
    });
    const out = rescaleScenesToChapters(input, 100);
    expect(out.warnings).toEqual([]);
    expect(out.scenes).toEqual(input.scenes);
  });

  it('rescales the overflowing chapter while leaving aligned chapters untouched (the Casey v1.5.0 case)', () => {
    // Mirrors the actual Casey v1.5.0 output: chapters 1-4 align with
    // scenes; chapter 5 (240-277, 37s span) is claimed by scenes
    // spanning 240-437 (197s). Verify only the last chapter's scenes
    // get rescaled.
    const input = buildVideo({
      duration: 277,
      scenes: [
        scene(0, 22, 'p'), // chapter 1: 0-22 ✓
        scene(22, 119, 'p'), // chapter 2: 22-119 ✓
        scene(119, 205, 'p'), // chapter 3: 119-205 ✓
        scene(205, 240, 'p'), // chapter 4: 205-240 ✓
        scene(240, 300, 'p'), // chapter 5 starts here, overflows
        scene(300, 437, 'p'), // overflows further
      ],
      packs: [pack('p', 0)],
      chapters: [
        { start: 0, end: 22, title: 'A' },
        { start: 22, end: 119, title: 'B' },
        { start: 119, end: 205, title: 'C' },
        { start: 205, end: 240, title: 'D' },
        { start: 240, end: 277, title: 'E' },
      ],
    });
    const out = rescaleScenesToChapters(input, 277);
    // Chapters 1-4's scenes untouched
    expect(out.scenes[0]).toEqual(input.scenes[0]);
    expect(out.scenes[1]).toEqual(input.scenes[1]);
    expect(out.scenes[2]).toEqual(input.scenes[2]);
    expect(out.scenes[3]).toEqual(input.scenes[3]);
    // Chapter 5's scenes rescaled: claimed span 197s → target 37s
    expect(out.scenes[4].start).toBe(240);
    expect(out.scenes[5].end).toBe(277); // last scene snapped to chapter end
    // Relative duration preserved: scene 4 was 60/197 of the chapter,
    // scene 5 was 137/197. After rescale, scene 4 ≈ 11.3s, scene 5 ≈ 25.7s.
    expect(out.scenes[4].end - out.scenes[4].start).toBeCloseTo((60 / 197) * 37, 1);
    expect(out.warnings.some((w) => w.includes('chapter[4] scenes rescaled') && w.includes('2 scenes'))).toBe(true);
  });

  it('snaps the last rescaled scene exactly to chapter.end to preserve contiguity under float drift', () => {
    const input = buildVideo({
      duration: 100,
      scenes: [scene(0, 33, 'p'), scene(33, 67, 'p'), scene(67, 137, 'p')],
      packs: [pack('p', 0)],
      chapters: [{ start: 0, end: 100, title: 'A' }],
    });
    const out = rescaleScenesToChapters(input, 100);
    expect(out.scenes[out.scenes.length - 1].end).toBe(100);
  });
});

describe('normalizeAnalyzedVideo — integration with rescale (the Casey v1.5.0 case end-to-end)', () => {
  it('rescales scenes, then runs boundary checks against the rescaled output', () => {
    const input = buildVideo({
      duration: 277,
      scenes: [
        scene(0, 22, 'p'),
        scene(22, 119, 'p'),
        scene(119, 205, 'p'),
        scene(205, 240, 'p'),
        scene(240, 437, 'p'), // overflows
      ],
      packs: [pack('p', 0)],
      chapters: [
        { start: 0, end: 22, title: 'A' },
        { start: 22, end: 119, title: 'B' },
        { start: 119, end: 205, title: 'C' },
        { start: 205, end: 240, title: 'D' },
        { start: 240, end: 277, title: 'E' },
      ],
    });
    const out = normalizeAnalyzedVideo(input);
    // After rescale the scene-overflow warning should NOT fire — the
    // last scene end is now 277, matching duration_seconds.
    const overflowWarnings = out.warnings.filter((w) => w.includes('scenes[last].end overflow'));
    expect(overflowWarnings).toEqual([]);
    // The rescale warning IS emitted so the operator knows what happened.
    expect(out.warnings.some((w) => w.includes('chapter[4] scenes rescaled'))).toBe(true);
    expect(out.video.scenes[out.video.scenes.length - 1].end).toBe(277);
  });
});
