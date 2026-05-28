/**
 * Generate the Iconify icon module from the public Iconify API.
 *
 * Run once (or whenever you want to refresh the icon set):
 *   npx tsx scripts/download-flex-icon-grid-iconify-icons.ts
 *
 * What it does
 *   1. Fetches each icon in `ICONS` from `api.iconify.design`, which
 *      serves the upstream sets verbatim. Default curation targets
 *      MIT/Apache-2.0 sets: heroicons, tabler, phosphor, mdi
 *      (Material Design Icons), material-symbols.
 *   2. Re-wraps each fetched SVG in the lucide-static-shaped envelope
 *      so the composer's `extractIconInner` slices it identically to
 *      the rest of the icon registry.
 *   3. Writes the entries to
 *      `src/lib/thumbnail-formats/flex-icon-grid-iconify-icons.generated.ts`,
 *      replacing the empty default stub.
 *
 * License posture
 *   Each set listed below is MIT or Apache 2.0 — both permit
 *   redistribution as long as the upstream license terms are
 *   honoured (attribution, no warranty disclaimer). If you add a set
 *   with a different license, verify the terms before shipping.
 *
 * Adding an icon
 *   Append `{ name, label, category, iconStyle }` to the `ICONS`
 *   array below and re-run. `name` is the Iconify icon name in
 *   `<prefix>:<icon>` format. The slug stored in the registry is
 *   `iconify-<prefix>-<icon>` — namespaced to avoid collisions with
 *   the lucide-static slugs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

interface IconSpec {
  /** Iconify identifier, e.g. `heroicons:academic-cap`. */
  name: string;
  /** Picker display label. */
  label: string;
  /** Category bucket in the picker UI. Must be one of the
   *  `IconCategory` literals declared in `flex-icon-grid-icons.ts`. */
  category:
    | 'tech'
    | 'security'
    | 'communication'
    | 'money'
    | 'media'
    | 'people'
    | 'web'
    | 'common'
    | 'nature'
    | 'misc';
  /** Iconify sets vary between stroke (heroicons-outline, tabler) and
   *  fill (material-symbols, phosphor-fill, mdi). The composer wraps
   *  accordingly so a single registry can mix both. */
  iconStyle: 'stroke' | 'fill';
}

/** Allowed category literals. Mirrors `IconCategory` in
 *  `flex-icon-grid-icons.ts` so runtime validation can catch typos
 *  in a hand-edited entry before the script writes an invalid
 *  registry. */
const VALID_CATEGORIES = new Set<IconSpec['category']>([
  'tech', 'security', 'communication', 'money', 'media',
  'people', 'web', 'common', 'nature', 'misc',
]);

/**
 * Default curated list. Add/remove freely — each entry expands the
 * icon picker by one tile. Mix sets at will; the composer handles
 * `iconStyle` per icon.
 *
 * License roll-up:
 *   - heroicons:           MIT
 *   - tabler:              MIT
 *   - ph (Phosphor):       MIT
 *   - material-symbols:    Apache 2.0
 *   - mdi:                 Apache 2.0
 *   - lucide:              ISC (overlap with lucide-static; included
 *                          here for missing-from-static brands)
 *
 * To keep the bundle compact, prefer ONE source per icon — don't
 * duplicate `lightning` from both Phosphor AND Material Symbols
 * unless you want users to see both as distinct picker entries.
 */
const ICONS: IconSpec[] = [
  // ─── Heroicons (MIT) ────────────────────────────────────────────
  { name: 'heroicons:academic-cap', label: 'Academic Cap', category: 'common', iconStyle: 'stroke' },
  { name: 'heroicons:beaker', label: 'Beaker', category: 'tech', iconStyle: 'stroke' },
  { name: 'heroicons:rocket-launch', label: 'Rocket Launch', category: 'misc', iconStyle: 'stroke' },
  { name: 'heroicons:cpu-chip', label: 'CPU Chip', category: 'tech', iconStyle: 'stroke' },
  { name: 'heroicons:building-office', label: 'Office', category: 'common', iconStyle: 'stroke' },
  { name: 'heroicons:globe-alt', label: 'Globe Alt', category: 'web', iconStyle: 'stroke' },
  { name: 'heroicons:chart-bar', label: 'Chart Bar', category: 'money', iconStyle: 'stroke' },
  { name: 'heroicons:bookmark', label: 'Bookmark', category: 'common', iconStyle: 'stroke' },
  { name: 'heroicons:cake', label: 'Cake', category: 'misc', iconStyle: 'stroke' },
  { name: 'heroicons:hand-raised', label: 'Hand Raised', category: 'people', iconStyle: 'stroke' },

  // ─── Tabler (MIT) ───────────────────────────────────────────────
  { name: 'tabler:brain', label: 'Brain', category: 'people', iconStyle: 'stroke' },
  { name: 'tabler:droplet', label: 'Droplet', category: 'nature', iconStyle: 'stroke' },
  { name: 'tabler:atom', label: 'Atom', category: 'tech', iconStyle: 'stroke' },
  { name: 'tabler:robot', label: 'Robot', category: 'tech', iconStyle: 'stroke' },
  { name: 'tabler:planet', label: 'Planet', category: 'nature', iconStyle: 'stroke' },
  { name: 'tabler:cricket', label: 'Cricket', category: 'misc', iconStyle: 'stroke' },
  { name: 'tabler:rocket', label: 'Rocket (Tabler)', category: 'misc', iconStyle: 'stroke' },
  { name: 'tabler:trending-up', label: 'Trending Up (Tabler)', category: 'money', iconStyle: 'stroke' },
  { name: 'tabler:shield-lock', label: 'Shield Lock', category: 'security', iconStyle: 'stroke' },
  { name: 'tabler:device-mobile', label: 'Device Mobile', category: 'tech', iconStyle: 'stroke' },

  // ─── Phosphor (MIT) — solid fill variants ───────────────────────
  { name: 'ph:lightning-fill', label: 'Lightning (solid)', category: 'nature', iconStyle: 'fill' },
  { name: 'ph:flame-fill', label: 'Flame (solid)', category: 'nature', iconStyle: 'fill' },
  { name: 'ph:eye-fill', label: 'Eye (solid)', category: 'security', iconStyle: 'fill' },
  { name: 'ph:bug-fill', label: 'Bug (solid)', category: 'security', iconStyle: 'fill' },
  { name: 'ph:heart-fill', label: 'Heart (solid)', category: 'people', iconStyle: 'fill' },
  { name: 'ph:star-fill', label: 'Star (solid)', category: 'common', iconStyle: 'fill' },
  { name: 'ph:trophy-fill', label: 'Trophy (solid)', category: 'misc', iconStyle: 'fill' },
  { name: 'ph:crown-fill', label: 'Crown (solid)', category: 'misc', iconStyle: 'fill' },
  { name: 'ph:diamond-fill', label: 'Diamond', category: 'misc', iconStyle: 'fill' },
  { name: 'ph:cube-fill', label: 'Cube (solid)', category: 'tech', iconStyle: 'fill' },

  // ─── Material Symbols (Apache 2.0) ──────────────────────────────
  { name: 'material-symbols:shield', label: 'Shield (Material)', category: 'security', iconStyle: 'fill' },
  { name: 'material-symbols:bolt', label: 'Bolt (Material)', category: 'nature', iconStyle: 'fill' },
  { name: 'material-symbols:lock', label: 'Lock (Material)', category: 'security', iconStyle: 'fill' },
  { name: 'material-symbols:rocket-launch', label: 'Rocket (Material)', category: 'misc', iconStyle: 'fill' },
  { name: 'material-symbols:psychology', label: 'Psychology', category: 'people', iconStyle: 'fill' },
  { name: 'material-symbols:headphones', label: 'Headphones (Material)', category: 'media', iconStyle: 'fill' },
  { name: 'material-symbols:movie', label: 'Movie', category: 'media', iconStyle: 'fill' },
  { name: 'material-symbols:savings', label: 'Savings', category: 'money', iconStyle: 'fill' },
];

/** Pre-flight runtime check: every entry's `category` is one of the
 *  recognised IconCategory literals. Catches typos in hand-edited
 *  entries before we hit the network. Exits non-zero on failure so
 *  CI/precommit can wrap the script. */
function validateIconSpecs(specs: readonly IconSpec[]): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (!VALID_CATEGORIES.has(s.category)) {
      errors.push(`  [${i}] ${s.name}: unknown category "${s.category}"`);
    }
    if (s.iconStyle !== 'stroke' && s.iconStyle !== 'fill') {
      errors.push(`  [${i}] ${s.name}: iconStyle must be "stroke" or "fill" (got "${s.iconStyle}")`);
    }
    if (!s.name.includes(':')) {
      errors.push(`  [${i}] ${s.name}: name must be "<prefix>:<icon>"`);
    }
    if (seen.has(s.name)) {
      errors.push(`  [${i}] ${s.name}: duplicate entry`);
    }
    seen.add(s.name);
  }
  if (errors.length > 0) {
    console.error('[download-iconify-icons] icon-spec validation failed:');
    for (const e of errors) console.error(e);
    process.exit(2);
  }
}

const BASE_URL = 'https://api.iconify.design';
const OUTPUT_PATH = path.join(
  process.cwd(),
  'src',
  'lib',
  'thumbnail-formats',
  'flex-icon-grid-iconify-icons.generated.ts',
);

interface FetchResult {
  spec: IconSpec;
  inner: string | null;
  reason?: string;
}

async function fetchIcon(spec: IconSpec): Promise<FetchResult> {
  const url = `${BASE_URL}/${spec.name.replace(':', '/')}.svg`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { spec, inner: null, reason: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const inner = extractInner(text);
    if (!inner) {
      return { spec, inner: null, reason: 'inner-empty' };
    }
    return { spec, inner };
  } catch (err) {
    return { spec, inner: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Strip the outer `<svg …>…</svg>` tag — the inner XML is what the
 *  composer's `extractIconInner` consumes from the re-wrapped envelope. */
function extractInner(svg: string): string {
  const openClose = svg.indexOf('>');
  const closeOpen = svg.lastIndexOf('</svg>');
  if (openClose < 0 || closeOpen <= openClose) return '';
  return svg.slice(openClose + 1, closeOpen).trim();
}

/** Wrap a fetched body in the lucide-static-shaped envelope. The
 *  composer's `extractIconInner` slices the body back out identically
 *  to a real Lucide export, so the same downstream code path works
 *  for both. */
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

/** Build a kebab-case slug under the `iconify-` namespace. Avoids
 *  collisions with bare lucide slugs that share an icon name (e.g.
 *  `brain` from tabler vs `brain` from lucide-static). */
function buildSlug(name: string): string {
  return 'iconify-' + name.replace(':', '-').toLowerCase();
}

async function main(): Promise<void> {
  validateIconSpecs(ICONS);
  console.info(`[download-iconify-icons] fetching ${ICONS.length} icons from Iconify`);
  const results = await Promise.all(ICONS.map(fetchIcon));
  const successes = results.filter((r) => r.inner !== null);
  const failures = results.filter((r) => r.inner === null);
  console.info(`[download-iconify-icons] ${successes.length} ok / ${failures.length} failed`);
  for (const f of failures) {
    console.warn(`[download-iconify-icons]   skip ${f.spec.name}: ${f.reason}`);
  }

  const header = `/**
 * Flex Icon Grid — Iconify icon registry (auto-generated).
 *
 * GENERATED FILE — do not edit by hand. Re-run:
 *   npx tsx scripts/download-flex-icon-grid-iconify-icons.ts
 *
 * Source: Iconify (https://iconify.design). Underlying sets keep
 * their original licenses (MIT / Apache-2.0 for the default curation).
 *
 * Fetched ${new Date().toISOString().slice(0, 10)}.
 */

import type { IconEntry } from './flex-icon-grid-icons';
`;

  const entries = successes
    .map(({ spec, inner }) => {
      const svg = wrapLucide(inner!);
      const escapedSvg = escapeForTsString(svg);
      const escapedLabel = escapeForTsString(spec.label);
      return (
        `  {\n`
        + `    slug: '${buildSlug(spec.name)}',\n`
        + `    label: \`${escapedLabel}\`,\n`
        + `    category: '${spec.category}',\n`
        + `    iconStyle: '${spec.iconStyle}',\n`
        + `    svg: \`${escapedSvg}\`,\n`
        + `  },`
      );
    })
    .join('\n');

  const body =
    header
    + '\n'
    + 'export const ICONIFY_ICONS: readonly IconEntry[] = [\n'
    + entries
    + '\n];\n';

  await fs.writeFile(OUTPUT_PATH, body, 'utf8');
  console.info(`[download-iconify-icons] wrote ${OUTPUT_PATH}`);
  console.info('[download-iconify-icons] done — restart your dev server to pick up the new icons');
}

main().catch((err) => {
  console.error('[download-iconify-icons] failed', err);
  process.exit(1);
});
