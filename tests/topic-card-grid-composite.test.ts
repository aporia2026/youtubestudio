import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  applyCellUploads,
  cellRect,
  circularMaskSvg,
  escapePangoText,
  fitCover,
  renderLabelPng,
} from '@/lib/thumbnail-formats/topic-card-grid-composite';
import { makeDefaultLayout, type TopicCard } from '@/lib/thumbnail-formats/topic-card-grid';

// ─── Synthetic input helpers ────────────────────────────────────────────────

async function makeSolidPng(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 4, background: { ...color, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** Read the pixel at (x, y) in a PNG buffer. Returns [R, G, B, A].
 *  Floats are floored to integer pixel coordinates BEFORE indexing — without
 *  this, a y of 28.4 produces an idx of 27513 instead of 27512 and reads
 *  the G channel of the neighbouring pixel, which silently passes some
 *  assertions and fails others. */
async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
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

// ─── escapePangoText ────────────────────────────────────────────────────────

describe('escapePangoText', () => {
  it('escapes &, <, > as Pango entities', () => {
    expect(escapePangoText('AT&T')).toBe('AT&amp;T');
    expect(escapePangoText('<3 you')).toBe('&lt;3 you');
    expect(escapePangoText('a > b')).toBe('a &gt; b');
  });
  it('leaves safe text untouched', () => {
    expect(escapePangoText('Coffee Cup')).toBe('Coffee Cup');
  });
});

// ─── cellRect ───────────────────────────────────────────────────────────────

describe('cellRect', () => {
  it('matches the canvas top-left for card 1', () => {
    const layout = makeDefaultLayout(2, 3, 1280, 720);
    const r = cellRect(layout, 1);
    expect(r.x).toBe(layout.outerMargin);
    expect(r.y).toBe(layout.outerMargin);
  });
  it('places card 4 at the start of the second row (cols=3)', () => {
    const layout = makeDefaultLayout(2, 3, 1280, 720);
    const r1 = cellRect(layout, 1);
    const r4 = cellRect(layout, 4);
    expect(r4.x).toBe(r1.x);
    expect(r4.y).toBeGreaterThan(r1.y);
  });
});

// ─── circularMaskSvg ────────────────────────────────────────────────────────

describe('circularMaskSvg', () => {
  it('produces a valid SVG buffer of the requested diameter', () => {
    const svg = circularMaskSvg(120);
    const text = svg.toString('utf-8');
    expect(text).toMatch(/<svg/);
    expect(text).toMatch(/width="120"/);
    expect(text).toMatch(/r="60"/);
    expect(text).toMatch(/fill="white"/);
  });
});

// ─── fitCover ───────────────────────────────────────────────────────────────

describe('fitCover', () => {
  it('resizes to exactly the target dimensions', async () => {
    const src = await makeSolidPng(400, 300, { r: 0, g: 128, b: 255 });
    const out = await fitCover(src, 100, 50);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
  });
  it('returns the original color in the centre (no edge effects)', async () => {
    const src = await makeSolidPng(400, 300, { r: 200, g: 50, b: 25 });
    const out = await fitCover(src, 80, 40);
    const [r, g, b] = await pixelAt(out, 40, 20);
    expect(r).toBe(200);
    expect(g).toBe(50);
    expect(b).toBe(25);
  });
});

// ─── renderLabelPng ─────────────────────────────────────────────────────────

describe('renderLabelPng', () => {
  it('returns a non-trivial PNG for a real label', async () => {
    const png = await renderLabelPng('Coffee Cup', 200, 40);
    expect(png.byteLength).toBeGreaterThan(100);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });
  it('survives Pango-control characters in the label', async () => {
    await expect(renderLabelPng('AT&T <3', 200, 40)).resolves.toBeInstanceOf(Buffer);
  });
  it('returns a transparent placeholder for empty text', async () => {
    const png = await renderLabelPng('   ', 200, 40);
    const meta = await sharp(png).metadata();
    // Empty text returns a 1x1 transparent pixel — we just need to ensure
    // it didn't throw and produced a valid PNG.
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
  });
});

// ─── applyCellUploads ───────────────────────────────────────────────────────

describe('applyCellUploads', () => {
  // Fixed test canvas: 240×160, 2x2 grid. Tiny but deterministic.
  const CANVAS_W = 240;
  const CANVAS_H = 160;
  const cards: TopicCard[] = [
    { index: 1, label: 'A', icon_concept: 'icon a' },
    { index: 2, label: 'B', icon_concept: 'icon b' },
    { index: 3, label: 'C', icon_concept: 'icon c' },
    { index: 4, label: 'D', icon_concept: 'USER_UPLOADED_IMAGE' },
  ];

  it('paints uniform label bands on every cell even with no uploads (square mode)', async () => {
    // Square mode always uniformises labels so AI's per-cell font
    // autoscaling can't blow up short labels (e.g. "UVB-76") relative to
    // long ones in the same grid. Cells without uploads keep their AI
    // illustration but get their label band overpainted in white.
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H);
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'square',
      uploads: [],
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(CANVAS_W);
    expect(meta.height).toBe(CANVAS_H);
    // Gutter between rows = still untouched black.
    const [gr, gg, gb] = await pixelAt(out, CANVAS_W / 2, CANVAS_H / 2);
    expect(gr).toBe(0);
    expect(gg).toBe(0);
    expect(gb).toBe(0);
    // Illustration area of each cell = still black (AI render preserved).
    const r1 = cellRect(layout, 1);
    const [ir, ig, ib] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h * 0.3);
    expect(ir).toBe(0);
    expect(ig).toBe(0);
    expect(ib).toBe(0);
    // Bottom-centre of each cell's label band = white (overpainted).
    // Sample at 92% down the cell so we're inside the white band but
    // away from the border stroke at the very bottom edge.
    const [br, bg, bb] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h * 0.92);
    expect(br).toBeGreaterThan(200);
    expect(bg).toBeGreaterThan(200);
    expect(bb).toBeGreaterThan(200);
  });

  it('leaves the base untouched in circle mode when there are no uploads', async () => {
    // Circle mode skips non-upload label uniformisation — applyCellUploads
    // only paints label bands in square mode. Keep this test guarding the
    // skip so a future change that flips on circle-mode bands doesn't
    // silently break the AI's existing circle label rendering.
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'circle');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'circle',
      uploads: [],
    });
    const r1 = cellRect(layout, 1);
    const [r, g, b] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h * 0.92);
    expect(r).toBe(0);
    expect(g).toBe(0);
    expect(b).toBe(0);
  });

  it('paints a red upload into cell 4 and white-wipes non-uploaded cells in mixed mode', async () => {
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const upload = await makeSolidPng(64, 64, { r: 255, g: 0, b: 0 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'square');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'square',
      uploads: [{ cardIndex: 4, bytes: upload }],
    });
    // Cell 4 is bottom-right. Sample a point in the illustration region of
    // that cell — should be red (uploaded image) not black (base).
    const rect = cellRect(layout, 4);
    const sampleX = rect.x + Math.round(rect.w / 2);
    const sampleY = rect.y + Math.round(rect.h * 0.3); // upper portion = illustration
    const [r, g, b] = await pixelAt(out, sampleX, sampleY);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(b).toBeLessThan(60);
    // Cell 1 (top-left) is NOT uploaded but uploads.length > 0 → mixed
    // mode, so it gets the white-placeholder full-cell overlay rather
    // than the prompt-mode label-band-only treatment. The illustration
    // region of cell 1 should now be white (placeholder), wiping the
    // black base. This is the behaviour that prevents AI bleed from
    // showing up around non-uploaded cells when the user thought they
    // were uploading everything.
    const r1 = cellRect(layout, 1);
    const [cr, cg, cb] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h * 0.3);
    expect(cr).toBeGreaterThan(240);
    expect(cg).toBeGreaterThan(240);
    expect(cb).toBeGreaterThan(240);
  });

  it('leaves cell corners white in circle mode (circular mask)', async () => {
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    // Magenta upload — distinguishable from white background and black base.
    const upload = await makeSolidPng(120, 120, { r: 255, g: 0, b: 255 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'circle');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'circle',
      uploads: [{ cardIndex: 1, bytes: upload }],
    });
    const rect = cellRect(layout, 1);
    // Cell centre = inside the disc = magenta
    const [cR, cG, cB] = await pixelAt(out, rect.x + rect.w / 2, rect.y + rect.h * 0.3);
    expect(cR).toBeGreaterThan(200);
    expect(cG).toBeLessThan(60);
    expect(cB).toBeGreaterThan(200);
    // Cell top-left corner = outside the disc = white (we paint the entire
    // cell white before applying the disc, so AI cells around it stay
    // visually continuous with the gutters).
    const [tR, tG, tB] = await pixelAt(out, rect.x + 2, rect.y + 2);
    expect(tR).toBeGreaterThan(240);
    expect(tG).toBeGreaterThan(240);
    expect(tB).toBeGreaterThan(240);
  });

  it('wipes the row gutter beneath non-last-row cells in pure-prompt mode (r2)', async () => {
    // Pure-prompt mode (no uploads) previously left the row gutter
    // untouched at the cell's own width. If the AI's label rendering
    // wrapped to two lines, line 2 could land in the gutter under the
    // cell and survive next to our composite label. The new wipe paints
    // a white strip from the cell's bottom edge through the row gutter
    // at the cell's own width — for non-last-row cells.
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H);
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'square',
      uploads: [],
    });
    const r1 = cellRect(layout, 1);
    // Sample just below cell 1's bottom edge, at the cell's horizontal
    // centre. This is inside the row gutter under cell 1's column — the
    // exact spot where AI-rendered "Year"-style text would land. Should
    // now be white.
    const [gx, gy] = [r1.x + r1.w / 2, r1.y + r1.h + 1];
    const [gr, gg, gb] = await pixelAt(out, gx, gy);
    expect(gr).toBeGreaterThan(240);
    expect(gg).toBeGreaterThan(240);
    expect(gb).toBeGreaterThan(240);
    // But the gutter INTERSECTION (column gutter × row gutter) at canvas
    // centre must remain untouched black — we deliberately don't wipe
    // column gutters because the AI may anchor borders for adjacent
    // columns there.
    const [cr, cg, cb] = await pixelAt(out, CANVAS_W / 2, CANVAS_H / 2);
    expect(cr).toBe(0);
    expect(cg).toBe(0);
    expect(cb).toBe(0);
  });

  it('does not wipe a row gutter for circle mode in pure-prompt (r2 scope)', async () => {
    // Circle mode skips ALL pure-prompt overpainting (label band + gutter
    // wipe) so the AI's existing circle label rendering on white canvas
    // stays untouched. Pin this behaviour so a future change to circle
    // mode is forced to update the test alongside.
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'circle');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'circle',
      uploads: [],
    });
    const r1 = cellRect(layout, 1);
    const [gr, gg, gb] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h + 1);
    expect(gr).toBe(0);
    expect(gg).toBe(0);
    expect(gb).toBe(0);
  });

  it('paints each upload independently when multiple cells are uploaded', async () => {
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 0, g: 0, b: 0 });
    const redUpload = await makeSolidPng(64, 64, { r: 255, g: 0, b: 0 });
    const blueUpload = await makeSolidPng(64, 64, { r: 0, g: 0, b: 255 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'square');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'square',
      uploads: [
        { cardIndex: 1, bytes: redUpload },
        { cardIndex: 4, bytes: blueUpload },
      ],
    });
    const r1 = cellRect(layout, 1);
    const r4 = cellRect(layout, 4);
    const [pR1, , pB1] = await pixelAt(out, r1.x + r1.w / 2, r1.y + r1.h * 0.3);
    const [pR4, , pB4] = await pixelAt(out, r4.x + r4.w / 2, r4.y + r4.h * 0.3);
    expect(pR1).toBeGreaterThan(200); // red
    expect(pB1).toBeLessThan(60);
    expect(pB4).toBeGreaterThan(200); // blue
    expect(pR4).toBeLessThan(60);
  });
});
