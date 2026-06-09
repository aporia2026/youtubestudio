import { describe, expect, it } from 'vitest';
import {
  ZENN_V1_BOUNDS,
  ZENN_V1_DEFAULTS,
  resolveZennV1Settings,
} from '@/remotion/utils';

// ─── resolveZennV1Settings ───────────────────────────────────────────
//
// Mirrors `paint-explainer-v1-settings.test.ts`. The resolver is the
// single source of truth for what the renderer + pipeline consume; a
// regression that lets a malformed value through (NaN, wrong type,
// out-of-bounds) propagates into every zenn_v1 render and is hard to
// debug after the fact. See `_plans/2026-06-10-zenn-v1-style.md` §9.

describe('resolveZennV1Settings — defaults', () => {
  it('returns the canonical defaults when doc is null', () => {
    expect(resolveZennV1Settings(null)).toEqual(ZENN_V1_DEFAULTS);
  });

  it('returns the canonical defaults when doc is undefined', () => {
    expect(resolveZennV1Settings(undefined)).toEqual(ZENN_V1_DEFAULTS);
  });

  it('returns the canonical defaults when zenn_v1_settings is undefined', () => {
    expect(resolveZennV1Settings({})).toEqual(ZENN_V1_DEFAULTS);
  });

  it('returns the canonical defaults when zenn_v1_settings is the empty object', () => {
    expect(
      resolveZennV1Settings({ zenn_v1_settings: {} }),
    ).toEqual(ZENN_V1_DEFAULTS);
  });

  it("defaults default_mode to 'scene' — the differentiator mode", () => {
    // The plan explicitly chose 'scene' as the default because it's the
    // mode that visually separates zenn_v1 from doodle_explainer_2.
    expect(ZENN_V1_DEFAULTS.default_mode).toBe('scene');
  });
});

describe('resolveZennV1Settings — stored values', () => {
  it('passes through in-bounds numeric values verbatim', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: {
        median_shot_seconds: 4.0,
        max_canvas_reveal_layers: 5,
        max_unique_characters: 8,
      },
    });
    expect(resolved.median_shot_seconds).toBe(4.0);
    expect(resolved.max_canvas_reveal_layers).toBe(5);
    expect(resolved.max_unique_characters).toBe(8);
  });

  it('passes through boolean fields verbatim', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: {
        highlighter_enabled: false,
        character_persistence_enabled: false,
      },
    });
    expect(resolved.highlighter_enabled).toBe(false);
    expect(resolved.character_persistence_enabled).toBe(false);
  });

  it("accepts the alternative default_mode value 'stick'", () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: { default_mode: 'stick' },
    });
    expect(resolved.default_mode).toBe('stick');
  });

  it('passes through valid hex colors', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: {
        label_color_hex: '#FF00AA',
        highlighter_color_hex: '#ABCDEF',
        ground_color_hex: '#123456',
      },
    });
    expect(resolved.label_color_hex).toBe('#FF00AA');
    expect(resolved.highlighter_color_hex).toBe('#ABCDEF');
    expect(resolved.ground_color_hex).toBe('#123456');
  });
});

describe('resolveZennV1Settings — clamping', () => {
  it('clamps median_shot_seconds below the bound', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: { median_shot_seconds: 0.5 },
    });
    expect(resolved.median_shot_seconds).toBe(ZENN_V1_BOUNDS.median_shot_seconds[0]);
  });

  it('clamps median_shot_seconds above the bound', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: { median_shot_seconds: 99 },
    });
    expect(resolved.median_shot_seconds).toBe(ZENN_V1_BOUNDS.median_shot_seconds[1]);
  });

  it('clamps max_canvas_reveal_layers on both ends', () => {
    expect(
      resolveZennV1Settings({
        zenn_v1_settings: { max_canvas_reveal_layers: 0 },
      }).max_canvas_reveal_layers,
    ).toBe(ZENN_V1_BOUNDS.max_canvas_reveal_layers[0]);
    expect(
      resolveZennV1Settings({
        zenn_v1_settings: { max_canvas_reveal_layers: 50 },
      }).max_canvas_reveal_layers,
    ).toBe(ZENN_V1_BOUNDS.max_canvas_reveal_layers[1]);
  });

  it('clamps max_unique_characters on both ends', () => {
    // The plan caps the character bank at 12 for cost-control reasons.
    // Anything below 3 makes no sense (Zenn videos use 3-7); anything
    // above 20 would blow the budget.
    expect(
      resolveZennV1Settings({
        zenn_v1_settings: { max_unique_characters: 1 },
      }).max_unique_characters,
    ).toBe(ZENN_V1_BOUNDS.max_unique_characters[0]);
    expect(
      resolveZennV1Settings({
        zenn_v1_settings: { max_unique_characters: 999 },
      }).max_unique_characters,
    ).toBe(ZENN_V1_BOUNDS.max_unique_characters[1]);
  });
});

describe('resolveZennV1Settings — defense in depth', () => {
  it('falls back to default when a numeric field is NaN', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: { median_shot_seconds: Number.NaN },
    });
    expect(resolved.median_shot_seconds).toBe(ZENN_V1_DEFAULTS.median_shot_seconds);
  });

  it('falls back to default when a numeric field is Infinity', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: { max_canvas_reveal_layers: Number.POSITIVE_INFINITY },
    });
    expect(resolved.max_canvas_reveal_layers).toBe(
      ZENN_V1_DEFAULTS.max_canvas_reveal_layers,
    );
  });

  it('falls back to default when a boolean field is not a boolean', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: {
        // @ts-expect-error — intentional wrong-type payload
        highlighter_enabled: 'yes',
      },
    });
    expect(resolved.highlighter_enabled).toBe(
      ZENN_V1_DEFAULTS.highlighter_enabled,
    );
  });

  it('falls back to default when label_color_hex is malformed', () => {
    // Anything not matching /^#[0-9a-fA-F]{6}$/ is rejected.
    for (const malformed of ['', 'red', '#FFF', '#1234567', 'D32F2F', '#GGGGGG']) {
      const resolved = resolveZennV1Settings({
        zenn_v1_settings: { label_color_hex: malformed },
      });
      expect(resolved.label_color_hex).toBe(ZENN_V1_DEFAULTS.label_color_hex);
    }
  });

  it('falls back to default when default_mode is an unknown value', () => {
    const resolved = resolveZennV1Settings({
      zenn_v1_settings: {
        // @ts-expect-error — intentional unknown-enum payload
        default_mode: 'cinematic',
      },
    });
    expect(resolved.default_mode).toBe(ZENN_V1_DEFAULTS.default_mode);
  });

  it('produces a Required<> shape — every field is present in the output', () => {
    const resolved = resolveZennV1Settings({});
    const expectedKeys = Object.keys(ZENN_V1_DEFAULTS).sort();
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
