/**
 * YouTube Suggest (autocomplete) fetcher.
 *
 * Undocumented public endpoint at suggestqueries.google.com — free,
 * no auth, no quota cap, but fragile. Per the plan we treat it as a
 * "fragile public endpoint" with explicit fallback semantics: every
 * function in this module returns either a populated array or an
 * empty one, never throwing on transient network failure. Callers
 * gracefully degrade.
 *
 * Server-only — the endpoint doesn't return CORS headers for browser
 * direct calls.
 *
 * Caches each `(term, hl)` pair for 7 days via
 * niche_finder_api_cache.
 */
import { cacheKey, readApiCache, writeApiCache } from './db';
import { logger } from '@/lib/logger';

/** Endpoint base. Documented in council-pass sources. */
const SUGGEST_BASE = 'https://suggestqueries.google.com/complete/search';

/** Cap on the number of suggestions we return per (term, hl). The
 *  endpoint typically returns 10; we never want more than that. */
const SUGGESTION_CAP = 10;

/** Minimum gap between sequential calls to Suggest in milliseconds.
 *  Google's endpoint has no published rate limit; we self-throttle
 *  to be polite and to avoid getting flagged. */
const PER_CALL_GAP_MS = 350;

let lastCallAt = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastCallAt + PER_CALL_GAP_MS - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCallAt = Date.now();
}

/**
 * Parse the Suggest response into a simple string array.
 *
 * The endpoint returns a tuple shaped like
 *   ["originalQuery", [["suggestion1"], ["suggestion2"], ...], ...]
 * but in practice the suggestion items are sometimes plain strings,
 * sometimes one-element arrays of strings, sometimes objects with a
 * "0" key. This parser tolerates all three shapes and silently
 * drops malformed entries.
 *
 * Exported for unit testing — the regex-and-shape logic has bitten
 * us before.
 */
export function parseSuggestResponse(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const suggestionsBlock = raw[1];
  if (!Array.isArray(suggestionsBlock)) return [];
  const out: string[] = [];
  for (const item of suggestionsBlock) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push(item);
    } else if (Array.isArray(item) && typeof item[0] === 'string' && item[0].length > 0) {
      out.push(item[0]);
    } else if (item && typeof item === 'object' && typeof (item as { 0?: unknown })[0] === 'string') {
      const s = (item as { 0: string })[0];
      if (s.length > 0) out.push(s);
    }
  }
  // De-dupe while preserving order and cap.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of out) {
    const norm = s.trim();
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(norm);
    if (deduped.length >= SUGGESTION_CAP) break;
  }
  return deduped;
}

/** Build the Suggest URL for a (term, hl) pair. Exported for tests. */
export function suggestUrl(term: string, hl: string): string {
  const params = new URLSearchParams({
    client: 'youtube',
    ds: 'yt',
    q: term,
    hl,
  });
  return `${SUGGEST_BASE}?${params.toString()}`;
}

/**
 * Fetch suggestions for one term + locale. Returns an empty array on
 * any failure (network, parse, non-2xx). Caches both the success and
 * the empty-array result for 7 days so we don't hammer the endpoint
 * if it's degraded.
 *
 * `nowDateMs` is injected for tests; defaults to Date.now().
 */
export async function fetchSuggestions(
  term: string,
  hl: string = 'en',
): Promise<string[]> {
  const trimmed = term.trim();
  if (trimmed.length === 0) return [];

  const url = suggestUrl(trimmed, hl);
  const key = cacheKey({ method: 'GET', url });

  // Cache read first — quota-free path.
  try {
    const cached = await readApiCache<string[]>(key);
    if (cached !== null) return cached;
  } catch (err) {
    // Cache miss path is identical to "DB momentarily flaky"; log
    // and fall through to a live fetch.
    logger.warn('niche-finder suggest: cache read failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  await throttle();

  let parsed: string[] = [];
  try {
    // The endpoint sometimes returns JSONP-flavoured plain JSON; the
    // YouTube `client=youtube&ds=yt` combo returns clean JSON.
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json,text/javascript,*/*',
        'User-Agent': 'youtubestudio-niche-finder/0.5',
      },
    });
    if (!res.ok) {
      logger.warn('niche-finder suggest: non-2xx', { status: res.status, term: trimmed });
    } else {
      const text = await res.text();
      // Strip any JSONP wrapper (uncommon for client=youtube but
      // belt-and-braces).
      const jsonText = text.replace(/^[^[(]*[([]/, (m) => m.startsWith('(') || m === '[' ? m.endsWith('[') ? '[' : '(' : '[');
      let raw: unknown;
      try {
        raw = JSON.parse(jsonText);
      } catch {
        try {
          raw = JSON.parse(text);
        } catch {
          raw = null;
        }
      }
      parsed = parseSuggestResponse(raw);
    }
  } catch (err) {
    logger.warn('niche-finder suggest: fetch threw', {
      detail: err instanceof Error ? err.message : String(err),
      term: trimmed,
    });
    parsed = [];
  }

  // Cache even the empty array — saves us from re-hammering when
  // the endpoint is down.
  try {
    await writeApiCache(key, parsed);
  } catch (err) {
    logger.warn('niche-finder suggest: cache write failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return parsed;
}

/**
 * Expand a seed term into a deduped list of related terms by running
 * Suggest on the seed plus a short tail of follow-on probes. The
 * probes are letter-suffix queries ("seed a", "seed b", ...) which
 * is the same trick keyword-research tools use to enumerate the
 * Suggest tree without API access.
 *
 * Capped at `cap` total suggestions (default 30); always includes
 * the seed itself at index 0.
 */
export async function expandSeedTerm(
  seed: string,
  hl: string = 'en',
  cap: number = 30,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  function push(term: string): void {
    const norm = term.trim().toLowerCase();
    if (norm.length === 0 || seen.has(norm)) return;
    seen.add(norm);
    out.push(term.trim());
  }

  push(seed);

  // Probe 1: the seed itself.
  for (const s of await fetchSuggestions(seed, hl)) {
    push(s);
    if (out.length >= cap) return out;
  }

  // Probe 2: letter-suffix probes (a few only, to keep the cost low).
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < letters.length && out.length < cap; i++) {
    const probe = `${seed} ${letters[i]}`;
    for (const s of await fetchSuggestions(probe, hl)) {
      push(s);
      if (out.length >= cap) break;
    }
  }

  return out;
}
