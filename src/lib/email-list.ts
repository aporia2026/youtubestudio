/**
 * Phase 9.8.3 — single source of truth for email-list parsing.
 *
 * Used by:
 *   - POST /api/insights/preferences (validates the user's input
 *     before persisting)
 *   - The weekly-digest cron (parses the persisted column at
 *     dispatch time, with the workspace owner's email as fallback)
 *
 * Previously these had divergent regexes (the route was strict, the
 * digest was loose `/\S+@\S+\.\S+/`). The route's strict regex
 * already covers what the cron needs; consolidate.
 *
 * The single-address fragment matches a deliberately narrow subset
 * of RFC 5322: unquoted local part with [\w.+-], domain with
 * [\w-]+(\.[\w-]+)+. Strict enough to block CRLF/Bcc injection;
 * lenient enough for the addresses real users actually have.
 *
 * Pure: no DB, no Node deps.
 */

const SINGLE_EMAIL_FRAGMENT = `[\\w.+\\-]+@[\\w-]+(?:\\.[\\w-]+)+`;

/** Validates a comma-separated list. Anchors `^...$`. */
export const EMAIL_LIST_RE = new RegExp(
  `^${SINGLE_EMAIL_FRAGMENT}(?:\\s*,\\s*${SINGLE_EMAIL_FRAGMENT})*$`,
);

/** Validates a single address. Same fragment as the list. */
export const SINGLE_EMAIL_RE = new RegExp(`^${SINGLE_EMAIL_FRAGMENT}$`);

/**
 * Parse a stored `weekly_digest_email_recipients` value into the
 * delivery list. Falls back to the workspace owner's email when the
 * override is empty/null/invalid (which can happen if the column was
 * hand-edited in psql past the route's validation).
 *
 * Returns deduped, lowercase-host-preserved (we don't mangle the
 * local part) addresses. Empty array means "send nothing" — caller
 * should treat as "skip this workspace".
 */
export function parseEmailRecipients(
  raw: string | null,
  fallback: string | null,
): string[] {
  if (raw && raw.trim().length > 0) {
    if (!EMAIL_LIST_RE.test(raw.trim())) {
      // Stored value is malformed (likely a hand-edit). Fall through
      // to the fallback rather than silently producing partial sends.
      return fallback && SINGLE_EMAIL_RE.test(fallback) ? [fallback] : [];
    }
    const out = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => SINGLE_EMAIL_RE.test(s));
    // De-dup defensively — a hand-edited override could have repeats.
    return [...new Set(out)];
  }
  return fallback && SINGLE_EMAIL_RE.test(fallback) ? [fallback] : [];
}
