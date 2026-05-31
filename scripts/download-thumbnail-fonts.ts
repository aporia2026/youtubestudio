/**
 * One-time bootstrap script for the Topic Card Grid font picker.
 *
 * Downloads BOTH formats (latin subset only) for the 22 curated Google
 * Fonts and writes them to `public/fonts/thumbnail-grid/`:
 *  - `<File>-Regular.ttf`   — server-side label rendering via sharp's
 *    `fontfile` parameter. Pango/FreeType inside the sharp prebuilt for
 *    Linux is NOT compiled with brotli support, so a WOFF2 `fontfile`
 *    silently fails to decode and Pango falls back to a glyphless system
 *    font (tofu boxes). TTF works on every sharp prebuilt.
 *  - `<File>-Regular.woff2` — browser-side `@font-face` preview in the
 *    picker panel. WOFF2 is brotli-compressed so it's ~5x smaller than
 *    TTF in transit; we ship both formats and pick per runtime.
 *
 * Earlier revisions of this script shipped WOFF2 only with a comment
 * claiming Pango+brotli "verified locally" — that was true on macOS
 * (Homebrew freetype is built with brotli) but false on Vercel Linux.
 * The result was every topic-card-grid label rendering as tofu in
 * production. See `_plans/2026-05-31-topic-card-grid-font-tofu-fix.md`.
 *
 * TTF source: Google Fonts CSS v1 endpoint (`/css?family=`) returns
 * direct `.ttf` URLs when called with an EMPTY User-Agent. Modern UAs
 * get WOFF2 from the same endpoint; v2 (`/css2?family=`) always returns
 * WOFF2 regardless of UA. Both quirks are verified against the live API
 * before this script was finalised.
 *
 * All fonts are SIL OFL or Apache 2.0 licensed — both permit
 * redistribution as part of an application bundle.
 *
 * Run via `npx tsx scripts/download-thumbnail-fonts.ts`. The resulting
 * files are committed to the repo; no runtime CDN fetches.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** v2 returns WOFF2 to modern UAs. Used for the browser-side font. */
const GOOGLE_FONTS_CSS2_BASE = 'https://fonts.googleapis.com/css2';
/** v1 returns TTF when called with an empty User-Agent. Used for the
 *  server-side font that Pango/FreeType reads via `fontfile`. */
const GOOGLE_FONTS_CSS1_BASE = 'https://fonts.googleapis.com/css';
const MODERN_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface FontSpec {
  id: string;
  /** Family name with `+` for spaces — matches the Google Fonts URL
   *  format (e.g. `Patrick+Hand`, `Press+Start+2P`). */
  urlFamily: string;
  /** Base filename WITHOUT extension. Both `.ttf` and `.woff2` files
   *  share this stem. */
  outStem: string;
}

const FONTS: FontSpec[] = [
  // Hand-drawn
  { id: 'patrick-hand', urlFamily: 'Patrick+Hand', outStem: 'PatrickHand-Regular' },
  { id: 'caveat', urlFamily: 'Caveat', outStem: 'Caveat-Regular' },
  { id: 'permanent-marker', urlFamily: 'Permanent+Marker', outStem: 'PermanentMarker-Regular' },
  { id: 'architects-daughter', urlFamily: 'Architects+Daughter', outStem: 'ArchitectsDaughter-Regular' },
  { id: 'kalam', urlFamily: 'Kalam', outStem: 'Kalam-Regular' },

  // Bold display
  { id: 'bebas-neue', urlFamily: 'Bebas+Neue', outStem: 'BebasNeue-Regular' },
  { id: 'anton', urlFamily: 'Anton', outStem: 'Anton-Regular' },
  { id: 'bowlby-one', urlFamily: 'Bowlby+One', outStem: 'BowlbyOne-Regular' },
  { id: 'bungee', urlFamily: 'Bungee', outStem: 'Bungee-Regular' },
  { id: 'black-ops-one', urlFamily: 'Black+Ops+One', outStem: 'BlackOpsOne-Regular' },
  { id: 'bangers', urlFamily: 'Bangers', outStem: 'Bangers-Regular' },

  // Editorial serif
  { id: 'playfair-display', urlFamily: 'Playfair+Display', outStem: 'PlayfairDisplay-Regular' },
  { id: 'dm-serif-display', urlFamily: 'DM+Serif+Display', outStem: 'DMSerifDisplay-Regular' },
  { id: 'merriweather', urlFamily: 'Merriweather', outStem: 'Merriweather-Regular' },

  // Modern sans
  { id: 'inter', urlFamily: 'Inter', outStem: 'Inter-Regular' },
  { id: 'poppins', urlFamily: 'Poppins', outStem: 'Poppins-Regular' },
  { id: 'montserrat', urlFamily: 'Montserrat', outStem: 'Montserrat-Regular' },
  { id: 'roboto', urlFamily: 'Roboto', outStem: 'Roboto-Regular' },

  // Retro / Stylized
  { id: 'pacifico', urlFamily: 'Pacifico', outStem: 'Pacifico-Regular' },
  { id: 'press-start-2p', urlFamily: 'Press+Start+2P', outStem: 'PressStart2P-Regular' },
  { id: 'monoton', urlFamily: 'Monoton', outStem: 'Monoton-Regular' },
  { id: 'russo-one', urlFamily: 'Russo+One', outStem: 'RussoOne-Regular' },
];

/**
 * Fetch a Google Fonts CSS endpoint with the supplied User-Agent and
 * return the first asset URL whose extension/format matches `kind`.
 *
 * Google Fonts returns one `@font-face` block per unicode subset; the
 * first one is the latin subset, which is what we want for English
 * labels. The regex is permissive enough to handle optional
 * `format('...')` annotations and the v2 endpoint's quoted URLs.
 */
async function resolveAssetUrl(
  cssBase: string,
  family: string,
  ua: string,
  kind: 'woff2' | 'ttf',
): Promise<string> {
  const cssUrl = `${cssBase}?family=${family}${cssBase === GOOGLE_FONTS_CSS2_BASE ? '&display=swap' : ''}`;
  const cssRes = await fetch(cssUrl, ua ? { headers: { 'User-Agent': ua } } : undefined);
  if (!cssRes.ok) {
    throw new Error(`CSS fetch HTTP ${cssRes.status} for ${family} (${kind})`);
  }
  const css = await cssRes.text();
  const ext = kind === 'woff2' ? 'woff2' : 'ttf';
  const re = new RegExp(`url\\((https:\\/\\/[^)]+\\.${ext})\\)`);
  const match = css.match(re);
  if (!match) {
    throw new Error(`No ${kind.toUpperCase()} URL found in CSS for ${family}`);
  }
  return match[1];
}

/** Download an asset and write to disk. Validates a minimum byte size
 *  so a truncated / HTML error response can't masquerade as a font. */
async function downloadTo(url: string, outPath: string, label: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label}: asset fetch HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(`${label}: suspicious payload (${buf.byteLength} bytes)`);
  }
  await fs.writeFile(outPath, buf);
  return buf.byteLength;
}

async function main(): Promise<void> {
  const targetDir = path.join(process.cwd(), 'public/fonts/thumbnail-grid');
  await fs.mkdir(targetDir, { recursive: true });
  console.log(`Target: ${targetDir}`);
  console.log(`Downloading ${FONTS.length} fonts (TTF + WOFF2, latin subset)...\n`);

  let okCount = 0;
  let failCount = 0;
  let totalBytes = 0;
  for (const font of FONTS) {
    const ttfOut = path.join(targetDir, `${font.outStem}.ttf`);
    const woff2Out = path.join(targetDir, `${font.outStem}.woff2`);
    try {
      // Empty UA on the v1 endpoint returns TTF. Verified against live
      // API on 2026-05-31 for all 22 families in the registry.
      const ttfUrl = await resolveAssetUrl(GOOGLE_FONTS_CSS1_BASE, font.urlFamily, '', 'ttf');
      // Modern UA on v2 returns WOFF2.
      const woff2Url = await resolveAssetUrl(GOOGLE_FONTS_CSS2_BASE, font.urlFamily, MODERN_UA, 'woff2');
      const ttfBytes = await downloadTo(ttfUrl, ttfOut, `${font.id} ttf`);
      const woff2Bytes = await downloadTo(woff2Url, woff2Out, `${font.id} woff2`);
      totalBytes += ttfBytes + woff2Bytes;
      console.log(
        `✓ ${font.id} → ${font.outStem}.ttf (${ttfBytes.toLocaleString()} B) + .woff2 (${woff2Bytes.toLocaleString()} B)`,
      );
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
