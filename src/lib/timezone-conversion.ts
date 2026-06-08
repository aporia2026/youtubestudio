/**
 * Client-safe IANA timezone <-> UTC conversion helpers for the
 * schedule picker in `BatchShortReviewCard`.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * JS Date has no first-class IANA support — `Intl.DateTimeFormat`
 * is the only well-defined way to ask "what does this UTC instant
 * look like in timezone X". We use it as the single source of
 * truth for both directions and reconstruct via component math
 * (avoids the unreliable `new Date(string)` round-trip that
 * different engines parse differently).
 *
 * Surface:
 *   utcIsoToLocalInputValue(utcIso, tz) →
 *     "YYYY-MM-DDTHH:mm" suitable for <input type="datetime-local">
 *   localInputValueToUtcIso(local, tz) →
 *     ISO 8601 UTC string for `youtube_publish_at`
 *
 * Both functions are pure + side-effect-free; the unit tests
 * (`tests/timezone-conversion.test.ts`) lock the DST edges.
 */

/** Pad a number to 2-digit. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a UTC ISO timestamp as a "YYYY-MM-DDTHH:mm" string in the
 * given IANA timezone — the exact shape <input type="datetime-local">
 * accepts.
 */
export function utcIsoToLocalInputValue(utcIso: string, timezone: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    // Intl outputs hour=24 for midnight in some engines; normalise.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  } catch {
    return '';
  }
}

/**
 * Convert a "YYYY-MM-DDTHH:mm" local-time string (interpreted in
 * the given IANA timezone) to an ISO 8601 UTC string.
 *
 * Algorithm: build a naive UTC millisecond from the components,
 * then ask the timezone what those components look like when
 * formatted from that instant, and apply the resulting offset.
 * One round-trip is enough because the offset is constant between
 * two instants in the same year except across DST boundaries —
 * and the second iteration would only matter if the boundary
 * falls EXACTLY at the user's chosen time (in which case YouTube's
 * publishAt isn't well-defined either; the API picks one side
 * deterministically).
 */
export function localInputValueToUtcIso(local: string, timezone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`Invalid local datetime string: "${local}" (expected YYYY-MM-DDTHH:mm)`);
  const [, yStr, moStr, dStr, hStr, miStr] = match;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const mi = Number(miStr);

  // The naive UTC instant of the supplied components (i.e. treat
  // the local-string as if it were already UTC).
  const naiveUtcMs = Date.UTC(y, mo - 1, d, h, mi);

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  /** Format `utcMs` in `timezone` and re-pack the components as if
   *  they were a UTC timestamp. The difference `F(x) - x` equals the
   *  zone's offset (positive east of UTC). */
  const formatAsUtc = (utcMs: number): number => {
    const parts = fmt.formatToParts(new Date(utcMs));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    const hr = g('hour') === 24 ? 0 : g('hour');
    return Date.UTC(g('year'), g('month') - 1, g('day'), hr, g('minute'));
  };

  // Two iterations of the fixed-point `utcMs = naive - tzOffset(utcMs)`.
  // One iteration suffices for constant-offset zones; two iterations
  // also resolves DST boundaries (spring-forward + fall-back picks the
  // post-DST interpretation when the local time exists twice). The
  // ambiguity for non-existent / doubly-existent local times is
  // unavoidable — both interpretations are valid; we pick one
  // deterministically.
  let utcMs = naiveUtcMs;
  for (let i = 0; i < 2; i++) {
    const offset = formatAsUtc(utcMs) - utcMs;
    utcMs = naiveUtcMs - offset;
  }
  return new Date(utcMs).toISOString();
}

/** Best-effort detection of the browser's IANA timezone. Server
 *  callers should default to UTC instead since `Intl` on the server
 *  reflects the server's locale, which is rarely the user's. */
export function detectBrowserTimezone(): string {
  if (typeof Intl !== 'undefined') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      /* fall through */
    }
  }
  return 'UTC';
}

/** Re-export for tests so the YYYY-MM-DDTHH:mm format check is
 *  available as a public helper. */
export function formatLocalDate(y: number, mo: number, d: number, h: number, mi: number): string {
  return `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}`;
}
