import { describe, expect, it } from 'vitest';
import { compareAnalyses, summarizeDiff } from '@/lib/analyzer/compare';
import type { AnalyzedVideo, AnalyzedScene, StylePack } from '@/lib/analyzer/types';

/**
 * Coverage for `compareAnalyses` — the pure helper the eval driver's
 * stability mode uses to spot when re-running the same input gives
 * categorically different output. Phase 0 recorded 1/2/3/3 packs
 * across four Casey runs at temperature 0.3; this helper is how that
 * sort of drift becomes a structured signal instead of an "eh, looks
 * different" eyeball check.
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

function pack(id: string, suffixLength: number): StylePack {
  return {
    id,
    label: id,
    occupies_seconds: 0,
    scene_count: 0,
    overall_look: 'o',
    color_palette: ['#000000'],
    lighting: 'l',
    camera_grammar: 'c',
    typography_and_overlays: 't',
    pacing: { avg_scene_seconds: 0, cut_style: 'cs' },
    voice_style: null,
    music_and_sfx: 'm',
    suggested_ai_image_suffix: 'x'.repeat(suffixLength),
    suggested_mixing_rules: 'r',
    confidence_per_field: {},
  };
}

function buildVideo(opts: { duration: number; scenes: AnalyzedScene[]; packs: StylePack[] }): AnalyzedVideo {
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
    transcript: { text: '', chapters: [] },
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

describe('compareAnalyses — happy path / structurally stable', () => {
  it('reports stable when two analyses agree on duration, pack count, pack ids, and scene count', () => {
    const v = buildVideo({
      duration: 277,
      scenes: [scene(0, 100, 'a'), scene(100, 277, 'a')],
      packs: [pack('a', 200)],
    });
    const diff = compareAnalyses(v, v);
    expect(diff.structurallyStable).toBe(true);
    expect(diff.packCountA).toBe(1);
    expect(diff.packIdsInBoth).toEqual(['a']);
    expect(diff.packIdsOnlyInA).toEqual([]);
    expect(diff.packIdsOnlyInB).toEqual([]);
  });

  it('tolerates scene-count drift within 25%', () => {
    const a = buildVideo({
      duration: 100,
      scenes: [scene(0, 50, 'p'), scene(50, 100, 'p')],
      packs: [pack('p', 100)],
    });
    const b = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'p')],
      packs: [pack('p', 100)],
    });
    const diff = compareAnalyses(a, b);
    expect(diff.sceneCountA).toBe(2);
    expect(diff.sceneCountB).toBe(1);
    expect(diff.structurallyStable).toBe(false); // 1/2 = 50% < 75% threshold
  });
});

describe('compareAnalyses — unstable cases', () => {
  it('catches the Casey 1-vs-3-pack drift from Phase 0', () => {
    const oneShot = buildVideo({
      duration: 277,
      scenes: [scene(0, 277, 'travel-vlog')],
      packs: [pack('travel-vlog', 200)],
    });
    const threeShot = buildVideo({
      duration: 277,
      scenes: [scene(0, 277, 'travel-vlog')],
      packs: [pack('travel-vlog', 200), pack('text-card', 100), pack('cinematic-b-roll', 150)],
    });
    const diff = compareAnalyses(oneShot, threeShot);
    expect(diff.structurallyStable).toBe(false);
    expect(diff.packCountA).toBe(1);
    expect(diff.packCountB).toBe(3);
    expect(diff.packIdsOnlyInB.sort()).toEqual(['cinematic-b-roll', 'text-card']);
  });

  it('flags duration disagreement', () => {
    const a = buildVideo({ duration: 100, scenes: [scene(0, 100, 'a')], packs: [pack('a', 50)] });
    const b = buildVideo({ duration: 277, scenes: [scene(0, 277, 'a')], packs: [pack('a', 50)] });
    const diff = compareAnalyses(a, b);
    expect(diff.structurallyStable).toBe(false);
    expect(diff.durationSecondsA).toBe(100);
    expect(diff.durationSecondsB).toBe(277);
  });

  it('reports per-shared-pack suffix length deltas for materiality assessment', () => {
    const a = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'p')],
      packs: [pack('p', 100)],
    });
    const b = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'p')],
      packs: [pack('p', 250)],
    });
    const diff = compareAnalyses(a, b);
    expect(diff.suffixLengthDeltas).toEqual([{ packId: 'p', lengthA: 100, lengthB: 250, delta: 150 }]);
  });
});

describe('summarizeDiff', () => {
  it('produces a STABLE headline when packs and counts agree', () => {
    const v = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 50)],
    });
    const out = summarizeDiff(compareAnalyses(v, v));
    expect(out).toMatch(/^STABLE: 1 packs/);
  });

  it('produces an UNSTABLE headline naming the specific drifts', () => {
    const a = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 50)],
    });
    const b = buildVideo({
      duration: 100,
      scenes: [scene(0, 100, 'a')],
      packs: [pack('a', 50), pack('b', 30)],
    });
    const out = summarizeDiff(compareAnalyses(a, b));
    expect(out).toMatch(/^UNSTABLE:/);
    expect(out).toContain('pack count 1≠2');
    expect(out).toContain('B-only: b');
  });
});
