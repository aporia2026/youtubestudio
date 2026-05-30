/**
 * Topic Card Grid — font registry (client-safe).
 *
 * Single source of truth for the 22 curated Google Fonts bundled in
 * `public/fonts/thumbnail-grid/`. Both the server composite and the
 * client panel import from this file, so it MUST NOT depend on
 * `node:*` modules, `process.cwd()`, or anything else that doesn't
 * exist in the browser. Server-only path helpers live in
 * `topic-card-grid-fonts-server.ts`.
 *
 * Adding a new font:
 *  1. Re-run `scripts/download-thumbnail-fonts.ts` with the new entry
 *     so its WOFF2 lands in `public/fonts/thumbnail-grid/`.
 *  2. Append a `ThumbnailFont` entry below. The `id` is the
 *     canonical kebab-case key the API + localStorage round-trip;
 *     `family` is the SIL family name Pango expects; `file` is the
 *     filename under the bundled directory.
 *  3. Tests in `tests/topic-card-grid-fonts.test.ts` enforce id
 *     uniqueness and category-membership; new entries get caught
 *     automatically.
 */

/** Categories used to group fonts in the panel's dropdown. The order
 *  here is the order they appear under the picker. */
export const THUMBNAIL_FONT_CATEGORIES = [
  'hand-drawn',
  'bold-display',
  'editorial-serif',
  'modern-sans',
  'retro-stylized',
] as const;

export type ThumbnailFontCategory = (typeof THUMBNAIL_FONT_CATEGORIES)[number];

export interface ThumbnailFont {
  /** Canonical id used by the API, the panel, and localStorage. Kebab-
   *  case. Stable forever — renaming a font would orphan history. */
  id: string;
  /** Display label shown in the panel dropdown. */
  name: string;
  /** SIL family name as Pango / fontconfig expects it (used in the
   *  composite's `font` Pango string AND in the panel's CSS
   *  `font-family`). Matches the name inside the bundled WOFF2. */
  family: string;
  /** Filename under `public/fonts/thumbnail-grid/`. */
  file: string;
  /** Group the font sits under in the picker dropdown. */
  category: ThumbnailFontCategory;
}

/** The curated 22-font registry. Patrick Hand is first by convention —
 *  the default, and the format's bundled-reference typography. */
export const THUMBNAIL_FONTS: readonly ThumbnailFont[] = [
  // Hand-drawn (5)
  { id: 'patrick-hand', name: 'Patrick Hand', family: 'Patrick Hand', file: 'PatrickHand-Regular.woff2', category: 'hand-drawn' },
  { id: 'caveat', name: 'Caveat', family: 'Caveat', file: 'Caveat-Regular.woff2', category: 'hand-drawn' },
  { id: 'permanent-marker', name: 'Permanent Marker', family: 'Permanent Marker', file: 'PermanentMarker-Regular.woff2', category: 'hand-drawn' },
  { id: 'architects-daughter', name: 'Architects Daughter', family: 'Architects Daughter', file: 'ArchitectsDaughter-Regular.woff2', category: 'hand-drawn' },
  { id: 'kalam', name: 'Kalam', family: 'Kalam', file: 'Kalam-Regular.woff2', category: 'hand-drawn' },

  // Bold display (6)
  { id: 'bebas-neue', name: 'Bebas Neue', family: 'Bebas Neue', file: 'BebasNeue-Regular.woff2', category: 'bold-display' },
  { id: 'anton', name: 'Anton', family: 'Anton', file: 'Anton-Regular.woff2', category: 'bold-display' },
  { id: 'bowlby-one', name: 'Bowlby One', family: 'Bowlby One', file: 'BowlbyOne-Regular.woff2', category: 'bold-display' },
  { id: 'bungee', name: 'Bungee', family: 'Bungee', file: 'Bungee-Regular.woff2', category: 'bold-display' },
  { id: 'black-ops-one', name: 'Black Ops One', family: 'Black Ops One', file: 'BlackOpsOne-Regular.woff2', category: 'bold-display' },
  { id: 'bangers', name: 'Bangers', family: 'Bangers', file: 'Bangers-Regular.woff2', category: 'bold-display' },

  // Editorial serif (3)
  { id: 'playfair-display', name: 'Playfair Display', family: 'Playfair Display', file: 'PlayfairDisplay-Regular.woff2', category: 'editorial-serif' },
  { id: 'dm-serif-display', name: 'DM Serif Display', family: 'DM Serif Display', file: 'DMSerifDisplay-Regular.woff2', category: 'editorial-serif' },
  { id: 'merriweather', name: 'Merriweather', family: 'Merriweather', file: 'Merriweather-Regular.woff2', category: 'editorial-serif' },

  // Modern sans (4)
  { id: 'inter', name: 'Inter', family: 'Inter', file: 'Inter-Regular.woff2', category: 'modern-sans' },
  { id: 'poppins', name: 'Poppins', family: 'Poppins', file: 'Poppins-Regular.woff2', category: 'modern-sans' },
  { id: 'montserrat', name: 'Montserrat', family: 'Montserrat', file: 'Montserrat-Regular.woff2', category: 'modern-sans' },
  { id: 'roboto', name: 'Roboto', family: 'Roboto', file: 'Roboto-Regular.woff2', category: 'modern-sans' },

  // Retro / Stylized (4)
  { id: 'pacifico', name: 'Pacifico', family: 'Pacifico', file: 'Pacifico-Regular.woff2', category: 'retro-stylized' },
  { id: 'press-start-2p', name: 'Press Start 2P', family: 'Press Start 2P', file: 'PressStart2P-Regular.woff2', category: 'retro-stylized' },
  { id: 'monoton', name: 'Monoton', family: 'Monoton', file: 'Monoton-Regular.woff2', category: 'retro-stylized' },
  { id: 'russo-one', name: 'Russo One', family: 'Russo One', file: 'RussoOne-Regular.woff2', category: 'retro-stylized' },
];

/** Default font id. Patrick Hand matches the bundled curated reference
 *  image's typography, so flows that don't touch the picker render
 *  exactly as they did before the picker shipped. */
export const DEFAULT_FONT_ID = 'patrick-hand';

/** Human-readable category labels for the dropdown. Kept here so the
 *  panel doesn't have to maintain a parallel mapping. */
export const THUMBNAIL_FONT_CATEGORY_LABELS: Record<ThumbnailFontCategory, string> = {
  'hand-drawn': 'Hand-drawn',
  'bold-display': 'Bold display',
  'editorial-serif': 'Editorial serif',
  'modern-sans': 'Modern sans',
  'retro-stylized': 'Retro / Stylized',
};

/** Server-side allowlist lookup. Unknown ids return `null` so callers
 *  can decide whether to 400 the request or fall back to the default. */
export function findFontById(id: string | undefined | null): ThumbnailFont | null {
  if (!id) return null;
  return THUMBNAIL_FONTS.find((f) => f.id === id) ?? null;
}

/** Browser-side font URL for a given font entry. Used by the panel's
 *  `@font-face` declarations. The TTF/WOFF2 files in
 *  `public/fonts/thumbnail-grid/` are served as static assets at this
 *  path by Next.js automatically. */
export function fontBrowserUrl(font: ThumbnailFont): string {
  return `/fonts/thumbnail-grid/${font.file}`;
}
