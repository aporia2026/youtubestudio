/**
 * Flex Icon Grid — official brand icon registry (auto-generated).
 *
 * This file is INTENTIONALLY empty by default. Populate it by running:
 *
 *     npx tsx scripts/download-flex-icon-grid-brand-icons.ts
 *
 * The script fetches Simple Icons (https://simpleicons.org, CC0-licensed
 * SVG path data) for a curated list of major brands and rewrites this
 * file to export the entries. The registry import (`flex-icon-grid-
 * brand-icons.ts`) reads `OFFICIAL_BRAND_ICONS` and spreads it into
 * `BRAND_ICONS` when the array is non-empty — so re-running the script
 * with a different brand list updates the panel's icon picker on the
 * next render without any further wiring.
 *
 * Trademark posture: Simple Icons distributes the SVG path data as
 * CC0, but the underlying brand logos remain trademarks of their
 * respective owners. Embedding a brand logo in a YouTube thumbnail
 * about that brand is generally fair use under YouTube's policy.
 * Embedding a competitor's logo in your own promotional material
 * usually is not. The script and this file are tools — the caller
 * is responsible for ensuring their specific use is legitimate.
 *
 * Why the script writes a TS file rather than fetching at runtime:
 * keeps the bundle deterministic, avoids per-request fetches, and
 * lets `lucide-static`-shaped `extractIconInner` slice the body
 * exactly as the rest of the registry expects.
 */

import type { IconEntry } from './flex-icon-grid-icons';

/** Auto-generated entries. Empty until the download script runs. */
export const OFFICIAL_BRAND_ICONS: readonly IconEntry[] = [];
