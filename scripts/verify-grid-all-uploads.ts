/**
 * Verification script for the topic-card-grid "all cells uploaded" fast
 * path. Builds a 4×4 grid with 16 distinct synthetic uploads and labels
 * (including the user's failing labels like "UVB-76", "The Antikythera
 * Mechanism", and "The Bermuda Triangle"), renders the composite onto a
 * blank canvas (no AI), and writes the result to disk so we can eyeball
 * the borders, label positions, and uniform font sizing.
 *
 * Run with: npx tsx scripts/verify-grid-all-uploads.ts
 * Output:   scripts/_artifacts/grid-all-uploads.png
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { applyCellUploads, type CellUpload } from '@/lib/thumbnail-formats/topic-card-grid-composite';
import { makeDefaultLayout, type TopicCard } from '@/lib/thumbnail-formats/topic-card-grid';

const OUT_DIR = path.join(process.cwd(), 'scripts', '_artifacts');
const OUT_PATH = path.join(OUT_DIR, 'grid-all-uploads.png');

const CANVAS_W = 2048;
const CANVAS_H = 1152;
const ROWS = 4;
const COLS = 4;

const LABELS = [
  'Dyatlov Pass', 'The Wow! Signal', 'The Mary Celeste', 'Havana Syndrome',
  'The Tunguska Event', 'UVB-76', 'The Phoenix Lights', 'The Bermuda Triangle',
  'The Antikythera Mechanism', 'The Bloop', 'Belmez Faces', 'Hessdalen Lights',
  'Foo Fighters', 'The Taos Hum', 'Ball Lightning', 'Brown Mountain Lights',
];

const COLORS: Array<{ r: number; g: number; b: number }> = [
  { r: 200, g:  60, b:  60 }, { r:  60, g: 200, b:  60 }, { r:  60, g:  60, b: 200 }, { r: 200, g: 200, b:  60 },
  { r: 200, g:  60, b: 200 }, { r:  60, g: 200, b: 200 }, { r: 220, g: 120, b:  40 }, { r:  40, g: 120, b: 220 },
  { r: 120, g:  40, b: 220 }, { r: 220, g:  40, b: 120 }, { r:  40, g: 220, b: 120 }, { r: 120, g: 220, b:  40 },
  { r: 140, g: 100, b:  60 }, { r:  60, g: 100, b: 140 }, { r: 100, g: 140, b:  60 }, { r: 140, g:  60, b: 100 },
];

async function makeUpload(color: { r: number; g: number; b: number }, label: string): Promise<Buffer> {
  // 800×450 (16:9) coloured rectangle so cover-fit has something to crop —
  // we want to verify the inset-inside-border behaviour, not test exact pixel
  // colours at the centre.
  return await sharp({
    create: { width: 800, height: 450, channels: 4, background: { ...color, alpha: 1 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
            <rect x="20" y="20" width="760" height="410" fill="none" stroke="white" stroke-width="6"/>
            <text x="400" y="240" font-family="sans-serif" font-size="60" fill="white" text-anchor="middle">${label}</text>
          </svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const cards: TopicCard[] = LABELS.map((label, i) => ({
    index: i + 1,
    label,
    icon_concept: `concept ${i + 1}`,
  }));

  const uploads: CellUpload[] = [];
  for (let i = 0; i < LABELS.length; i++) {
    uploads.push({ cardIndex: i + 1, bytes: await makeUpload(COLORS[i], LABELS[i]) });
  }

  const blank = await sharp({
    create: { width: CANVAS_W, height: CANVAS_H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const layout = makeDefaultLayout(ROWS, COLS, CANVAS_W, CANVAS_H, 'square');
  const started = Date.now();
  const out = await applyCellUploads({
    baseImage: blank,
    layout,
    cards,
    cardShape: 'square',
    uploads,
  });
  const ms = Date.now() - started;

  await fs.writeFile(OUT_PATH, out);
  const meta = await sharp(out).metadata();
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${OUT_PATH} (${meta.width}×${meta.height}, ${out.byteLength} bytes) in ${ms}ms — ` +
      `${ROWS}×${COLS} grid, ${cards.length} uploads.`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
