/**
 * On-demand monetization check for a single YouTube video.
 *
 * The Data API doesn't publish per-video monetization status for
 * channels we don't own, so we scrape the public watch page and
 * read the `ytInitialPlayerResponse` JSON that YouTube embeds in
 * the HTML. The `adPlacements` array inside that object is the
 * canonical signal — non-empty means YouTube has configured ad
 * slots for the video.
 *
 * This module is split in half for testability:
 *
 *   - `detectMonetizationFromPlayerResponse(obj)` — pure function
 *     over a parsed player-response object. Returns the status
 *     enum + a short human reason. Covered by fixture-based unit
 *     tests; no I/O.
 *   - `extractPlayerResponseFromHtml(html)` — pure regex + JSON
 *     parser over the raw page HTML. Returns the parsed object or
 *     null. Also unit-tested.
 *   - `checkVideoMonetization(videoId)` — the network wrapper.
 *     Fetches the watch page, parses, caches the result in the
 *     existing 7-day niche_finder_api_cache table, returns the
 *     status object.
 *
 * Fragility note: YouTube changes the watch-page HTML structure
 * every few months. The extractor uses brace-counting (not regex
 * for the whole object) so it tolerates minor punctuation changes,
 * but a renamed top-level field will make the parser return
 * `unknown` until we update it. Both extractor and detector
 * degrade to `unknown` rather than throw.
 *
 * ToS note: scraping youtube.com is a ToS-violation surface.
 * Mitigations live one layer up in the route handler: authed-only
 * access + lazy on-demand triggering (no bulk auto-fetch).
 */
import { cacheKey, readApiCache, writeApiCache } from './db';
import { logger } from '@/lib/logger';

export type MonetizationStatus = 'monetized' | 'not-monetized' | 'unknown';

export interface MonetizationCheckResult {
  videoId: string;
  status: MonetizationStatus;
  /** Short, static reason string — safe to surface to the UI. */
  reason: string;
  checkedAt: string;
  cached: boolean;
}

/** Realistic Chrome User-Agent. YouTube serves a different (often
 *  ad-stripped) shell to bot UAs; the desktop Chrome string returns
 *  the page shape our parser expects. */
const FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Hard cap on fetch latency — YouTube usually responds in <800ms;
 *  we abandon any slower request rather than block the user. */
const FETCH_TIMEOUT_MS = 8_000;

/** Loose shape of the slice of `ytInitialPlayerResponse` we read.
 *  Treated as `unknown` everywhere outside the detector to avoid
 *  trusting field-presence claims. */
export interface PlayerResponseLike {
  playabilityStatus?: { status?: string; reason?: string };
  adPlacements?: unknown[];
  playerAds?: unknown[];
  videoDetails?: { isLiveContent?: boolean };
}

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, fixture-testable.
// ---------------------------------------------------------------------------

/**
 * Walk the JS source looking for `ytInitialPlayerResponse = {…}` and
 * return the JSON string for that object literal. Uses brace counting
 * so nested braces / strings inside the object don't trip the parser.
 *
 * Returns null when:
 *   - the assignment marker isn't found at all (changed HTML shape);
 *   - the opening brace isn't located after the marker;
 *   - the brace count never returns to zero before EOF.
 */
export function extractPlayerResponseJson(html: string): string | null {
  if (typeof html !== 'string' || html.length === 0) return null;

  // Two known assignment patterns on YouTube watch pages — covers
  // both `var ytInitialPlayerResponse = ...` and the inline window
  // assignment used on lighter shells.
  const markers = [
    /ytInitialPlayerResponse\s*=\s*\{/,
    /"ytInitialPlayerResponse"\s*:\s*\{/,
  ];
  let braceStart = -1;
  for (const re of markers) {
    const m = re.exec(html);
    if (m) {
      braceStart = m.index + m[0].length - 1; // index of the opening `{`
      break;
    }
  }
  if (braceStart < 0) return null;

  // Walk forward, tracking string state so braces inside strings
  // don't pollute the count.
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;
  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return html.slice(braceStart, i + 1);
      }
    }
  }
  return null;
}

/** Higher-level wrapper: extract the JSON and parse it, returning
 *  null on any failure so the caller can short-circuit cleanly. */
export function extractPlayerResponseFromHtml(html: string): PlayerResponseLike | null {
  const raw = extractPlayerResponseJson(html);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as PlayerResponseLike;
  } catch {
    return null;
  }
}

/**
 * Decide the monetization status given a parsed player-response
 * object. Returns the status enum and a short, human-readable
 * reason that's safe to display in a tooltip.
 *
 * Conservative on "monetized" — only positive ad-field signals
 * earn that label. Conservative on "not-monetized" — only when
 * playability is OK and both ad fields are empty / missing. Every
 * other case is `unknown`.
 */
export function detectMonetizationFromPlayerResponse(
  response: PlayerResponseLike | null | undefined,
): { status: MonetizationStatus; reason: string } {
  if (!response || typeof response !== 'object') {
    return { status: 'unknown', reason: 'Watch page did not return a player response.' };
  }

  const playability = response.playabilityStatus?.status;
  if (typeof playability === 'string' && playability !== 'OK') {
    return {
      status: 'unknown',
      reason: `Video not playable (${playability.toLowerCase()}); monetization status unavailable.`,
    };
  }

  if (response.videoDetails?.isLiveContent === true) {
    return {
      status: 'unknown',
      reason: 'Live content uses a different ad model; static check is unreliable.',
    };
  }

  const adPlacements = Array.isArray(response.adPlacements) ? response.adPlacements : [];
  const playerAds = Array.isArray(response.playerAds) ? response.playerAds : [];

  if (adPlacements.length > 0) {
    return {
      status: 'monetized',
      reason: `adPlacements populated (${adPlacements.length} slot${
        adPlacements.length === 1 ? '' : 's'
      }).`,
    };
  }
  if (playerAds.length > 0) {
    return {
      status: 'monetized',
      reason: `playerAds populated (${playerAds.length} entr${
        playerAds.length === 1 ? 'y' : 'ies'
      }).`,
    };
  }

  if (playability === 'OK') {
    return {
      status: 'not-monetized',
      reason: 'Watch page returned no ad placements.',
    };
  }

  return {
    status: 'unknown',
    reason: 'No definitive monetization signal in the watch page.',
  };
}

// ---------------------------------------------------------------------------
// Network wrapper — caches per-video for 7 days via the existing
// niche_finder_api_cache table. Degrades to `unknown` on every
// failure path so a flaky scrape never throws into the route.
// ---------------------------------------------------------------------------

function watchUrlFor(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function isValidVideoId(videoId: unknown): videoId is string {
  return typeof videoId === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(videoId);
}

interface CachedShape {
  status: MonetizationStatus;
  reason: string;
  checkedAt: string;
}

/**
 * Check one video's monetization status. Cached in
 * `niche_finder_api_cache` (7-day TTL) under
 * `GET <watch-url>:monetization` so repeat clicks are free.
 *
 * `forceRefresh` skips the cache read but still writes the new
 * result back — useful for the "re-check" path if we add one.
 */
export async function checkVideoMonetization(
  videoId: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<MonetizationCheckResult> {
  if (!isValidVideoId(videoId)) {
    return {
      videoId: String(videoId ?? ''),
      status: 'unknown',
      reason: 'Invalid video id.',
      checkedAt: new Date().toISOString(),
      cached: false,
    };
  }

  const key = cacheKey({ method: 'GET', url: `${watchUrlFor(videoId)}#monetization` });

  if (!opts.forceRefresh) {
    try {
      const hit = await readApiCache<CachedShape>(key);
      if (hit !== null) {
        return { videoId, ...hit, cached: true };
      }
    } catch (err) {
      logger.warn('monetization-scrape: cache read failed', {
        videoId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html: string | null = null;
  try {
    const res = await fetch(watchUrlFor(videoId), {
      method: 'GET',
      headers: {
        'User-Agent': FETCH_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('monetization-scrape: non-2xx', { videoId, status: res.status });
      return {
        videoId,
        status: 'unknown',
        reason: `YouTube returned HTTP ${res.status}.`,
        checkedAt: new Date().toISOString(),
        cached: false,
      };
    }
    html = await res.text();
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    logger.warn('monetization-scrape: fetch failed', {
      videoId,
      aborted,
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      videoId,
      status: 'unknown',
      reason: aborted ? 'Request timed out.' : 'Could not reach YouTube.',
      checkedAt: new Date().toISOString(),
      cached: false,
    };
  } finally {
    clearTimeout(timeout);
  }

  const playerResponse = extractPlayerResponseFromHtml(html ?? '');
  const detected = detectMonetizationFromPlayerResponse(playerResponse);
  const shape: CachedShape = {
    status: detected.status,
    reason: detected.reason,
    checkedAt: new Date().toISOString(),
  };

  try {
    await writeApiCache(key, shape);
  } catch (err) {
    logger.warn('monetization-scrape: cache write failed', {
      videoId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return { videoId, ...shape, cached: false };
}
