/**
 * Phase 9.7 — catalog explorer.
 *
 * Sortable, filterable view over every video the workspace has
 * published. Joins the live `video_analytics` row with `channels`
 * for the channel name, `video_format_tags` for the auto-detected
 * format (Phase 9.4), and `video_breakout_fires` for the breakout
 * badge (9.5).
 *
 * The exported lib has three concerns:
 *   1. Pure filter / sort normalisation (so filters from the URL
 *      query string and from a saved view both flow through the
 *      same gauntlet)
 *   2. The DB read with parameterised filters (one beefy SELECT)
 *   3. CRUD on the saved-view table
 *
 * Pure helpers are unit-tested. The DB query is exercised at runtime;
 * we keep the SQL surface small enough that visual review covers it.
 */
import { sql } from '@vercel/postgres';
import { isVideoFormat } from './format-tags-types';
import {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  DURATION_BUCKET_RANGES,
  SORT_FIELDS,
  normaliseFilter,
  normaliseSort,
  parseSavedViewName,
  type CatalogFilter,
  type CatalogSort,
  type CatalogVideoRow,
  type DurationBucket,
  type SavedView,
  type SortDir,
  type SortField,
} from './catalog-explorer-types';

// Re-export for back-compat with existing callers that imported types
// + helpers from this module before the client/server split.
export {
  DEFAULT_FILTER,
  DEFAULT_SORT,
  DURATION_BUCKET_RANGES,
  SORT_FIELDS,
  normaliseFilter,
  normaliseSort,
  parseSavedViewName,
};
export type {
  CatalogFilter,
  CatalogSort,
  CatalogVideoRow,
  DurationBucket,
  SavedView,
  SortDir,
  SortField,
};

// ---------------------------------------------------------------------------
// DB read — catalog rows
// ---------------------------------------------------------------------------

interface RawCatalogRow {
  youtube_video_id: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;
  format: string | null;
  has_breakout: boolean;
  days_since_publish: number | null;
}

/**
 * The big query. Filter columns are passed as nullable parameters and
 * the SQL applies each conditionally with the `($N::T IS NULL OR ...)`
 * pattern — that lets the query plan stay stable across filter combos
 * without resorting to dynamic SQL string concatenation.
 *
 * Sort is one of a fixed enum, applied via CASE so we don't have to
 * concatenate the field name into the SQL string (still safe — it's
 * already enum-validated by normaliseSort — but CASE is cleaner).
 */
export async function listCatalogVideos(opts: {
  workspaceId: string;
  filter: CatalogFilter;
  sort: CatalogSort;
  limit?: number;
  offset?: number;
}): Promise<{ rows: CatalogVideoRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { filter, sort } = opts;

  // Postgres array literal '{a,b,c}' for the array filters. NULL
  // literal in array form so the "IS NULL" branch matches.
  const channelArr =
    filter.channelDbIds.length > 0 ? `{${filter.channelDbIds.join(',')}}` : null;
  const formatArr =
    filter.formats.length > 0 ? `{${filter.formats.join(',')}}` : null;

  // Duration buckets — convert the selected buckets into a list of
  // (lo, hi) ranges and OR them in the WHERE. We unfold to up to 4
  // ranges; the lib's enum makes the unfolding trivial.
  const durationRanges = filter.durations.map((b) => DURATION_BUCKET_RANGES[b]);
  const durLo1 = durationRanges[0]?.[0] ?? null;
  const durHi1 = durationRanges[0]?.[1] ?? null;
  const durLo2 = durationRanges[1]?.[0] ?? null;
  const durHi2 = durationRanges[1]?.[1] ?? null;
  const durLo3 = durationRanges[2]?.[0] ?? null;
  const durHi3 = durationRanges[2]?.[1] ?? null;
  const durLo4 = durationRanges[3]?.[0] ?? null;
  const durHi4 = durationRanges[3]?.[1] ?? null;
  const hasDurationFilter = durationRanges.length > 0;

  const sortField = sort.field; // already enum-validated
  const sortDirAsc = sort.dir === 'asc';

  // ORDER BY needs raw SQL (the template tag escapes everything as
  // a parameter, but ORDER BY direction can't be parameterised).
  // Both `sortField` and `sort.dir` are enum-validated in
  // normaliseSort, so concatenating them is safe — but we still
  // route the value-bearing parts through `sql.query` parameters.
  const SORT_COL: Record<SortField, string> = {
    published_at: 'va.published_at',
    views: 'va.views',
    ctr_percentage: 'va.ctr_percentage',
    average_view_percentage: 'va.average_view_percentage',
    subscribers_gained: 'va.subscribers_gained',
    duration_seconds: 'va.duration_seconds',
    // "days since publish" is just published_at flipped — newer = fewer days.
    days_since_publish: 'va.published_at',
  };
  const sortCol = SORT_COL[sortField];
  // For days_since_publish, dir 'asc' means "fewest days first" =
  // newest first = published_at DESC.
  const effectiveDir =
    sortField === 'days_since_publish'
      ? sortDirAsc
        ? 'DESC'
        : 'ASC'
      : sortDirAsc
        ? 'ASC'
        : 'DESC';

  // Build a single parameterised query and execute via sql.query so
  // we can splice the validated ORDER BY in. Values are passed
  // positionally — same shape as the tagged-template path.
  const baseFrom = `
    FROM video_analytics va
    LEFT JOIN channels ch
      ON ch.id = va.channel_id
    LEFT JOIN video_format_tags vft
      ON vft.workspace_id     = va.workspace_id
     AND vft.youtube_video_id = va.youtube_video_id
    LEFT JOIN video_breakout_fires bf
      ON bf.workspace_id     = va.workspace_id
     AND bf.youtube_video_id = va.youtube_video_id
    WHERE va.workspace_id = $1::uuid
      AND ($2::uuid[] IS NULL OR va.channel_id = ANY($2::uuid[]))
      AND ($3::text[] IS NULL OR vft.format = ANY($3::text[]))
      AND ($4::date IS NULL OR va.published_at >= $4::date)
      AND ($5::date IS NULL OR va.published_at < $5::date)
      AND ($6::numeric IS NULL OR va.average_view_percentage >= $6::numeric)
      AND ($7::numeric IS NULL OR va.average_view_percentage <= $7::numeric)
      AND ($8::numeric IS NULL OR va.ctr_percentage >= $8::numeric)
      AND ($9::numeric IS NULL OR va.ctr_percentage <= $9::numeric)
      AND (NOT $10::boolean OR bf.youtube_video_id IS NOT NULL)
      AND (
        NOT $11::boolean
        OR ($12::int IS NOT NULL AND va.duration_seconds >= $12::int AND ($13::int IS NULL OR va.duration_seconds < $13::int))
        OR ($14::int IS NOT NULL AND va.duration_seconds >= $14::int AND ($15::int IS NULL OR va.duration_seconds < $15::int))
        OR ($16::int IS NOT NULL AND va.duration_seconds >= $16::int AND ($17::int IS NULL OR va.duration_seconds < $17::int))
        OR ($18::int IS NOT NULL AND va.duration_seconds >= $18::int AND ($19::int IS NULL OR va.duration_seconds < $19::int))
      )
  `;

  const filterParams = [
    opts.workspaceId,                  // $1
    channelArr,                        // $2
    formatArr,                         // $3
    filter.publishedSince,             // $4
    filter.publishedUntil,             // $5
    filter.avpMin,                     // $6
    filter.avpMax,                     // $7
    filter.ctrMin,                     // $8
    filter.ctrMax,                     // $9
    filter.onlyBreakouts,              // $10
    hasDurationFilter,                 // $11
    durLo1, durHi1,                    // $12, $13
    durLo2, durHi2,                    // $14, $15
    durLo3, durHi3,                    // $16, $17
    durLo4, durHi4,                    // $18, $19
  ];

  const countRowsRes = await sql.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c ${baseFrom}`,
    filterParams,
  );
  const total = Number(countRowsRes.rows[0]?.c ?? '0');

  const rowsRes = await sql.query<RawCatalogRow>(
    `
    SELECT
      va.youtube_video_id,
      va.channel_id,
      ch.name AS channel_name,
      va.title,
      va.thumbnail_url,
      va.published_at::text AS published_at,
      va.duration_seconds,
      va.views,
      va.ctr_percentage,
      va.average_view_percentage,
      va.subscribers_gained,
      vft.format,
      (bf.youtube_video_id IS NOT NULL) AS has_breakout,
      CASE WHEN va.published_at IS NULL THEN NULL
           ELSE EXTRACT(EPOCH FROM (NOW() - va.published_at))::numeric / 86400.0
      END::float AS days_since_publish
    ${baseFrom}
    ORDER BY ${sortCol} ${effectiveDir} NULLS LAST, va.youtube_video_id ASC
    LIMIT $20
    OFFSET $21
    `,
    [...filterParams, limit, offset],
  );
  const rows = rowsRes.rows;

  return {
    rows: rows.map((r) => ({
      youtube_video_id: r.youtube_video_id,
      channel_id: r.channel_id,
      channel_name: r.channel_name,
      title: r.title,
      thumbnail_url: r.thumbnail_url,
      published_at: r.published_at,
      duration_seconds: r.duration_seconds,
      views: r.views === null ? null : Number(r.views),
      ctr_percentage: r.ctr_percentage === null ? null : Number(r.ctr_percentage),
      average_view_percentage:
        r.average_view_percentage === null ? null : Number(r.average_view_percentage),
      subscribers_gained:
        r.subscribers_gained === null ? null : Number(r.subscribers_gained),
      format: r.format && isVideoFormat(r.format) ? r.format : null,
      has_breakout: r.has_breakout === true,
      days_since_publish:
        r.days_since_publish === null ? null : Number(r.days_since_publish),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// DB CRUD — saved views
// ---------------------------------------------------------------------------

interface RawSavedView {
  id: string;
  workspace_id: string;
  created_by_user_id: string | null;
  name: string;
  filters: unknown;
  sort: unknown;
  created_at: string;
  updated_at: string;
}

function rowToSavedView(r: RawSavedView): SavedView {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    created_by_user_id: r.created_by_user_id,
    name: r.name,
    filters: normaliseFilter(r.filters),
    sort: normaliseSort(r.sort),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listSavedViews(workspaceId: string): Promise<SavedView[]> {
  const { rows } = await sql<RawSavedView>`
    SELECT
      id, workspace_id, created_by_user_id, name, filters, sort,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM saved_catalog_views
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY updated_at DESC
    LIMIT 50
  `;
  return rows.map(rowToSavedView);
}

export async function createSavedView(opts: {
  workspaceId: string;
  createdByUserId: string;
  name: string;
  filter: CatalogFilter;
  sort: CatalogSort;
}): Promise<SavedView> {
  const { rows } = await sql<RawSavedView>`
    INSERT INTO saved_catalog_views (
      workspace_id, created_by_user_id, name, filters, sort
    ) VALUES (
      ${opts.workspaceId}::uuid,
      ${opts.createdByUserId}::uuid,
      ${opts.name},
      ${JSON.stringify(opts.filter)}::jsonb,
      ${JSON.stringify(opts.sort)}::jsonb
    )
    RETURNING
      id, workspace_id, created_by_user_id, name, filters, sort,
      created_at::text AS created_at,
      updated_at::text AS updated_at
  `;
  return rowToSavedView(rows[0]!);
}

export async function deleteSavedView(opts: {
  workspaceId: string;
  id: string;
}): Promise<boolean> {
  const result = await sql`
    DELETE FROM saved_catalog_views
     WHERE id = ${opts.id}::uuid
       AND workspace_id = ${opts.workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}
