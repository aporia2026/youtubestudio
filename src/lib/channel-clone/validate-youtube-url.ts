/**
 * YouTube URL validation + parsing for the channel-clone intake.
 *
 * The validator is the first defence before a user-supplied string
 * reaches the yt-dlp subprocess. yt-dlp itself is robust, but giving
 * it a hostile URL still costs network calls and surfaces opaque
 * errors to the UI. The cheaper move is to reject anything that
 * isn't a YouTube channel/video URL up-front, return a typed
 * ParsedYoutubeUrl on success, and let the route handler trust it.
 *
 * Security considerations (per plan §Security):
 *   - Rejects non-http(s) schemes outright (no javascript:, data:,
 *     file:, ftp:, etc.) so the parsed URL can never be confused
 *     for a local resource by a downstream tool.
 *   - Rejects URLs with embedded credentials (`user:pass@host`) —
 *     YouTube doesn't use them and they're a phishing/SSRF tell.
 *   - Rejects URLs containing control characters or NULL bytes
 *     (the standard URL parser will already throw on most of these
 *     but we belt-and-brace it).
 *   - Caps URL length to 2048 chars — well beyond any legitimate
 *     YouTube URL but a guard against accidental log/db bloat.
 *
 * The validator does NOT make network calls. Channel-handle existence
 * is resolved later by yt-dlp during intake.
 */

import type {
  ChannelUrlIdentifierType,
  ParsedYoutubeUrl,
  YoutubeUrlKind,
} from './types';

const MAX_URL_LENGTH = 2048;

/** Hosts we accept. Subdomains other than `www.` are rejected to
 *  keep the surface tight — `m.youtube.com` and `music.youtube.com`
 *  both serve channel pages, but the intake flow has no need for
 *  the mobile-web variant, and music.youtube.com is a different
 *  product entirely (different channel shapes, different content).
 *  Add to this set only when there's a concrete use-case. */
const ACCEPTED_HOSTS = new Set<string>([
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
]);

/** First path segment shape for known channel-URL variants. */
const CHANNEL_PATH_PREFIXES: { prefix: string; type: ChannelUrlIdentifierType }[] = [
  { prefix: 'channel', type: 'id' },
  { prefix: 'c', type: 'custom' },
  { prefix: 'user', type: 'user' },
];

/** Strict pattern for a YouTube video id: 11 chars from the
 *  base64url alphabet. The 11-char invariant has been stable since
 *  2008 — see https://webapps.stackexchange.com/q/54443. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Pattern for a YouTube channel id (UC…): 24 chars starting with
 *  `UC` from the base64url alphabet. */
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

/** Pattern for an @handle: starts with `@`, then 3-30 chars of
 *  letters/digits/underscore/period/hyphen. YouTube's actual rules
 *  are looser around length but this range covers ~all real handles
 *  while rejecting blatant junk. */
const HANDLE_RE = /^@[A-Za-z0-9_.-]{3,30}$/;

/** Pattern for a /c/CustomName or /user/Username path segment. The
 *  legacy custom URLs allow letters, digits, and a few punctuation
 *  characters but not arbitrary URL-encoded slashes. */
const CUSTOM_NAME_RE = /^[A-Za-z0-9_.-]{2,50}$/;

/** Control characters that have no business appearing in a URL.
 *  C0 controls (0x00-0x1F including NULL), DEL (0x7F), and C1
 *  controls (0x80-0x9F). The URL constructor will already reject
 *  most of these but we belt-and-brace it. */
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F-\x9F]/;

export type ValidateYoutubeUrlResult =
  | { ok: true; parsed: ParsedYoutubeUrl }
  | { ok: false; error: string };

/**
 * Validate and parse a user-supplied YouTube URL.
 *
 * Returns a discriminated result so the caller can render a precise
 * error message in the UI without throwing across an async boundary.
 */
export function validateYoutubeUrl(input: unknown): ValidateYoutubeUrlResult {
  // 1. Basic input shape — must be a string, finite length, no control chars.
  if (typeof input !== 'string') {
    return { ok: false, error: 'URL must be a string.' };
  }
  const raw = input.trim();
  if (raw.length === 0) {
    return { ok: false, error: 'URL is empty.' };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL exceeds the ${MAX_URL_LENGTH} character limit.` };
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    return { ok: false, error: 'URL contains control characters.' };
  }

  // 2. Parse as a URL. Anything that fails URL parsing is out.
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'URL is malformed.' };
  }

  // 3. Scheme + host gate.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Unsupported URL scheme: ${url.protocol.replace(':', '')}.` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
  }
  const host = url.hostname.toLowerCase();
  if (!ACCEPTED_HOSTS.has(host)) {
    return { ok: false, error: `Unsupported host: ${host}. Use youtube.com or youtu.be.` };
  }

  // 4. youtu.be → video.
  if (host === 'youtu.be') {
    const videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (!VIDEO_ID_RE.test(videoId)) {
      return { ok: false, error: 'youtu.be URL is missing a valid video id.' };
    }
    return {
      ok: true,
      parsed: buildParsed('video', `https://www.youtube.com/watch?v=${videoId}`, videoId),
    };
  }

  // 5. youtube.com — branch by first path segment.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  // 5a. `/watch?v=…`
  if (segments[0] === 'watch') {
    const videoId = url.searchParams.get('v') ?? '';
    if (!VIDEO_ID_RE.test(videoId)) {
      return { ok: false, error: '/watch URL is missing a valid `v` parameter.' };
    }
    return {
      ok: true,
      parsed: buildParsed('video', `https://www.youtube.com/watch?v=${videoId}`, videoId),
    };
  }

  // 5b. `/shorts/…` (treated as video for intake purposes — the
  // intake stage will resolve to channel via yt-dlp metadata).
  if (segments[0] === 'shorts' && segments.length >= 2) {
    const videoId = segments[1];
    if (!VIDEO_ID_RE.test(videoId)) {
      return { ok: false, error: '/shorts URL is missing a valid video id.' };
    }
    return {
      ok: true,
      parsed: buildParsed('video', `https://www.youtube.com/watch?v=${videoId}`, videoId),
    };
  }

  // 5c. `/@handle`
  if (segments[0]?.startsWith('@')) {
    const handle = segments[0];
    if (!HANDLE_RE.test(handle)) {
      return { ok: false, error: `Invalid @handle: ${handle}.` };
    }
    return {
      ok: true,
      parsed: buildChannelParsed(`https://www.youtube.com/${handle}`, handle, 'handle'),
    };
  }

  // 5d. `/channel/UCxxxx` | `/c/Name` | `/user/Username`
  const prefix = CHANNEL_PATH_PREFIXES.find((p) => p.prefix === segments[0]);
  if (prefix && segments.length >= 2) {
    const identifier = segments[1];
    if (prefix.type === 'id' && !CHANNEL_ID_RE.test(identifier)) {
      return { ok: false, error: `Invalid channel id: ${identifier}. Must look like UCxxxxxxxxxxxxxxxxxxxxxx.` };
    }
    if ((prefix.type === 'custom' || prefix.type === 'user') && !CUSTOM_NAME_RE.test(identifier)) {
      return { ok: false, error: `Invalid /${prefix.prefix}/ name: ${identifier}.` };
    }
    return {
      ok: true,
      parsed: buildChannelParsed(
        `https://www.youtube.com/${prefix.prefix}/${identifier}`,
        identifier,
        prefix.type,
      ),
    };
  }

  return {
    ok: false,
    error:
      'URL does not look like a YouTube channel or video. Try a /@handle, /channel/UC…, /watch?v=…, or youtu.be/… link.',
  };
}

function buildParsed(kind: YoutubeUrlKind, canonical: string, identifier: string): ParsedYoutubeUrl {
  return { kind, canonical, identifier };
}

function buildChannelParsed(
  canonical: string,
  identifier: string,
  identifierType: ChannelUrlIdentifierType,
): ParsedYoutubeUrl {
  return { kind: 'channel', canonical, identifier, identifierType };
}
