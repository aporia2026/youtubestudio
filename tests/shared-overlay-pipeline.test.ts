import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  applyFilter,
  applySharedOverlays,
  buildGrainOverlay,
  buildTitleBarOverlay,
  buildVignetteSvg,
  clampRange,
  clampUnit,
  escapePangoText,
  isHexColor,
  parsePostProcessConfig,
  parseTitleBarRequestPayload,
  safeHexColor,
  titleBarRect,
  type FontRef,
  type TitleBarConfig,
} from '@/lib/thumbnail-formats/shared-overlay-pipeline';

// ─── Test fixtures ──────────────────────────────────────────────────────────

/** Patrick Hand bundled font — the same one Topic Card Grid uses. Available
 *  on disk in the repo so title bar tests can render real Pango output. */
const PATRICK_HAND: FontRef = {
  family: 'Patrick Hand',
  filePath: path.join(process.cwd(), 'public/fonts/PatrickHand-Regular.ttf'),
};

/** Build a solid-colour PNG for use as a base image. */
async function makeSolidPng(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** Read the pixel at (x, y) in a PNG buffer. Returns [R, G, B, A]. */
async function pixelAt(
  png: Buffer,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 3) throw new Error('expected at least 3 channels');
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const idx = (iy * info.width + ix) * info.channels;
  return [
    data[idx],
    data[idx + 1],
    data[idx + 2],
    info.channels >= 4 ? data[idx + 3] : 255,
  ];
}

/** Compute variance of luminance values across the image — a simple
 *  measure of "how busy" the image is. Used by grain tests where we
 *  expect noise to increase variance vs a solid base. */
async function luminanceVariance(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += ch) {
    const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += l;
    n++;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < data.length; i += ch) {
    const l = (data[i] + data[i + 1] + data[i + 2]) / 3;
    varSum += (l - mean) * (l - mean);
  }
  return varSum / n;
}

// ─── Bounds + safety helpers ────────────────────────────────────────────────

describe('clampUnit', () => {
  it('returns 0 for negative inputs', () => {
    expect(clampUnit(-0.5)).toBe(0);
    expect(clampUnit(-100)).toBe(0);
  });
  it('returns 1 for inputs above 1', () => {
    expect(clampUnit(1.5)).toBe(1);
    expect(clampUnit(100)).toBe(1);
  });
  it('preserves inputs in [0, 1]', () => {
    expect(clampUnit(0)).toBe(0);
    expect(clampUnit(0.5)).toBe(0.5);
    expect(clampUnit(1)).toBe(1);
  });
  it('treats non-finite inputs as 0', () => {
    expect(clampUnit(NaN)).toBe(0);
    expect(clampUnit(Infinity)).toBe(1);
    expect(clampUnit(-Infinity)).toBe(0);
  });
});

describe('clampRange', () => {
  it('clamps to lo when below', () => {
    expect(clampRange(-5, 0, 10)).toBe(0);
  });
  it('clamps to hi when above', () => {
    expect(clampRange(50, 0, 10)).toBe(10);
  });
  it('preserves in-range values', () => {
    expect(clampRange(3, 0, 10)).toBe(3);
  });
  it('returns lo for NaN', () => {
    expect(clampRange(NaN, 1, 5)).toBe(1);
  });
});

describe('isHexColor', () => {
  it('accepts #RRGGBB', () => {
    expect(isHexColor('#000000')).toBe(true);
    expect(isHexColor('#ffffff')).toBe(true);
    expect(isHexColor('#abcDEF')).toBe(true);
  });
  it('accepts #RRGGBBAA', () => {
    expect(isHexColor('#00000000')).toBe(true);
    expect(isHexColor('#ffffff80')).toBe(true);
  });
  it('rejects malformed hex', () => {
    expect(isHexColor('000000')).toBe(false);
    expect(isHexColor('#fff')).toBe(false);
    expect(isHexColor('#gggggg')).toBe(false);
    expect(isHexColor('not a color')).toBe(false);
    expect(isHexColor('')).toBe(false);
  });
});

describe('safeHexColor', () => {
  it('returns the input when valid', () => {
    expect(safeHexColor('#abcdef', '#000000')).toBe('#abcdef');
  });
  it('returns the fallback when invalid', () => {
    expect(safeHexColor('garbage', '#000000')).toBe('#000000');
    expect(safeHexColor('#fff', '#111111')).toBe('#111111');
  });
});

describe('escapePangoText', () => {
  it('escapes ampersand', () => {
    expect(escapePangoText('AT&T')).toBe('AT&amp;T');
  });
  it('escapes angle brackets', () => {
    expect(escapePangoText('<3')).toBe('&lt;3');
    expect(escapePangoText('>=')).toBe('&gt;=');
  });
  it('escapes combinations', () => {
    expect(escapePangoText('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });
  it('passes through unaffected text', () => {
    expect(escapePangoText('Hello World')).toBe('Hello World');
  });
});

// ─── Filter pipeline ────────────────────────────────────────────────────────

describe('applyFilter', () => {
  it('grayscale produces equal R, G, B at the center', async () => {
    // Input: red square. After grayscale, R/G/B at center should be equal.
    const input = await makeSolidPng(40, 40, { r: 200, g: 50, b: 50 });
    const out = await applyFilter(input, 'grayscale');
    const [r, g, b] = await pixelAt(out, 20, 20);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('sepia shifts a pure white toward a warm tone', async () => {
    const input = await makeSolidPng(40, 40, { r: 255, g: 255, b: 255 });
    const out = await applyFilter(input, 'sepia');
    const [r, g, b] = await pixelAt(out, 20, 20);
    // Sepia matrix on white: R = 0.393+0.769+0.189 ~ 1.351 (clamps 255),
    // G ~ 1.203 (clamps), B ~ 0.937 (~239). So R == G == 255 and B < R.
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBeLessThan(r);
  });

  it('invert flips RGB on a black input', async () => {
    const input = await makeSolidPng(40, 40, { r: 0, g: 0, b: 0 });
    const out = await applyFilter(input, 'invert');
    const [r, g, b] = await pixelAt(out, 20, 20);
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(255);
  });

  it('high-contrast pushes mid-gray slightly off from baseline', async () => {
    const input = await makeSolidPng(40, 40, { r: 128, g: 128, b: 128 });
    const out = await applyFilter(input, 'high-contrast');
    const [r] = await pixelAt(out, 20, 20);
    // linear(1.3, -38) on 128 -> 128*1.3 - 38 = 128.4 -> rounds to 128 area.
    // Allow ±5 wiggle for rounding.
    expect(r).toBeGreaterThanOrEqual(123);
    expect(r).toBeLessThanOrEqual(133);
  });

  it('low-contrast lifts a pure black input', async () => {
    const input = await makeSolidPng(40, 40, { r: 0, g: 0, b: 0 });
    const out = await applyFilter(input, 'low-contrast');
    const [r, g, b] = await pixelAt(out, 20, 20);
    // linear(0.6, 51) on 0 -> 51. Allow some rounding wiggle.
    expect(r).toBeGreaterThan(40);
    expect(g).toBeGreaterThan(40);
    expect(b).toBeGreaterThan(40);
  });
});

// ─── Vignette ───────────────────────────────────────────────────────────────

describe('buildVignetteSvg', () => {
  it('embeds the safe hex color', () => {
    const svg = buildVignetteSvg(100, 100, '#abcdef', 0.5, 0.5);
    expect(svg).toContain('#abcdef');
  });

  it('falls back to black when given an invalid color', () => {
    const svg = buildVignetteSvg(100, 100, 'garbage', 0.5, 0.5);
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('garbage');
  });

  it('clamps intensity to [0, 1]', () => {
    const svg = buildVignetteSvg(100, 100, '#000000', 5, 0.5);
    // Look for stop-opacity="1" which is the clamped intensity value.
    expect(svg).toMatch(/stop-opacity="1"/);
  });
});

describe('vignette via applySharedOverlays', () => {
  it('darkens corners more than center', async () => {
    const base = await makeSolidPng(200, 200, { r: 200, g: 200, b: 200 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 200, height: 200 },
      postProcess: { vignette: { color: '#000000', intensity: 0.7, radius: 0.3 } },
    });
    const [centerR] = await pixelAt(out, 100, 100);
    const [cornerR] = await pixelAt(out, 5, 5);
    expect(cornerR).toBeLessThan(centerR);
  });

  it('intensity=0 leaves the image untouched', async () => {
    const base = await makeSolidPng(100, 100, { r: 200, g: 200, b: 200 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 100, height: 100 },
      postProcess: { vignette: { color: '#000000', intensity: 0, radius: 0.5 } },
    });
    const [r, g, b] = await pixelAt(out, 5, 5);
    expect(r).toBe(200);
    expect(g).toBe(200);
    expect(b).toBe(200);
  });
});

// ─── Grain ──────────────────────────────────────────────────────────────────

describe('buildGrainOverlay', () => {
  it('produces a buffer at the requested canvas size', async () => {
    const buf = await buildGrainOverlay(100, 80, 0.5, 1, true);
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it('monochrome produces equal RGB at sampled pixels', async () => {
    const buf = await buildGrainOverlay(100, 100, 1, 1, true);
    const [r, g, b] = await pixelAt(buf, 50, 50);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('is deterministic across calls (fixed seed)', async () => {
    const a = await buildGrainOverlay(40, 40, 0.5, 1, true);
    const b = await buildGrainOverlay(40, 40, 0.5, 1, true);
    expect(a.equals(b)).toBe(true);
  });
});

describe('grain via applySharedOverlays', () => {
  it('increases variance vs the solid base', async () => {
    const base = await makeSolidPng(120, 120, { r: 128, g: 128, b: 128 });
    const baseVar = await luminanceVariance(base);
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 120, height: 120 },
      postProcess: { grain: { intensity: 0.8, size: 1, monochrome: true } },
    });
    const outVar = await luminanceVariance(out);
    expect(outVar).toBeGreaterThan(baseVar);
  });

  it('intensity=0 is a no-op (variance unchanged)', async () => {
    const base = await makeSolidPng(80, 80, { r: 128, g: 128, b: 128 });
    const baseVar = await luminanceVariance(base);
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 80, height: 80 },
      postProcess: { grain: { intensity: 0, size: 1, monochrome: true } },
    });
    const outVar = await luminanceVariance(out);
    expect(outVar).toBeCloseTo(baseVar, 5);
  });
});

// ─── Title bar layout math ──────────────────────────────────────────────────

describe('titleBarRect', () => {
  it('positions top band at y=0', () => {
    const r = titleBarRect(1280, 720, 'top', 0.2);
    expect(r.y).toBe(0);
    expect(r.h).toBe(144); // 720 * 0.2
  });

  it('positions bottom band against canvas bottom', () => {
    const r = titleBarRect(1280, 720, 'bottom', 0.2);
    expect(r.y).toBe(576); // 720 - 144
    expect(r.h).toBe(144);
  });

  it('overlay-top behaves identically to top for layout (only opacity differs)', () => {
    const a = titleBarRect(1280, 720, 'top', 0.2);
    const b = titleBarRect(1280, 720, 'overlay-top', 0.2);
    expect(a).toEqual(b);
  });

  it('clamps heightFraction below the minimum', () => {
    const r = titleBarRect(1280, 720, 'top', 0.001);
    // 0.05 * 720 = 36
    expect(r.h).toBe(36);
  });

  it('clamps heightFraction above the maximum', () => {
    const r = titleBarRect(1280, 720, 'top', 0.95);
    // 0.5 * 720 = 360
    expect(r.h).toBe(360);
  });
});

// ─── Title bar rendering ────────────────────────────────────────────────────

describe('buildTitleBarOverlay', () => {
  it('returns a buffer at the band rect size', async () => {
    const overlay = await buildTitleBarOverlay(1280, 720, {
      text: 'HELLO',
      position: 'bottom',
      heightFraction: 0.2,
      align: 'center',
      backgroundColor: '#000000',
      backgroundOpacity: 1,
      textColor: '#ffffff',
      font: PATRICK_HAND,
    });
    const meta = await sharp(overlay.buffer).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(144); // 720 * 0.2
    expect(overlay.top).toBe(576);
    expect(overlay.left).toBe(0);
  });

  it('positions a top bar at y=0', async () => {
    const overlay = await buildTitleBarOverlay(640, 360, {
      text: 'TOP',
      position: 'top',
      heightFraction: 0.15,
      align: 'center',
      backgroundColor: '#222222',
      backgroundOpacity: 1,
      textColor: '#ffffff',
      font: PATRICK_HAND,
    });
    expect(overlay.top).toBe(0);
  });

  it('renders a subtitle when provided', async () => {
    // Smoke test — the function should not throw and should still produce
    // a buffer at the configured size when a subtitle is included.
    const overlay = await buildTitleBarOverlay(800, 450, {
      text: 'MAIN TITLE',
      subtitle: 'subtitle line',
      position: 'bottom',
      heightFraction: 0.25,
      align: 'left',
      subtitleAlign: 'match-title',
      backgroundColor: '#000000',
      backgroundOpacity: 0.9,
      textColor: '#ffffff',
      subtitleColor: '#ffff00',
      font: PATRICK_HAND,
    });
    const meta = await sharp(overlay.buffer).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(113); // round(450 * 0.25) = round(112.5) = 113
  });

  it('does not throw on Pango-control characters in text', async () => {
    // "AT&T" used to error out before the escape was wired in. Verify
    // the escape is applied through the whole render path.
    const overlay = await buildTitleBarOverlay(400, 200, {
      text: 'AT&T <Premium>',
      position: 'top',
      heightFraction: 0.2,
      align: 'center',
      backgroundColor: '#000000',
      backgroundOpacity: 1,
      textColor: '#ffffff',
      font: PATRICK_HAND,
    });
    expect(overlay.buffer.length).toBeGreaterThan(0);
  });
});

// ─── Request-body parser ────────────────────────────────────────────────────

describe('parsePostProcessConfig', () => {
  it('returns null for non-objects', () => {
    expect(parsePostProcessConfig(null)).toBeNull();
    expect(parsePostProcessConfig(undefined)).toBeNull();
    expect(parsePostProcessConfig('not an object')).toBeNull();
    expect(parsePostProcessConfig(42)).toBeNull();
  });

  it('returns null when the object has no recognised fields', () => {
    expect(parsePostProcessConfig({})).toBeNull();
    expect(parsePostProcessConfig({ irrelevant: true })).toBeNull();
  });

  it('returns null when only zero-intensity sub-objects are present', () => {
    // Empty-payload short-circuit: vignette intensity 0 + grain intensity
    // 0 + no filter would all be no-ops, so the parser drops them and
    // returns null instead of an empty config the pipeline still has to
    // walk.
    const out = parsePostProcessConfig({
      vignette: { color: '#000000', intensity: 0, radius: 0.5 },
      grain: { intensity: 0, size: 1, monochrome: true },
    });
    expect(out).toBeNull();
  });

  it('accepts a valid filter id', () => {
    const out = parsePostProcessConfig({ filter: 'sepia' });
    expect(out).not.toBeNull();
    expect(out?.filter).toBe('sepia');
  });

  it('drops unknown filter ids silently', () => {
    const out = parsePostProcessConfig({ filter: 'made-up-filter' });
    expect(out).toBeNull();
  });

  it('parses a valid vignette object with clamping', () => {
    const out = parsePostProcessConfig({
      vignette: { color: '#ff0000', intensity: 2, radius: 5 },
    });
    expect(out?.vignette).toEqual({
      color: '#ff0000',
      intensity: 1, // clamped from 2
      radius: 1, // clamped from 5
    });
  });

  it('falls back vignette color to black when invalid', () => {
    const out = parsePostProcessConfig({
      vignette: { color: 'garbage', intensity: 0.5, radius: 0.5 },
    });
    expect(out?.vignette?.color).toBe('#000000');
  });

  it('parses a valid grain object with clamping', () => {
    const out = parsePostProcessConfig({
      grain: { intensity: 1.5, size: 10, monochrome: true },
    });
    expect(out?.grain).toEqual({
      intensity: 1, // clamped from 1.5
      size: 5, // clamped from 10
      monochrome: true,
    });
  });

  it('combines filter + vignette + grain correctly', () => {
    const out = parsePostProcessConfig({
      filter: 'grayscale',
      vignette: { color: '#000000', intensity: 0.4, radius: 0.5 },
      grain: { intensity: 0.3, size: 2, monochrome: false },
    });
    expect(out?.filter).toBe('grayscale');
    expect(out?.vignette).toBeDefined();
    expect(out?.grain).toBeDefined();
  });

  it('ignores non-object vignette / grain sub-payloads', () => {
    const out = parsePostProcessConfig({
      filter: 'invert',
      vignette: 'not an object',
      grain: 42,
    });
    expect(out?.filter).toBe('invert');
    expect(out?.vignette).toBeUndefined();
    expect(out?.grain).toBeUndefined();
  });
});

// ─── Title bar request-body parser ──────────────────────────────────────────

const MINIMAL_TITLE_BAR_PAYLOAD = {
  text: 'HELLO',
  position: 'bottom',
  heightFraction: 0.2,
  align: 'center',
  backgroundColor: '#000000',
  backgroundOpacity: 1,
  textColor: '#ffffff',
  fontId: 'patrick-hand',
};

describe('parseTitleBarRequestPayload', () => {
  it('returns null for non-objects', () => {
    expect(parseTitleBarRequestPayload(null)).toBeNull();
    expect(parseTitleBarRequestPayload(undefined)).toBeNull();
    expect(parseTitleBarRequestPayload('not an object')).toBeNull();
    expect(parseTitleBarRequestPayload(42)).toBeNull();
  });

  it('returns null when text is empty', () => {
    expect(parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, text: '' })).toBeNull();
    expect(parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, text: '   ' })).toBeNull();
  });

  it('returns null when fontId is missing', () => {
    const { fontId: _f, ...rest } = MINIMAL_TITLE_BAR_PAYLOAD;
    expect(parseTitleBarRequestPayload(rest)).toBeNull();
  });

  it('returns null for unknown position', () => {
    expect(
      parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, position: 'sideways' }),
    ).toBeNull();
  });

  it('returns null for unknown align', () => {
    expect(
      parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, align: 'diagonal' }),
    ).toBeNull();
  });

  it('accepts the minimal valid payload', () => {
    const out = parseTitleBarRequestPayload(MINIMAL_TITLE_BAR_PAYLOAD);
    expect(out).not.toBeNull();
    expect(out?.text).toBe('HELLO');
    expect(out?.position).toBe('bottom');
    expect(out?.align).toBe('center');
    expect(out?.heightFraction).toBe(0.2);
    expect(out?.backgroundColor).toBe('#000000');
    expect(out?.backgroundOpacity).toBe(1);
    expect(out?.textColor).toBe('#ffffff');
    expect(out?.fontId).toBe('patrick-hand');
    // No subtitle provided; default subtitleAlign should still resolve
    // even though there's no subtitle to apply it to.
    expect(out?.subtitleAlign).toBe('match-title');
    expect(out?.subtitle).toBeUndefined();
    expect(out?.shadow).toBeUndefined();
  });

  it('clamps heightFraction to the documented range', () => {
    const low = parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, heightFraction: 0 });
    expect(low?.heightFraction).toBe(0.05);
    const high = parseTitleBarRequestPayload({ ...MINIMAL_TITLE_BAR_PAYLOAD, heightFraction: 2 });
    expect(high?.heightFraction).toBe(0.5);
  });

  it('clamps backgroundOpacity to [0, 1]', () => {
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      backgroundOpacity: 5,
    });
    expect(out?.backgroundOpacity).toBe(1);
  });

  it('falls back colors to documented defaults when invalid', () => {
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      backgroundColor: 'garbage',
      textColor: 'still-garbage',
    });
    expect(out?.backgroundColor).toBe('#000000');
    expect(out?.textColor).toBe('#ffffff');
  });

  it('drops shadow when opacity is 0', () => {
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      shadow: { offsetPx: 2, blurPx: 4, opacity: 0, color: '#000000' },
    });
    expect(out?.shadow).toBeUndefined();
  });

  it('parses a valid shadow sub-object', () => {
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      shadow: { offsetPx: 3, blurPx: 5, opacity: 0.5, color: '#000000' },
    });
    expect(out?.shadow).toEqual({
      offsetPx: 3,
      blurPx: 5,
      opacity: 0.5,
      color: '#000000',
    });
  });

  it('truncates text and subtitle to the documented cap', () => {
    const longText = 'A'.repeat(500);
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      text: longText,
      subtitle: longText,
    });
    expect(out?.text.length).toBe(200);
    expect(out?.subtitle?.length).toBe(200);
  });

  it('accepts subtitle and subtitleFontId', () => {
    const out = parseTitleBarRequestPayload({
      ...MINIMAL_TITLE_BAR_PAYLOAD,
      subtitle: 'sub',
      subtitleFontId: 'anton',
      subtitleColor: '#ffff00',
      subtitleAlign: 'left',
    });
    expect(out?.subtitle).toBe('sub');
    expect(out?.subtitleFontId).toBe('anton');
    expect(out?.subtitleColor).toBe('#ffff00');
    expect(out?.subtitleAlign).toBe('left');
  });
});

// ─── Top-level pipeline ─────────────────────────────────────────────────────

describe('applySharedOverlays', () => {
  it('empty config returns the base image re-encoded as PNG', async () => {
    const base = await makeSolidPng(100, 100, { r: 200, g: 100, b: 50 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 100, height: 100 },
    });
    // Should still be a valid PNG of the same dimensions.
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
    // Center pixel preserves the input colour.
    const [r, g, b] = await pixelAt(out, 50, 50);
    expect(r).toBe(200);
    expect(g).toBe(100);
    expect(b).toBe(50);
  });

  it('combines filter + vignette + grain + title bar without error', async () => {
    const base = await makeSolidPng(400, 225, { r: 100, g: 150, b: 200 });
    const titleBar: TitleBarConfig = {
      text: 'COMBINED',
      position: 'bottom',
      heightFraction: 0.2,
      align: 'center',
      backgroundColor: '#000000',
      backgroundOpacity: 1,
      textColor: '#ffffff',
      font: PATRICK_HAND,
    };
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 400, height: 225 },
      postProcess: {
        filter: 'sepia',
        vignette: { color: '#000000', intensity: 0.4, radius: 0.4 },
        grain: { intensity: 0.3, size: 2, monochrome: true },
      },
      titleBar,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(225);
  });

  it('filter only changes pixel values (smoke test for the filter path)', async () => {
    const base = await makeSolidPng(50, 50, { r: 200, g: 50, b: 50 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 50, height: 50 },
      postProcess: { filter: 'grayscale' },
    });
    const [r, g, b] = await pixelAt(out, 25, 25);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
});

// ─── r2.8 finishing overlays ────────────────────────────────────────────────

describe('r2.8 finishing overlay parsing', () => {
  it('parses a full postProcess payload with all r2.8 fields', () => {
    const parsed = parsePostProcessConfig({
      tint: { color: '#ff8000', intensity: 0.3, blendMode: 'soft-light' },
      lightLeak: { color: '#ffd28a', intensity: 0.4, radius: 0.6, position: 'top-right' },
      innerGlow: { color: '#ffffff', intensity: 0.2, radius: 0.8, blendMode: 'screen' },
      dust: { color: '#ffffff', intensity: 0.5, density: 0.4, seed: 7 },
      halftone: { color: '#000000', opacity: 0.3, dotSize: 1.5, spacing: 6, blendMode: 'multiply' },
      letterbox: { color: '#000000', top: 40, bottom: 40, left: 0, right: 0 },
      frame: { color: '#ffffff', thickness: 4, inset: 8, style: 'double' },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.tint?.intensity).toBe(0.3);
    expect(parsed!.lightLeak?.position).toBe('top-right');
    expect(parsed!.innerGlow?.blendMode).toBe('screen');
    expect(parsed!.dust?.seed).toBe(7);
    expect(parsed!.halftone?.dotSize).toBe(1.5);
    expect(parsed!.letterbox?.top).toBe(40);
    expect(parsed!.frame?.style).toBe('double');
  });

  it('drops zero-intensity overlays (no JSON-state round-trip for "off" knobs)', () => {
    const parsed = parsePostProcessConfig({
      tint: { color: '#ff8000', intensity: 0, blendMode: 'multiply' },
      lightLeak: { color: '#ffd28a', intensity: 0, radius: 0.6, position: 'top' },
      innerGlow: { color: '#ffffff', intensity: 0, radius: 0.8 },
      dust: { color: '#ffffff', intensity: 0.3, density: 0 },
      halftone: { color: '#000000', opacity: 0, dotSize: 1, spacing: 6 },
    });
    expect(parsed).toBeNull();
  });

  it('drops malformed sub-objects but keeps the rest', () => {
    const parsed = parsePostProcessConfig({
      tint: 'not-an-object',
      halftone: { color: '#ff0000', opacity: 0.5, dotSize: 2, spacing: 8, blendMode: 'multiply' },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.tint).toBeUndefined();
    expect(parsed!.halftone).toBeDefined();
  });

  it('clamps out-of-range numerics (letterbox up to 240, frame up to 40)', () => {
    const parsed = parsePostProcessConfig({
      letterbox: { color: '#000000', top: 9999, bottom: -50, left: 0, right: 0 },
      frame: { color: '#fff', thickness: 9999, inset: -10 },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.letterbox?.top).toBe(240);
    expect(parsed!.letterbox?.bottom).toBe(0);
    expect(parsed!.frame?.thickness).toBe(40);
    expect(parsed!.frame?.inset).toBe(0);
  });

  it('drops the field when required keys are missing (tint without blendMode, lightLeak without position)', () => {
    const parsed = parsePostProcessConfig({
      tint: { color: '#ff0000', intensity: 0.5 },
      lightLeak: { color: '#ff0000', intensity: 0.5, radius: 0.6 },
    });
    expect(parsed).toBeNull();
  });
});

describe('r2.8 finishing overlay rendering', () => {
  it('halftone overlay paints dots that change pixel values vs base', async () => {
    const base = await makeSolidPng(120, 120, { r: 255, g: 255, b: 255 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 120, height: 120 },
      postProcess: {
        halftone: {
          color: '#000000',
          opacity: 1,
          dotSize: 3,
          spacing: 6,
          blendMode: 'multiply',
        },
      },
    });
    // White base + black dots → variance must rise. White pixel sum was
    // ~765 uniformly; with dots painted, at least one sample should be
    // significantly darker.
    let foundDark = false;
    for (let x = 0; x < 60; x += 3) {
      for (let y = 0; y < 60; y += 3) {
        const [r, g, b] = await pixelAt(out, x, y);
        if (r + g + b < 600) {
          foundDark = true;
          break;
        }
      }
      if (foundDark) break;
    }
    expect(foundDark).toBe(true);
  });

  it('tint overlay shifts colour toward the configured hue (red on white via multiply)', async () => {
    const base = await makeSolidPng(50, 50, { r: 255, g: 255, b: 255 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 50, height: 50 },
      postProcess: { tint: { color: '#ff0000', intensity: 1, blendMode: 'multiply' } },
    });
    const [r, g, b] = await pixelAt(out, 25, 25);
    // Multiply by pure red on white = red. R stays high, G/B drop.
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
  });

  it('frame overlay paints a stroke at the canvas edge (top-left inset corner is dark)', async () => {
    const base = await makeSolidPng(100, 100, { r: 255, g: 255, b: 255 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 100, height: 100 },
      postProcess: {
        frame: { color: '#000000', thickness: 4, inset: 2, style: 'solid' },
      },
    });
    // Stroke is centred at inset + thickness/2 = 4. So pixel (4, 50) is
    // on the left vertical stroke = black.
    const [r, g, b] = await pixelAt(out, 4, 50);
    expect(r + g + b).toBeLessThan(150);
    // A pixel well inside the frame should still be white.
    const [r2, g2, b2] = await pixelAt(out, 50, 50);
    expect(r2 + g2 + b2).toBeGreaterThan(700);
  });

  it('letterbox overlay paints bars on the configured sides (top + bottom = black, middle = white)', async () => {
    const base = await makeSolidPng(100, 100, { r: 255, g: 255, b: 255 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 100, height: 100 },
      postProcess: {
        letterbox: { color: '#000000', top: 10, bottom: 10, left: 0, right: 0 },
      },
    });
    const [topR, topG, topB] = await pixelAt(out, 50, 5);
    expect(topR + topG + topB).toBeLessThan(50);
    const [botR, botG, botB] = await pixelAt(out, 50, 95);
    expect(botR + botG + botB).toBeLessThan(50);
    const [midR, midG, midB] = await pixelAt(out, 50, 50);
    expect(midR + midG + midB).toBeGreaterThan(700);
  });

  it('inner glow overlay lifts the centre but not the edges (white glow on grey base)', async () => {
    const base = await makeSolidPng(100, 100, { r: 64, g: 64, b: 64 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 100, height: 100 },
      postProcess: {
        innerGlow: { color: '#ffffff', intensity: 1, radius: 1, blendMode: 'screen' },
      },
    });
    const [cR, cG, cB] = await pixelAt(out, 50, 50);
    const [eR, eG, eB] = await pixelAt(out, 5, 5);
    // Centre brighter than corner.
    expect(cR + cG + cB).toBeGreaterThan(eR + eG + eB);
  });

  it('does NOT apply overlays whose intensity / opacity / density is 0 (no-op pass)', async () => {
    const base = await makeSolidPng(50, 50, { r: 100, g: 100, b: 100 });
    const out = await applySharedOverlays({
      baseImage: base,
      canvas: { width: 50, height: 50 },
      postProcess: {
        // Intensity 0 → parser drops the field via `parsePostProcessConfig`
        // upstream; here we test the pipeline tolerates an empty config too.
      },
    });
    const [r, g, b] = await pixelAt(out, 25, 25);
    expect(r).toBe(100);
    expect(g).toBe(100);
    expect(b).toBe(100);
  });
});
