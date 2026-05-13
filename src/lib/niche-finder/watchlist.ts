/**
 * Niche watchlist data layer + pure helpers for the weekly cron.
 *
 * The watchlist is a simple `(workspace_id, niche_slug)` keyed
 * table; the value is a 26-entry JSONB array of weekly snapshots.
 * Each snapshot captures the niche's combined score + plain-English
 * dimension labels at the moment of capture, so the UI can render
 * sparklines without re-running scoring math at read time.
 *
 * The score-spike detector (`detectScoreSpike`) is the pure math
 * that decides whether to fire a `niche_score_spike` workflow event.
 * It compares the latest two snapshots and returns the delta + a
 * boolean threshold flag. No I/O — easy to unit-test.
 */
import { sql } from '@vercel/postgres';
import { randomUUID } from 'node:crypto';
import type { NicheScores } from './types';
import type { BrowseFilters } from './browse-filters';

/** Per-week snapshot stored inside `niche_watchlist.weekly_history`. */
export interface WatchlistSnapshot {
  captured_at: string;
  combined: number;
  demand_label: string;
  supply_label: string;
  monetization_label: string;
  monetization_low_usd: number;
  monetization_high_usd: number;
  fit_label: string;
}

/** Kind of row in `niche_watchlist`:
 *  - `'niche'` (default) — saved niche with weekly re-scoring history.
 *  - `'search'` — saved Browse-Categories filter spec, replayable
 *    against currently-cached taxonomy scores.
 */
export type WatchlistRowKind = 'niche' | 'search';

export interface NicheWatchlistRow {
  workspace_id: string;
  niche_slug: string;
  niche_name: string;
  weekly_history: WatchlistSnapshot[];
  alarm_threshold: number | null;
  created_at: string;
  last_rescored_at: string | null;
  /** Optional — present from migration 0062 onward. Defaults to 'niche'
   *  on rows that pre-date the migration. */
  kind?: WatchlistRowKind;
  /** Saved-search filter spec — null on niche rows. */
  search_spec?: BrowseFilters | null;
  /** User-supplied label for the saved search — null on niche rows. */
  search_label?: string | null;
  /** Count of matches the last time the search was run. */
  last_match_count?: number | null;
}

/** Synthetic slug prefix for saved-search rows (so the table's existing
 *  PK `(workspace_id, niche_slug)` keeps doing its job without a real
 *  niche slug). Search slugs are NOT exposed in URLs — the watchlist UI
 *  treats them as opaque ids. */
export const SAVED_SEARCH_SLUG_PREFIX = 'search-';

/** Generate a fresh slug for a new saved search. The trailing UUID
 *  segment is collision-proof in practice; the prefix makes the column
 *  self-documenting if anyone reads the raw table. */
export function newSavedSearchSlug(): string {
  return `${SAVED_SEARCH_SLUG_PREFIX}${randomUUID()}`;
}

export function isSavedSearchSlug(slug: string): boolean {
  return slug.startsWith(SAVED_SEARCH_SLUG_PREFIX);
}

/** Cap on history length per row. 26 weeks = 6 months — enough for
 *  the sparkline to show meaningful trajectory without bloating the
 *  row. The cron trims on every write. */
export const HISTORY_MAX = 26;

/** Default alarm threshold for newly-saved niches (10% delta in
 *  combined score across two consecutive snapshots). */
export const DEFAULT_ALARM_THRESHOLD = 0.1;

/** Add a niche to the workspace's watchlist. Idempotent — re-saving
 *  the same slug is a no-op (preserves history). Optionally seeds
 *  the initial history with the niche's current scores so the
 *  sparkline has at least one point on day one. */
export async function addToWatchlist(args: {
  workspaceId: string;
  nicheSlug: string;
  nicheName: string;
  initialSnapshot?: WatchlistSnapshot;
}): Promise<NicheWatchlistRow> {
  const initialHistory: WatchlistSnapshot[] = args.initialSnapshot ? [args.initialSnapshot] : [];
  const { rows } = await sql<NicheWatchlistRow>`
    INSERT INTO niche_watchlist (
      workspace_id, niche_slug, niche_name, weekly_history,
      alarm_threshold, last_rescored_at
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.nicheSlug},
      ${args.nicheName},
      ${JSON.stringify(initialHistory)}::jsonb,
      ${DEFAULT_ALARM_THRESHOLD},
      ${args.initialSnapshot ? args.initialSnapshot.captured_at : null}
    )
    ON CONFLICT (workspace_id, niche_slug) DO UPDATE SET
      niche_name = EXCLUDED.niche_name
    RETURNING workspace_id::text, niche_slug, niche_name,
      weekly_history, alarm_threshold, created_at, last_rescored_at
  `;
  return rows[0];
}

/** Remove a niche. Returns true when a row was deleted. */
export async function removeFromWatchlist(workspaceId: string, nicheSlug: string): Promise<boolean> {
  const { rowCount } = await sql`
    DELETE FROM niche_watchlist
    WHERE workspace_id = ${workspaceId}::uuid AND niche_slug = ${nicheSlug}
  `;
  return (rowCount ?? 0) > 0;
}

/** List the workspace's watched niches, newest-first. Filters out
 *  saved-search rows so the watchlist page and cron stay free of
 *  filter-spec entries. */
export async function listWatchlist(workspaceId: string): Promise<NicheWatchlistRow[]> {
  const { rows } = await sql<NicheWatchlistRow>`
    SELECT workspace_id::text, niche_slug, niche_name,
      weekly_history, alarm_threshold, created_at, last_rescored_at,
      kind, search_spec, search_label, last_match_count
    FROM niche_watchlist
    WHERE workspace_id = ${workspaceId}::uuid
      AND kind = 'niche'
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows;
}

/** Get a single watchlist row by slug. Works for both kinds — callers
 *  that need to distinguish should branch on `.kind`. */
export async function getWatchlistEntry(
  workspaceId: string,
  nicheSlug: string,
): Promise<NicheWatchlistRow | null> {
  const { rows } = await sql<NicheWatchlistRow>`
    SELECT workspace_id::text, niche_slug, niche_name,
      weekly_history, alarm_threshold, created_at, last_rescored_at,
      kind, search_spec, search_label, last_match_count
    FROM niche_watchlist
    WHERE workspace_id = ${workspaceId}::uuid AND niche_slug = ${nicheSlug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** All niche rows across all workspaces — used by the weekly re-score
 *  cron. Saved-search rows are excluded; they don't get re-scored. */
export async function listAllWatchlistRows(): Promise<NicheWatchlistRow[]> {
  const { rows } = await sql<NicheWatchlistRow>`
    SELECT workspace_id::text, niche_slug, niche_name,
      weekly_history, alarm_threshold, created_at, last_rescored_at,
      kind, search_spec, search_label, last_match_count
    FROM niche_watchlist
    WHERE kind = 'niche'
    ORDER BY workspace_id, niche_slug
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Saved-search CRUD (migration 0062+)
// ---------------------------------------------------------------------------

export interface SavedSearchRow {
  workspace_id: string;
  niche_slug: string; // synthetic 'search-<uuid>' — opaque to the UI
  search_label: string;
  search_spec: BrowseFilters;
  last_match_count: number | null;
  last_rescored_at: string | null; // re-used as "last run at"
  created_at: string;
}

/** Insert a new saved-search row. Generates a fresh synthetic slug.
 *  The `niche_name` column is set to the search label so existing
 *  text-only watchlist queries still return something readable. */
export async function addSavedSearch(args: {
  workspaceId: string;
  label: string;
  spec: BrowseFilters;
}): Promise<SavedSearchRow> {
  const slug = newSavedSearchSlug();
  const label = args.label.trim().slice(0, 80) || 'Untitled search';
  const { rows } = await sql<SavedSearchRow>`
    INSERT INTO niche_watchlist (
      workspace_id, niche_slug, niche_name, weekly_history,
      alarm_threshold, kind, search_spec, search_label, last_match_count
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${slug},
      ${label},
      '[]'::jsonb,
      NULL,
      'search',
      ${JSON.stringify(args.spec)}::jsonb,
      ${label},
      NULL
    )
    RETURNING workspace_id::text, niche_slug, search_label, search_spec,
      last_match_count, last_rescored_at, created_at
  `;
  return rows[0];
}

/** List all saved searches for a workspace, newest-first. Capped at 50
 *  to stop a runaway client from bloating the list. */
export async function listSavedSearches(workspaceId: string): Promise<SavedSearchRow[]> {
  const { rows } = await sql<SavedSearchRow>`
    SELECT workspace_id::text, niche_slug, search_label, search_spec,
      last_match_count, last_rescored_at, created_at
    FROM niche_watchlist
    WHERE workspace_id = ${workspaceId}::uuid
      AND kind = 'search'
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows;
}

/** Delete a saved search. Returns true when a row was removed.
 *  Cross-workspace ids return false (not 403) to avoid existence
 *  leaks, mirroring the existing preset-delete pattern. */
export async function removeSavedSearch(
  workspaceId: string,
  searchSlug: string,
): Promise<boolean> {
  if (!isSavedSearchSlug(searchSlug)) return false;
  const { rowCount } = await sql`
    DELETE FROM niche_watchlist
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug = ${searchSlug}
      AND kind = 'search'
  `;
  return (rowCount ?? 0) > 0;
}

/** Update the cached "last match count" + "last run at" for a saved
 *  search. Called whenever the user re-runs the search so the
 *  watchlist page can show fresh numbers without re-running on render. */
export async function updateSavedSearchRunStamp(args: {
  workspaceId: string;
  searchSlug: string;
  matchCount: number;
}): Promise<void> {
  if (!isSavedSearchSlug(args.searchSlug)) return;
  await sql`
    UPDATE niche_watchlist
    SET last_match_count = ${args.matchCount},
        last_rescored_at = NOW()
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND niche_slug = ${args.searchSlug}
      AND kind = 'search'
  `;
}

/** Append a snapshot, trim to HISTORY_MAX, update last_rescored_at. */
export async function appendSnapshot(args: {
  workspaceId: string;
  nicheSlug: string;
  snapshot: WatchlistSnapshot;
  nicheName?: string;
}): Promise<NicheWatchlistRow | null> {
  const existing = await getWatchlistEntry(args.workspaceId, args.nicheSlug);
  if (!existing) return null;
  const next = trimHistory([...existing.weekly_history, args.snapshot]);
  const { rows } = await sql<NicheWatchlistRow>`
    UPDATE niche_watchlist
    SET weekly_history = ${JSON.stringify(next)}::jsonb,
        last_rescored_at = ${args.snapshot.captured_at},
        niche_name = ${args.nicheName ?? existing.niche_name}
    WHERE workspace_id = ${args.workspaceId}::uuid AND niche_slug = ${args.nicheSlug}
    RETURNING workspace_id::text, niche_slug, niche_name,
      weekly_history, alarm_threshold, created_at, last_rescored_at
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Trim the array to HISTORY_MAX, keeping the newest entries. */
export function trimHistory(history: readonly WatchlistSnapshot[]): WatchlistSnapshot[] {
  if (history.length <= HISTORY_MAX) return history.slice();
  return history.slice(history.length - HISTORY_MAX);
}

/** Build a snapshot from a NicheScores object + capture time. */
export function snapshotFromScores(scores: NicheScores, capturedAt: string): WatchlistSnapshot {
  return {
    captured_at: capturedAt,
    combined: Number(scores.combined.toFixed(4)),
    demand_label: scores.demand.label,
    supply_label: scores.supply.label,
    monetization_label: scores.monetization.label,
    monetization_low_usd: scores.monetization.lowUsdPerMille,
    monetization_high_usd: scores.monetization.highUsdPerMille,
    fit_label: scores.fit.label,
  };
}

export interface ScoreSpikeResult {
  /** Delta in combined score between the latest two snapshots.
   *  Positive = niche heating up; negative = cooling. */
  delta: number;
  /** True when |delta| meets or exceeds threshold AND there are at
   *  least two snapshots to compare. */
  spike: boolean;
  /** Direction of the move when `spike` is true. */
  direction: 'up' | 'down' | null;
  /** Captured-at of the snapshot that triggered the spike. NULL
   *  when no spike. */
  trigger_captured_at: string | null;
}

/** Detect a score-spike between the last two snapshots. Pure
 *  function — exported for tests.
 *
 *  Returns `{ delta: 0, spike: false, direction: null,
 *  trigger_captured_at: null }` when the history is shorter than 2
 *  or the threshold is NULL. */
export function detectScoreSpike(
  history: readonly WatchlistSnapshot[],
  threshold: number | null,
): ScoreSpikeResult {
  if (history.length < 2 || threshold === null || !Number.isFinite(threshold) || threshold <= 0) {
    return { delta: 0, spike: false, direction: null, trigger_captured_at: null };
  }
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const delta = Number((last.combined - prev.combined).toFixed(4));
  const spike = Math.abs(delta) >= threshold;
  return {
    delta,
    spike,
    direction: spike ? (delta >= 0 ? 'up' : 'down') : null,
    trigger_captured_at: spike ? last.captured_at : null,
  };
}
