/**
 * Shared types for the server-synced generator history.
 *
 * Lives in a dedicated file (with NO server-only imports) so both the
 * server lib `src/lib/user-history.ts` AND the client lib
 * `src/lib/history.ts` can import the canonical kind enum without
 * dragging `@vercel/postgres` into the browser bundle.
 *
 * Adding a new history kind means:
 *   1. Add the literal to `HISTORY_KINDS` here.
 *   2. Add a `MAX_*_ENTRIES` cap to `KIND_CAPS` in `user-history.ts`.
 *   3. Add a typed `*HistoryEntry` interface + wiring constant in
 *      `history.ts`.
 *   4. Add a panel page that consumes the new kind.
 */

export const HISTORY_KINDS = [
  'script',
  'ideas',
  'voiceover',
  'seo',
  'thumbnail',
  'qa',
  'production_doc',
  // Shorts-specific kinds. `shorts_ideas` is the hook-first idea batch
  // produced by ShortNativeIdeasSurface (Phase 15.2 + 15.8). Lives next
  // to long-form `ideas` so the history panel reads + writes go through
  // the same code path the other six panels use.
  'shorts_ideas',
] as const;

export type HistoryKind = typeof HISTORY_KINDS[number];

export function isHistoryKind(value: unknown): value is HistoryKind {
  return typeof value === 'string' && (HISTORY_KINDS as readonly string[]).includes(value);
}

/**
 * RFC 4122 UUID shape check. Used by the routes to reject ids that
 * couldn't possibly correspond to a server row before the SQL runs —
 * a non-UUID string against a Postgres UUID column would raise
 * `invalid input syntax for type uuid` and surface as a 500 instead
 * of the deliberate 404 the routes use for cross-scope safety.
 *
 * Accepts version 1-5 + the nil UUID. Case-insensitive.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^00000000-0000-0000-0000-000000000000$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}
