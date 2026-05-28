/**
 * Flex Icon Grid — custom font family name derivation.
 *
 * Pure helper shared between the panel (workspace-font chip preview),
 * the live preview (config-driven font registration), and any other
 * surface that needs to reference the same FontFace by name.
 *
 * The browser-side family name is derived from a stable hash of the
 * source URL. Same URL → same family name across the entire app, so
 * a FontFace registered by the panel is immediately usable by the
 * live preview's `<text>` elements (and vice versa).
 *
 * Hash function: FNV-1a-ish multiply/add with a 31 multiplier. Not
 * cryptographic — just stable and collision-resistant enough for
 * <1000 unique URLs per workspace.
 */

export function customFontFamilyName(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0;
  }
  return `fg-custom-${(hash >>> 0).toString(36)}`;
}
