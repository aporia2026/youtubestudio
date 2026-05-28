/**
 * Generate the official brand icons module from Simple Icons.
 *
 * Run once (or whenever you want to refresh the brand-logo set):
 *   npx tsx scripts/download-flex-icon-grid-brand-icons.ts
 *
 * What it does
 *   1. Fetches the SVG for each brand in `BRANDS` from the
 *      simple-icons GitHub repo (CC0 SVG data).
 *   2. Wraps each SVG body in the lucide-static-shaped envelope so
 *      the composer's existing `extractIconInner` slices it
 *      identically to the rest of the icon registry.
 *   3. Writes the entries to
 *      `src/lib/thumbnail-formats/flex-icon-grid-brand-icons-official.ts`,
 *      replacing the empty default stub.
 *
 * Slug convention
 *   Each official entry uses slug `<brand>-official` (e.g.
 *   `github-official`). The simplified geometric marks keep their
 *   bare slugs (`github`). Users pick whichever variant they want
 *   from the icon picker — no global toggle, both appear side-by-side
 *   in the Web & Social category.
 *
 * Trademark posture
 *   Simple Icons distributes the SVG path data under CC0. Brand
 *   logos themselves remain trademarks of their respective owners.
 *   Embedding a brand logo in a thumbnail about that brand is
 *   generally fair use under YouTube's policy; embedding a
 *   competitor's logo in your own promotional material usually is
 *   not. The caller is responsible for ensuring their specific use
 *   is legitimate.
 *
 * Adding a brand
 *   Append `{ slug, label }` to the `BRANDS` array and re-run.
 *   `slug` is the Simple Icons slug (lowercase, no spaces); `label`
 *   is the picker display name. The script handles the rest.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface BrandSpec {
  /** Slug used by Simple Icons for the SVG filename. */
  simpleIconsSlug: string;
  /** Picker label shown next to the icon. */
  label: string;
}

const BRANDS: BrandSpec[] = [
  { simpleIconsSlug: 'github', label: 'GitHub (official)' },
  { simpleIconsSlug: 'x', label: 'X (official)' },
  { simpleIconsSlug: 'youtube', label: 'YouTube (official)' },
  { simpleIconsSlug: 'instagram', label: 'Instagram (official)' },
  { simpleIconsSlug: 'linkedin', label: 'LinkedIn (official)' },
  { simpleIconsSlug: 'discord', label: 'Discord (official)' },
  { simpleIconsSlug: 'tiktok', label: 'TikTok (official)' },
  { simpleIconsSlug: 'slack', label: 'Slack (official)' },
  { simpleIconsSlug: 'facebook', label: 'Facebook (official)' },
  { simpleIconsSlug: 'pinterest', label: 'Pinterest (official)' },
  { simpleIconsSlug: 'reddit', label: 'Reddit (official)' },
  { simpleIconsSlug: 'twitch', label: 'Twitch (official)' },
  { simpleIconsSlug: 'spotify', label: 'Spotify (official)' },
  { simpleIconsSlug: 'apple', label: 'Apple (official)' },
  { simpleIconsSlug: 'google', label: 'Google (official)' },
  { simpleIconsSlug: 'microsoft', label: 'Microsoft (official)' },
];

const BASE_URL = 'https://raw.githubusercontent.com/simple-icons/simple-icons/master/icons';
const OUTPUT_PATH = path.join(
  process.cwd(),
  'src',
  'lib',
  'thumbnail-formats',
  'flex-icon-grid-brand-icons-official.ts',
);

interface FetchResult {
  brand: BrandSpec;
  inner: string | null;
  reason?: string;
}

async function fetchBrand(brand: BrandSpec): Promise<FetchResult> {
  const url = `${BASE_URL}/${brand.simpleIconsSlug}.svg`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { brand, inner: null, reason: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const inner = extractInner(text);
    if (!inner) {
      return { brand, inner: null, reason: 'inner-empty' };
    }
    return { brand, inner };
  } catch (err) {
    return { brand, inner: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Strip Simple Icons' `<svg …>…</svg>` outer tag + the `<title>`
 * element (informational, not visual). The remainder is the path
 * data ready to be re-wrapped in our lucide-static-shaped envelope.
 */
function extractInner(svg: string): string {
  const openClose = svg.indexOf('>');
  const closeOpen = svg.lastIndexOf('</svg>');
  if (openClose < 0 || closeOpen <= openClose) return '';
  let inner = svg.slice(openClose + 1, closeOpen);
  // Drop `<title>…</title>` — Simple Icons embeds it for screen
  // readers but it adds nothing visual and bloats the bundle.
  inner = inner.replace(/<title>[^<]*<\/title>/g, '');
  return inner.trim();
}

/**
 * Wrap a fetched path body in the lucide-static-compatible envelope
 * so the composer's existing `extractIconInner` slice logic works
 * without any special-casing. Note: Simple Icons paths are fill-based
 * (no stroke attributes), so the file marks each entry with
 * `iconStyle: 'fill'` so the composer wraps them with `fill="…"`
 * instead of the default `stroke="…"`.
 */
function wrapLucide(body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
    + 'viewBox="0 0 24 24">'
    + body
    + '</svg>'
  );
}

function escapeForTsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

async function main(): Promise<void> {
  console.info(`[download-brand-icons] fetching ${BRANDS.length} brands from Simple Icons`);
  const results = await Promise.all(BRANDS.map(fetchBrand));
  const successes = results.filter((r) => r.inner !== null);
  const failures = results.filter((r) => r.inner === null);
  console.info(`[download-brand-icons] ${successes.length} ok / ${failures.length} failed`);
  for (const f of failures) {
    console.warn(`[download-brand-icons]   skip ${f.brand.simpleIconsSlug}: ${f.reason}`);
  }

  const header = `/**
 * Flex Icon Grid — official brand icon registry (auto-generated).
 *
 * GENERATED FILE — do not edit by hand. Re-run:
 *   npx tsx scripts/download-flex-icon-grid-brand-icons.ts
 *
 * Source: simple-icons (https://simpleicons.org, CC0). Brand logos
 * remain trademarks of their respective owners.
 *
 * Fetched ${new Date().toISOString().slice(0, 10)}.
 */

import type { IconEntry } from './flex-icon-grid-icons';
`;

  const entries = successes
    .map(({ brand, inner }) => {
      const svg = wrapLucide(inner!);
      const escapedSvg = escapeForTsString(svg);
      const escapedLabel = escapeForTsString(brand.label);
      return (
        `  {\n`
        + `    slug: '${brand.simpleIconsSlug}-official',\n`
        + `    label: \`${escapedLabel}\`,\n`
        + `    category: 'web',\n`
        + `    iconStyle: 'fill',\n`
        + `    svg: \`${escapedSvg}\`,\n`
        + `  },`
      );
    })
    .join('\n');

  const body =
    header
    + '\n'
    + 'export const OFFICIAL_BRAND_ICONS: readonly IconEntry[] = [\n'
    + entries
    + '\n];\n';

  await fs.writeFile(OUTPUT_PATH, body, 'utf8');
  console.info(`[download-brand-icons] wrote ${OUTPUT_PATH}`);
  console.info('[download-brand-icons] done — restart your dev server to pick up the new icons');
}

main().catch((err) => {
  console.error('[download-brand-icons] failed', err);
  process.exit(1);
});
