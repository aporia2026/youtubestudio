/**
 * Flex Icon Grid — sticker style presets.
 *
 * A curated set of named visual styles that the generate-stickers route
 * prepends to each user-supplied prompt before composing the 2×2 collage
 * image-gen call. Lets a user pick a consistent look across an entire
 * grid without having to repeat the same style boilerplate in every
 * cell's prompt.
 *
 * Used by:
 *  - `FlexIconGridPanel.tsx` — the global "Sticker style" picker chip
 *    row next to the "Generate stickers" button.
 *  - `/api/thumbnails/format/flex-icon-grid/generate-stickers/route.ts`
 *    — looks up the style id, prefixes the style language to each
 *    prompt during prompt composition.
 *
 * Adding a style:
 *   1. Append an entry to `STICKER_STYLE_PRESETS` below.
 *   2. The panel chip row picks it up automatically.
 *   3. Old thumbnails with a now-unknown style fall back to
 *      `DEFAULT_STICKER_STYLE` — the server's `resolveStickerStyle`
 *      handles the normalisation.
 */

export interface StickerStylePreset {
  /** Wire identifier persisted in the panel + sent to the route. */
  id: string;
  /** Display label for the picker chip. */
  label: string;
  /** Short description shown as a tooltip / under-chip caption. */
  description: string;
  /**
   * Style language prepended to the user's per-cell prompt. The route
   * composes: `"${prefix}: ${userPrompt}"` per cell before wrapping in
   * the 2×2 collage template. Worded to play well with both Kie's
   * gpt-image-2 and the other image models — short, declarative, no
   * negative prompts.
   */
  prefix: string;
}

export const STICKER_STYLE_PRESETS: readonly StickerStylePreset[] = [
  {
    id: 'minimal-vector',
    label: 'Minimal vector',
    description: 'Clean flat illustration, single iconic subject, no background.',
    prefix:
      'a minimal flat vector sticker illustration, clean lines, single iconic subject centred '
      + 'on a clean off-white background, no fine detail, no text',
  },
  {
    id: 'hand-drawn',
    label: 'Hand-drawn',
    description: 'Marker outlines, sketchy feel, hand-illustrated.',
    prefix:
      'a hand-drawn doodle sticker, thick marker outlines, slightly sketchy edges, flat fills, '
      + 'on a clean off-white background, no text',
  },
  {
    id: 'cartoon-mascot',
    label: 'Cartoon mascot',
    description: 'Bold outlines, expressive cartoon character style.',
    prefix:
      'a bold cartoon mascot sticker, thick black outlines, expressive features, saturated flat '
      + 'colours, on a clean off-white background, no text',
  },
  {
    id: '3d-toy',
    label: '3D toy',
    description: 'Glossy plastic toy figurine render, soft shadows.',
    prefix:
      'a glossy 3D render of a plastic toy figurine sticker, soft studio lighting, subtle drop '
      + 'shadow, on a clean off-white background, no text',
  },
  {
    id: 'neon',
    label: 'Neon',
    description: 'Glowing neon outlines on a dark background.',
    prefix:
      'a neon-glow sticker, bright glowing outlines on a deep dark background, vibrant electric '
      + 'colours, no text',
  },
  {
    id: 'paper-cutout',
    label: 'Paper cutout',
    description: 'Layered paper craft style with crisp edges.',
    prefix:
      'a paper-cutout craft sticker, crisp layered paper shapes, subtle paper-grain texture, on '
      + 'a clean off-white background, no text',
  },
  {
    id: 'pixel-art',
    label: 'Pixel art',
    description: '8-bit / 16-bit pixel art aesthetic.',
    prefix:
      'a chunky pixel-art sticker, 16-bit retro game aesthetic, sharp pixel edges, limited '
      + 'palette, on a clean off-white background, no text',
  },
  {
    id: 'watercolor',
    label: 'Watercolour',
    description: 'Soft watercolour wash with painterly edges.',
    prefix:
      'a soft watercolour illustration sticker, painterly edges with gentle bleed, light wash '
      + 'colours, on a clean off-white background, no text',
  },
];

/** Default chosen when the user hasn't picked a style yet. */
export const DEFAULT_STICKER_STYLE = 'minimal-vector';

const PRESETS_BY_ID = new Map<string, StickerStylePreset>(
  STICKER_STYLE_PRESETS.map((p) => [p.id, p]),
);

/**
 * Resolve an arbitrary string id (typically from the request body) to
 * a concrete preset. Falls back to the default preset on any unknown
 * id — keeps the route's contract robust against stale clients that
 * send an id we've since renamed or retired.
 */
export function resolveStickerStyle(id: string | undefined | null): StickerStylePreset {
  if (id && PRESETS_BY_ID.has(id)) return PRESETS_BY_ID.get(id)!;
  return PRESETS_BY_ID.get(DEFAULT_STICKER_STYLE)!;
}
