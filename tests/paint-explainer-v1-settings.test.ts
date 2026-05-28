import { describe, expect, it } from 'vitest';
import {
  PAINT_EXPLAINER_V1_BOUNDS,
  PAINT_EXPLAINER_V1_DEFAULTS,
  resolvePaintExplainerV1Settings,
} from '@/remotion/utils';

// ─── resolvePaintExplainerV1Settings ─────────────────────────────────
//
// The resolver is the single source of truth for what the renderer +
// pipeline actually consume. A regression that lets a malformed value
// through (NaN, wrong type, out-of-bounds) propagates into every
// paint_explainer_v1 render and is hard to debug after the fact.

describe('resolvePaintExplainerV1Settings — defaults', () => {
  it('returns the canonical defaults when doc is null', () => {
    expect(resolvePaintExplainerV1Settings(null)).toEqual(PAINT_EXPLAINER_V1_DEFAULTS);
  });

  it('returns the canonical defaults when doc is undefined', () => {
    expect(resolvePaintExplainerV1Settings(undefined)).toEqual(PAINT_EXPLAINER_V1_DEFAULTS);
  });

  it('returns the canonical defaults when paint_explainer_v1_settings is undefined', () => {
    expect(resolvePaintExplainerV1Settings({})).toEqual(PAINT_EXPLAINER_V1_DEFAULTS);
  });

  it('returns the canonical defaults when paint_explainer_v1_settings is the empty object', () => {
    expect(
      resolvePaintExplainerV1Settings({ paint_explainer_v1_settings: {} }),
    ).toEqual(PAINT_EXPLAINER_V1_DEFAULTS);
  });
});

describe('resolvePaintExplainerV1Settings — stored values', () => {
  it('passes through in-bounds numeric values verbatim', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: {
        median_shot_seconds: 3.5,
        mouth_swap_fps_fallback: 10,
        real_photo_cadence_pct: 65,
        draw_on_default_duration_ms: 1500,
      },
    });
    expect(resolved.median_shot_seconds).toBe(3.5);
    expect(resolved.mouth_swap_fps_fallback).toBe(10);
    expect(resolved.real_photo_cadence_pct).toBe(65);
    expect(resolved.draw_on_default_duration_ms).toBe(1500);
  });

  it('passes through boolean fields verbatim', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: {
        use_alignment_driven_visemes: false,
        character_persistence_enabled: false,
      },
    });
    expect(resolved.use_alignment_driven_visemes).toBe(false);
    expect(resolved.character_persistence_enabled).toBe(false);
  });

  it("accepts the alternative hard_cut_transition value 'micro-fade'", () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { hard_cut_transition: 'micro-fade' },
    });
    expect(resolved.hard_cut_transition).toBe('micro-fade');
  });

  it('passes through valid hex colors', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { label_color_hex: '#FF00AA' },
    });
    expect(resolved.label_color_hex).toBe('#FF00AA');
  });
});

describe('resolvePaintExplainerV1Settings — clamping', () => {
  it('clamps median_shot_seconds below the bound', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { median_shot_seconds: 0.5 },
    });
    expect(resolved.median_shot_seconds).toBe(PAINT_EXPLAINER_V1_BOUNDS.median_shot_seconds[0]);
  });

  it('clamps median_shot_seconds above the bound', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { median_shot_seconds: 99 },
    });
    expect(resolved.median_shot_seconds).toBe(PAINT_EXPLAINER_V1_BOUNDS.median_shot_seconds[1]);
  });

  it('clamps mouth_swap_fps_fallback below the bound', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { mouth_swap_fps_fallback: 1 },
    });
    expect(resolved.mouth_swap_fps_fallback).toBe(PAINT_EXPLAINER_V1_BOUNDS.mouth_swap_fps_fallback[0]);
  });

  it('clamps mouth_swap_fps_fallback above the bound', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { mouth_swap_fps_fallback: 100 },
    });
    expect(resolved.mouth_swap_fps_fallback).toBe(PAINT_EXPLAINER_V1_BOUNDS.mouth_swap_fps_fallback[1]);
  });

  it('clamps real_photo_cadence_pct on both ends', () => {
    expect(
      resolvePaintExplainerV1Settings({
        paint_explainer_v1_settings: { real_photo_cadence_pct: 0 },
      }).real_photo_cadence_pct,
    ).toBe(PAINT_EXPLAINER_V1_BOUNDS.real_photo_cadence_pct[0]);
    expect(
      resolvePaintExplainerV1Settings({
        paint_explainer_v1_settings: { real_photo_cadence_pct: 100 },
      }).real_photo_cadence_pct,
    ).toBe(PAINT_EXPLAINER_V1_BOUNDS.real_photo_cadence_pct[1]);
  });

  it('clamps draw_on_default_duration_ms on both ends', () => {
    expect(
      resolvePaintExplainerV1Settings({
        paint_explainer_v1_settings: { draw_on_default_duration_ms: 100 },
      }).draw_on_default_duration_ms,
    ).toBe(PAINT_EXPLAINER_V1_BOUNDS.draw_on_default_duration_ms[0]);
    expect(
      resolvePaintExplainerV1Settings({
        paint_explainer_v1_settings: { draw_on_default_duration_ms: 10_000 },
      }).draw_on_default_duration_ms,
    ).toBe(PAINT_EXPLAINER_V1_BOUNDS.draw_on_default_duration_ms[1]);
  });
});

describe('resolvePaintExplainerV1Settings — defense in depth', () => {
  it('falls back to default when a numeric field is NaN', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { median_shot_seconds: Number.NaN },
    });
    expect(resolved.median_shot_seconds).toBe(PAINT_EXPLAINER_V1_DEFAULTS.median_shot_seconds);
  });

  it('falls back to default when a numeric field is Infinity', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: { mouth_swap_fps_fallback: Number.POSITIVE_INFINITY },
    });
    expect(resolved.mouth_swap_fps_fallback).toBe(
      PAINT_EXPLAINER_V1_DEFAULTS.mouth_swap_fps_fallback,
    );
  });

  it('falls back to default when a boolean field is not a boolean', () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: {
        // @ts-expect-error — intentional wrong-type payload
        use_alignment_driven_visemes: 'yes',
      },
    });
    expect(resolved.use_alignment_driven_visemes).toBe(
      PAINT_EXPLAINER_V1_DEFAULTS.use_alignment_driven_visemes,
    );
  });

  it('falls back to default when label_color_hex is malformed', () => {
    // Anything not matching /^#[0-9a-fA-F]{6}$/ is rejected.
    for (const malformed of ['', 'red', '#FFF', '#1234567', 'EBC347', '#GGGGGG']) {
      const resolved = resolvePaintExplainerV1Settings({
        paint_explainer_v1_settings: { label_color_hex: malformed },
      });
      expect(resolved.label_color_hex).toBe(PAINT_EXPLAINER_V1_DEFAULTS.label_color_hex);
    }
  });

  it("falls back to default when hard_cut_transition is an unknown value", () => {
    const resolved = resolvePaintExplainerV1Settings({
      paint_explainer_v1_settings: {
        // @ts-expect-error — intentional unknown-enum payload
        hard_cut_transition: 'fancy-wipe',
      },
    });
    expect(resolved.hard_cut_transition).toBe(PAINT_EXPLAINER_V1_DEFAULTS.hard_cut_transition);
  });

  it('produces a Required<> shape — every field is present in the output', () => {
    const resolved = resolvePaintExplainerV1Settings({});
    // Sanity: the resolver must never return undefined for any field;
    // downstream callers rely on every property being populated.
    const expectedKeys = Object.keys(PAINT_EXPLAINER_V1_DEFAULTS).sort();
    const actualKeys = Object.keys(resolved).sort();
    expect(actualKeys).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      expect(
        (resolved as Record<string, unknown>)[key],
        `${key} should be defined`,
      ).toBeDefined();
    }
  });
});
