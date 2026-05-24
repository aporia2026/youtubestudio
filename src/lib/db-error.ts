/**
 * Postgres error classification + safe extraction of `pg` driver
 * fields for diagnostic logging.
 *
 * Why this exists:
 *   When a row-asset write (or any other DB call) returns 500, the
 *   client toast is generic ("Server error while saving — try again,
 *   or refresh") and the server log just records the bare error
 *   message. That's enough to know SOMETHING broke; it's not enough
 *   to know WHAT, and a user keeps hitting the same kind of error
 *   without any way to diagnose. This module pulls the PG-specific
 *   fields off the underlying `pg` driver error (`@vercel/postgres`
 *   wraps it but doesn't strip them) and classifies the error into
 *   a coarse `failureClass` the client can show as actionable text.
 *
 * What we DON'T expose to the client:
 *   - `detail` / `hint` / `where` / `column` / `constraint` may carry
 *     schema fingerprints. They go in the server log only.
 *   - PG error `code` strings are public knowledge but still wrapped
 *     in the coarse `failureClass` so the client doesn't render raw
 *     codes at the user.
 *
 * Scope: this module is intentionally tiny and DB-driver-agnostic on
 * the surface — `classifyDbError(err)` accepts `unknown` and never
 * throws, so callers can drop it into any catch block without
 * worrying about typing.
 */

/** Coarse error category that's safe to surface to the client + use
 *  for branching toast copy. The mapping from PG codes is in
 *  `classifyDbError` below; unrecognised codes fall back to
 *  `'unknown'`. */
export type DbFailureClass =
  | 'schema_missing'       // 42P01 / 42P02 / 42703 — table/column not in schema (migration not run)
  | 'concurrent_update'    // 40001 / 40P01 — serialization failure or deadlock
  | 'connection'           // 08xxx / 57P0x / 53300 — pool / socket / shutdown / too-many-conns
  | 'constraint'           // 23xxx — unique / FK / not-null / check violation
  | 'data_invalid'         // 22xxx — bad value (string-out-of-range, invalid bytea, etc.)
  | 'permission'           // 42501 / 28xxx — insufficient privilege / invalid auth
  | 'syntax'               // 42601 — query syntax error (code bug)
  | 'timeout'              // 57014 — statement_timeout / query_canceled
  | 'unknown';

/** Server-side log payload. The `pg_*` fields are populated when the
 *  error came from the PG driver; missing when the error was
 *  thrown by JS (network, abort, JSON parse, etc.) — caller can tell
 *  the two apart by checking whether `pg_code` is undefined. */
export interface ClassifiedDbError {
  /** Coarse category for the client + branching server logic. */
  failureClass: DbFailureClass;
  /** Plain-English summary suitable for the server log. Never sent
   *  to the client (may include schema fingerprint). */
  serverMessage: string;
  /** Raw PG error fields when present. All optional — undefined when
   *  the error didn't come from the driver. */
  pg_code?: string;
  pg_detail?: string;
  pg_hint?: string;
  pg_severity?: string;
  pg_table?: string;
  pg_column?: string;
  pg_constraint?: string;
  /** Original error message — always populated, falls back to
   *  `String(err)` when err isn't an Error instance. */
  raw_message: string;
}

/**
 * Classify any thrown value into a `ClassifiedDbError`. Never
 * throws; safe to call from any catch block.
 */
export function classifyDbError(err: unknown): ClassifiedDbError {
  const raw_message = err instanceof Error ? err.message : String(err);

  // Pull pg fields off the error if present. They're not on the
  // Error prototype — defensive duck-typing so we don't depend on
  // the pg driver's exact class shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const pg_code = typeof e?.code === 'string' ? e.code : undefined;
  const pg_detail = typeof e?.detail === 'string' ? e.detail : undefined;
  const pg_hint = typeof e?.hint === 'string' ? e.hint : undefined;
  const pg_severity = typeof e?.severity === 'string' ? e.severity : undefined;
  const pg_table = typeof e?.table === 'string' ? e.table : undefined;
  const pg_column = typeof e?.column === 'string' ? e.column : undefined;
  const pg_constraint = typeof e?.constraint === 'string' ? e.constraint : undefined;

  const failureClass = classifyByCode(pg_code, raw_message);
  const serverMessage = buildServerMessage(failureClass, raw_message, {
    pg_code,
    pg_table,
    pg_constraint,
  });

  return {
    failureClass,
    serverMessage,
    pg_code,
    pg_detail,
    pg_hint,
    pg_severity,
    pg_table,
    pg_column,
    pg_constraint,
    raw_message,
  };
}

/** Map a PG SQLSTATE code to our coarse category. SQLSTATEs are
 *  organised by class (first 2 chars) — e.g. class 23 is integrity
 *  constraint violation. We classify on the class when the specific
 *  code isn't itself meaningful enough. Fallback to message-pattern
 *  matching when there's no PG code (the error wasn't from the
 *  driver — could be a fetch failure, JSON parse, abort, etc.). */
function classifyByCode(pg_code: string | undefined, message: string): DbFailureClass {
  if (pg_code) {
    // Specific codes first
    if (pg_code === '42P01' || pg_code === '42P02' || pg_code === '42703') return 'schema_missing';
    if (pg_code === '40001' || pg_code === '40P01') return 'concurrent_update';
    if (pg_code === '57014') return 'timeout';
    if (pg_code === '42601') return 'syntax';
    if (pg_code === '42501') return 'permission';
    // Class-level fallbacks
    const cls = pg_code.slice(0, 2);
    if (cls === '08' || pg_code === '53300' || pg_code === '57P01' || pg_code === '57P02' || pg_code === '57P03') return 'connection';
    if (cls === '23') return 'constraint';
    if (cls === '22') return 'data_invalid';
    if (cls === '28') return 'permission';
    if (cls === '53') return 'connection'; // resource issues — out of memory, too many conns
  }
  // No PG code — pattern-match the message. Network and
  // connection-pool errors from the pg driver sometimes arrive
  // without a SQLSTATE (e.g. socket closed mid-query).
  const lower = message.toLowerCase();
  if (lower.includes('connection') && (lower.includes('terminated') || lower.includes('closed') || lower.includes('refused') || lower.includes('reset') || lower.includes('timeout'))) {
    return 'connection';
  }
  if (lower.includes('econnreset') || lower.includes('etimedout') || lower.includes('econnrefused')) {
    return 'connection';
  }
  if (lower.includes('fetch failed') || lower.includes('network')) {
    return 'connection';
  }
  return 'unknown';
}

function buildServerMessage(
  failureClass: DbFailureClass,
  raw_message: string,
  ctx: { pg_code?: string; pg_table?: string; pg_constraint?: string },
): string {
  const codePart = ctx.pg_code ? ` (PG ${ctx.pg_code})` : '';
  const tablePart = ctx.pg_table ? ` table=${ctx.pg_table}` : '';
  const constraintPart = ctx.pg_constraint ? ` constraint=${ctx.pg_constraint}` : '';
  return `[${failureClass}]${codePart}${tablePart}${constraintPart} ${raw_message}`;
}

/** Client-safe sentence for each failure class. Used by the
 *  row-asset route response so the editor's toast can show
 *  actionable text instead of a generic "server error". */
export const FAILURE_CLASS_USER_MESSAGES: Record<DbFailureClass, string> = {
  schema_missing: 'Database schema is out of date — admin needs to deploy the latest migration.',
  concurrent_update: 'Another change landed at the same time. Refresh and try again.',
  connection: 'Database connection blip. The next attempt will likely succeed.',
  constraint: 'Save rejected by a data integrity check. See the support log for details.',
  data_invalid: 'The value didn’t pass server-side validation.',
  permission: 'Server denied access to that row. Sign out and back in, then retry.',
  syntax: 'Server query is malformed — this is a bug, please report it.',
  timeout: 'Database statement timed out. Try again in a moment.',
  unknown: 'Server error while saving.',
};
