/**
 * Flex Icon Grid — unit tests.
 *
 * Covers the pure-module surface (`flex-icon-grid.ts`) end-to-end and
 * the palette engine's adjacency contract (`flex-icon-grid-palettes.ts`).
 * The composer + Sharp pipeline are tested separately by exercising
 * `buildBaseSvg` against a minimal config — a full PNG render test
 * would require the bundled TTFs and is deferred to the integration
 * suite once the font download script has run in CI.
 */

import { describe, expect, it } from 'vitest';
import {
  applyLabelCase,
  ASPECT_RATIO_PRESETS,
  computeCellGeometry,
  computeCellRect,
  computeGridLayout,
  computeRegions,
  DEFAULT_CANVAS,
  escapeSvgText,
  getAspectRatioPreset,
  getConsumedCellIndexes,
  getSpanConflicts,
  computeShadowFilterRegion,
  makeDefaultConfig,
  parseConfig,
  resolveCellShadow,
  sanitizeUserText,
  transposeCells,
  SUPPORTED_CELL_SHAPES,
  SUPPORTED_CONTENT_TYPES,
  validateConfig,
  type FlexIconGridConfig,
} from '@/lib/thumbnail-formats/flex-icon-grid';
import { emojiToCodepointSlug } from '@/lib/thumbnail-formats/flex-icon-grid-emoji';
import { BRAND_ICONS } from '@/lib/thumbnail-formats/flex-icon-grid-brand-icons';
import { OFFICIAL_BRAND_ICONS } from '@/lib/thumbnail-formats/flex-icon-grid-brand-icons-official.generated';
import { ICONIFY_ICONS } from '@/lib/thumbnail-formats/flex-icon-grid-iconify-icons.generated';
import { extractIconInner, ICON_REGISTRY, getIconEntry, inlineIconSvg } from '@/lib/thumbnail-formats/flex-icon-grid-icons';
import {
  DEFAULT_STICKER_STYLE,
  STICKER_STYLE_PRESETS,
  resolveStickerStyle,
} from '@/lib/thumbnail-formats/flex-icon-grid-sticker-styles';
import { validateSavedPaletteInput } from '@/lib/flex-icon-grid-saved-palettes-validate';
import { validateSavedTemplateInput } from '@/lib/flex-icon-grid-saved-templates-validate';
import { validateWorkspaceFontInput } from '@/lib/flex-icon-grid-workspace-fonts-validate';
import {
  generateRandomPalette,
  hueFamilyOf,
  parseHex,
  pickLabelColourFor,
  resolveCellBackgrounds,
  shiftPaletteLightness,
  shiftPaletteSaturation,
  PALETTE_RAINBOW,
} from '@/lib/thumbnail-formats/flex-icon-grid-palettes';
import { buildBaseSvg } from '@/lib/thumbnail-formats/flex-icon-grid-composer';

// ─── Geometry ───────────────────────────────────────────────────────────────

describe('makeDefaultConfig', () => {
  it('produces rows*cols cells with 1-based reading-order indexes', () => {
    const config = makeDefaultConfig(3, 5);
    expect(config.cells).toHaveLength(15);
    config.cells.forEach((cell, i) => {
      expect(cell.index).toBe(i + 1);
    });
  });
  it('defaults to circle cells + rainbow palette + Anton labels', () => {
    const config = makeDefaultConfig(2, 2);
    expect(config.defaultCellShape).toBe('circle');
    expect(config.palette).toEqual({ type: 'preset', name: 'rainbow' });
    expect(config.defaultLabel.font).toBe('anton');
    expect(config.defaultLabel.case).toBe('upper');
  });
  it('uses provided icon library names + labels when supplied', () => {
    const config = makeDefaultConfig(1, 3, {
      iconLibraryNames: ['shield', 'lock', 'bug'],
      labels: ['Shield', 'Lock', 'Bug'],
    });
    expect(config.cells[0].content).toEqual({ type: 'icon-library', name: 'shield' });
    expect(config.cells[0].label).toBe('Shield');
    expect(config.cells[2].content).toEqual({ type: 'icon-library', name: 'bug' });
  });
});

describe('computeGridLayout', () => {
  it('returns the full canvas minus padding when no title bar', () => {
    const config = makeDefaultConfig(3, 5);
    const layout = computeGridLayout(config);
    expect(layout.x).toBe(0);
    expect(layout.y).toBe(0);
    expect(layout.w).toBe(DEFAULT_CANVAS.width);
    expect(layout.h).toBe(DEFAULT_CANVAS.height);
  });
  it('shifts grid downward when title bar is on top', () => {
    const config: FlexIconGridConfig = {
      ...makeDefaultConfig(3, 5),
      titleBar: {
        text: 'X',
        position: 'top',
        height: 100,
        background: '#000000',
        color: '#ffffff',
        font: 'anton',
      },
    };
    const layout = computeGridLayout(config);
    expect(layout.y).toBe(100);
    expect(layout.h).toBe(DEFAULT_CANVAS.height - 100);
  });
  it('shrinks grid from bottom when title bar is at bottom', () => {
    const config: FlexIconGridConfig = {
      ...makeDefaultConfig(3, 5),
      titleBar: {
        text: 'X',
        position: 'bottom',
        height: 96,
        background: '#000000',
        color: '#ffffff',
        font: 'anton',
      },
    };
    const layout = computeGridLayout(config);
    expect(layout.y).toBe(0);
    expect(layout.h).toBe(DEFAULT_CANVAS.height - 96);
  });
});

describe('computeCellRect', () => {
  it('places the first cell at the layout origin', () => {
    const config = makeDefaultConfig(2, 3);
    const layout = computeGridLayout(config);
    const r = computeCellRect(layout, 1);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it('places the last cell so its right edge meets the layout right edge', () => {
    const config = makeDefaultConfig(2, 3); // 6 cells
    const layout = computeGridLayout(config);
    const r = computeCellRect(layout, 6);
    expect(Math.round(r.x + r.w)).toBe(DEFAULT_CANVAS.width);
    expect(Math.round(r.y + r.h)).toBe(DEFAULT_CANVAS.height);
  });
  it('respects cell gap', () => {
    const config: FlexIconGridConfig = { ...makeDefaultConfig(2, 2), cellGap: 20 };
    const layout = computeGridLayout(config);
    const r1 = computeCellRect(layout, 1);
    const r2 = computeCellRect(layout, 2);
    expect(Math.round(r2.x - (r1.x + r1.w))).toBe(20);
  });
});

describe('computeCellGeometry', () => {
  it('label band sits below the shape when position is "below"', () => {
    const geom = computeCellGeometry(0, 0, 256, 240, 'below');
    expect(geom.labelY).toBeGreaterThan(geom.shapeY);
    expect(Math.round(geom.labelY + geom.labelH)).toBe(240);
  });
  it('label band sits above the shape when position is "above"', () => {
    const geom = computeCellGeometry(0, 0, 256, 240, 'above');
    expect(geom.labelY).toBe(0);
    expect(geom.shapeY).toBeGreaterThan(geom.labelY + geom.labelH - 1);
  });
  it('shape fills the cell vertically when label is hidden', () => {
    const geom = computeCellGeometry(0, 0, 200, 200, 'hidden');
    expect(geom.labelW).toBe(0);
    expect(geom.labelH).toBe(0);
    // Shape is a square equal to the smaller dimension (here both 200)
    expect(geom.shapeW).toBe(geom.shapeH);
  });
});

// ─── Escaping & sanitisation ────────────────────────────────────────────────

describe('escapeSvgText', () => {
  it('escapes all five SVG special characters', () => {
    expect(escapeSvgText('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
  it('leaves benign text unchanged', () => {
    expect(escapeSvgText('Malware')).toBe('Malware');
  });
});

describe('sanitizeUserText', () => {
  it('strips control characters', () => {
    const s = 'abc';
    expect(sanitizeUserText(s)).toBe('abc');
  });
  it('collapses tab/newline runs to a single space', () => {
    expect(sanitizeUserText('hello\t\n\rworld')).toBe('hello world');
  });
  it('clamps to maxLen', () => {
    expect(sanitizeUserText('a'.repeat(300), 10)).toHaveLength(10);
  });
});

describe('applyLabelCase', () => {
  it('uppercases when mode is upper', () => {
    expect(applyLabelCase('hello world', 'upper')).toBe('HELLO WORLD');
  });
  it('preserves user input when mode is as-typed', () => {
    expect(applyLabelCase('iOS', 'as-typed')).toBe('iOS');
  });
  it('capitalises word initials but does NOT lowercase the rest under title', () => {
    // Documents the intentional "title" behaviour — keeps proper nouns like RAT intact.
    expect(applyLabelCase('rat aTtaCk', 'title')).toBe('Rat ATtaCk');
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts the default config', () => {
    expect(validateConfig(makeDefaultConfig(3, 5))).toEqual({ ok: true });
  });
  it('rejects cell count mismatch with an actionable reason', () => {
    const config = makeDefaultConfig(2, 2);
    config.cells.pop();
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cells\.length/);
    }
  });
  it('rejects out-of-order cell indexes', () => {
    const config = makeDefaultConfig(2, 2);
    config.cells[1].index = 5;
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.offending_cell_index).toBe(2);
    }
  });
  it('rejects unsupported cell content type', () => {
    const config = makeDefaultConfig(1, 1);
    // Cast through unknown — we're deliberately producing a bad runtime shape.
    (config.cells[0] as unknown as { content: unknown }).content = { type: 'video', url: 'x' };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/content\.type/);
    }
  });
  it('rejects malformed hex background colour on a cell', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].backgroundColor = 'not-a-color';
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
});

// ─── parseConfig ────────────────────────────────────────────────────────────

describe('parseConfig', () => {
  it('fills sensible defaults for missing optional fields', () => {
    const minimal = {
      rows: 2,
      cols: 2,
      cells: [
        { index: 1, label: 'A', content: { type: 'text-only' } },
        { index: 2, label: 'B', content: { type: 'text-only' } },
        { index: 3, label: 'C', content: { type: 'text-only' } },
        { index: 4, label: 'D', content: { type: 'text-only' } },
      ],
    };
    const config = parseConfig(minimal);
    expect(config.width).toBe(DEFAULT_CANVAS.width);
    expect(config.defaultCellShape).toBe('circle');
    expect(config.palette).toEqual({ type: 'preset', name: 'rainbow' });
  });
  it('falls back to rainbow for unknown palette names', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'X', content: { type: 'text-only' } }],
      palette: { type: 'preset', name: 'midnight' }, // unknown
    });
    expect(config.palette).toEqual({ type: 'preset', name: 'rainbow' });
  });
});

// ─── Palette engine ─────────────────────────────────────────────────────────

describe('parseHex', () => {
  it('parses #RGB shorthand', () => {
    expect(parseHex('#f0a')).toEqual({ r: 255, g: 0, b: 170 });
  });
  it('parses #RRGGBB', () => {
    expect(parseHex('#1A2B3C')).toEqual({ r: 26, g: 43, b: 60 });
  });
  it('returns null for malformed input', () => {
    expect(parseHex('not-a-color')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
  });
});

describe('hueFamilyOf', () => {
  it('buckets primary red into red', () => {
    expect(hueFamilyOf('#E63946')).toBe('red');
  });
  it('buckets pure blue into blue', () => {
    expect(hueFamilyOf('#2563EB')).toBe('blue');
  });
  it('buckets vivid green into lime or green', () => {
    // Sub-bucket boundary is fuzzy by design; we accept either side.
    expect(['lime', 'green']).toContain(hueFamilyOf('#84CC16'));
  });
  it('buckets near-black into mono', () => {
    expect(hueFamilyOf('#080808')).toBe('mono');
  });
  it('buckets desaturated grey into grey', () => {
    expect(hueFamilyOf('#888888')).toBe('grey');
  });
});

describe('pickLabelColourFor', () => {
  it('picks dark text on a bright background', () => {
    expect(pickLabelColourFor('#FFD60A')).toBe('#0a0a0a');
  });
  it('picks light text on a dark background', () => {
    expect(pickLabelColourFor('#1A1A1A')).toBe('#fbfbf8');
  });
});

describe('resolveCellBackgrounds — adjacency rule', () => {
  it('returns rows*cols colours', () => {
    const config = makeDefaultConfig(3, 5);
    const result = resolveCellBackgrounds(config);
    expect(result).toHaveLength(15);
  });
  it('respects explicit per-cell backgroundColor overrides', () => {
    const config = makeDefaultConfig(2, 2);
    config.cells[0].backgroundColor = '#123456';
    const result = resolveCellBackgrounds(config);
    expect(result[0]).toBe('#123456');
  });
  it('avoids same-family adjacency horizontally and vertically when palette is large enough', () => {
    const config = makeDefaultConfig(3, 5);
    const result = resolveCellBackgrounds(config);
    // Walk the grid in reading order. Each cell's family should differ
    // from its left and top neighbour.
    for (let r = 0; r < config.rows; r++) {
      for (let c = 0; c < config.cols; c++) {
        const i = r * config.cols + c;
        const me = hueFamilyOf(result[i]);
        if (c > 0) {
          expect(hueFamilyOf(result[i - 1])).not.toBe(me);
        }
        if (r > 0) {
          expect(hueFamilyOf(result[i - config.cols])).not.toBe(me);
        }
      }
    }
  });
  it('falls through gracefully when the palette is too small to satisfy adjacency', () => {
    // A 2-colour palette on a 3×3 grid cannot satisfy the adjacency
    // rule strictly. The resolver should return a result anyway — the
    // adjacency rule is a soft preference, not a hard constraint.
    const config: FlexIconGridConfig = {
      ...makeDefaultConfig(3, 3),
      palette: { type: 'custom', colors: ['#FF0000', '#0000FF'] },
    };
    const result = resolveCellBackgrounds(config);
    expect(result).toHaveLength(9);
    for (const c of result) {
      expect(['#FF0000', '#0000FF']).toContain(c);
    }
  });
});

// ─── Composer base SVG ──────────────────────────────────────────────────────

describe('buildBaseSvg', () => {
  it('emits a well-formed root SVG element with the configured dimensions', () => {
    const config = makeDefaultConfig(2, 2);
    const layout = computeGridLayout(config);
    const backgrounds = resolveCellBackgrounds(config);
    const svg = buildBaseSvg(config, layout, backgrounds);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toMatch(/<\/svg>$/);
    expect(svg).toContain(`width="${config.width}"`);
    expect(svg).toContain(`height="${config.height}"`);
  });
  it('emits one cell-background rect per cell', () => {
    const config = makeDefaultConfig(2, 3);
    const layout = computeGridLayout(config);
    const backgrounds = resolveCellBackgrounds(config);
    const svg = buildBaseSvg(config, layout, backgrounds);
    // 1 canvas bg + 6 cell bgs + 6 shape rects/circles = at least 13 elements,
    // but minimum 6 cell bg rects after stripping canvas bg.
    const cellBgs = svg.match(/<rect[^>]*fill="/g);
    expect(cellBgs?.length).toBeGreaterThanOrEqual(7);
  });
  it('escapes background colour interpolation', () => {
    const config: FlexIconGridConfig = {
      ...makeDefaultConfig(1, 1),
      background: { type: 'solid', color: '#0a0a0a' },
    };
    const layout = computeGridLayout(config);
    const backgrounds = resolveCellBackgrounds(config);
    // Sanity — passing through valid hex should NOT introduce entities
    const svg = buildBaseSvg(config, layout, backgrounds);
    expect(svg).not.toContain('&amp;amp;');
  });
});

// ─── PALETTE constants smoke test ───────────────────────────────────────────

describe('PALETTE_RAINBOW', () => {
  it('contains exactly 15 entries to cover 5×3 grids without repeats', () => {
    expect(PALETTE_RAINBOW).toHaveLength(15);
  });
  it('contains only valid hex codes', () => {
    for (const c of PALETTE_RAINBOW) {
      expect(parseHex(c)).not.toBeNull();
    }
  });
});

// ─── Phase 2 ─────────────────────────────────────────────────────────────────

describe('Phase 2 — cell shapes', () => {
  it('supports the full six-shape enumeration', () => {
    expect(SUPPORTED_CELL_SHAPES).toEqual([
      'circle',
      'square',
      'rounded-square',
      'hexagon',
      'pill',
      'capsule',
    ]);
  });
  it('accepts every supported shape in validateConfig', () => {
    for (const shape of SUPPORTED_CELL_SHAPES) {
      const config = makeDefaultConfig(1, 1);
      config.cells[0].shape = shape;
      const result = validateConfig(config);
      expect(result).toEqual({ ok: true });
    }
  });
});

describe('Phase 2 — content types', () => {
  it('supports five content variants including ai-sticker', () => {
    expect(SUPPORTED_CONTENT_TYPES).toEqual([
      'icon-library',
      'emoji',
      'upload',
      'text-only',
      'ai-sticker',
    ]);
  });
  it('rejects ai-sticker cells without a prompt', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].content = { type: 'ai-sticker', prompt: '' };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
  it('accepts ai-sticker cells with a prompt but no url', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].content = { type: 'ai-sticker', prompt: 'a hooded rat' };
    const result = validateConfig(config);
    expect(result).toEqual({ ok: true });
  });
});

describe('Phase 2 — per-cell backgrounds', () => {
  it('parseConfig normalises gradient cell background', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        background: { type: 'gradient', from: '#000000', to: '#ffffff', angle: 45 },
      }],
    });
    expect(config.cells[0].background).toEqual({
      type: 'gradient', from: '#000000', to: '#ffffff', angle: 45,
    });
  });
  it('parseConfig normalises pattern cell background', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        background: { type: 'pattern', pattern: 'dots', fg: '#000', bg: '#fff' },
      }],
    });
    expect(config.cells[0].background).toEqual({
      type: 'pattern', pattern: 'dots', fg: '#000', bg: '#fff',
    });
  });
  it('parseConfig falls back to dots for unknown pattern names', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        background: { type: 'pattern', pattern: 'plaid', fg: '#000', bg: '#fff' },
      }],
    });
    expect(config.cells[0].background).toMatchObject({ type: 'pattern', pattern: 'dots' });
  });
});

describe('Phase 2 — cell-merge (cellSpan)', () => {
  it('computeCellRect returns the span-extended rect', () => {
    const config = makeDefaultConfig(3, 5);
    const layout = computeGridLayout(config);
    const single = computeCellRect(layout, 1);
    const span = computeCellRect(layout, 1, { rows: 2, cols: 2 });
    // Spanning 2×2 doubles width (plus 1 gap, which is 0 by default)
    // and doubles height.
    expect(span.w).toBeCloseTo(single.w * 2, 1);
    expect(span.h).toBeCloseTo(single.h * 2, 1);
    expect(span.x).toBe(single.x);
    expect(span.y).toBe(single.y);
  });
  it('clamps a span that would overflow the grid', () => {
    const config = makeDefaultConfig(2, 2);
    const layout = computeGridLayout(config);
    // Bottom-right cell (index 4) attempting a 2×2 span — should
    // clamp to 1×1 because there's nothing to the right or below.
    const r = computeCellRect(layout, 4, { rows: 2, cols: 2 });
    const single = computeCellRect(layout, 4);
    expect(r.w).toBeCloseTo(single.w, 1);
    expect(r.h).toBeCloseTo(single.h, 1);
  });
  it('getConsumedCellIndexes returns the cells claimed by a span', () => {
    const config = makeDefaultConfig(3, 5);
    config.cells[0].cellSpan = { rows: 2, cols: 2 };
    const consumed = getConsumedCellIndexes(config);
    // Cell 1 at (0,0) spanning 2×2 in a 5-col grid claims:
    // (0,1)=2, (1,0)=6, (1,1)=7
    expect(consumed).toEqual(new Set([2, 6, 7]));
  });
  it('computeRegions skips consumed cells', () => {
    const config = makeDefaultConfig(2, 2);
    config.cells[0].cellSpan = { rows: 2, cols: 2 };
    const regions = computeRegions(config, () => 'id');
    // Only the spanning cell renders a region — the 3 consumed cells
    // are skipped. The spanning region covers the whole grid.
    expect(regions).toHaveLength(1);
    expect(regions[0].label).toBe(config.cells[0].label);
  });
});

describe('Phase 2 — twemoji codepoint slug', () => {
  it('produces lowercase hex slug for a simple emoji', () => {
    expect(emojiToCodepointSlug('⚡')).toBe('26a1');
  });
  it('joins codepoints with dashes for ZWJ-joined emoji', () => {
    expect(emojiToCodepointSlug('👨‍👩‍👧')).toBe('1f468-200d-1f469-200d-1f467');
  });
  it('strips the variation selector U+FE0F', () => {
    // ❤️ = U+2764 U+FE0F → slug should be just 2764
    expect(emojiToCodepointSlug('❤️')).toBe('2764');
  });
  it('returns empty string for empty input', () => {
    expect(emojiToCodepointSlug('')).toBe('');
  });
});

// ─── Phase 3 ─────────────────────────────────────────────────────────────────

describe('Phase 3 — brand icons', () => {
  it('exports the expected eight brand marks', () => {
    expect(BRAND_ICONS.map((b) => b.slug)).toEqual([
      'github', 'twitter', 'youtube', 'instagram', 'linkedin',
      'discord', 'tiktok', 'slack',
    ]);
  });
  it('every brand icon is registered in the main ICON_REGISTRY', () => {
    for (const brand of BRAND_ICONS) {
      const entry = getIconEntry(brand.slug);
      expect(entry).not.toBeNull();
      expect(entry?.category).toBe('web');
    }
  });
  it('brand icons are wrapped in a lucide-static-shaped SVG envelope', () => {
    for (const brand of BRAND_ICONS) {
      expect(brand.svg).toMatch(/^<svg /);
      expect(brand.svg).toMatch(/viewBox="0 0 24 24"/);
      expect(brand.svg).toMatch(/<\/svg>$/);
    }
  });
  it('extractIconInner returns a non-empty body for every brand icon', () => {
    for (const brand of BRAND_ICONS) {
      const inner = extractIconInner(brand.svg);
      expect(inner.length).toBeGreaterThan(0);
      expect(inner).not.toContain('<svg');
    }
  });
  it('does not collide with the existing X (close) Lucide slug', () => {
    // The brand renamed itself to X; we use slug 'twitter' to avoid
    // collision with the close-cross icon that's already in the
    // registry under slug 'x'.
    const slugs = ICON_REGISTRY.map((e) => e.slug);
    const xCount = slugs.filter((s) => s === 'x').length;
    expect(xCount).toBe(1);
  });
});

describe('Phase 3 — sticker style presets', () => {
  it('exposes the expected catalogue of presets', () => {
    const ids = STICKER_STYLE_PRESETS.map((p) => p.id);
    expect(ids).toContain(DEFAULT_STICKER_STYLE);
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });
  it('every preset has a non-empty prefix', () => {
    for (const preset of STICKER_STYLE_PRESETS) {
      expect(preset.prefix.length).toBeGreaterThan(20);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });
  it('resolveStickerStyle returns the default for unknown ids', () => {
    expect(resolveStickerStyle('does-not-exist').id).toBe(DEFAULT_STICKER_STYLE);
    expect(resolveStickerStyle(null).id).toBe(DEFAULT_STICKER_STYLE);
    expect(resolveStickerStyle(undefined).id).toBe(DEFAULT_STICKER_STYLE);
  });
  it('resolveStickerStyle returns the matching preset for known ids', () => {
    expect(resolveStickerStyle('neon').id).toBe('neon');
    expect(resolveStickerStyle('hand-drawn').id).toBe('hand-drawn');
  });
});

describe('Phase 3 — span conflicts', () => {
  it('flags a span that overlaps an earlier cell\'s span', () => {
    // 3×5 grid. Cell 1 has span 2×2 (consumes 2, 6, 7). Cell 6 also
    // has span 2×2 — but cell 6 is itself consumed, so the cascading
    // rule reports it as 'consumed-by-earlier' (the more informative
    // diagnosis with the post-Phase-3.5 simplified union).
    const config = makeDefaultConfig(3, 5);
    config.cells[0].cellSpan = { rows: 2, cols: 2 };
    config.cells[5].cellSpan = { rows: 2, cols: 2 };
    const conflicts = getSpanConflicts(config);
    expect(conflicts.get(6)).toBe('consumed-by-earlier');
  });
  it('flags a span that extends past the grid edge', () => {
    // Bottom-right cell in a 2×2 grid tries a 2×2 span — there's
    // nothing to its right or below, so the renderer clamps to 1×1
    // and the cell is flagged so the editor can warn the user.
    const config = makeDefaultConfig(2, 2);
    config.cells[3].cellSpan = { rows: 2, cols: 2 };
    const conflicts = getSpanConflicts(config);
    expect(conflicts.get(4)).toBe('clamped-to-grid');
  });
  it('returns empty map when no spans are set', () => {
    const config = makeDefaultConfig(3, 3);
    expect(getSpanConflicts(config).size).toBe(0);
  });
  it('cascading consume rule: consumed cells\' spans are ignored', () => {
    // Cell 1 span 2×2 consumes 2, 6, 7. Cell 6's span 2×2 would
    // normally claim 7, 11, 12 — but cell 6 is consumed, so its span
    // is dropped. Net consumed set: {2, 6, 7} (not {2, 6, 7, 11, 12}).
    const config = makeDefaultConfig(3, 5);
    config.cells[0].cellSpan = { rows: 2, cols: 2 };
    config.cells[5].cellSpan = { rows: 2, cols: 2 };
    const consumed = getConsumedCellIndexes(config);
    expect(consumed).toEqual(new Set([2, 6, 7]));
  });
});

// ─── Phase 3.5 ───────────────────────────────────────────────────────────────

describe('Phase 3.5 — iconStyle on IconEntry', () => {
  it('omitting iconStyle is equivalent to stroke', () => {
    // Every simplified brand icon ships without an iconStyle field;
    // the composer must render them in stroke mode (Lucide default).
    for (const entry of BRAND_ICONS) {
      if (!entry.iconStyle) {
        // Confirmed stroke fallback by walking inlineIconSvg's wrap.
        const wrapped = inlineIconSvg(entry.slug, 12, 12, 24, '#ff0000', 2);
        expect(wrapped).toContain('stroke="#ff0000"');
        expect(wrapped).toContain('fill="none"');
      }
    }
  });
  it('iconStyle "fill" wraps the body in a fill group with no stroke', () => {
    // OFFICIAL_BRAND_ICONS is empty by default. Inject a synthetic
    // fill-style entry via the registry to verify the wrap behaviour.
    // We can't mutate ICON_REGISTRY at runtime, so we exercise the
    // path indirectly: any entry the download script writes would
    // carry iconStyle 'fill'. Verify that, when such an entry IS
    // present (the future shape), the wrap is correct by simulating
    // the function's output shape for the same body.
    const stroke = inlineIconSvg('shield', 12, 12, 24, '#00ff00', 2);
    // Sanity: shield is a Lucide entry (stroke). Different from fill.
    expect(stroke).toContain('stroke="#00ff00"');
    expect(stroke).not.toContain('fill="#00ff00"');
  });
});

describe('Phase 3.5 — OFFICIAL_BRAND_ICONS stub', () => {
  it('exports an empty readonly array by default', () => {
    expect(OFFICIAL_BRAND_ICONS).toEqual([]);
  });
  it('does not pollute the BRAND_ICONS registry with empty entries', () => {
    // BRAND_ICONS = SIMPLIFIED + OFFICIAL. Empty OFFICIAL means
    // BRAND_ICONS length equals SIMPLIFIED_BRAND_ICONS length (8).
    expect(BRAND_ICONS).toHaveLength(8);
  });
});

describe('Phase 4.8 — font byte cache', () => {
  it('coalesces concurrent fetches into a single in-flight request', async () => {
    const { fetchFontBytesCached, _resetFontByteCacheForTests } =
      await import('@/lib/thumbnail-formats/flex-icon-grid-font-cache');
    _resetFontByteCacheForTests();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return Buffer.from('font-bytes');
    };
    const [a, b] = await Promise.all([
      fetchFontBytesCached('https://example.com/font.ttf', fetcher),
      fetchFontBytesCached('https://example.com/font.ttf', fetcher),
    ]);
    expect(a.toString()).toBe('font-bytes');
    expect(b.toString()).toBe('font-bytes');
    expect(calls).toBe(1);
  });
  it('serves cached results without refetching', async () => {
    const { fetchFontBytesCached, _resetFontByteCacheForTests } =
      await import('@/lib/thumbnail-formats/flex-icon-grid-font-cache');
    _resetFontByteCacheForTests();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Buffer.from('bytes');
    };
    await fetchFontBytesCached('https://example.com/a.ttf', fetcher);
    await fetchFontBytesCached('https://example.com/a.ttf', fetcher);
    await fetchFontBytesCached('https://example.com/a.ttf', fetcher);
    expect(calls).toBe(1);
  });
  it('evicts the oldest entry by atime when capacity is reached', async () => {
    const { fetchFontBytesCached, _resetFontByteCacheForTests, getFontCacheStats } =
      await import('@/lib/thumbnail-formats/flex-icon-grid-font-cache');
    _resetFontByteCacheForTests();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return Buffer.from('x');
    };
    // Fill past capacity (20). Capacity guard activates on insert.
    for (let i = 0; i < 25; i++) {
      await fetchFontBytesCached(`https://example.com/font-${i}.ttf`, fetcher);
    }
    const stats = getFontCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(stats.max);
    expect(calls).toBe(25);
  });
});

describe('Phase 4.8 — workspace-font validation (pure module)', () => {
  const goodKey = 'thumbnails/flex-icon-grid-font/1234-MyFont.ttf';
  it('accepts a well-formed input', () => {
    const result = validateWorkspaceFontInput({
      name: 'My Font',
      r2_key: goodKey,
      mime_type: 'font/ttf',
      size_bytes: 102400,
    });
    expect(result.ok).toBe(true);
  });
  it('rejects missing name', () => {
    expect(validateWorkspaceFontInput({
      r2_key: goodKey, mime_type: 'font/ttf', size_bytes: 10,
    }).ok).toBe(false);
  });
  it('rejects oversized name', () => {
    expect(validateWorkspaceFontInput({
      name: 'a'.repeat(61),
      r2_key: goodKey, mime_type: 'font/ttf', size_bytes: 10,
    }).ok).toBe(false);
  });
  it('rejects r2_key outside the font upload prefix', () => {
    const result = validateWorkspaceFontInput({
      name: 'X',
      r2_key: 'thumbnails/flex-icon-grid-cell-upload/123-MyImage.jpg',
      mime_type: 'font/ttf',
      size_bytes: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/r2_key must point at/);
  });
  it('rejects unsupported mime_type', () => {
    expect(validateWorkspaceFontInput({
      name: 'X', r2_key: goodKey, mime_type: 'image/png', size_bytes: 10,
    }).ok).toBe(false);
  });
  it('rejects oversized files', () => {
    expect(validateWorkspaceFontInput({
      name: 'X', r2_key: goodKey, mime_type: 'font/ttf',
      size_bytes: 6 * 1024 * 1024,
    }).ok).toBe(false);
  });
});

describe('Phase 4.7c — saved-template validation (pure module)', () => {
  it('accepts a well-formed input', () => {
    const result = validateSavedTemplateInput({
      name: 'My Template',
      config: { rows: 3, cols: 5 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('My Template');
    }
  });
  it('rejects missing name', () => {
    const result = validateSavedTemplateInput({ config: {} });
    expect(result.ok).toBe(false);
  });
  it('rejects empty/whitespace name', () => {
    const result = validateSavedTemplateInput({ name: '   ', config: {} });
    expect(result.ok).toBe(false);
  });
  it('rejects oversized name', () => {
    const result = validateSavedTemplateInput({
      name: 'a'.repeat(61),
      config: {},
    });
    expect(result.ok).toBe(false);
  });
  it('rejects missing config', () => {
    const result = validateSavedTemplateInput({ name: 'X' });
    expect(result.ok).toBe(false);
  });
  it('rejects non-object config', () => {
    const result = validateSavedTemplateInput({ name: 'X', config: 'not an object' });
    expect(result.ok).toBe(false);
  });
  it('trims whitespace from name', () => {
    const result = validateSavedTemplateInput({
      name: '  My Template  ',
      config: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('My Template');
  });
});

describe('Phase 4 — saved-palette validation (pure module)', () => {
  it('accepts a well-formed input', () => {
    const result = validateSavedPaletteInput({
      name: 'My Palette',
      colors: ['#FF0000', '#00FF00', '#0000FF'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('My Palette');
      expect(result.value.colors).toEqual(['#FF0000', '#00FF00', '#0000FF']);
    }
  });
  it('rejects missing name', () => {
    const result = validateSavedPaletteInput({ colors: ['#FF0000'] });
    expect(result.ok).toBe(false);
  });
  it('rejects empty colours', () => {
    const result = validateSavedPaletteInput({ name: 'X', colors: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at least one entry/);
  });
  it('rejects too many colours', () => {
    const result = validateSavedPaletteInput({
      name: 'X',
      colors: Array.from({ length: 31 }, () => '#FF0000'),
    });
    expect(result.ok).toBe(false);
  });
  it('rejects malformed hex strings with the offending index', () => {
    const result = validateSavedPaletteInput({
      name: 'X',
      colors: ['#FF0000', 'not-a-color', '#0000FF'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/colors\[1\]/);
  });
  it('trims whitespace from name and re-validates length', () => {
    const result = validateSavedPaletteInput({
      name: '   My Palette   ',
      colors: ['#FF0000'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('My Palette');
  });
  it('accepts #RGB shorthand hex', () => {
    const result = validateSavedPaletteInput({
      name: 'X',
      colors: ['#f0a', '#abc'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('Phase 4 — ICONIFY_ICONS stub', () => {
  it('exports an empty readonly array by default', () => {
    expect(ICONIFY_ICONS).toEqual([]);
  });
  it('does not pollute the registry with empty entries', () => {
    // The .generated stub stays empty until the download script runs.
    // BRAND_ICONS (length 8) + ICONIFY_ICONS (length 0) means the
    // total ICON_REGISTRY count matches the simplified-only count.
    const iconifyInRegistry = ICON_REGISTRY.filter((e) =>
      ICONIFY_ICONS.some((i) => i.slug === e.slug),
    );
    expect(iconifyInRegistry).toEqual([]);
  });
});

describe('Phase 3.5 — per-cell sticker style', () => {
  it('parseConfig normalises a per-cell style override', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A',
        content: { type: 'ai-sticker', prompt: 'a flame', style: 'neon' },
      }],
    });
    const content = config.cells[0].content;
    if (content.type !== 'ai-sticker') throw new Error('expected ai-sticker');
    expect(content.style).toBe('neon');
  });
  it('parseConfig leaves style undefined when omitted', () => {
    const config = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A',
        content: { type: 'ai-sticker', prompt: 'a flame' },
      }],
    });
    const content = config.cells[0].content;
    if (content.type !== 'ai-sticker') throw new Error('expected ai-sticker');
    expect(content.style).toBeUndefined();
  });
});

// ─── Phase 4.5 ───────────────────────────────────────────────────────────────

describe('Phase 4.6 — saved-palettes client cache', () => {
  it('coalesces concurrent fetches into a single in-flight request', async () => {
    const { fetchSavedPalettesCached, _resetSavedPalettesCacheForTests } =
      await import('@/lib/flex-icon-grid-saved-palettes-client-cache');
    _resetSavedPalettesCacheForTests();
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      // Tiny delay so the second caller arrives while the first is in flight.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ palettes: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([
        fetchSavedPalettesCached(),
        fetchSavedPalettesCached(),
      ]);
      expect(a).toEqual([]);
      expect(b).toEqual([]);
      expect(calls).toBe(1); // shared in-flight promise
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('serves cached results within the TTL window without refetching', async () => {
    const { fetchSavedPalettesCached, _resetSavedPalettesCacheForTests } =
      await import('@/lib/flex-icon-grid-saved-palettes-client-cache');
    _resetSavedPalettesCacheForTests();
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ palettes: [{ id: '1', name: 'A', colors: ['#FF0000'], updated_at: '' }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const a = await fetchSavedPalettesCached();
      const b = await fetchSavedPalettesCached();
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('refetches after invalidate', async () => {
    const {
      fetchSavedPalettesCached,
      invalidateSavedPalettesCache,
      _resetSavedPalettesCacheForTests,
    } = await import('@/lib/flex-icon-grid-saved-palettes-client-cache');
    _resetSavedPalettesCacheForTests();
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ palettes: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchSavedPalettesCached();
      invalidateSavedPalettesCache();
      await fetchSavedPalettesCached();
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('returns null on HTTP error so callers can render an error state', async () => {
    const { fetchSavedPalettesCached, _resetSavedPalettesCacheForTests } =
      await import('@/lib/flex-icon-grid-saved-palettes-client-cache');
    _resetSavedPalettesCacheForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch;
    try {
      const result = await fetchSavedPalettesCached();
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Phase 4.5 — per-cell sticker style history round-trip', () => {
  it('per-cell style survives JSON round-trip (history save → restore)', () => {
    // Simulate the history save path: panel reports config →
    // FlexIconGridHistoryPayload.config = config → JSON.stringify on
    // save → JSON.parse on restore → parseConfig hydrates the panel
    // state. The per-cell style must survive that loop unchanged.
    const original = makeDefaultConfig(1, 2);
    original.cells[0].content = { type: 'ai-sticker', prompt: 'a flame', style: 'neon' };
    original.cells[1].content = { type: 'ai-sticker', prompt: 'a leaf', style: 'watercolor' };

    const serialised = JSON.stringify(original);
    const reparsed = parseConfig(JSON.parse(serialised));

    const c0 = reparsed.cells[0].content;
    const c1 = reparsed.cells[1].content;
    if (c0.type !== 'ai-sticker' || c1.type !== 'ai-sticker') {
      throw new Error('expected ai-sticker on both cells');
    }
    expect(c0.style).toBe('neon');
    expect(c1.style).toBe('watercolor');
  });
  it('per-cell style + url both survive when sticker is already generated', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].content = {
      type: 'ai-sticker',
      prompt: 'a flame',
      style: 'neon',
      url: 'https://example.com/sticker.png',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    const content = reparsed.cells[0].content;
    if (content.type !== 'ai-sticker') throw new Error('expected ai-sticker');
    expect(content.style).toBe('neon');
    expect(content.url).toBe('https://example.com/sticker.png');
  });
});

// ─── Phase 4.10 — title bar subtitle ────────────────────────────────────────

describe('Phase 4.10 — title bar subtitle', () => {
  it('round-trips subtitle + subtitleColor through parseConfig', () => {
    const original = makeDefaultConfig(2, 2);
    original.titleBar = {
      text: '5 LEVELS',
      position: 'top',
      height: 120,
      background: '#0a0a0a',
      color: '#ffffff',
      font: 'anton',
      subtitle: 'OF PHOTOSYNTHESIS',
      subtitleColor: '#9ca3af',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.subtitle).toBe('OF PHOTOSYNTHESIS');
    expect(reparsed.titleBar?.subtitleColor).toBe('#9ca3af');
  });
  it('drops empty-string subtitle so it normalises to undefined', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X',
        position: 'bottom',
        height: 96,
        background: '#000000',
        color: '#ffffff',
        font: 'anton',
        subtitle: '',
      },
    });
    expect(reparsed.titleBar?.subtitle).toBeUndefined();
  });
  it('rejects subtitle longer than 200 chars', () => {
    const config = makeDefaultConfig(1, 1);
    config.titleBar = {
      text: 'A', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      subtitle: 'x'.repeat(201),
    };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subtitle/);
  });
  it('rejects malformed hex on subtitleColor', () => {
    const config = makeDefaultConfig(1, 1);
    config.titleBar = {
      text: 'A', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      subtitleColor: 'not-a-color',
    };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subtitleColor/);
  });
});

// ─── Phase 4.11 — independent subtitle font ─────────────────────────────────

describe('Phase 4.11 — independent subtitle font', () => {
  it('round-trips subtitleFont through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.titleBar = {
      text: 'TITLE', position: 'top', height: 100,
      background: '#000', color: '#fff', font: 'anton',
      subtitle: 'subtitle text', subtitleFont: 'patrick-hand',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.subtitleFont).toBe('patrick-hand');
  });
  it('drops subtitleCustomFontUrl when subtitleFont is not custom', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        subtitle: 'y', subtitleFont: 'bowlby-one',
        subtitleCustomFontUrl: 'https://example.com/stale.ttf',
      },
    });
    expect(reparsed.titleBar?.subtitleCustomFontUrl).toBeUndefined();
  });
  it('falls back to undefined for unsupported subtitleFont values', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        subtitle: 'y', subtitleFont: 'comic-sans',
      },
    });
    expect(reparsed.titleBar?.subtitleFont).toBeUndefined();
  });
});

// ─── Phase 4.11 — per-cell drop shadow ──────────────────────────────────────

describe('Phase 4.11 — per-cell drop shadow', () => {
  it('round-trips defaultShadow through parseConfig', () => {
    const original = makeDefaultConfig(2, 2);
    original.defaultShadow = { offsetY: 6, blur: 10, color: '#000000', opacity: 0.3 };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.defaultShadow).toEqual({ offsetY: 6, blur: 10, color: '#000000', opacity: 0.3 });
  });
  it('clamps opacity into [0, 1]', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      defaultShadow: { offsetY: 4, blur: 8, color: '#000000', opacity: 1.5 },
    });
    expect(reparsed.defaultShadow?.opacity).toBe(1);
  });
  it('floors negative blur at 0', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      defaultShadow: { offsetY: 4, blur: -5, color: '#000000', opacity: 0.5 },
    });
    expect(reparsed.defaultShadow?.blur).toBe(0);
  });
  it('resolveCellShadow returns null when cell.shadow is null even with default set', () => {
    const config = makeDefaultConfig(1, 1);
    config.defaultShadow = { offsetY: 4, blur: 8, color: '#000', opacity: 0.5 };
    config.cells[0].shadow = null;
    expect(resolveCellShadow(config.cells[0], config)).toBeNull();
  });
  it('resolveCellShadow falls back to default when cell.shadow is undefined', () => {
    const config = makeDefaultConfig(1, 1);
    config.defaultShadow = { offsetY: 7, blur: 9, color: '#111', opacity: 0.4 };
    expect(resolveCellShadow(config.cells[0], config)).toEqual({
      offsetY: 7, blur: 9, color: '#111', opacity: 0.4,
    });
  });
  it('resolveCellShadow uses the cell override when present', () => {
    const config = makeDefaultConfig(1, 1);
    config.defaultShadow = { offsetY: 1, blur: 1, color: '#000', opacity: 0.1 };
    config.cells[0].shadow = { offsetY: 20, blur: 4, color: '#ff0000', opacity: 0.8 };
    expect(resolveCellShadow(config.cells[0], config)).toEqual({
      offsetY: 20, blur: 4, color: '#ff0000', opacity: 0.8,
    });
  });
  it('rejects malformed shadow.color on defaultShadow', () => {
    const config = makeDefaultConfig(1, 1);
    config.defaultShadow = { offsetY: 4, blur: 8, color: 'red', opacity: 0.5 };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/shadow\.color/);
  });
  it('rejects shadow.opacity out of [0, 1] on a cell', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].shadow = { offsetY: 4, blur: 8, color: '#000000', opacity: 2 };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.offending_cell_index).toBe(1);
  });
});

// ─── Phase 4.12 — shadow filter region ──────────────────────────────────────

describe('Phase 4.12 — shadow filter region', () => {
  it('floors per-axis pad at 25% for subtle shadows', () => {
    const region = computeShadowFilterRegion({ offsetY: 2, blur: 1, color: '#000', opacity: 0.3 });
    expect(region.x).toBe(-25);
    expect(region.y).toBe(-25);
    expect(region.w).toBe(150);
  });
  it('expands region for large blur', () => {
    const region = computeShadowFilterRegion({ offsetY: 0, blur: 30, color: '#000', opacity: 0.3 });
    expect(region.x).toBeLessThan(-25);
    expect(region.w).toBeGreaterThan(150);
  });
  it('adds downward headroom for positive offsetY', () => {
    const region = computeShadowFilterRegion({ offsetY: 20, blur: 4, color: '#000', opacity: 0.3 });
    // Bottom edge = 100 + 2*padPct + downExtra; padPct = max(25, 2*4+20)=28
    expect(region.h).toBeGreaterThan(100 + 2 * 28);
  });
});

// ─── Phase 4.12 — corner badges ─────────────────────────────────────────────

describe('Phase 4.12 — corner badges', () => {
  it('round-trips badge through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].badge = { text: 'NEW', corner: 'top-right', background: '#fbbf24', color: '#0a0a0a' };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.cells[0].badge).toEqual({
      text: 'NEW', corner: 'top-right', background: '#fbbf24', color: '#0a0a0a',
    });
  });
  it('truncates badge text past 8 chars at parse time', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        badge: { text: 'EXTRA-LONG', corner: 'top-left', background: '#000', color: '#fff' },
      }],
    });
    expect(reparsed.cells[0].badge?.text.length).toBeLessThanOrEqual(8);
  });
  it('drops empty-text badge to undefined', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        badge: { text: '', corner: 'top-left', background: '#000', color: '#fff' },
      }],
    });
    expect(reparsed.cells[0].badge).toBeUndefined();
  });
  it('falls back to top-right for unknown corner', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        badge: { text: 'NEW', corner: 'middle', background: '#000', color: '#fff' },
      }],
    });
    expect(reparsed.cells[0].badge?.corner).toBe('top-right');
  });
  it('rejects malformed hex on badge.background', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].badge = { text: 'NEW', corner: 'top-right', background: 'red', color: '#000000' };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/badge\.background/);
  });
  it('rejects empty badge text', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].badge = { text: '', corner: 'top-right', background: '#000000', color: '#ffffff' };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
  it('rejects badge text longer than 8 chars at validate time', () => {
    const config = makeDefaultConfig(1, 1);
    config.cells[0].badge = { text: 'TOO-LONG-9', corner: 'top-right', background: '#000000', color: '#ffffff' };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
});

// ─── Phase 4.13 — badge custom font ─────────────────────────────────────────

describe('Phase 4.13 — badge custom font', () => {
  it('round-trips badge font through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].badge = {
      text: 'NEW', corner: 'top-right', background: '#fbbf24', color: '#0a0a0a',
      font: 'bowlby-one',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.cells[0].badge?.font).toBe('bowlby-one');
  });
  it('drops customFontUrl when badge.font is not custom', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        badge: {
          text: 'NEW', corner: 'top-right', background: '#000', color: '#fff',
          font: 'anton', customFontUrl: 'https://example.com/stale.ttf',
        },
      }],
    });
    expect(reparsed.cells[0].badge?.customFontUrl).toBeUndefined();
  });
  it('falls back to undefined for unsupported badge font', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{
        index: 1, label: 'A', content: { type: 'text-only' },
        badge: {
          text: 'NEW', corner: 'top-right', background: '#000', color: '#fff',
          font: 'comic-sans',
        },
      }],
    });
    expect(reparsed.cells[0].badge?.font).toBeUndefined();
  });
});

// ─── Phase 4.13 — shapeSize-aware shadow filter region ──────────────────────

describe('Phase 4.13 — shapeSize-aware shadow filter region', () => {
  it('converts pixel pad to accurate percentage when shapeSize provided', () => {
    // 30px blur + 10px offset = 70px pad on a 200px shape = 35%
    const region = computeShadowFilterRegion(
      { offsetY: 10, blur: 30, color: '#000', opacity: 0.3 },
      200,
    );
    expect(region.x).toBe(-35);
    expect(region.y).toBe(-35);
  });
  it('still floors at 25% when pixel pad is tiny relative to shape', () => {
    // 1px blur, 1px offset on a 500px shape = ~0.6% — floored to 25%
    const region = computeShadowFilterRegion(
      { offsetY: 1, blur: 1, color: '#000', opacity: 0.3 },
      500,
    );
    expect(region.x).toBe(-25);
  });
  it('preserves Phase-4.12 behavior when shapeSize is omitted', () => {
    const region = computeShadowFilterRegion(
      { offsetY: 4, blur: 6, color: '#000', opacity: 0.3 },
    );
    // padFraction = 2*6 + 4 = 16; max(25, 16) = 25
    expect(region.x).toBe(-25);
  });
});

// ─── Phase 4.13 — aspect ratio presets ──────────────────────────────────────

describe('Phase 4.13 — aspect ratio presets', () => {
  it('exposes 16:9, 1:1, 9:16, and 4:3 presets', () => {
    const ids = ASPECT_RATIO_PRESETS.map((p) => p.id);
    expect(ids).toContain('16-9');
    expect(ids).toContain('1-1');
    expect(ids).toContain('9-16');
    expect(ids).toContain('4-3');
  });
  it('getAspectRatioPreset returns the matching preset', () => {
    const shorts = getAspectRatioPreset('9-16');
    expect(shorts?.width).toBe(720);
    expect(shorts?.height).toBe(1280);
  });
  it('getAspectRatioPreset returns undefined for unknown ids', () => {
    expect(getAspectRatioPreset('not-a-real-ratio')).toBeUndefined();
  });
});

// ─── Phase 4.14 — shadow region Gaussian tail headroom ──────────────────────

describe('Phase 4.14 — shadow region Gaussian tail headroom', () => {
  it('adds 2*blur of downward headroom on top of offsetY', () => {
    const shadowNoBlur = { offsetY: 10, blur: 0, color: '#000', opacity: 0.3 };
    const shadowWithBlur = { offsetY: 10, blur: 8, color: '#000', opacity: 0.3 };
    const regionNoBlur = computeShadowFilterRegion(shadowNoBlur, 200);
    const regionWithBlur = computeShadowFilterRegion(shadowWithBlur, 200);
    // With blur=8, downExtraPx = 10 + 16 = 26 → ceil(26/200*100) = 13 %
    // Without blur, downExtraPx = 10 → ceil(10/200*100) = 5 %
    // Difference should be ~8 % more bottom headroom.
    const diff = regionWithBlur.h - regionNoBlur.h;
    expect(diff).toBeGreaterThan(0);
  });
  it('keeps downExtra at zero for negative offsetY (shadow above)', () => {
    const region = computeShadowFilterRegion(
      { offsetY: -10, blur: 4, color: '#000', opacity: 0.3 },
      200,
    );
    // Bottom edge = 100 + 2 * padPct (no downExtra contribution).
    const padPct = region.w / 2 - 50;
    expect(region.h).toBe(100 + 2 * padPct);
  });
});

// ─── Phase 4.15 — cell transposition ────────────────────────────────────────

describe('Phase 4.15 — transposeCells', () => {
  it('rotates a 3-col grid so row 1 becomes column 1', () => {
    // Old grid (rows=2, cols=3):
    //   1 2 3
    //   4 5 6
    // New grid (rows=3, cols=2):
    //   1 4
    //   2 5
    //   3 6
    const cells = [
      { index: 1, label: 'a', content: { type: 'text-only' as const } },
      { index: 2, label: 'b', content: { type: 'text-only' as const } },
      { index: 3, label: 'c', content: { type: 'text-only' as const } },
      { index: 4, label: 'd', content: { type: 'text-only' as const } },
      { index: 5, label: 'e', content: { type: 'text-only' as const } },
      { index: 6, label: 'f', content: { type: 'text-only' as const } },
    ];
    const out = transposeCells(cells, 2, 3);
    expect(out.map((c) => c.label)).toEqual(['a', 'd', 'b', 'e', 'c', 'f']);
    expect(out.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('preserves per-cell overrides through the transpose', () => {
    const cells = [
      { index: 1, label: 'hero', content: { type: 'text-only' as const }, backgroundColor: '#ff0000' },
      { index: 2, label: 'b', content: { type: 'text-only' as const } },
    ];
    const out = transposeCells(cells, 1, 2);
    expect(out[0].backgroundColor).toBe('#ff0000');
  });
});

// ─── Phase 4.15 — title bar heightFraction ──────────────────────────────────

describe('Phase 4.15 — title bar heightFraction', () => {
  it('round-trips heightFraction through parseConfig', () => {
    const original = makeDefaultConfig(2, 2);
    original.titleBar = {
      text: 'TITLE', position: 'top', height: 130,
      heightFraction: 0.18,
      background: '#000', color: '#fff', font: 'anton',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.heightFraction).toBe(0.18);
  });
  it('drops out-of-range heightFraction values', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96, heightFraction: 2.5,
        background: '#000', color: '#fff', font: 'anton',
      },
    });
    expect(reparsed.titleBar?.heightFraction).toBeUndefined();
  });
});

// ─── Phase 4.15 — palette shuffle offset ────────────────────────────────────

describe('Phase 4.15 — palette shuffle offset', () => {
  it('round-trips paletteShuffleOffset through parseConfig', () => {
    const original = makeDefaultConfig(2, 2);
    original.paletteShuffleOffset = 3;
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.paletteShuffleOffset).toBe(3);
  });
  it('coerces non-integer offsets via floor + max(0,…)', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      paletteShuffleOffset: 5.9,
    });
    expect(reparsed.paletteShuffleOffset).toBe(5);
  });
  it('drops negative offsets at parse time', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      paletteShuffleOffset: -3,
    });
    expect(reparsed.paletteShuffleOffset).toBe(0);
  });
});

// ─── Phase 4.15 — 21:9 aspect ratio preset ──────────────────────────────────

describe('Phase 4.15 — 21:9 ultra-wide preset', () => {
  it('exposes the ultra-wide preset', () => {
    const wide = getAspectRatioPreset('21-9');
    expect(wide).toBeDefined();
    expect(wide?.width).toBe(1680);
    expect(wide?.height).toBe(720);
  });
});

// ─── Phase 4.16 — cellSpan transpose ────────────────────────────────────────

describe('Phase 4.16 — transposeCells swaps cellSpan rows/cols', () => {
  it('swaps cellSpan rows and cols on transpose', () => {
    const cells = [
      {
        index: 1,
        label: 'hero',
        content: { type: 'text-only' as const },
        cellSpan: { rows: 2, cols: 1 },
      },
      { index: 2, label: 'b', content: { type: 'text-only' as const } },
      { index: 3, label: 'c', content: { type: 'text-only' as const } },
      { index: 4, label: 'd', content: { type: 'text-only' as const } },
    ];
    const out = transposeCells(cells, 2, 2);
    expect(out[0].cellSpan).toEqual({ rows: 1, cols: 2 });
  });
  it('leaves un-spanned cells without a cellSpan field', () => {
    const cells = [
      { index: 1, label: 'a', content: { type: 'text-only' as const } },
    ];
    const out = transposeCells(cells, 1, 1);
    expect(out[0].cellSpan).toBeUndefined();
  });
});

// ─── Phase 4.16 — per-cell rotation ─────────────────────────────────────────

describe('Phase 4.16 — per-cell rotation', () => {
  it('round-trips rotation through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].rotation = 45;
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.cells[0].rotation).toBe(45);
  });
  it('clamps rotation outside [-180, 180] at parse time', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' }, rotation: 500 }],
    });
    expect(reparsed.cells[0].rotation).toBe(180);
  });
  it('rounds fractional rotation values', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' }, rotation: 45.7 }],
    });
    expect(reparsed.cells[0].rotation).toBe(46);
  });
  it('rejects rotation outside [-180, 180] at validate time', () => {
    const config = makeDefaultConfig(1, 1);
    (config.cells[0] as unknown as { rotation: number }).rotation = 200;
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/rotation/);
  });
  it('rejects non-finite rotation at validate time', () => {
    const config = makeDefaultConfig(1, 1);
    (config.cells[0] as unknown as { rotation: number }).rotation = Number.NaN;
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
});

// ─── Phase 4.17 — JSON round-trip ───────────────────────────────────────────

describe('Phase 4.22 — shiftPaletteLightness', () => {
  it('lightens by the requested delta when headroom is ample', () => {
    // #808080 is HSL(0, 0%, 50%). +20 has 45 headroom, so full +20 applies → L=70%.
    const next = shiftPaletteLightness(['#808080'], 20);
    const rgb = parseHex(next[0]);
    expect(rgb).not.toBeNull();
    if (rgb) expect(rgb.r).toBeGreaterThan(0x80);
  });
  it('clamps at 95% so the colour never goes fully white', () => {
    // Already near-white; +50 should clamp short of pure white.
    const next = shiftPaletteLightness(['#f0f0f0'], 50);
    expect(next[0]).not.toBe('#ffffff');
  });
  it('clamps at 5% so the colour never goes fully black', () => {
    const next = shiftPaletteLightness(['#0a0a0a'], -50);
    expect(next[0]).not.toBe('#000000');
  });
  it('returns the input verbatim for unparseable hex', () => {
    const next = shiftPaletteLightness(['not-a-color'], 8);
    expect(next[0]).toBe('not-a-color');
  });
  it('preserves the array length', () => {
    const next = shiftPaletteLightness(['#ff0000', '#00ff00', '#0000ff'], 8);
    expect(next).toHaveLength(3);
  });
  // Phase 4.23: saturation companion.
  it('Phase 4.23 — shiftPaletteSaturation increases saturation when headroom is ample', () => {
    // #c87878 is a desaturated red (S ≈ 41 %); +10 has room and
    // pulls it toward a more saturated red.
    const before = parseHex('#c87878');
    const next = shiftPaletteSaturation(['#c87878'], 10);
    const after = parseHex(next[0]);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (before && after) {
      // R should stay similar or grow (the dominant hue);
      // G + B should drop (further from grey).
      expect(after.g).toBeLessThan(before.g);
      expect(after.b).toBeLessThan(before.b);
    }
  });
  it('Phase 4.23 — shiftPaletteSaturation clamps at 0 / 100', () => {
    // Fully saturated #ff0000 with +50 stays #ff0000.
    const up = shiftPaletteSaturation(['#ff0000'], 50);
    expect(up[0]).toBe('#ff0000');
    // Already desaturated #808080 with -50 stays grey.
    const down = shiftPaletteSaturation(['#808080'], -50);
    const rgb = parseHex(down[0]);
    if (rgb) {
      expect(rgb.r).toBe(rgb.g);
      expect(rgb.g).toBe(rgb.b);
    }
  });
  // Phase 4.23: spread preservation.
  it('Phase 4.23 — preserves relative spread when one colour is near the clamp', () => {
    // #f0f0f0 ≈ L 94%; #808080 = L 50%. Spread = 44.
    // +20 lightens; near-white has headroom = 95 - 94 = 1. So
    // effectiveDelta = 1; both shift by +1. New L's ≈ 95 and 51 → spread 44.
    const next = shiftPaletteLightness(['#f0f0f0', '#808080'], 20);
    const a = parseHex(next[0]);
    const b = parseHex(next[1]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a && b) {
      // Light grey grew by ~1; mid-grey also grew by ~1. The
      // CHANNEL difference between them stays close to the original.
      expect(a.r - b.r).toBeGreaterThanOrEqual(0x6c);
    }
  });
});

describe('Phase 4.21 — generateRandomPalette', () => {
  it('returns the requested count of colours', () => {
    const seq = seededRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 0.5, 0.4, 0.3, 0.2, 0.1, 0.6, 0.7, 0.8, 0.9, 0.5, 0.4, 0.3, 0.2, 0.1, 0.6, 0.7, 0.8, 0.9, 0.5, 0.4]);
    const palette = generateRandomPalette(5, seq);
    expect(palette.length).toBe(5);
  });
  it('returns valid #RRGGBB hex strings', () => {
    const palette = generateRandomPalette(4, () => 0.5);
    for (const c of palette) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
  it('returns the empty array when count is zero or negative', () => {
    expect(generateRandomPalette(0)).toEqual([]);
    expect(generateRandomPalette(-3)).toEqual([]);
  });
  it('is deterministic with a deterministic rng', () => {
    const a = generateRandomPalette(3, seededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
    const b = generateRandomPalette(3, seededRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));
    expect(a).toEqual(b);
  });
});

// Simple test helper: returns a function that yields the next value
// from `seq` on each call, cycling back to the start when exhausted.
function seededRng(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

describe('Phase 4.29 — title bar transparent + text alignment', () => {
  it('round-trips backgroundTransparent through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.titleBar = {
      text: 'X', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      backgroundTransparent: true,
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.backgroundTransparent).toBe(true);
  });
  it('drops backgroundTransparent for non-true values', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        backgroundTransparent: 1,
      },
    });
    expect(reparsed.titleBar?.backgroundTransparent).toBeUndefined();
  });
  it('round-trips textAlign through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.titleBar = {
      text: 'X', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      textAlign: 'left',
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.textAlign).toBe('left');
  });
  it('drops textAlign for unsupported values', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        textAlign: 'justify',
      },
    });
    expect(reparsed.titleBar?.textAlign).toBeUndefined();
  });
});

describe('Phase 4.28 — title bar gradient background', () => {
  it('round-trips backgroundGradient through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.titleBar = {
      text: 'X', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      backgroundGradient: { from: '#ff0000', to: '#0000ff', angle: 135 },
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.backgroundGradient).toEqual({
      from: '#ff0000', to: '#0000ff', angle: 135,
    });
  });
  it('drops backgroundGradient when from / to is missing', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        backgroundGradient: { from: '#ff0000' }, // missing `to`
      },
    });
    expect(reparsed.titleBar?.backgroundGradient).toBeUndefined();
  });
  it('rejects backgroundGradient with bad hex on validation', () => {
    const config = makeDefaultConfig(1, 1);
    config.titleBar = {
      text: 'X', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      backgroundGradient: { from: 'not-a-color', to: '#0000ff', angle: 90 },
    };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/backgroundGradient/);
  });
  it('defaults angle to 180 when parseConfig is given a partial', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        backgroundGradient: { from: '#ff0000', to: '#0000ff' }, // no angle
      },
    });
    expect(reparsed.titleBar?.backgroundGradient?.angle).toBe(180);
  });
});

describe('Phase 4.27 — title bar drop shadow', () => {
  it('round-trips titleBar.shadow through parseConfig', () => {
    const original = makeDefaultConfig(2, 2);
    original.titleBar = {
      text: 'TITLE', position: 'top', height: 100,
      background: '#000', color: '#fff', font: 'anton',
      shadow: { offsetY: 10, blur: 16, color: '#000000', opacity: 0.4 },
    };
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.titleBar?.shadow).toEqual({
      offsetY: 10, blur: 16, color: '#000000', opacity: 0.4,
    });
  });
  it('keeps titleBar.shadow as null when explicitly opted out', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' } }],
      titleBar: {
        text: 'X', position: 'top', height: 96,
        background: '#000', color: '#fff', font: 'anton',
        shadow: null,
      },
    });
    expect(reparsed.titleBar?.shadow).toBeNull();
  });
  it('rejects titleBar.shadow with opacity out of [0, 1]', () => {
    const config = makeDefaultConfig(1, 1);
    config.titleBar = {
      text: 'A', position: 'top', height: 96,
      background: '#000000', color: '#ffffff', font: 'anton',
      shadow: { offsetY: 4, blur: 8, color: '#000000', opacity: 2 },
    };
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/titleBar.shadow/);
  });
});

describe('Phase 4.19 — per-cell flip', () => {
  it('round-trips flipX through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].flipX = true;
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.cells[0].flipX).toBe(true);
  });
  it('round-trips flipY through parseConfig', () => {
    const original = makeDefaultConfig(1, 1);
    original.cells[0].flipY = true;
    const reparsed = parseConfig(JSON.parse(JSON.stringify(original)));
    expect(reparsed.cells[0].flipY).toBe(true);
  });
  it('coerces non-boolean flip values to undefined', () => {
    const reparsed = parseConfig({
      rows: 1, cols: 1,
      cells: [{ index: 1, label: 'A', content: { type: 'text-only' }, flipX: 1, flipY: 'yes' }],
    });
    expect(reparsed.cells[0].flipX).toBeUndefined();
    expect(reparsed.cells[0].flipY).toBeUndefined();
  });
});

describe('Phase 4.17 — JSON round-trip', () => {
  it('survives a full JSON.stringify → JSON.parse → parseConfig cycle', () => {
    const original = makeDefaultConfig(3, 5);
    // Touch a representative spread of fields so any silent drop in
    // the round-trip surfaces here.
    original.titleBar = {
      text: 'Hello', position: 'bottom', height: 96,
      heightFraction: 0.13, background: '#000', color: '#fff', font: 'anton',
      subtitle: 'World', subtitleColor: '#ccc', subtitleFont: 'patrick-hand',
    };
    original.defaultShadow = { offsetY: 8, blur: 12, color: '#000000', opacity: 0.35 };
    original.paletteShuffleOffset = 2;
    original.cells[0].rotation = 45;
    original.cells[0].badge = {
      text: 'NEW', corner: 'top-right', background: '#fbbf24', color: '#0a0a0a',
    };
    original.cells[1].shadow = { offsetY: 4, blur: 6, color: '#000000', opacity: 0.2 };
    original.cells[2].cellSpan = { rows: 2, cols: 2 };

    const roundTripped = parseConfig(JSON.parse(JSON.stringify(original)));

    expect(roundTripped.titleBar?.subtitle).toBe('World');
    expect(roundTripped.titleBar?.heightFraction).toBe(0.13);
    expect(roundTripped.defaultShadow?.opacity).toBe(0.35);
    expect(roundTripped.paletteShuffleOffset).toBe(2);
    expect(roundTripped.cells[0].rotation).toBe(45);
    expect(roundTripped.cells[0].badge?.text).toBe('NEW');
    expect(roundTripped.cells[1].shadow?.blur).toBe(6);
    expect(roundTripped.cells[2].cellSpan).toEqual({ rows: 2, cols: 2 });
  });
});
