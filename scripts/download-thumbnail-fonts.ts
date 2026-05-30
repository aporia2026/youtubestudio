/**
 * One-time bootstrap script for the Topic Card Grid font picker.
 *
 * Downloads WOFF2 files (latin subset only) for the 22 curated Google
 * Fonts via the official Google Fonts CSS2 API and writes them to
 * `public/fonts/thumbnail-grid/`. WOFF2 is chosen because:
 *  - Single format works for both browser (@font-face) AND server
 *    (sharp's `fontfile` via Pango/Freetype with brotli) — verified
 *    locally before this script was finalised.
 *  - Latin subset keeps each font around 10–40 KB versus the 200–4600 KB
 *    full-character static or variable TTFs in google/fonts.
 *  - Total bundle is well under 1 MB instead of ~9.5 MB.
 *
 * All fonts are SIL OFL or Apache 2.0 licensed — both permit
 * redistribution as part of an application bundle.
 *
 * Run once via `npx tsx scripts/download-thumbnail-fonts.ts`. The
 * resulting files are committed to the repo; no runtime CDN fetches.
 *
 * The Google Fonts CSS API returns one `@font-face` block per unicode
 * subset (latin, latin-ext, cyrillic, vietnamese, etc.). We grab the
 * FIRST one — the latin subset, sufficient for English thumbnail
 * labels. The validator's MAX_LABEL_CHARS cap keeps labels short, so
 * non-Latin characters are out of scope.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const GOOGLE_FONTS_CSS_BASE = 'https://fonts.googleapis.com/css2';
const MODERN_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface FontSpec {
  id: string;
  /** Family name with `+` for spaces — matches the Google Fonts URL
   *  format (e.g. `Patrick+Hand`, `Press+Start+2P`). */
  urlFamily: string;
  /** Output filename. Used by the registry + @font-face declarations. */
  outFile: string;
}

const FONTS: FontSpec[] = [
  // Hand-drawn
  { id: 'patrick-hand', urlFamily: 'Patrick+Hand', outFile: 'PatrickHand-Regular.woff2' },
  { id: 'caveat', urlFamily: 'Caveat', outFile: 'Caveat-Regular.woff2' },
  { id: 'permanent-marker', urlFamily: 'Permanent+Marker', outFile: 'PermanentMarker-Regular.woff2' },
  { id: 'architects-daughter', urlFamily: 'Architects+Daughter', outFile: 'ArchitectsDaughter-Regular.woff2' },
  { id: 'kalam', urlFamily: 'Kalam', outFile: 'Kalam-Regular.woff2' },

  // Bold display
  { id: 'bebas-neue', urlFamily: 'Bebas+Neue', outFile: 'BebasNeue-Regular.woff2' },
  { id: 'anton', urlFamily: 'Anton', outFile: 'Anton-Regular.woff2' },
  { id: 'bowlby-one', urlFamily: 'Bowlby+One', outFile: 'BowlbyOne-Regular.woff2' },
  { id: 'bungee', urlFamily: 'Bungee', outFile: 'Bungee-Regular.woff2' },
  { id: 'black-ops-one', urlFamily: 'Black+Ops+One', outFile: 'BlackOpsOne-Regular.woff2' },
  { id: 'bangers', urlFamily: 'Bangers', outFile: 'Bangers-Regular.woff2' },

  // Editorial serif
  { id: 'playfair-display', urlFamily: 'Playfair+Display', outFile: 'PlayfairDisplay-Regular.woff2' },
  { id: 'dm-serif-display', urlFamily: 'DM+Serif+Display', outFile: 'DMSerifDisplay-Regular.woff2' },
  { id: 'merriweather', urlFamily: 'Merriweather', outFile: 'Merriweather-Regular.woff2' },

  // Modern sans
  { id: 'inter', urlFamily: 'Inter', outFile: 'Inter-Regular.woff2' },
  { id: 'poppins', urlFamily: 'Poppins', outFile: 'Poppins-Regular.woff2' },
  { id: 'montserrat', urlFamily: 'Montserrat', outFile: 'Montserrat-Regular.woff2' },
  { id: 'roboto', urlFamily: 'Roboto', outFile: 'Roboto-Regular.woff2' },

  // Retro / Stylized
  { id: 'pacifico', urlFamily: 'Pacifico', outFile: 'Pacifico-Regular.woff2' },
  { id: 'press-start-2p', urlFamily: 'Press+Start+2P', outFile: 'PressStart2P-Regular.woff2' },
  { id: 'monoton', urlFamily: 'Monoton', outFile: 'Monoton-Regular.woff2' },
  { id: 'russo-one', urlFamily: 'Russo+One', outFile: 'RussoOne-Regular.woff2' },
];

/**
 * Fetch the CSS for a family and return the FIRST WOFF2 URL.
 *
 * Google Fonts returns multiple @font-face blocks for different unicode
 * subsets; the first block is the LATIN subset, which is what we want
 * for English labels. The match is deliberately greedy enough to handle
 * the `font-weight` / `font-stretch` lines between `@font-face {` and
 * the `src: url(...)` declaration.
 */
async function resolveWoff2Url(family: string): Promise<string> {
  const cssUrl = `${GOOGLE_FONTS_CSS_BASE}?family=${family}&display=swap`;
  const cssRes = await fetch(cssUrl, { headers: { 'User-Agent': MODERN_UA } });
  if (!cssRes.ok) {
    throw new Error(`CSS fetch HTTP ${cssRes.status} for ${family}`);
  }
  const css = await cssRes.text();
  const match = css.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!match) {
    throw new Error(`No WOFF2 URL found in CSS for ${family}`);
  }
  return match[1];
}

async function main(): Promise<void> {
  const targetDir = path.join(process.cwd(), 'public/fonts/thumbnail-grid');
  await fs.mkdir(targetDir, { recursive: true });
  console.log(`Target: ${targetDir}`);
  console.log(`Downloading ${FONTS.length} fonts (WOFF2, latin subset)...\n`);

  let okCount = 0;
  let failCount = 0;
  let totalBytes = 0;
  for (const font of FONTS) {
    const outPath = path.join(targetDir, font.outFile);
    try {
      const woff2Url = await resolveWoff2Url(font.urlFamily);
      const fontRes = await fetch(woff2Url);
      if (!fontRes.ok) {
        console.error(`✗ ${font.id}: WOFF2 fetch HTTP ${fontRes.status}`);
        failCount++;
        continue;
      }
      const buf = Buffer.from(await fontRes.arrayBuffer());
      if (buf.byteLength < 1024) {
        console.error(`✗ ${font.id}: suspicious payload (${buf.byteLength} bytes)`);
        failCount++;
        continue;
      }
      await fs.writeFile(outPath, buf);
      totalBytes += buf.byteLength;
      console.log(`✓ ${font.id} → ${font.outFile} (${buf.byteLength.toLocaleString()} bytes)`);
      okCount++;
    } catch (err) {
      console.error(`✗ ${font.id}: ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  }

  console.log(
    `\nDone. ${okCount} succeeded, ${failCount} failed. Total: ${(totalBytes / 1024).toFixed(1)} KB.`,
  );
  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
