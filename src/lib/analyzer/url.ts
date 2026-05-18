/**
 * YouTube URL helpers shared by analyzer routes.
 *
 * Kept in its own file (not inlined into the POST route) because the
 * niche-finder OutlierCard integration needs the same extractor on
 * the client side when it builds the `/analyze?videoId=...` deep
 * link, and the GET route may want to canonicalize incoming URLs as
 * well.
 */

const PATTERNS: readonly RegExp[] = [
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
  /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
  /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
];

/**
 * Extracts the 11-character YouTube video id from any common URL
 * shape. Returns null on a URL we can't recognise.
 *
 * Stricter than the regex in /api/analyze/youtube-style — we anchor
 * the id to the canonical 11-char alphabet so a malformed URL with
 * a punctuation suffix doesn't end up as a "video_id" with weird
 * characters in our cache table.
 */
export function extractYoutubeVideoId(url: string): string | null {
  if (!url) return null;
  for (const p of PATTERNS) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function canonicalYoutubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
