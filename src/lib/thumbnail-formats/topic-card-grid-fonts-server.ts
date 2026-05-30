/**
 * Topic Card Grid — server-only font helpers.
 *
 * Split out of `topic-card-grid-fonts.ts` because the registry file
 * has to be safe to import from a client component (which the panel
 * is), and the browser doesn't have `node:path` or `process.cwd()`.
 * Server-side modules (the composite, the API route) import from
 * here when they need the absolute filesystem path to a bundled
 * font file.
 */

import path from 'node:path';
import type { ThumbnailFont } from './topic-card-grid-fonts';

/** Absolute path on the function filesystem to the bundled fonts
 *  directory. Computed from `process.cwd()` so server-side composite
 *  calls can resolve to the local WOFF2. */
export const BUNDLED_THUMBNAIL_FONT_DIR = path.join(
  process.cwd(),
  'public/fonts/thumbnail-grid',
);

/** Absolute filesystem path for a given font entry. Helper so callers
 *  don't have to remember the bundled-dir convention. */
export function fontFilePath(font: ThumbnailFont): string {
  return path.join(BUNDLED_THUMBNAIL_FONT_DIR, font.file);
}
