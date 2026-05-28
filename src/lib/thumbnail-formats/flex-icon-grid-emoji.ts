/**
 * Flex Icon Grid — Twemoji resolver.
 *
 * Server-side emoji rendering. Twemoji (CC-BY-4.0) provides SVG glyphs
 * for every Unicode emoji at a stable jsdelivr CDN URL keyed on the
 * emoji's codepoint slug. We fetch on-demand at composition time, cache
 * per function instance, and hand the SVG bytes back to the composer to
 * use as an image overlay.
 *
 * Why this exists:
 * - Sharp's text input goes through Pango + fontconfig. On Vercel
 *   Linux the available system emoji fonts are unreliable — most
 *   emoji render as missing-glyph boxes. Bundling a full emoji font
 *   (Noto Color Emoji is ~9 MB) inflates the function bundle.
 *   Fetching individual Twemoji SVGs (~2 KB each) on demand is the
 *   cheap path.
 * - Twemoji SVGs are CC-BY-4.0; an attribution NOTICE is added at the
 *   project root in Phase 2.
 *
 * Pure-ish module: uses `fetch` (a global). No Next.js / React.
 * Module-level cache survives across requests within the same Lambda
 * instance — a sensible amount of memory pressure for production
 * workloads (the cache is at most ~few hundred emoji × ~2 KB each).
 */

/**
 * jsDelivr serves the Twitter Twemoji repository at this base. We pin
 * to `latest` deliberately: emoji set updates are additive (new
 * Unicode codepoints get added), so `latest` doesn't break old
 * thumbnails and adds future-emoji support automatically.
 */
const TWEMOJI_BASE_URL = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg';

/**
 * Module-level cache keyed by codepoint slug. Sharing across requests
 * within the same function instance avoids paying the fetch cost
 * multiple times for popular emoji like ⚡ or 🔒. Cleared automatically
 * when the Lambda instance is recycled.
 */
const SVG_CACHE = new Map<string, Buffer | null>();

/** Cap on how many emoji we'll cache before we start evicting.
 *  Hand-tuned: well above typical per-instance lifetime usage, but
 *  small enough that an adversarial input can't blow up memory. */
const MAX_CACHE_SIZE = 256;

/**
 * Convert an emoji character (potentially multi-codepoint, ZWJ-joined)
 * into the dash-separated lowercase-hex slug Twemoji uses for its SVG
 * filenames. Examples:
 *   "⚡" → "26a1"
 *   "🔒" → "1f512"
 *   "👨‍👩‍👧" → "1f468-200d-1f469-200d-1f467"
 *
 * Twemoji's convention drops the `fe0f` variation selector for most
 * emoji — including it produces 404s for common single-codepoint
 * emoji. We strip it here to match.
 */
export function emojiToCodepointSlug(emoji: string): string {
  const codepoints: string[] = [];
  for (const char of emoji) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) {
      const hex = cp.toString(16);
      // Drop the variation selector codepoint (U+FE0F) — Twemoji's
      // SVG filenames omit it for most emoji.
      if (hex !== 'fe0f') codepoints.push(hex);
    }
  }
  return codepoints.join('-');
}

/**
 * Fetch the Twemoji SVG bytes for an emoji character. Returns `null`
 * when:
 *   - The codepoint slug is empty (invalid input).
 *   - The CDN responds with a non-2xx status (unknown emoji).
 *   - The fetch throws (network error, DNS failure, etc.).
 *
 * Cached at the module level keyed on slug. Negative results are
 * cached too (`null` value) so we don't retry a known-missing emoji.
 */
export async function fetchTwemojiSvg(emoji: string): Promise<Buffer | null> {
  const slug = emojiToCodepointSlug(emoji);
  if (!slug) return null;
  if (SVG_CACHE.has(slug)) return SVG_CACHE.get(slug) ?? null;
  // Evict oldest when capped — simple LRU via Map insertion order.
  if (SVG_CACHE.size >= MAX_CACHE_SIZE) {
    const oldest = SVG_CACHE.keys().next().value;
    if (oldest !== undefined) SVG_CACHE.delete(oldest);
  }
  try {
    const res = await fetch(`${TWEMOJI_BASE_URL}/${slug}.svg`);
    if (!res.ok) {
      console.warn('[flex-icon-grid emoji] twemoji miss', {
        slug, status: res.status,
      });
      SVG_CACHE.set(slug, null);
      return null;
    }
    const text = await res.text();
    const buffer = Buffer.from(text, 'utf8');
    SVG_CACHE.set(slug, buffer);
    return buffer;
  } catch (err) {
    console.warn('[flex-icon-grid emoji] twemoji fetch failed', {
      slug, reason: err instanceof Error ? err.message : String(err),
    });
    SVG_CACHE.set(slug, null);
    return null;
  }
}

/**
 * Drain the cache. Exposed for tests; production code never calls it.
 */
export function _resetTwemojiCacheForTests(): void {
  SVG_CACHE.clear();
}
