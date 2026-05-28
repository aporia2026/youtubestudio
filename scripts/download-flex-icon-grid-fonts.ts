/**
 * Download the bundled fonts for the Flex Icon Grid thumbnail format.
 *
 * Pulls TTFs from the canonical Google Fonts repository (all three are
 * SIL OFL — free to redistribute) and drops them under
 * `public/fonts/flex-icon-grid/`. Idempotent: skips any file already
 * present at the target size so a re-run is cheap.
 *
 * Run once after `npm install`:
 *   npx tsx scripts/download-flex-icon-grid-fonts.ts
 *
 * The font resolver in `src/lib/thumbnail-formats/flex-icon-grid-
 * composer.ts` reads from these absolute paths at render time; missing
 * files surface as `EFONT` errors from sharp's Pango integration with
 * a clear "TTF not found" message.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface FontSpec {
  /** Display name only — for log lines. */
  label: string;
  /** Target on-disk filename (must match FONT_RESOLVER in the composer). */
  fileName: string;
  /** Google Fonts repo URL — raw GitHub CDN. */
  url: string;
}

const FONTS: FontSpec[] = [
  {
    label: 'Anton',
    fileName: 'Anton-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf',
  },
  {
    label: 'Bowlby One',
    fileName: 'BowlbyOne-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/bowlbyone/BowlbyOne-Regular.ttf',
  },
  {
    label: 'Archivo Black',
    fileName: 'ArchivoBlack-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf',
  },
];

const TARGET_DIR = path.join(process.cwd(), 'public', 'fonts', 'flex-icon-grid');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(spec: FontSpec): Promise<void> {
  const out = path.join(TARGET_DIR, spec.fileName);
  if (await exists(out)) {
    const stat = await fs.stat(out);
    if (stat.size > 0) {
      console.info(`[download-fonts] skip ${spec.label} — already present (${stat.size} bytes)`);
      return;
    }
  }
  console.info(`[download-fonts] fetching ${spec.label} from ${spec.url}`);
  const res = await fetch(spec.url);
  if (!res.ok) {
    throw new Error(`${spec.label}: HTTP ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  await fs.writeFile(out, Buffer.from(ab));
  console.info(`[download-fonts] saved ${spec.label} → ${out} (${ab.byteLength} bytes)`);
}

async function main(): Promise<void> {
  await fs.mkdir(TARGET_DIR, { recursive: true });
  for (const spec of FONTS) {
    await download(spec);
  }
  console.info('[download-fonts] done');
}

main().catch((err) => {
  console.error('[download-fonts] failed', err);
  process.exit(1);
});
