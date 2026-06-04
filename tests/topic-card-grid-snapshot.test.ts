import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  applyCellUploads,
  type CellCutout,
  type CellUpload,
} from '@/lib/thumbnail-formats/topic-card-grid-composite';
import { makeDefaultLayout, type TopicCard } from '@/lib/thumbnail-formats/topic-card-grid';

// Cross-axis smoke test for Phase 3 (server Sharp composite parity).
// Renders one thumbnail per (`fillStyle` × `labelPosition`) combo = 6
// snapshots, diffs each against a fixture stored on disk. On the first
// run (no fixture present), records the rendered PNG to disk and passes
// the test — the developer commits the fixtures alongside the test.
// Subsequent runs (including CI) compare with a 1 % per-pixel-diff
// tolerance to absorb anti-aliasing wobble.
//
// Why a tolerance: Sharp + Pango + librsvg produce deterministic output
// for identical inputs at the same library versions, but text rasteriser
// fonthinting can shift a glyph edge by a sub-pixel on a different OS.
// 1 % of ~96k pixels = ~960 pixels — large enough to absorb that
// drift, small enough to catch any real branch regression (a missing
// border, a wrong fill colour, a label that didn't render).
//
// Fixture layout:
//   tests/fixtures/topic-card-grid-snapshot/photo-below.png
//   tests/fixtures/topic-card-grid-snapshot/photo-overlap.png
//   …
//
// Plan: `_plans/2026-06-04-handoff-topic-card-grid-parity.md` §Phase 4.

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'topic-card-grid-snapshot');
/** Per-pixel channel-diff cap before we count a pixel as different.
 *  Lower = stricter. 30 absorbs anti-aliasing wobble on glyph edges
 *  without letting a real colour change slip through. */
const PIXEL_DIFF_THRESHOLD = 30;
/** Max fraction of pixels allowed to differ before the test fails. 1 %
 *  of a ~600x400 canvas = ~2400 pixels — enough headroom for AA drift
 *  on the cross-platform CI runners. */
const ALLOWED_DIFF_FRACTION = 0.01;

const CANVAS_W = 600;
const CANVAS_H = 400;
const cards: TopicCard[] = [
  { index: 1, label: 'Alpha', icon_concept: 'A', accent_color: '#ff3333' },
  { index: 2, label: 'Beta', icon_concept: 'B', accent_color: '#3366ff' },
];

async function makeSolidPng(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return await sharp({
    create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** Count pixels whose summed RGB channel difference exceeds the
 *  per-pixel threshold. Alpha is intentionally ignored — Sharp
 *  occasionally emits alpha = 254 instead of 255 on rasterised SVG
 *  composites and we don't want that false-positive. */
async function countDifferingPixels(a: Buffer, b: Buffer): Promise<{
  width: number;
  height: number;
  differing: number;
  total: number;
}> {
  const ra = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rb = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
    throw new Error(
      `snapshot dimensions diverged: actual ${ra.info.width}×${ra.info.height}, fixture ${rb.info.width}×${rb.info.height}`,
    );
  }
  const w = ra.info.width;
  const h = ra.info.height;
  const aData = ra.data as Buffer;
  const bData = rb.data as Buffer;
  let differing = 0;
  const stride = ra.info.channels;
  for (let i = 0; i < aData.length; i += stride) {
    const dr = Math.abs(aData[i] - bData[i]);
    const dg = Math.abs(aData[i + 1] - bData[i + 1]);
    const db = Math.abs(aData[i + 2] - bData[i + 2]);
    if (dr + dg + db > PIXEL_DIFF_THRESHOLD) differing++;
  }
  return { width: w, height: h, differing, total: w * h };
}

/** Render → compare-or-record. Centralised so each combo's test stays
 *  a two-liner. The first run that creates a fixture also logs the
 *  output path so it's obvious the developer needs to commit it. */
async function snapshotCheck(name: string, actual: Buffer): Promise<void> {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  const fixturePath = path.join(FIXTURE_DIR, `${name}.png`);
  if (!existsSync(fixturePath)) {
    writeFileSync(fixturePath, actual);
    console.info('[topic-card-grid snapshot] recorded fixture', {
      name,
      path: fixturePath,
      bytes: actual.length,
      note: 'commit this file alongside the test',
    });
    return;
  }
  const fixture = readFileSync(fixturePath);
  const diff = await countDifferingPixels(actual, fixture);
  const fraction = diff.differing / diff.total;
  console.info('[topic-card-grid snapshot] diff', {
    name,
    differing_pixels: diff.differing,
    total_pixels: diff.total,
    fraction: Number(fraction.toFixed(4)),
    threshold: ALLOWED_DIFF_FRACTION,
  });
  expect(fraction).toBeLessThanOrEqual(ALLOWED_DIFF_FRACTION);
}

async function renderCombo(
  fillStyle: 'photo' | 'cutout' | 'icon',
  labelPosition: 'below' | 'overlap',
): Promise<Buffer> {
  const base = await makeSolidPng(CANVAS_W, CANVAS_H, 0, 0, 0);
  // Bright magenta upload + bright cyan cutout so each axis branch
  // produces visually distinct pixels — a regression that pipes the
  // upload through the cutout branch (or vice versa) shows up as a
  // wrong-colour disc centre in the diff.
  const upload = await makeSolidPng(120, 120, 255, 0, 255);
  const cutout = await makeSolidPng(120, 120, 0, 255, 255);
  const layout = makeDefaultLayout(1, 2, CANVAS_W, CANVAS_H, 'circle');
  const uploads: CellUpload[] = [
    { cardIndex: 1, bytes: upload },
    { cardIndex: 2, bytes: upload },
  ];
  const cutouts: CellCutout[] | undefined =
    fillStyle === 'cutout'
      ? [
          { cardIndex: 1, bytes: cutout },
          { cardIndex: 2, bytes: cutout },
        ]
      : undefined;
  return await applyCellUploads({
    baseImage: base,
    layout,
    cards,
    cardShape: 'circle',
    uploads,
    fillStyle,
    labelPosition,
    // The other two axes pinned at their defaults so the 6-combo
    // matrix only varies what the diff matrix is actually meant to
    // cover. A future test can fan out across borderWeight + labelCase
    // if those branches need their own pixel pinning.
    borderWeight: 'thin',
    labelCase: 'title',
    overlapLabelStroke: 'white-on-black',
    cutouts,
  });
}

describe('topic-card-grid snapshot — fillStyle × labelPosition cross matrix', () => {
  const combos: Array<{ fillStyle: 'photo' | 'cutout' | 'icon'; labelPosition: 'below' | 'overlap' }> = [
    { fillStyle: 'photo', labelPosition: 'below' },
    { fillStyle: 'photo', labelPosition: 'overlap' },
    { fillStyle: 'cutout', labelPosition: 'below' },
    { fillStyle: 'cutout', labelPosition: 'overlap' },
    { fillStyle: 'icon', labelPosition: 'below' },
    { fillStyle: 'icon', labelPosition: 'overlap' },
  ];

  for (const { fillStyle, labelPosition } of combos) {
    const name = `${fillStyle}-${labelPosition}`;
    it(`matches fixture for ${name}`, async () => {
      const actual = await renderCombo(fillStyle, labelPosition);
      await snapshotCheck(name, actual);
    });
  }
});
