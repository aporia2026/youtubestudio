import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  applyCellUploads,
  cellRect,
  circularMaskSvg,
  detectAiCellRect,
  detectAiDividerLine,
  detectAiLabelTop,
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

/** Build a white canvas with a bordered rectangle at `borderRect`. Used to
 *  simulate an AI render where the cell border is at a known position. */
async function makePngWithBorder(
  canvasW: number,
  canvasH: number,
  borderRect: { x: number; y: number; w: number; h: number },
  strokeWidth = 3,
): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
    <rect x="0" y="0" width="${canvasW}" height="${canvasH}" fill="white"/>
    <rect x="${borderRect.x}" y="${borderRect.y}" width="${borderRect.w}" height="${borderRect.h}" fill="none" stroke="black" stroke-width="${strokeWidth}"/>
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/** Decode a PNG buffer to raw RGBA pixels for direct sampling in detection
 *  tests. Wraps the sharp boilerplate so each test stays focused on
 *  detection assertions rather than I/O setup. */
async function decodeRaw(
  png: Buffer,
): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: data as Buffer, width: info.width, height: info.height, channels: info.channels };
}

// ─── detectAiCellRect ───────────────────────────────────────────────────────

describe('detectAiCellRect', () => {
  it('snaps to the actual border when the AI rendered wider than expected', async () => {
    // Simulated AI cell at (20, 20) to (80, 80) — a 60x60 black-bordered
    // box on a 100x100 white canvas. The expected rect from our cellRect
    // math is narrower at (25, 25) to (75, 75). Detection should return
    // the actual border position, not the expected one.
    const png = await makePngWithBorder(100, 100, { x: 20, y: 20, w: 60, h: 60 });
    const raw = await decodeRaw(png);
    const detected = detectAiCellRect(
      raw.data,
      raw.width,
      raw.height,
      raw.channels,
      { x: 25, y: 25, w: 50, h: 50 },
    );
    // ±2 px tolerance for stroke anti-aliasing on the border edge.
    expect(detected.x).toBeGreaterThanOrEqual(18);
    expect(detected.x).toBeLessThanOrEqual(22);
    expect(detected.y).toBeGreaterThanOrEqual(18);
    expect(detected.y).toBeLessThanOrEqual(22);
    expect(detected.x + detected.w).toBeGreaterThanOrEqual(78);
    expect(detected.x + detected.w).toBeLessThanOrEqual(82);
    expect(detected.y + detected.h).toBeGreaterThanOrEqual(78);
    expect(detected.y + detected.h).toBeLessThanOrEqual(82);
  });

  it('snaps to the actual border when the AI rendered NARROWER than expected', async () => {
    // Inverse case: AI cell at (30, 30) to (70, 70), expected rect was
    // wider at (25, 25) to (75, 75). Detection must walk INWARD from
    // expected to find the AI's narrower border.
    const png = await makePngWithBorder(100, 100, { x: 30, y: 30, w: 40, h: 40 });
    const raw = await decodeRaw(png);
    const detected = detectAiCellRect(
      raw.data,
      raw.width,
      raw.height,
      raw.channels,
      { x: 25, y: 25, w: 50, h: 50 },
    );
    expect(detected.x).toBeGreaterThanOrEqual(28);
    expect(detected.x).toBeLessThanOrEqual(32);
    expect(detected.x + detected.w).toBeGreaterThanOrEqual(68);
    expect(detected.x + detected.w).toBeLessThanOrEqual(72);
  });

  it('falls back to expected when no clear border exists', async () => {
    // Solid white image with no border anywhere. Every edge scan finds
    // no dark column / row above the coverage threshold, so the function
    // returns the expected rect unchanged.
    const png = await makeSolidPng(100, 100, { r: 255, g: 255, b: 255 });
    const raw = await decodeRaw(png);
    const expected = { x: 25, y: 25, w: 50, h: 50 };
    const detected = detectAiCellRect(
      raw.data,
      raw.width,
      raw.height,
      raw.channels,
      expected,
    );
    expect(detected).toEqual(expected);
  });

  it("does not snap onto a neighbouring cell's border (searchRange cap)", async () => {
    // Two cells: one at (10..40), gutter (40..60), another at (60..90).
    // Expected rect points to the LEFT cell. With a wide enough search
    // range the scan could theoretically reach the right cell, but
    // searchRange is capped so that can't happen.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="20" width="30" height="60" fill="none" stroke="black" stroke-width="3"/>
      <rect x="60" y="20" width="30" height="60" fill="none" stroke="black" stroke-width="3"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    // Expected rect at the LEFT cell with a TIGHT search range — must
    // stay on the left cell's borders.
    const detected = detectAiCellRect(
      raw.data,
      raw.width,
      raw.height,
      raw.channels,
      { x: 12, y: 22, w: 26, h: 56 },
      8,
    );
    // Detected width should still belong to the LEFT cell (~30-ish),
    // not the gap to the right cell.
    expect(detected.x).toBeLessThan(20);
    expect(detected.x + detected.w).toBeLessThan(50);
  });
});

// ─── detectAiDividerLine (r2.4) ─────────────────────────────────────────────

describe('detectAiDividerLine', () => {
  it('finds the top edge of a horizontal black divider inside the cell', async () => {
    // Cell rect 10..90, with a black divider line at y=70 (1 px thick).
    // Scanner walks down from 40% of cellH (y >= 38) and should return
    // 70 — the divider's top edge — so the band overlay can land its
    // own hairline on the same y instead of below it.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="60" fill="red"/>
      <line x1="10" y1="70" x2="90" y2="70" stroke="black" stroke-width="2"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 80 };
    const dividerY = detectAiDividerLine(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(dividerY).not.toBeNull();
    // The 2-px stroke is centred on y=70 so its top edge is at y=69
    // and its bottom edge at y=71. The scanner returns whichever row
    // first crosses the coverage threshold — anywhere in [69, 71] is
    // correct.
    expect(dividerY!).toBeGreaterThanOrEqual(68);
    expect(dividerY!).toBeLessThanOrEqual(72);
  });

  it('returns null when the cell has no horizontal dark line in the bottom area', async () => {
    // Solid red cell. No divider anywhere — scanner must report null
    // so the caller can fall back to the white-row heuristic.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="80" fill="red"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 80 };
    const dividerY = detectAiDividerLine(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(dividerY).toBeNull();
  });

  it('finds the divider even when the illustration above also contains dark pixels', async () => {
    // Illustration with scattered dark pixels (mimics anti-aliased
    // details in a real illustration) followed by a divider at y=72.
    // The scattered pixels are sparse enough that no row hits the
    // coverage threshold until the divider.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="60" fill="#eeeeee"/>
      <circle cx="50" cy="40" r="4" fill="black"/>
      <line x1="10" y1="72" x2="90" y2="72" stroke="black" stroke-width="2"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 80 };
    const dividerY = detectAiDividerLine(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(dividerY).not.toBeNull();
    expect(dividerY!).toBeGreaterThanOrEqual(70);
    expect(dividerY!).toBeLessThanOrEqual(74);
  });
});

// ─── detectAiLabelTop ───────────────────────────────────────────────────────

describe('detectAiLabelTop', () => {
  it('finds the first mostly-white row in the bottom half of a two-rectangle render', async () => {
    // Simulated AI two-box render: blue illustration panel from (10, 10)
    // to (90, 55), then a white gap from 55 to 70, then a smaller label
    // box (with text-like content represented as a single dark stroke at
    // row 75) from (25, 70) to (75, 85). The first mostly-white row when
    // walking down from 40% of cell height (= y ≥ 38) should be in the
    // gap area (around y=56).
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="45" fill="blue"/>
      <rect x="25" y="70" width="50" height="15" fill="white" stroke="black" stroke-width="1"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 75 }; // detection earlier found this cell rect
    const labelTop = detectAiLabelTop(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(labelTop).not.toBeNull();
    // The gap starts at y=55. First mostly-white row should be at or just
    // after y=55.
    expect(labelTop!).toBeGreaterThanOrEqual(55);
    expect(labelTop!).toBeLessThan(70);
  });

  it('returns null when there is no mostly-white row (illustration extends down)', async () => {
    // Solid blue cell from top to bottom — no white gap or label area.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="80" fill="blue"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 80 };
    const labelTop = detectAiLabelTop(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(labelTop).toBeNull();
  });

  it('finds the band start in a unified-cell render (white strip at the bottom)', async () => {
    // Unified cell: illustration on top, hairline at 80%, white label
    // strip at the bottom — exactly the layout the prompt asks for.
    // Scanner should find the white strip just below the hairline.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="0" y="0" width="100" height="100" fill="white"/>
      <rect x="10" y="10" width="80" height="80" fill="none" stroke="black" stroke-width="2"/>
      <rect x="10" y="10" width="80" height="64" fill="red"/>
      <line x1="10" y1="74" x2="90" y2="74" stroke="black" stroke-width="1"/>
    </svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const raw = await decodeRaw(png);
    const detected = { x: 10, y: 10, w: 80, h: 80 };
    const labelTop = detectAiLabelTop(raw.data, raw.width, raw.height, raw.channels, detected);
    expect(labelTop).not.toBeNull();
    // Should find the white strip area at y >= 75 (just past the hairline).
    expect(labelTop!).toBeGreaterThanOrEqual(74);
    expect(labelTop!).toBeLessThan(85);
  });
});

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
    // cell and survive next to our composite label. The wipe paints
    // a white strip from the cell's bottom edge through the row gutter
    // — for non-last-row cells.
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
  });

  it('wipes the band-height left & right column-gutter slack in pure-prompt mode (r2.1)', async () => {
    // r2.1: the AI uses tighter column gutters than our cellRect
    // formula predicts, so its cell-border lines and narrower label
    // sub-frames bleed into the slack just outside our band overlay.
    // The horizontal slack wipes cover that area (limited to the band
    // height so the AI's illustration in the top 80% is preserved).
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
    // Compute the band y-range so we sample inside it. Mirrors the
    // constants in the production code (illustration is 80% of cell H).
    const labelH = r1.h - Math.round(r1.h * 0.8);
    const bandMidY = r1.y + r1.h - Math.floor(labelH / 2);
    // Left slack: a pixel just to the left of cell 1's left edge, at the
    // band's vertical middle. With outerMargin == gutter == 8 and
    // gutterPad == 4, the wipe covers x in [4, 7]. Sample at x=5.
    const [lr, lg, lb] = await pixelAt(out, r1.x - 3, bandMidY);
    expect(lr).toBeGreaterThan(240);
    expect(lg).toBeGreaterThan(240);
    expect(lb).toBeGreaterThan(240);
    // Right slack: a pixel just to the right of cell 1's right edge, at
    // the band's vertical middle. Wipe covers x in [r1.x+r1.w,
    // r1.x+r1.w+gutterPad-1].
    const [rr, rg, rb] = await pixelAt(out, r1.x + r1.w + 1, bandMidY);
    expect(rr).toBeGreaterThan(240);
    expect(rg).toBeGreaterThan(240);
    expect(rb).toBeGreaterThan(240);
    // But the slack ABOVE the band (still in the cell's illustration
    // region) must remain UNTOUCHED so the AI's illustration above
    // doesn't get clipped. Sample at the same x but a y well within the
    // top 80%.
    const illustrationMidY = r1.y + Math.floor(r1.h * 0.4);
    const [ar, ag, ab] = await pixelAt(out, r1.x - 3, illustrationMidY);
    expect(ar).toBe(0);
    expect(ag).toBe(0);
    expect(ab).toBe(0);
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

  it('paints a top border on every cell in pure-prompt mode (r2.4)', async () => {
    // r2.4: the AI sometimes omits the top border on row 2+ cells when
    // it shares borders with the row above. The composite now paints a
    // thin black line at aiRect.y on every cell so every cell ends up
    // with a visible top border regardless of what the AI drew.
    //
    // Setup: white base (no AI borders anywhere) so the "before" top
    // edge of each cell is white. Run pure-prompt composite; expect
    // the top edge of each cell to be dark afterwards.
    const base = await makeSolidPng(CANVAS_W, CANVAS_H, { r: 255, g: 255, b: 255 });
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'square');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards,
      cardShape: 'square',
      uploads: [],
    });
    // For each cell, sample at the centre of the top edge — should be
    // dark (the painted top border).
    for (const card of cards) {
      const rect = cellRect(layout, card.index);
      const [tr, tg, tb] = await pixelAt(out, rect.x + Math.floor(rect.w / 2), rect.y);
      const sum = tr + tg + tb;
      expect(sum, `card ${card.index} top edge should be dark (painted border)`).toBeLessThan(200);
    }
    // Sanity: a pixel well inside the illustration area (not on the
    // top border) should still be white — the top border paint is
    // only at the very top, it doesn't bleed downward.
    const r1 = cellRect(layout, 1);
    const [ir, ig, ib] = await pixelAt(out, r1.x + Math.floor(r1.w / 2), r1.y + Math.floor(r1.h * 0.4));
    expect(ir + ig + ib).toBeGreaterThan(700);
  });

  it('lands the band at the AI divider line, eliminating the doubled-hairline gap (r2.4)', async () => {
    // r2.4: when the AI drew its own divider between illustration and
    // label, the old r2.3 white-row heuristic placed the band BELOW the
    // divider, so the divider stayed visible above our hairline. The
    // new divider-line scanner places the band's top edge AT the
    // divider's top so our overlay's white fill covers the AI's
    // divider entirely. The band's hairline lands at the divider's y.
    //
    // Setup: build a base where each cell has a visible illustration
    // (red) ABOVE the divider and an AI-drawn black hairline. After
    // the composite runs, the row just BELOW the hairline must be
    // white (the band's overpaint), proving the band absorbed the
    // divider and what's left is our clean overpaint.
    const cellW = (CANVAS_W - 2 * 8 - 8) / 2;
    const cellH = (CANVAS_H - 2 * 8 - 8) / 2;
    const r1 = { x: 8, y: 8, w: cellW, h: cellH };
    const dividerY = r1.y + Math.floor(r1.h * 0.78);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
      <rect x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" fill="white"/>
      <rect x="${r1.x}" y="${r1.y}" width="${r1.w}" height="${r1.h * 0.78}" fill="red"/>
      <line x1="${r1.x}" y1="${dividerY}" x2="${r1.x + r1.w}" y2="${dividerY}" stroke="black" stroke-width="2"/>
    </svg>`;
    const base = await sharp(Buffer.from(svg)).png().toBuffer();
    const layout = makeDefaultLayout(2, 2, CANVAS_W, CANVAS_H, 'square');
    const out = await applyCellUploads({
      baseImage: base,
      layout,
      cards: [cards[0]],
      cardShape: 'square',
      uploads: [],
    });
    // Sample a few rows below the AI divider, well to the LEFT of the
    // cell centre so we don't land inside the centred label glyph
    // (the "A" label renders dark and would otherwise fail this
    // assertion for the wrong reason). The band's white fill must
    // dominate here.
    const sampleX = r1.x + Math.floor(r1.w * 0.15);
    const [br, bg, bb] = await pixelAt(out, sampleX, dividerY + 6);
    expect(br + bg + bb, 'rows below AI divider should be white (band overpaint)').toBeGreaterThan(600);
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
