/**
 * Flex Icon Grid — brand-mark icons.
 *
 * Lucide-static v1 dropped the major brand icons (Github / Twitter /
 * Youtube / Instagram / Linkedin) for trademark reasons. This module
 * ships brand-INSPIRED simplified geometric marks that read as "this
 * is a social brand" without being pixel-perfect reproductions of the
 * official logos.
 *
 * Design choices:
 *  - Every mark is stroke-based, matching the Lucide aesthetic so the
 *    composer's existing `inlineIconSvg` (which forces
 *    `fill="none"` + `stroke="currentColor"` on the parent group)
 *    renders them consistently with the rest of the icon set.
 *  - 24×24 viewBox so they slot into the same registry as the
 *    lucide-static icons without any geometry conversion.
 *  - Output string matches the lucide-static export shape exactly:
 *    `<svg xmlns=… viewBox="0 0 24 24" fill="none" stroke="currentColor"…>…</svg>`.
 *    Same `extractIconInner` strip logic works without modification.
 *  - Trademark posture: simplified marks deliberately omit fine logo
 *    details (e.g. no Twitter bird, no Octocat). Recognisable enough
 *    that a viewer pairs them with the label below, not so faithful
 *    that we're shipping a derivative work of the brand's protected
 *    logo asset.
 *
 * Adding a brand icon means:
 *   1. Design a stroke-only Lucide-style mark in a 24-unit viewBox.
 *   2. Append an entry to `BRAND_ICONS` below.
 *   3. The main registry (`flex-icon-grid-icons.ts`) spreads the
 *      array into `ICON_REGISTRY`; no other wiring required.
 */

import type { IconEntry } from './flex-icon-grid-icons';
import { OFFICIAL_BRAND_ICONS } from './flex-icon-grid-brand-icons-official';

/** Wrap a body string in the lucide-static-compatible SVG shell so
 *  the composer's existing `extractIconInner` slices the body back out
 *  identically to a lucide-static export. */
function wrapLucide(body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
    + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + body
    + '</svg>'
  );
}

// ─── Brand marks ────────────────────────────────────────────────────────────

/**
 * Github — rounded square with a `</>` code-bracket pair. Suggests
 * "code repository" without invoking the Octocat silhouette.
 */
const GITHUB_MARK = wrapLucide(
  '<rect x="3" y="3" width="18" height="18" rx="3"/>'
  + '<path d="M9 9 L6 12 L9 15"/>'
  + '<path d="M15 9 L18 12 L15 15"/>'
);

/**
 * X (formerly Twitter) — the literal X mark the rebrand already
 * reduced to. Two crossed strokes inside a rounded square frame to
 * read as a single "app icon" unit.
 */
const X_MARK = wrapLucide(
  '<rect x="3" y="3" width="18" height="18" rx="3"/>'
  + '<path d="M8 8 L16 16"/>'
  + '<path d="M16 8 L8 16"/>'
);

/**
 * YouTube — rounded rectangle frame with an outlined play triangle
 * inside. Avoids using the protected red colour by sticking to
 * stroke-only — the cell's bright background does the colour work.
 */
const YOUTUBE_MARK = wrapLucide(
  '<rect x="2" y="6" width="20" height="12" rx="3"/>'
  + '<path d="M10 9 L15 12 L10 15 Z"/>'
);

/**
 * Instagram — rounded camera square with a circular lens centre and a
 * small flash dot at the top-right corner. Reads as "camera app"
 * without invoking the gradient ring.
 */
const INSTAGRAM_MARK = wrapLucide(
  '<rect x="3" y="3" width="18" height="18" rx="5"/>'
  + '<circle cx="12" cy="12" r="4"/>'
  + '<circle cx="17.5" cy="6.5" r="0.7"/>'
);

/**
 * LinkedIn — square frame with a vertical bar + dot ("i" pattern) on
 * the left and a stylised "n" curve on the right. Suggests "in" as a
 * monogram without copying the wordmark.
 */
const LINKEDIN_MARK = wrapLucide(
  '<rect x="3" y="3" width="18" height="18" rx="2"/>'
  + '<line x1="8" y1="11" x2="8" y2="17"/>'
  + '<circle cx="8" cy="8" r="0.8"/>'
  + '<path d="M11 17 L11 11 M11 14 c0-3 5-4 5 0 v3"/>'
);

/**
 * Discord — rounded gaming-controller silhouette with two pill eyes.
 * Suggests "voice chat / gaming community" without the precise
 * controller geometry of the Discord brand mark.
 */
const DISCORD_MARK = wrapLucide(
  '<path d="M6 7 C9 5 15 5 18 7 L19 15 C16 17 14 17 12 17 C10 17 8 17 5 15 Z"/>'
  + '<ellipse cx="9" cy="11" rx="1" ry="1.5"/>'
  + '<ellipse cx="15" cy="11" rx="1" ry="1.5"/>'
);

/**
 * TikTok — a stylised musical note with a glitched secondary stem.
 * Suggests "short-form music video" without the brand's colour-shift
 * treatment.
 */
const TIKTOK_MARK = wrapLucide(
  '<path d="M10 4 V16 a4 4 0 1 1-4-4"/>'
  + '<path d="M10 4 C10 7 13 10 16 10"/>'
);

/**
 * Slack — four rounded bars arranged in an octothorpe pattern.
 * Suggests "channels / hash" without the four-colour treatment.
 */
const SLACK_MARK = wrapLucide(
  '<rect x="3" y="10" width="8" height="4" rx="2"/>'
  + '<rect x="13" y="10" width="8" height="4" rx="2"/>'
  + '<rect x="10" y="3" width="4" height="8" rx="2"/>'
  + '<rect x="10" y="13" width="4" height="8" rx="2"/>'
);

// ─── Registry ───────────────────────────────────────────────────────────────

const SIMPLIFIED_BRAND_ICONS: readonly IconEntry[] = [
  { slug: 'github', label: 'GitHub', category: 'web', svg: GITHUB_MARK },
  // Slug intentionally `twitter` — the existing Lucide 'x' slug is the
  // close-cross icon, and we keep this slug stable across any future
  // rebrand. Label reflects the current brand identity.
  { slug: 'twitter', label: 'X (Twitter)', category: 'web', svg: X_MARK },
  { slug: 'youtube', label: 'YouTube', category: 'web', svg: YOUTUBE_MARK },
  { slug: 'instagram', label: 'Instagram', category: 'web', svg: INSTAGRAM_MARK },
  { slug: 'linkedin', label: 'LinkedIn', category: 'web', svg: LINKEDIN_MARK },
  { slug: 'discord', label: 'Discord', category: 'web', svg: DISCORD_MARK },
  { slug: 'tiktok', label: 'TikTok', category: 'web', svg: TIKTOK_MARK },
  { slug: 'slack', label: 'Slack', category: 'web', svg: SLACK_MARK },
];

/**
 * Public registry. Combines:
 *  - The simplified geometric marks above (always present).
 *  - The official brand icons from `flex-icon-grid-brand-icons-
 *    official.ts` (empty until the user runs
 *    `scripts/download-flex-icon-grid-brand-icons.ts`). The script
 *    sources these from Simple Icons (CC0 SVG data) and writes them
 *    to a slug prefix of `<brand>-official` — so `github` stays the
 *    simplified mark and `github-official` is the brand-accurate logo
 *    once the script populates the registry. Users pick whichever
 *    they want from the icon picker; no global toggle needed.
 */
export const BRAND_ICONS: readonly IconEntry[] = [
  ...SIMPLIFIED_BRAND_ICONS,
  ...OFFICIAL_BRAND_ICONS,
];
