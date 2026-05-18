/**
 * Generate the curated default reference image for the Topic Card Grid
 * format. Runs ONCE to produce `public/thumbnail-formats/topic-card-grid-
 * default.png` — the bundled style anchor that ships when a user hasn't
 * uploaded their own reference.
 *
 * Why this exists: the format is i2i-locked and uses a reference image as
 * the typography / layout anchor. Without a baked-in default, every
 * generation requires the user to upload something. This script produces a
 * neutral, brand-safe baseline that demonstrates the format's intended
 * style — clean cards, varied per-card palettes, minimal text inside each
 * illustration, real recognisable visuals (we use generic everyday objects
 * to avoid trademark exposure in the repo).
 *
 * Run with:
 *   npx tsx scripts/generate-default-grid-reference.ts
 *
 * The script needs KIE_API_KEY in your environment (same as the deployed
 * app). It costs roughly $0.05-$0.10 per run via GPT Image 2 t2i — verify
 * on the Kie dashboard before re-running repeatedly.
 *
 * On success it writes the PNG to disk and prints the path. Open it,
 * decide whether it represents the style you want, and either re-run
 * (tweaks below to the CARDS array) or `git add` + commit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { topicCardGridImagePrompt } from '../src/lib/thumbnail-formats/topic-card-grid';
import { createKieTask, pollKieResult } from '../src/lib/kie-poll';

// Subjects chosen to be:
//  - Recognisable in <1 second at thumbnail size
//  - Visually varied (different colours, different objects, different
//    photographic moods — so the model sees variety is welcome)
//  - Trademark-safe (no logos, no copyrighted characters) — this PNG
//    ships in the repo so we keep it neutral.
const CARDS = [
  { index: 1, label: 'Coffee Cup', icon_concept: 'a single white ceramic coffee cup with a thin curl of steam, warm beige backdrop' },
  { index: 2, label: 'Pizza Slice', icon_concept: 'one triangular slice of pepperoni pizza, top-down view, neutral wooden surface' },
  { index: 3, label: 'Vintage Camera', icon_concept: 'a single classic 35mm film camera in matte black with chrome accents, soft grey background' },
  { index: 4, label: 'Acoustic Guitar', icon_concept: 'a single warm-toned acoustic guitar leaning against a plain dark wall, soft side light' },
  { index: 5, label: 'Sunglasses', icon_concept: 'one pair of classic black aviator sunglasses, flat lay on cream paper' },
  { index: 6, label: 'Brass Compass', icon_concept: 'a single antique brass compass on a weathered wooden surface, top-down' },
  { index: 7, label: 'Headphones', icon_concept: 'one pair of modern over-ear matte black headphones, isolated on light grey backdrop' },
  { index: 8, label: 'Stacked Books', icon_concept: 'a neat stack of three hardcover books in muted earthtones, plain backdrop' },
  { index: 9, label: 'Red Apple', icon_concept: 'a single glossy red apple on a clean white surface with soft natural light' },
];

const GRID_ROWS = 3;
const GRID_COLS = 3;
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'public/thumbnail-formats/topic-card-grid-default.png',
);

async function main() {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    console.error('KIE_API_KEY environment variable is required.');
    console.error('Tip: run `vercel env pull .env.local` if the project is linked, or copy the key from Vercel\'s dashboard.');
    process.exit(1);
  }

  // Build the same image prompt the format's API would build for a real
  // user run — so the default is a perfect self-reference for the format.
  const prompt = topicCardGridImagePrompt({
    cards: CARDS,
    palette: { background: '#000000', primary_accent: 'inherit', secondary_accent: 'inherit' },
    gridRows: GRID_ROWS,
    gridCols: GRID_COLS,
    notesForImageModel:
      'This is the canonical style template for the Topic Card Grid format. Clean, varied, minimal-text per card.',
  });

  // We're generating WITHOUT a reference image (chicken-and-egg: this IS
  // the reference we're making). Use GPT Image 2 text-to-image.
  const input = {
    prompt,
    aspect_ratio: '16:9',
    resolution: '1K',
  };

  console.log(`[generate-default] Submitting Kie task for ${GRID_ROWS}×${GRID_COLS} grid (${CARDS.length} cards)...`);
  const startedAt = Date.now();
  const taskId = await createKieTask(apiKey, 'gpt-image-2-text-to-image', input);
  console.log(`[generate-default] Task created: ${taskId}. Polling...`);

  const imageUrl = await pollKieResult(taskId, apiKey);
  console.log(`[generate-default] Image ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${imageUrl}`);

  // Download the result.
  const res = await fetch(imageUrl);
  if (!res.ok) {
    throw new Error(`Failed to download generated image (HTTP ${res.status}).`);
  }
  const arrayBuf = await res.arrayBuffer();
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, Buffer.from(arrayBuf));

  console.log(`[generate-default] Wrote ${arrayBuf.byteLength} bytes to ${OUTPUT_PATH}`);
  console.log('');
  console.log('Open the file and decide:');
  console.log('  - If you like it: run `git add public/thumbnail-formats/topic-card-grid-default.png` and tell Claude to commit.');
  console.log('  - If you want to tweak: edit the CARDS array at the top of this script and re-run.');
  console.log('  - If the style is wrong: tighten the prompt in src/lib/thumbnail-formats/topic-card-grid.ts and re-run.');
}

main().catch((err) => {
  console.error('[generate-default] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
