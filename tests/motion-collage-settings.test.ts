import { describe, expect, it } from 'vitest';
import {
  DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS,
  DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS,
  resolveDoodleExplainer2MotionCollageSettings,
} from '@/remotion/utils';

// resolveDoodleExplainer2MotionCollageSettings layers user-stored
// values over the canonical defaults and clamps numeric fields to
// their bounds. Mirrors the paint_explainer_v1 settings resolver
// pattern exactly; these tests cover the four shapes the resolver
// can hit:
//   1. nothing stored → defaults verbatim
//   2. partial stored → stored wins, defaults fill gaps
//   3. out-of-bound numeric → clamped to nearest edge
//   4. wrong type → falls back to default
//
// The resolver lives next to PAINT_EXPLAINER_V1_* in `utils.ts`; both
// use the same `clampPaintSetting` helper.

describe('resolveDoodleExplainer2MotionCollageSettings', () => {
  it('returns canonical defaults when no settings are stored on the doc', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings(undefined);
    expect(resolved).toEqual(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS);
  });

  it('returns canonical defaults when the doc has no settings field', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({});
    expect(resolved).toEqual(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS);
  });

  it('returns canonical defaults when the settings field is explicitly empty', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: {},
    });
    expect(resolved).toEqual(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS);
  });

  it('preserves valid stored values verbatim', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: {
        allow_motion_collage: false,
        max_grid_panels: 9,
        min_per_frame_ms: 300,
        max_per_frame_ms: 600,
      },
    });
    expect(resolved.allow_motion_collage).toBe(false);
    expect(resolved.max_grid_panels).toBe(9);
    expect(resolved.min_per_frame_ms).toBe(300);
    expect(resolved.max_per_frame_ms).toBe(600);
  });

  it('layers partial stored values over defaults', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: {
        max_grid_panels: 6,
      },
    });
    expect(resolved.max_grid_panels).toBe(6);
    // Untouched fields land at defaults.
    expect(resolved.allow_motion_collage).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.allow_motion_collage);
    expect(resolved.min_per_frame_ms).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.min_per_frame_ms);
    expect(resolved.max_per_frame_ms).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.max_per_frame_ms);
  });

  it('clamps a numeric field below its lower bound to the lower bound', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: { max_grid_panels: 1 },
    });
    expect(resolved.max_grid_panels).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[0]);
  });

  it('clamps a numeric field above its upper bound to the upper bound', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: { max_grid_panels: 99 },
    });
    expect(resolved.max_grid_panels).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[1]);
  });

  it('clamps min_per_frame_ms outside [100, 500]', () => {
    expect(
      resolveDoodleExplainer2MotionCollageSettings({
        doodle_explainer_2_motion_collage_settings: { min_per_frame_ms: 50 },
      }).min_per_frame_ms,
    ).toBe(100);
    expect(
      resolveDoodleExplainer2MotionCollageSettings({
        doodle_explainer_2_motion_collage_settings: { min_per_frame_ms: 9999 },
      }).min_per_frame_ms,
    ).toBe(500);
  });

  it('clamps max_per_frame_ms outside [300, 1500]', () => {
    expect(
      resolveDoodleExplainer2MotionCollageSettings({
        doodle_explainer_2_motion_collage_settings: { max_per_frame_ms: 1 },
      }).max_per_frame_ms,
    ).toBe(300);
    expect(
      resolveDoodleExplainer2MotionCollageSettings({
        doodle_explainer_2_motion_collage_settings: { max_per_frame_ms: 9999 },
      }).max_per_frame_ms,
    ).toBe(1500);
  });

  it.each([
    { label: 'NaN', value: NaN },
    { label: 'Infinity', value: Infinity },
    { label: 'string', value: 'hi' as unknown as number },
    { label: 'null', value: null as unknown as number },
  ])('falls back to default when a numeric field is $label', ({ value }) => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: { max_grid_panels: value },
    });
    expect(resolved.max_grid_panels).toBe(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.max_grid_panels);
  });

  it.each([
    { label: 'undefined', value: undefined },
    { label: 'string', value: 'true' as unknown as boolean },
    { label: 'number', value: 1 as unknown as boolean },
  ])('falls back to default when allow_motion_collage is $label', ({ value }) => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: { allow_motion_collage: value },
    });
    expect(resolved.allow_motion_collage).toBe(
      DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS.allow_motion_collage,
    );
  });

  it('honours explicit `false` for allow_motion_collage (doesn\'t treat it as missing)', () => {
    const resolved = resolveDoodleExplainer2MotionCollageSettings({
      doodle_explainer_2_motion_collage_settings: { allow_motion_collage: false },
    });
    expect(resolved.allow_motion_collage).toBe(false);
  });
});

describe('DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS', () => {
  it('matches the architecture plan §Settings table', () => {
    // Pin so any future drift through this file's review.
    expect(DOODLE_EXPLAINER_2_MOTION_COLLAGE_DEFAULTS).toEqual({
      allow_motion_collage: true,
      max_grid_panels: 12,
      min_per_frame_ms: 200,
      max_per_frame_ms: 800,
    });
  });
});

describe('DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS', () => {
  it('aligns with the slicer hard ceiling (max_grid_panels upper bound = MAX_COLLAGE_CELLS = 16)', () => {
    expect(DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[1]).toBe(16);
  });

  it('has lower bound ≥ 4 (a 2×2 keyframe arc is the floor for "motion")', () => {
    expect(DOODLE_EXPLAINER_2_MOTION_COLLAGE_BOUNDS.max_grid_panels[0]).toBeGreaterThanOrEqual(4);
  });
});
