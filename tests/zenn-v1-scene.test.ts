import { describe, expect, it } from 'vitest';
import {
  resolveCharacterUrl,
  resolveWorldPalette,
  worldBandLayout,
} from '@/remotion/scenes/ZennScene';

// ─── resolveWorldPalette ────────────────────────────────────────────
//
// The palette resolver is the bridge between the doc-level world def
// and the renderer. Mode B scenes look broken on screen the moment
// this returns the wrong color, so the tests pin every branch.

describe('resolveWorldPalette', () => {
  it('returns the sky_ground defaults when the world def is missing', () => {
    const palette = resolveWorldPalette('sky_ground', undefined);
    expect(palette.sky_color_hex).toBe('#BFE4F3');
    expect(palette.ground_color_hex).toBe('#F2D69A');
  });

  it('returns the room defaults when the world def is missing', () => {
    const palette = resolveWorldPalette('room', undefined);
    expect(palette.sky_color_hex).toBe('#E8E8E8');
    expect(palette.ground_color_hex).toBe('#9E9E9E');
    expect(palette.wall_color_hex).toBe('#E8E8E8');
  });

  it('returns the underwater defaults when the world def is missing', () => {
    const palette = resolveWorldPalette('underwater', undefined);
    expect(palette.sky_color_hex).toBe('#1B4F72');
    expect(palette.ground_color_hex).toBe('#0B2A4A');
  });

  it('returns the sky_only fallback for null overlay', () => {
    const palette = resolveWorldPalette(null, undefined);
    expect(palette.sky_color_hex).toBe('#FFFFFF');
  });

  it('returns the sky_only fallback for undefined overlay', () => {
    const palette = resolveWorldPalette(undefined, undefined);
    expect(palette.sky_color_hex).toBe('#FFFFFF');
  });

  it('user-set sky color overrides the default', () => {
    const palette = resolveWorldPalette('sky_ground', { sky_color_hex: '#000000' });
    expect(palette.sky_color_hex).toBe('#000000');
    expect(palette.ground_color_hex).toBe('#F2D69A');
  });

  it('user-set ground color overrides the default', () => {
    const palette = resolveWorldPalette('sky_ground', { ground_color_hex: '#FF00FF' });
    expect(palette.sky_color_hex).toBe('#BFE4F3');
    expect(palette.ground_color_hex).toBe('#FF00FF');
  });

  it('user-set wall color overrides the default', () => {
    const palette = resolveWorldPalette('room', { wall_color_hex: '#123456' });
    expect(palette.wall_color_hex).toBe('#123456');
  });
});

// ─── worldBandLayout ────────────────────────────────────────────────
//
// The layout function returns a discriminated union the compositor
// branches on. The discriminant + dimensions are what the rendered
// scene actually looks like, so the tests pin both.

const fixturePalette = {
  sky_color_hex: '#BFE4F3',
  ground_color_hex: '#F2D69A',
  wall_color_hex: '#E8E8E8',
};

describe('worldBandLayout', () => {
  it('sky_only returns a solid sky-color fill', () => {
    const layout = worldBandLayout('sky_only', fixturePalette);
    expect(layout.kind).toBe('solid');
    if (layout.kind === 'solid') {
      expect(layout.color).toBe('#BFE4F3');
    }
  });

  it('sky_ground returns 50 / 50 bands at sky on top, ground on bottom', () => {
    const layout = worldBandLayout('sky_ground', fixturePalette);
    expect(layout.kind).toBe('bands');
    if (layout.kind === 'bands') {
      expect(layout.topColor).toBe('#BFE4F3');
      expect(layout.bottomColor).toBe('#F2D69A');
      expect(layout.topHeightPct).toBe(50);
      expect(layout.bottomHeightPct).toBe(50);
    }
  });

  it('sky_ground band heights sum to 100', () => {
    const layout = worldBandLayout('sky_ground', fixturePalette);
    if (layout.kind === 'bands') {
      expect(layout.topHeightPct + layout.bottomHeightPct).toBe(100);
    }
  });

  it('room returns wall-on-top bands instead of sky', () => {
    const layout = worldBandLayout('room', fixturePalette);
    expect(layout.kind).toBe('bands');
    if (layout.kind === 'bands') {
      // Room overlay paints the wall (NOT the sky) on top — verifies
      // the Calhoun mouse-cage interior look.
      expect(layout.topColor).toBe('#E8E8E8');
      expect(layout.bottomColor).toBe('#F2D69A');
    }
  });

  it('underwater returns a top-to-bottom gradient', () => {
    const layout = worldBandLayout('underwater', fixturePalette);
    expect(layout.kind).toBe('gradient');
    if (layout.kind === 'gradient') {
      expect(layout.topColor).toBe('#BFE4F3');
      expect(layout.bottomColor).toBe('#F2D69A');
    }
  });

  it('null overlay falls back to a solid fill', () => {
    const layout = worldBandLayout(null, fixturePalette);
    expect(layout.kind).toBe('solid');
  });

  it('undefined overlay falls back to a solid fill', () => {
    const layout = worldBandLayout(undefined, fixturePalette);
    expect(layout.kind).toBe('solid');
  });
});

// ─── resolveCharacterUrl ────────────────────────────────────────────
//
// The character URL resolver is the load-bearing piece of the
// character-bank reuse story. A bug here would either render the
// wrong character (catastrophic identity drift) or render nothing
// (silent breakage). Pinning every fallback is worth the test cost.

const fixtureBank: Record<string, {
  base_url: string;
  poses?: Record<string, string>;
  first_seen_row_index: number;
}> = {
  hero: {
    base_url: 'https://r2.example/hero-base.jpg',
    poses: {
      idle: 'https://r2.example/hero-idle.jpg',
      pointing: 'https://r2.example/hero-pointing.jpg',
    },
    first_seen_row_index: 0,
  },
  villain: {
    base_url: 'https://r2.example/villain-base.jpg',
    first_seen_row_index: 5,
  },
};

describe('resolveCharacterUrl', () => {
  it('returns undefined when characterId is missing', () => {
    expect(resolveCharacterUrl(fixtureBank, undefined, undefined)).toBeUndefined();
    expect(resolveCharacterUrl(fixtureBank, '', undefined)).toBeUndefined();
  });

  it('returns undefined when the bank is missing', () => {
    expect(resolveCharacterUrl(undefined, 'hero', 'idle')).toBeUndefined();
  });

  it('returns undefined when the bank has no entry for the character', () => {
    expect(resolveCharacterUrl(fixtureBank, 'unknown-character', 'idle')).toBeUndefined();
  });

  it('returns the pose URL when both the character and the pose are registered', () => {
    expect(resolveCharacterUrl(fixtureBank, 'hero', 'idle')).toBe(
      'https://r2.example/hero-idle.jpg',
    );
    expect(resolveCharacterUrl(fixtureBank, 'hero', 'pointing')).toBe(
      'https://r2.example/hero-pointing.jpg',
    );
  });

  it('falls back to the base_url when the pose is unknown', () => {
    expect(resolveCharacterUrl(fixtureBank, 'hero', 'sprinting')).toBe(
      'https://r2.example/hero-base.jpg',
    );
  });

  it('falls back to the base_url when no pose is supplied', () => {
    expect(resolveCharacterUrl(fixtureBank, 'hero', undefined)).toBe(
      'https://r2.example/hero-base.jpg',
    );
  });

  it('returns the base_url for a character with no poses bank at all', () => {
    expect(resolveCharacterUrl(fixtureBank, 'villain', 'idle')).toBe(
      'https://r2.example/villain-base.jpg',
    );
    expect(resolveCharacterUrl(fixtureBank, 'villain', undefined)).toBe(
      'https://r2.example/villain-base.jpg',
    );
  });

  it('returns undefined when the bank entry has an empty base_url', () => {
    // Defense in depth: a half-written cache entry (mid-tick crash
    // between writing the key and writing the URL) should NOT render
    // a broken <Img src="">. Returning undefined cleanly skips the
    // character layer.
    const brokenBank = {
      hero: { base_url: '', first_seen_row_index: 0 },
    };
    expect(resolveCharacterUrl(brokenBank, 'hero', undefined)).toBeUndefined();
  });

  // ─── QA fix 2026-06-10: case-variant slugs share a bank entry ─────
  //
  // The pipeline writes bank entries under the NORMALIZED slug
  // (`Knight` → `knight`). The renderer's lookup must do the matching
  // transform on read so a row with `zenn_character_id: 'Knight'`
  // and a row with `zenn_character_id: 'knight'` both find the same
  // entry. Without these tests the regression would silently drop
  // the character layer on the mismatched-case row.

  it('resolves a case-variant slug to the normalized bank entry', () => {
    const normalizedBank = {
      // Bank is keyed by the normalized slug post-QA-fix.
      'curly-haired-hunter': {
        base_url: 'https://r2.example/hunter.jpg',
        first_seen_row_index: 0,
      },
    };
    // Row emits the LLM's verbatim casing — different from the bank
    // key — but the lookup still resolves.
    expect(
      resolveCharacterUrl(normalizedBank, 'Curly-Haired Hunter', undefined),
    ).toBe('https://r2.example/hunter.jpg');
    expect(
      resolveCharacterUrl(normalizedBank, 'CURLY_HAIRED_HUNTER', undefined),
    ).toBe('https://r2.example/hunter.jpg');
    expect(
      resolveCharacterUrl(normalizedBank, 'curly haired hunter', undefined),
    ).toBe('https://r2.example/hunter.jpg');
  });

  it('falls back to a raw-keyed bank entry (back-compat with pre-fix banks)', () => {
    // A doc generated before the QA fix may have a bank keyed by
    // the LLM's verbatim slug instead of the normalized form. The
    // renderer falls back to a raw lookup so existing docs keep
    // rendering correctly.
    const rawKeyedBank = {
      Knight: {
        base_url: 'https://r2.example/knight.jpg',
        first_seen_row_index: 0,
      },
    };
    expect(resolveCharacterUrl(rawKeyedBank, 'Knight', undefined)).toBe(
      'https://r2.example/knight.jpg',
    );
  });
});
