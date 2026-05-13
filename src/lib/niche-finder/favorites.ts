/**
 * Niche-finder favorites data layer.
 *
 * Editorial collection of niches the operator is considering for
 * production. Deliberately separate from `niche_watchlist` (which is a
 * monitoring primitive) — the same niche can be both watchlisted AND
 * favorited.
 *
 * Three tables, all workspace-scoped, user-stamped, with a soft-delete
 * window on the parent table (30 days; cron purges in PR3). See
 * `0063_create_niche_favorites.ts` for the schema rationale.
 *
 * This module is the v1 surface — PR2 will add brief CRUD on top of
 * `niche_favorite_briefs`. The brief table is created in PR1 so the
 * v2 path is a code-only change.
 */
import { sql } from '@vercel/postgres';
import type { NicheScores } from './types';

// ---------------------------------------------------------------------------
// Type unions — match the CHECK constraints in 0063.
// ---------------------------------------------------------------------------

/** Which tab the operator was on when they favorited. Drives the
 *  hybrid niche-assignment heuristic (auto-attach when context is
 *  unambiguous) AND eventually UX analytics. */
export type FavoriteSourceTab =
  | 'type'
  | 'interests'
  | 'channel'
  | 'category'
  | 'outliers'
  | 'manual';

/** Editorial pipeline state. Operator-controlled via dropdown.
 *  Default 'considering' on insert. */
export type FavoriteStatus = 'considering' | 'committed' | 'parked' | 'passed';

/** Operator's reaction to the AI brief. Optional — null until the
 *  operator clicks accept/override/reject. */
export type FavoriteVerdict = 'accept' | 'override' | 'reject';

/** Production outcome. Captured once the operator decides what
 *  actually happened. Null until set. */
export type FavoriteOutcome = 'producing' | 'produced' | 'parked' | 'killed';

/** Outlier classification mirrored from `OutlierVideo.classification`. */
export type VideoClassification = 'underperformer' | 'normal' | 'breakout' | 'viral';

// ---------------------------------------------------------------------------
// Row interfaces.
// ---------------------------------------------------------------------------

export interface NicheFavoriteRow {
  workspace_id: string;
  niche_slug: string;
  niche_name: string;
  source_tab: FavoriteSourceTab;
  scores: NicheScores;
  notes: string | null;
  status: FavoriteStatus;
  verdict: FavoriteVerdict | null;
  verdict_reason: string | null;
  outcome: FavoriteOutcome | null;
  outcome_video_id: string | null;
  outcome_reason: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface NicheFavoriteVideoRow {
  id: string;
  workspace_id: string;
  niche_slug: string;
  video_id: string;
  channel_id: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number | null;
  published_at: string | null;
  outlier_score: number | null;
  classification: VideoClassification | null;
  duration_iso: string | null;
  channel_title: string | null;
  subscriber_count: number | null;
  is_removed_upstream: boolean;
  last_validated_at: string | null;
  added_at: string;
  added_by_user_id: string | null;
}

/** A favorite + its proof videos, in a single fetch. Returned by
 *  `listFavoritesWithVideos` so the Favorites tab can render without
 *  N+1 round trips. */
export interface NicheFavoriteWithVideos extends NicheFavoriteRow {
  videos: NicheFavoriteVideoRow[];
}

// ---------------------------------------------------------------------------
// Validation primitives.
// ---------------------------------------------------------------------------

/** Cap notes at 4 KB so the UI's autosave never paints a write-amp
 *  surprise on the DB. */
export const NOTES_MAX_LENGTH = 4000;

/** Placeholder scores used when a favorite niche is created from a
 *  context that lacks real deep-dive scores (e.g. the operator hits
 *  "Save under a new niche" from a video, or the Outliers tab where
 *  the searched-niche text has no scoring data yet). Every dimension
 *  is the lowest valid label so the Favorites tab can render a "—"
 *  hint and the operator knows scores are pending. A subsequent
 *  deep-dive overwrites this snapshot. */
export const PLACEHOLDER_NICHE_SCORES: NicheScores = {
  combined: 0,
  demand: {
    numeric: 0,
    label: 'low',
    confidence: 'rough guess',
    evidence: {},
  },
  supply: {
    numeric: 0,
    label: 'saturated',
    confidence: 'rough guess',
    evidence: {},
  },
  monetization: {
    numeric: 0,
    label: 'low',
    confidence: 'rough guess',
    evidence: {},
    lowUsdPerMille: 0,
    highUsdPerMille: 0,
  },
  fit: {
    numeric: 0,
    label: 'could work',
    confidence: 'rough guess',
    evidence: {},
  },
};

/** True iff the scores snapshot is the placeholder (i.e. no real
 *  deep-dive has run for this favorite yet). Lets the UI render a
 *  "Run deep-dive to populate scores" affordance. */
export function isPlaceholderScores(s: NicheScores): boolean {
  return (
    s.combined === 0 &&
    s.demand.confidence === 'rough guess' &&
    s.supply.label === 'saturated' &&
    s.monetization.lowUsdPerMille === 0 &&
    s.monetization.highUsdPerMille === 0
  );
}

/** Cap verdict / outcome reasons at 1 KB — short rationale, not an essay. */
export const REASON_MAX_LENGTH = 1000;

const VALID_SOURCE_TABS: readonly FavoriteSourceTab[] = [
  'type', 'interests', 'channel', 'category', 'outliers', 'manual',
];
const VALID_STATUSES: readonly FavoriteStatus[] = ['considering', 'committed', 'parked', 'passed'];
const VALID_VERDICTS: readonly FavoriteVerdict[] = ['accept', 'override', 'reject'];
const VALID_OUTCOMES: readonly FavoriteOutcome[] = ['producing', 'produced', 'parked', 'killed'];

export function isValidSourceTab(v: unknown): v is FavoriteSourceTab {
  return typeof v === 'string' && (VALID_SOURCE_TABS as readonly string[]).includes(v);
}
export function isValidStatus(v: unknown): v is FavoriteStatus {
  return typeof v === 'string' && (VALID_STATUSES as readonly string[]).includes(v);
}
export function isValidVerdict(v: unknown): v is FavoriteVerdict {
  return typeof v === 'string' && (VALID_VERDICTS as readonly string[]).includes(v);
}
export function isValidOutcome(v: unknown): v is FavoriteOutcome {
  return typeof v === 'string' && (VALID_OUTCOMES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Niche-favorite CRUD.
// ---------------------------------------------------------------------------

/** Add a niche to the workspace's favorites. Idempotent — re-favoriting
 *  the same slug refreshes the score snapshot + name + source_tab and
 *  un-soft-deletes if it was in the 30-day restore bin. Preserves
 *  `notes`, `status`, `verdict`, `outcome` if already set so a
 *  re-favorite from a different tab doesn't wipe operator state. */
export async function addNicheFavorite(args: {
  workspaceId: string;
  userId: string;
  nicheSlug: string;
  nicheName: string;
  sourceTab: FavoriteSourceTab;
  scores: NicheScores;
}): Promise<NicheFavoriteRow> {
  const { rows } = await sql<NicheFavoriteRow>`
    INSERT INTO niche_favorites (
      workspace_id, niche_slug, niche_name, source_tab, scores,
      created_by_user_id, status
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.nicheSlug},
      ${args.nicheName},
      ${args.sourceTab},
      ${JSON.stringify(args.scores)}::jsonb,
      ${args.userId}::uuid,
      'considering'
    )
    ON CONFLICT (workspace_id, niche_slug) DO UPDATE SET
      niche_name   = EXCLUDED.niche_name,
      source_tab   = EXCLUDED.source_tab,
      scores       = EXCLUDED.scores,
      deleted_at   = NULL,
      updated_at   = NOW()
    RETURNING
      workspace_id::text, niche_slug, niche_name, source_tab, scores,
      notes, status, verdict, verdict_reason, outcome, outcome_video_id,
      outcome_reason, created_by_user_id::text, created_at, updated_at,
      deleted_at
  `;
  return rows[0];
}

/** Soft-delete: sets `deleted_at = NOW()`. Returns true when a row
 *  was actually touched (workspace + slug existed and was not
 *  already deleted). */
export async function softDeleteFavorite(
  workspaceId: string,
  nicheSlug: string,
): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE niche_favorites
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
      AND deleted_at IS NULL
  `;
  return (rowCount ?? 0) > 0;
}

/** Restore a soft-deleted favorite. Returns true when restored. */
export async function restoreFavorite(
  workspaceId: string,
  nicheSlug: string,
): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE niche_favorites
    SET deleted_at = NULL, updated_at = NOW()
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
      AND deleted_at IS NOT NULL
  `;
  return (rowCount ?? 0) > 0;
}

/** Hard-purge soft-deleted rows older than 30 days. Called by the
 *  cleanup cron (PR3). Returns the number of rows purged so the cron
 *  can log it. */
export async function purgeExpiredFavorites(): Promise<number> {
  const { rowCount } = await sql`
    DELETE FROM niche_favorites
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '30 days'
  `;
  return rowCount ?? 0;
}

/** Live favorites for the Favorites tab. Excludes soft-deleted rows.
 *  Newest-first by default; the UI applies its own sort on top. Cap
 *  at 200 to stop a runaway client from bloating the response. */
export async function listFavorites(
  workspaceId: string,
  opts: { status?: FavoriteStatus } = {},
): Promise<NicheFavoriteRow[]> {
  if (opts.status !== undefined && !isValidStatus(opts.status)) {
    throw new Error(`Invalid status filter: ${String(opts.status)}`);
  }
  if (opts.status) {
    const { rows } = await sql<NicheFavoriteRow>`
      SELECT
        workspace_id::text, niche_slug, niche_name, source_tab, scores,
        notes, status, verdict, verdict_reason, outcome, outcome_video_id,
        outcome_reason, created_by_user_id::text, created_at, updated_at,
        deleted_at
      FROM niche_favorites
      WHERE workspace_id = ${workspaceId}::uuid
        AND deleted_at IS NULL
        AND status     = ${opts.status}
      ORDER BY updated_at DESC
      LIMIT 200
    `;
    return rows;
  }
  const { rows } = await sql<NicheFavoriteRow>`
    SELECT
      workspace_id::text, niche_slug, niche_name, source_tab, scores,
      notes, status, verdict, verdict_reason, outcome, outcome_video_id,
      outcome_reason, created_by_user_id::text, created_at, updated_at,
      deleted_at
    FROM niche_favorites
    WHERE workspace_id = ${workspaceId}::uuid
      AND deleted_at IS NULL
    ORDER BY updated_at DESC
    LIMIT 200
  `;
  return rows;
}

/** Soft-deleted favorites still inside the 30-day restore window.
 *  Powers the "Recently removed" link at the bottom of the Favorites
 *  tab. Newest-deleted first. */
export async function listRecentlyRemovedFavorites(
  workspaceId: string,
): Promise<NicheFavoriteRow[]> {
  const { rows } = await sql<NicheFavoriteRow>`
    SELECT
      workspace_id::text, niche_slug, niche_name, source_tab, scores,
      notes, status, verdict, verdict_reason, outcome, outcome_video_id,
      outcome_reason, created_by_user_id::text, created_at, updated_at,
      deleted_at
    FROM niche_favorites
    WHERE workspace_id = ${workspaceId}::uuid
      AND deleted_at IS NOT NULL
      AND deleted_at > NOW() - INTERVAL '30 days'
    ORDER BY deleted_at DESC
    LIMIT 100
  `;
  return rows;
}

/** Fetch a single favorite by slug. Returns null on miss OR on
 *  soft-deleted rows — callers that need the restore-window view use
 *  `getFavoriteIncludingDeleted` instead. */
export async function getFavorite(
  workspaceId: string,
  nicheSlug: string,
): Promise<NicheFavoriteRow | null> {
  const { rows } = await sql<NicheFavoriteRow>`
    SELECT
      workspace_id::text, niche_slug, niche_name, source_tab, scores,
      notes, status, verdict, verdict_reason, outcome, outcome_video_id,
      outcome_reason, created_by_user_id::text, created_at, updated_at,
      deleted_at
    FROM niche_favorites
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Variant that includes soft-deleted rows. Used by the restore
 *  endpoint so the operator can recover something they just removed. */
export async function getFavoriteIncludingDeleted(
  workspaceId: string,
  nicheSlug: string,
): Promise<NicheFavoriteRow | null> {
  const { rows } = await sql<NicheFavoriteRow>`
    SELECT
      workspace_id::text, niche_slug, niche_name, source_tab, scores,
      notes, status, verdict, verdict_reason, outcome, outcome_video_id,
      outcome_reason, created_by_user_id::text, created_at, updated_at,
      deleted_at
    FROM niche_favorites
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Patch operator-controlled fields. Pass `undefined` to leave a
 *  field unchanged, `null` to clear it (where the column is nullable).
 *  Returns the updated row, or null if the slug doesn't exist /
 *  is soft-deleted. */
export async function updateFavorite(args: {
  workspaceId: string;
  nicheSlug: string;
  notes?: string | null;
  status?: FavoriteStatus;
  verdict?: FavoriteVerdict | null;
  verdictReason?: string | null;
  outcome?: FavoriteOutcome | null;
  outcomeVideoId?: string | null;
  outcomeReason?: string | null;
}): Promise<NicheFavoriteRow | null> {
  // Validate enums up front — the CHECK constraints catch invalid
  // values too but a 400 with a readable message beats a 500.
  if (args.status !== undefined && !isValidStatus(args.status)) {
    throw new Error(`Invalid status: ${String(args.status)}`);
  }
  if (args.verdict !== undefined && args.verdict !== null && !isValidVerdict(args.verdict)) {
    throw new Error(`Invalid verdict: ${String(args.verdict)}`);
  }
  if (args.outcome !== undefined && args.outcome !== null && !isValidOutcome(args.outcome)) {
    throw new Error(`Invalid outcome: ${String(args.outcome)}`);
  }
  // Notes / reason length caps.
  if (typeof args.notes === 'string' && args.notes.length > NOTES_MAX_LENGTH) {
    throw new Error(`Notes exceed ${NOTES_MAX_LENGTH} characters`);
  }
  if (typeof args.verdictReason === 'string' && args.verdictReason.length > REASON_MAX_LENGTH) {
    throw new Error(`Verdict reason exceeds ${REASON_MAX_LENGTH} characters`);
  }
  if (typeof args.outcomeReason === 'string' && args.outcomeReason.length > REASON_MAX_LENGTH) {
    throw new Error(`Outcome reason exceeds ${REASON_MAX_LENGTH} characters`);
  }

  // COALESCE pattern: ${value}::type IS NULL means "leave alone";
  // a real value (including SQL NULL via explicit null) overrides.
  // We can't distinguish "no change" from "set to NULL" in a single
  // SQL parameter, so use sentinel `__NOCHANGE__` strings for the
  // text columns and a special path for nullable enums.
  //
  // Simpler: build the SET clause dynamically. The tagged-template
  // `sql` helper doesn't compose well with dynamic SET clauses, so
  // fall through to the lower-level path: a single UPDATE with
  // CASE WHEN sentinel literals.
  //
  // Pragmatic compromise — issue one focused UPDATE per provided
  // field. The Favorites tab edits at human pace; the round-trips
  // are not the hot path. Wrapped in a transaction is overkill for
  // independent column updates.
  if (args.notes !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET notes = ${args.notes}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.status !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET status = ${args.status}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.verdict !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET verdict = ${args.verdict}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.verdictReason !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET verdict_reason = ${args.verdictReason}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.outcome !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET outcome = ${args.outcome}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.outcomeVideoId !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET outcome_video_id = ${args.outcomeVideoId}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }
  if (args.outcomeReason !== undefined) {
    await sql`
      UPDATE niche_favorites
      SET outcome_reason = ${args.outcomeReason}, updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
        AND deleted_at IS NULL
    `;
  }

  return getFavorite(args.workspaceId, args.nicheSlug);
}

// ---------------------------------------------------------------------------
// Proof-video CRUD.
// ---------------------------------------------------------------------------

/** Add a proof video under a favorite niche. Idempotent — if the
 *  same (workspace, niche, video) already exists, refreshes the
 *  snapshotted fields. Returns the row. Throws if the parent
 *  favorite doesn't exist (FK violation surfaces as a Postgres
 *  error — callers translate via `domainErrorResponse`). */
export async function addFavoriteVideo(args: {
  workspaceId: string;
  userId: string;
  nicheSlug: string;
  video: {
    videoId: string;
    channelId: string;
    title: string;
    thumbnailUrl?: string | null;
    viewCount?: number | null;
    publishedAt?: string | null;
    outlierScore?: number | null;
    classification?: VideoClassification | null;
    durationIso?: string | null;
    channelTitle?: string | null;
    subscriberCount?: number | null;
  };
}): Promise<NicheFavoriteVideoRow> {
  const v = args.video;
  const { rows } = await sql<NicheFavoriteVideoRow>`
    INSERT INTO niche_favorite_videos (
      workspace_id, niche_slug, video_id, channel_id, title,
      thumbnail_url, view_count, published_at, outlier_score,
      classification, duration_iso, channel_title, subscriber_count,
      added_by_user_id
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.nicheSlug},
      ${v.videoId},
      ${v.channelId},
      ${v.title},
      ${v.thumbnailUrl ?? null},
      ${v.viewCount ?? null},
      ${v.publishedAt ?? null},
      ${v.outlierScore ?? null},
      ${v.classification ?? null},
      ${v.durationIso ?? null},
      ${v.channelTitle ?? null},
      ${v.subscriberCount ?? null},
      ${args.userId}::uuid
    )
    ON CONFLICT (workspace_id, niche_slug, video_id) DO UPDATE SET
      title             = EXCLUDED.title,
      thumbnail_url     = EXCLUDED.thumbnail_url,
      view_count        = EXCLUDED.view_count,
      published_at      = EXCLUDED.published_at,
      outlier_score     = EXCLUDED.outlier_score,
      classification    = EXCLUDED.classification,
      duration_iso      = EXCLUDED.duration_iso,
      channel_title     = EXCLUDED.channel_title,
      subscriber_count  = EXCLUDED.subscriber_count
    RETURNING
      id::text, workspace_id::text, niche_slug, video_id, channel_id,
      title, thumbnail_url, view_count, published_at, outlier_score,
      classification, duration_iso, channel_title, subscriber_count,
      is_removed_upstream, last_validated_at, added_at,
      added_by_user_id::text
  `;
  // Bump parent's updated_at so the Favorites tab sort reflects activity.
  await sql`
    UPDATE niche_favorites
    SET updated_at = NOW()
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND niche_slug   = ${args.nicheSlug}
  `;
  return rows[0];
}

/** Remove a single proof video. Returns true when a row was removed. */
export async function removeFavoriteVideo(args: {
  workspaceId: string;
  nicheSlug: string;
  videoId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    DELETE FROM niche_favorite_videos
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND niche_slug   = ${args.nicheSlug}
      AND video_id     = ${args.videoId}
  `;
  if ((rowCount ?? 0) > 0) {
    await sql`
      UPDATE niche_favorites
      SET updated_at = NOW()
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND niche_slug   = ${args.nicheSlug}
    `;
  }
  return (rowCount ?? 0) > 0;
}

/** List proof videos under one favorite, newest-added-first. */
export async function listFavoriteVideos(
  workspaceId: string,
  nicheSlug: string,
): Promise<NicheFavoriteVideoRow[]> {
  const { rows } = await sql<NicheFavoriteVideoRow>`
    SELECT
      id::text, workspace_id::text, niche_slug, video_id, channel_id,
      title, thumbnail_url, view_count, published_at, outlier_score,
      classification, duration_iso, channel_title, subscriber_count,
      is_removed_upstream, last_validated_at, added_at,
      added_by_user_id::text
    FROM niche_favorite_videos
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
    ORDER BY added_at DESC
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// Bundled fetch — Favorites tab calls this once on mount.
// ---------------------------------------------------------------------------

/** Fetch every live favorite + every proof video under it, grouped.
 *  Single round-trip. Used by `GET /api/niche-finder/favorites`. */
export async function listFavoritesWithVideos(
  workspaceId: string,
): Promise<NicheFavoriteWithVideos[]> {
  const favorites = await listFavorites(workspaceId);
  if (favorites.length === 0) return [];

  // Single batch fetch of every video under any of these slugs.
  // `sql.query` (vs the tagged-template form) is required to pass a
  // text[] parameter — the tagged-template form serialises arrays as
  // their JSON string. Pattern matches inbox-db.ts:307.
  const slugs = favorites.map((f) => f.niche_slug);
  const { rows: allVideos } = await sql.query<NicheFavoriteVideoRow>(
    `SELECT
       id::text, workspace_id::text, niche_slug, video_id, channel_id,
       title, thumbnail_url, view_count, published_at, outlier_score,
       classification, duration_iso, channel_title, subscriber_count,
       is_removed_upstream, last_validated_at, added_at,
       added_by_user_id::text
     FROM niche_favorite_videos
     WHERE workspace_id = $1::uuid
       AND niche_slug   = ANY($2::text[])
     ORDER BY added_at DESC`,
    [workspaceId, slugs],
  );

  // Group videos by slug.
  const bySlug = new Map<string, NicheFavoriteVideoRow[]>();
  for (const v of allVideos) {
    const list = bySlug.get(v.niche_slug);
    if (list) list.push(v);
    else bySlug.set(v.niche_slug, [v]);
  }

  return favorites.map((f) => ({ ...f, videos: bySlug.get(f.niche_slug) ?? [] }));
}
