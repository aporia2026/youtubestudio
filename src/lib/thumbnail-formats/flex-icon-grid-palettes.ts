/**
 * Flex Icon Grid — palette engine.
 *
 * Two responsibilities:
 *  1. Carry the named palette presets (`rainbow`, `pastel`, `neon`,
 *     `monochrome`) as flat colour arrays.
 *  2. Assign one colour per cell so no two horizontally OR vertically
 *     adjacent cells share a "hue family". This is the visual rule
 *     that makes the reference channels' grids read as a collection
 *     of distinct items instead of one murky blob (per the design
 *     analysis the user and I went through).
 *
 * Pure module: no React, no Next.js, no I/O. Everything is unit-testable.
 *
 * Used by:
 *  - `flex-icon-grid-composer.ts` — resolves per-cell backgrounds.
 *  - `FlexIconGridLivePreview.tsx` — same code path client-side.
 *  - `FlexIconGridPanel.tsx` — palette preview chips.
 */

import type { FlexIconGridConfig, PaletteSpec } from './flex-icon-grid';

// ─── Hue families ───────────────────────────────────────────────────────────

/**
 * The 12 hue families used by the adjacency rule. We bucket every
 * palette colour into one family; the assignment algorithm walks
 * reading order and picks the next palette colour whose family isn't
 * already adopted by the cell's left or top neighbour.
 *
 * Bucketing rule (kept simple on purpose): convert the colour to HSL,
 * round the hue to a 30° bucket; greys (very low saturation) collapse
 * to one shared family. Black and white sit in their own families so
 * a row of all-white cells with one black cell doesn't trip the
 * adjacency check.
 */
export type HueFamily =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'lime'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'magenta'
  | 'grey'
  | 'mono'; // black + near-black + white + near-white

// ─── Named presets ──────────────────────────────────────────────────────────

/**
 * Rainbow — the bright multi-hue set that drives the reference look.
 * 15 colours so a 5×3 grid (the most successful reference layout) gets
 * a unique colour per cell without repetition. Adjacency rule still
 * applies for smaller grids.
 *
 * Ordered roughly by hue so a colour-blind viewer still sees a
 * gradient-like distribution rather than a chaotic spread.
 */
export const PALETTE_RAINBOW: readonly string[] = [
  '#FFD60A', // yellow
  '#F97316', // orange
  '#E63946', // red
  '#EC4899', // pink
  '#C026D3', // magenta
  '#7C3AED', // purple
  '#2563EB', // blue
  '#38BDF8', // sky
  '#06B6D4', // cyan
  '#0F766E', // teal
  '#34D399', // mint
  '#84CC16', // lime
  '#FACC15', // lemon
  '#FB7185', // coral
  '#B91C1C', // crimson
] as const;

/**
 * Pastel — the same colour wheel pulled toward white. Lower saturation,
 * higher lightness. Suits "friendly" topics (kids, cooking, lifestyle).
 */
export const PALETTE_PASTEL: readonly string[] = [
  '#FFE4B5', // peach
  '#FFD6E0', // pink
  '#E0BBE4', // lavender
  '#C9C9FF', // periwinkle
  '#BFD8FF', // sky
  '#B5EAEA', // turquoise
  '#C7F0BD', // mint
  '#FAFFBD', // lemon cream
  '#FFD4A8', // apricot
  '#FFC9C9', // blush
  '#E2C7FF', // lilac
  '#A6E3E9', // robin
  '#DAD7CD', // sage
  '#F4D6CC', // shell
  '#E9F5DB', // honeydew
] as const;

/**
 * Neon — high-saturation electric set. Suits "tech / cyber / hype"
 * topics. Pairs hard with a black cell ring and white labels (the
 * composer flips label colour to white automatically on neon cells —
 * see `pickLabelColourFor`).
 */
export const PALETTE_NEON: readonly string[] = [
  '#FFEE00', // electric yellow
  '#FF6B00', // hot orange
  '#FF0040', // neon red
  '#FF00FF', // magenta
  '#A100FF', // electric violet
  '#3D00FF', // ultraviolet
  '#0066FF', // electric blue
  '#00C8FF', // cyan
  '#00FFE0', // mint glow
  '#00FF66', // toxic green
  '#A0FF00', // chartreuse
  '#F5FF00', // lemon flash
  '#FF7700', // tangerine
  '#FF1493', // hot pink
  '#5800FF', // indigo flare
] as const;

/**
 * Monochrome — five tints of one hue, alternating with mid-greys. The
 * adjacency rule still works because each tint lives in a different
 * lightness bucket; the family map collapses them all to `mono` so the
 * composer never tries to enforce hue diversity here. Use for
 * editorial / serious / longform-essay channels.
 */
export const PALETTE_MONOCHROME: readonly string[] = [
  '#1A1A1A',
  '#2E2E2E',
  '#404040',
  '#525252',
  '#666666',
  '#7A7A7A',
  '#8C8C8C',
  '#A0A0A0',
  '#B3B3B3',
  '#C6C6C6',
  '#D9D9D9',
  '#E5E5E5',
  '#F0F0F0',
  '#F5F5F5',
  '#FAFAFA',
] as const;

/**
 * Lookup table for the preset arrays so the resolver can fetch by
 * `name` in O(1). Exported so the editor's swatch preview can iterate
 * the same source of truth.
 */
export const NAMED_PALETTES: Record<
  Extract<PaletteSpec, { type: 'preset' }>['name'],
  readonly string[]
> = {
  rainbow: PALETTE_RAINBOW,
  pastel: PALETTE_PASTEL,
  neon: PALETTE_NEON,
  monochrome: PALETTE_MONOCHROME,
};

// ─── Hex → family ───────────────────────────────────────────────────────────

/**
 * Bucket a `#RRGGBB` or `#RGB` colour into one of the 12 hue families.
 * Pure function, exported for tests + the editor's "show me which
 * cells share a family" debug overlay.
 *
 * The thresholds are calibrated empirically — they pass the reference
 * channels' grids end-to-end (each disc lands in a distinct family
 * from its neighbours) without rejecting reasonable design choices.
 * If two perceptually-different colours land in the same bucket and a
 * thumbnail looks "blobby", widen the bucket boundary here rather
 * than hand-massaging individual hex codes upstream.
 */
export function hueFamilyOf(hex: string): HueFamily {
  const rgb = parseHex(hex);
  if (!rgb) return 'mono';
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(2 * (max + min) / 2 - 255));
  // Treat very dark, very light, and very desaturated colours as
  // monochrome — they don't carry a hue identity strong enough for
  // adjacency to matter.
  if (lightness < 0.08 || lightness > 0.93) return 'mono';
  if (saturation < 0.12) return 'grey';
  // Hue in degrees [0..360).
  let h: number;
  if (max === r) {
    h = ((g - b) / (max - min)) * 60;
  } else if (max === g) {
    h = ((b - r) / (max - min) + 2) * 60;
  } else {
    h = ((r - g) / (max - min) + 4) * 60;
  }
  if (h < 0) h += 360;
  // 30° buckets, anchored on the visually distinct primary/secondary
  // names. The boundaries are loose on the edges (e.g. red wraps from
  // 345..15) so a hex one degree off the canonical primary still
  // lands in the expected bucket.
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 100) return 'lime';
  if (h < 150) return 'green';
  if (h < 180) return 'teal';
  if (h < 210) return 'cyan';
  if (h < 250) return 'blue';
  if (h < 285) return 'purple';
  if (h < 345) return 'magenta';
  return 'red';
}

/** Parse `#RGB` or `#RRGGBB` into 0..255 channels. Returns null for
 *  any malformed input so the caller can fall back to a default. */
export function parseHex(hex: string): { r: number; g: number; b: number } | null {
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
    return null;
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return { r, g, b };
    return null;
  }
  return null;
}

/**
 * Pick black-or-white for a label sitting on the given background
 * colour. Uses the WCAG-style relative luminance; flips at the
 * conventional 0.5 cutoff. Composer uses this to override the
 * user-configured `LabelStyle.color` on a per-cell basis ONLY when
 * the user has not explicitly picked a colour for the cell — see
 * `resolveLabelColor` in the composer.
 */
export function pickLabelColourFor(backgroundHex: string): '#0a0a0a' | '#fbfbf8' {
  const rgb = parseHex(backgroundHex);
  if (!rgb) return '#0a0a0a';
  // Relative luminance (Rec. 709 weights). Cheap enough at composition
  // time — no need for the full sRGB linearisation step.
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return lum > 0.55 ? '#0a0a0a' : '#fbfbf8';
}

// ─── Adjacency-aware assignment ─────────────────────────────────────────────

/**
 * Resolve the per-cell background colour for every cell in the config,
 * respecting:
 *   1. Per-cell explicit `backgroundColor` (always wins).
 *   2. The `PaletteSpec` (preset or custom array).
 *   3. The adjacency rule — no two horizontally OR vertically adjacent
 *      cells share a hue family.
 *
 * Returns an array indexed by `cellIndex - 1` so the composer can do
 * `colors[cell.index - 1]` without re-traversing. Pure function; same
 * config always yields the same colour list.
 *
 * Algorithm: walk cells in reading order. For each cell:
 *   - If user supplied a colour, take it.
 *   - Otherwise, pick the next palette colour whose family is not in
 *     the "forbidden" set (left neighbour + top neighbour families).
 *   - If every palette colour is forbidden (tiny palette, dense
 *     adjacency), fall through to the first available colour — the
 *     adjacency rule is a soft preference, not a hard constraint, so
 *     a user who picks a 2-colour custom palette still gets a
 *     thumbnail rather than an error.
 */
export function resolveCellBackgrounds(config: FlexIconGridConfig): string[] {
  const total = config.rows * config.cols;
  const out = new Array<string>(total);
  const palette = paletteColours(config.palette);
  if (palette.length === 0) {
    // Defensive: empty custom palette → fall back to rainbow so the
    // user sees a sensible grid instead of an undefined array.
    return resolveCellBackgrounds({
      ...config,
      palette: { type: 'preset', name: 'rainbow' },
    });
  }
  // Track which palette slot we tried last so the assignment walks
  // the palette deterministically instead of biasing toward index 0
  // when adjacency constraints reset the search. Phase 4.15: seed the
  // cursor with `paletteShuffleOffset` so the panel's "Shuffle" chip
  // rotates the colour assignment without changing palette or
  // touching locked cells.
  let cursor = ((config.paletteShuffleOffset ?? 0) % palette.length + palette.length) % palette.length;
  for (let i = 0; i < total; i++) {
    const cell = config.cells[i];
    if (cell?.backgroundColor) {
      out[i] = cell.backgroundColor;
      continue;
    }
    const row = Math.floor(i / config.cols);
    const col = i % config.cols;
    const forbidden = new Set<HueFamily>();
    if (col > 0) {
      const left = out[i - 1];
      if (left) forbidden.add(hueFamilyOf(left));
    }
    if (row > 0) {
      const above = out[i - config.cols];
      if (above) forbidden.add(hueFamilyOf(above));
    }
    let pick: string | null = null;
    for (let step = 0; step < palette.length; step++) {
      const candidate = palette[(cursor + step) % palette.length];
      if (!forbidden.has(hueFamilyOf(candidate))) {
        pick = candidate;
        cursor = (cursor + step + 1) % palette.length;
        break;
      }
    }
    out[i] = pick ?? palette[cursor % palette.length];
  }
  return out;
}

/** Resolve a `PaletteSpec` to its concrete colour array. Exported for
 *  the editor's swatch preview so the same source of truth that drives
 *  the composer drives the picker UI. */
export function paletteColours(spec: PaletteSpec): readonly string[] {
  if (spec.type === 'preset') return NAMED_PALETTES[spec.name];
  return spec.colors;
}

/**
 * Phase 4.21: generate a fresh, harmonious random palette of `count`
 * hex colours. Uses evenly-spaced hues around the wheel with small
 * per-slot jitter so two calls never produce identical palettes;
 * saturation + lightness are clamped to the "vibrant but legible"
 * band so labels read regardless of the picked text colour.
 *
 * `rng` is injected so tests can pass a seeded source; production
 * callers pass `Math.random`. Pure function — no side effects.
 */
export function generateRandomPalette(count: number, rng: () => number = Math.random): string[] {
  if (count <= 0) return [];
  const out: string[] = [];
  const baseHueOffset = rng() * 360; // start anywhere on the wheel
  const step = 360 / count;
  for (let i = 0; i < count; i++) {
    const hueJitter = (rng() - 0.5) * Math.min(step * 0.5, 25);
    const hue = (baseHueOffset + i * step + hueJitter + 360) % 360;
    // Vibrant + legible band — picked empirically against the
    // reference channels' look. Sat 65–85 %, light 50–62 %.
    const sat = 65 + rng() * 20;
    const light = 50 + rng() * 12;
    out.push(hslToHex(hue, sat, light));
  }
  return out;
}

/** HSL (0–360, 0–100, 0–100) → #RRGGBB. Internal helper for
 *  `generateRandomPalette`; not exported because callers should
 *  prefer the palette helper rather than fiddle with raw colour
 *  spaces. */
function hslToHex(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) { r = c; g = x; b = 0; }
  else if (hp < 2) { r = x; g = c; b = 0; }
  else if (hp < 3) { r = 0; g = c; b = x; }
  else if (hp < 4) { r = 0; g = x; b = c; }
  else if (hp < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const m = lNorm - c / 2;
  const toByte = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}
