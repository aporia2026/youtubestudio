/**
 * Dashboard summary builder. Fetches the data the new /dashboard page
 * needs in a single round trip and runs it through the pure aggregator
 * functions. The pure parts are testable without a DB.
 *
 * Sections:
 *   1. today_publishes — schedule items dated today (UTC day boundary).
 *   2. stuck — items past their stage threshold.
 *   3. underperformers — published items in the recent window with
 *      below-threshold CTR or AVP, joined from video_analytics.
 *   4. cadence — per-channel publishes in the trailing 4 weeks vs.
 *      target uploads/week (default 1).
 *
 * All four sections accept an optional `channelFilter` so the dashboard
 * can scope to the user's pinned active channel.
 */
import { sql } from '@vercel/postgres';
import { DEFAULT_STUCK_THRESHOLDS } from './schedule';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  id: string;
  title: string;
  status: string;
  scheduled_for: string | null;
  stage_entered_at: string | null;
  editor_collaborator_name: string | null;
  narrator_collaborator_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  youtube_url: string | null;
}

export interface AnalyticsRow {
  schedule_item_id: string | null;
  youtube_video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_percentage: number | null;
  fetched_at: string;
  channel_id: string | null;
  channel_name: string | null;
}

export interface ChannelRow {
  id: string;
  name: string;
}

export interface PublishedCountRow {
  channel_id: string | null;
  count: number;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface TodayPublishItem {
  id: string;
  title: string;
  status: string;
  scheduled_for: string;
  editor_name: string | null;
  narrator_name: string | null;
  channel_name: string | null;
}

export interface StuckItem {
  id: string;
  title: string;
  status: string;
  days_in_stage: number;
  threshold_days: number;
  channel_name: string | null;
}

export interface UnderperformerItem {
  schedule_item_id: string | null;
  youtube_video_id: string;
  title: string | null;
  thumbnail_url: string | null;
  views: number | null;
  ctr_percentage: number | null;
  average_view_percentage: number | null;
  reasons: string[];
  channel_name: string | null;
  fetched_at: string;
}

export interface CadenceRow {
  channel_id: string;
  channel_name: string;
  target_per_week: number;
  actual_per_week: number;
  weeks_window: number;
  gap: number; // positive = behind target
}

export interface DashboardSummary {
  today_publishes: TodayPublishItem[];
  stuck: StuckItem[];
  underperformers: UnderperformerItem[];
  cadence: CadenceRow[];
  generated_at: string;
  /** Per-section error messages when a fetch failed. Surfaces in the UI
   *  as a soft warning instead of replacing every section with an error. */
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Pure aggregators
// ---------------------------------------------------------------------------

/** True if the timestamp falls on the same UTC calendar day as `now`. */
export function isSameUtcDay(iso: string, now: Date): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

export function pickTodayPublishes(items: ScheduleRow[], now: Date): TodayPublishItem[] {
  const out: TodayPublishItem[] = [];
  for (const item of items) {
    if (!item.scheduled_for) continue;
    if (!isSameUtcDay(item.scheduled_for, now)) continue;
    out.push({
      id: item.id,
      title: item.title,
      status: item.status,
      scheduled_for: item.scheduled_for,
      editor_name: item.editor_collaborator_name,
      narrator_name: item.narrator_collaborator_name,
      channel_name: item.channel_name,
    });
  }
  // Earliest first by scheduled_for.
  out.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
  return out;
}

/** Days since stage_entered_at (UTC, integer floor). Null if no anchor. */
export function daysSince(stageEnteredAt: string | null, now: Date): number | null {
  if (!stageEnteredAt) return null;
  const t = new Date(stageEnteredAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function pickStuckItems(
  items: ScheduleRow[],
  now: Date,
  thresholds: Record<string, number> = DEFAULT_STUCK_THRESHOLDS,
): StuckItem[] {
  const out: StuckItem[] = [];
  for (const item of items) {
    const limit = thresholds[item.status];
    // Skip stages that aren't gated (e.g. 'published' = Infinity, or unknown
    // statuses we don't have a threshold for).
    if (limit === undefined || !Number.isFinite(limit)) continue;
    const d = daysSince(item.stage_entered_at, now);
    if (d === null) continue;
    if (d <= limit) continue;
    out.push({
      id: item.id,
      title: item.title,
      status: item.status,
      days_in_stage: d,
      threshold_days: limit,
      channel_name: item.channel_name,
    });
  }
  out.sort((a, b) => b.days_in_stage - a.days_in_stage);
  return out;
}

export interface UnderperformerThresholds {
  /** CTR below this in % flags the row. */
  ctr_percent_min?: number;
  /** Average-view-percentage below this in % flags the row. */
  avp_percent_min?: number;
  /** Only consider rows whose published_at is within this many days from now. */
  recent_days?: number;
}

export const DEFAULT_UNDERPERFORMER_THRESHOLDS: Required<UnderperformerThresholds> = {
  ctr_percent_min: 4,
  avp_percent_min: 30,
  recent_days: 14,
};

export function pickUnderperformers(
  rows: AnalyticsRow[],
  now: Date,
  thresholds: UnderperformerThresholds = DEFAULT_UNDERPERFORMER_THRESHOLDS,
): UnderperformerItem[] {
  const t = { ...DEFAULT_UNDERPERFORMER_THRESHOLDS, ...thresholds };
  const cutoff = now.getTime() - t.recent_days * 86_400_000;
  const out: UnderperformerItem[] = [];
  for (const row of rows) {
    if (!row.published_at) continue;
    const ts = new Date(row.published_at).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;
    const reasons: string[] = [];
    if (row.ctr_percentage !== null && row.ctr_percentage < t.ctr_percent_min) {
      reasons.push(`CTR ${row.ctr_percentage.toFixed(1)}% (below ${t.ctr_percent_min}%)`);
    }
    if (row.average_view_percentage !== null && row.average_view_percentage < t.avp_percent_min) {
      reasons.push(
        `Avg view ${row.average_view_percentage.toFixed(1)}% (below ${t.avp_percent_min}%)`,
      );
    }
    if (reasons.length === 0) continue;
    out.push({
      schedule_item_id: row.schedule_item_id,
      youtube_video_id: row.youtube_video_id,
      title: row.title,
      thumbnail_url: row.thumbnail_url,
      views: row.views,
      ctr_percentage: row.ctr_percentage,
      average_view_percentage: row.average_view_percentage,
      reasons,
      channel_name: row.channel_name,
      fetched_at: row.fetched_at,
    });
  }
  // Sort by severity — videos that match BOTH conditions first, then by lowest CTR.
  out.sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    const ac = a.ctr_percentage ?? Infinity;
    const bc = b.ctr_percentage ?? Infinity;
    return ac - bc;
  });
  return out;
}

export const DEFAULT_TARGET_UPLOADS_PER_WEEK = 1;
export const DEFAULT_CADENCE_WEEKS_WINDOW = 4;

export function computeCadenceGap(
  channels: ChannelRow[],
  publishedCounts: PublishedCountRow[],
  weeksWindow: number = DEFAULT_CADENCE_WEEKS_WINDOW,
  targetPerWeek: number = DEFAULT_TARGET_UPLOADS_PER_WEEK,
): CadenceRow[] {
  const counts = new Map<string, number>();
  for (const r of publishedCounts) {
    if (!r.channel_id) continue;
    counts.set(r.channel_id, r.count);
  }
  const out: CadenceRow[] = [];
  for (const ch of channels) {
    const totalPublished = counts.get(ch.id) ?? 0;
    const actual = totalPublished / weeksWindow;
    out.push({
      channel_id: ch.id,
      channel_name: ch.name,
      target_per_week: targetPerWeek,
      actual_per_week: Number(actual.toFixed(2)),
      weeks_window: weeksWindow,
      gap: Number((targetPerWeek - actual).toFixed(2)),
    });
  }
  // Worst gap first so the user sees what's most behind.
  out.sort((a, b) => b.gap - a.gap);
  return out;
}

// ---------------------------------------------------------------------------
// DB I/O
// ---------------------------------------------------------------------------

export interface BuildSummaryArgs {
  workspaceId: string;
  /** When set, every section is filtered to this channel id. */
  activeChannelId?: string | null;
  now?: Date;
}

/**
 * One round trip per section. Each query is workspace-scoped and (when
 * applicable) channel-scoped. Returns the assembled summary.
 *
 * Sections are independent — a failure in one (e.g. a missing optional
 * column) leaves that section empty rather than blanking the whole
 * dashboard. The `errors` field surfaces what failed so the UI can show
 * a non-fatal hint.
 */
export async function buildDashboardSummary(args: BuildSummaryArgs): Promise<DashboardSummary> {
  const now = args.now ?? new Date();
  const channelFilter = args.activeChannelId ?? null;
  const errors: string[] = [];

  // -- Schedule rows in scope -------------------------------------------------
  let scheduleRows: ScheduleRow[] = [];
  try {
    scheduleRows = await fetchScheduleRows(args.workspaceId, channelFilter);
  } catch (e) {
    errors.push(`schedule: ${e instanceof Error ? e.message : String(e)}`);
  }

  // -- Analytics rows for the recent window ----------------------------------
  let analyticsRows: AnalyticsRow[] = [];
  try {
    analyticsRows = await fetchAnalyticsRows(args.workspaceId, channelFilter);
  } catch (e) {
    errors.push(`analytics: ${e instanceof Error ? e.message : String(e)}`);
  }

  // -- Channels for cadence calc ---------------------------------------------
  let channels: ChannelRow[] = [];
  try {
    channels = await fetchChannelsList(args.workspaceId, channelFilter);
  } catch (e) {
    errors.push(`channels: ${e instanceof Error ? e.message : String(e)}`);
  }

  // -- Published counts in trailing 4 weeks ---------------------------------
  let counts: PublishedCountRow[] = [];
  try {
    counts = await fetchPublishedCountsLast4w(args.workspaceId, channelFilter, now);
  } catch (e) {
    errors.push(`cadence: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    today_publishes: pickTodayPublishes(scheduleRows, now),
    stuck: pickStuckItems(scheduleRows, now),
    underperformers: pickUnderperformers(analyticsRows, now),
    cadence: computeCadenceGap(channels, counts),
    generated_at: now.toISOString(),
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function fetchScheduleRows(
  workspaceId: string,
  channelFilter: string | null,
): Promise<ScheduleRow[]> {
  // Editor / narrator names live on the collaborators table — we resolve them
  // via the FK columns (editor_collaborator_id, narrator_collaborator_id).
  // Earlier prototypes denormalised the names onto schedule_items, but that
  // wasn't the schema we shipped; joining is the canonical path.
  //
  // LEFT JOINs to schedule_item_channels keep items without a channel
  // visible. When channelFilter is set, the channel JOIN becomes inner-join
  // semantics so only items in that channel are returned.
  if (channelFilter) {
    const { rows } = await sql<ScheduleRow>`
      SELECT
        si.id, si.title, si.status, si.scheduled_for, si.stage_entered_at,
        ed.name AS editor_collaborator_name,
        na.name AS narrator_collaborator_name,
        si.youtube_url,
        c.id AS channel_id, c.name AS channel_name
      FROM schedule_items si
      JOIN schedule_item_channels sic ON sic.item_id = si.id
      JOIN channels c ON c.id = sic.channel_id
      LEFT JOIN collaborators ed ON ed.id = si.editor_collaborator_id
      LEFT JOIN collaborators na ON na.id = si.narrator_collaborator_id
      WHERE si.workspace_id = ${workspaceId}::uuid
        AND c.id = ${channelFilter}::uuid
    `;
    return rows;
  }
  const { rows } = await sql<ScheduleRow>`
    SELECT
      si.id, si.title, si.status, si.scheduled_for, si.stage_entered_at,
      ed.name AS editor_collaborator_name,
      na.name AS narrator_collaborator_name,
      si.youtube_url,
      c.id AS channel_id, c.name AS channel_name
    FROM schedule_items si
    LEFT JOIN schedule_item_channels sic ON sic.item_id = si.id
    LEFT JOIN channels c ON c.id = sic.channel_id
    LEFT JOIN collaborators ed ON ed.id = si.editor_collaborator_id
    LEFT JOIN collaborators na ON na.id = si.narrator_collaborator_id
    WHERE si.workspace_id = ${workspaceId}::uuid
  `;
  return rows;
}

async function fetchAnalyticsRows(
  workspaceId: string,
  channelFilter: string | null,
): Promise<AnalyticsRow[]> {
  if (channelFilter) {
    const { rows } = await sql<AnalyticsRow>`
      SELECT
        va.schedule_item_id, va.youtube_video_id, va.title, va.thumbnail_url,
        va.published_at, va.views, va.ctr_percentage, va.average_view_percentage,
        va.fetched_at::text AS fetched_at,
        c.id AS channel_id, c.name AS channel_name
      FROM video_analytics va
      LEFT JOIN channels c ON c.id = va.channel_id
      WHERE va.workspace_id = ${workspaceId}::uuid
        AND va.channel_id = ${channelFilter}::uuid
        AND va.published_at IS NOT NULL
    `;
    return rows;
  }
  const { rows } = await sql<AnalyticsRow>`
    SELECT
      va.schedule_item_id, va.youtube_video_id, va.title, va.thumbnail_url,
      va.published_at, va.views, va.ctr_percentage, va.average_view_percentage,
      va.fetched_at::text AS fetched_at,
      c.id AS channel_id, c.name AS channel_name
    FROM video_analytics va
    LEFT JOIN channels c ON c.id = va.channel_id
    WHERE va.workspace_id = ${workspaceId}::uuid
      AND va.published_at IS NOT NULL
  `;
  return rows;
}

async function fetchChannelsList(
  workspaceId: string,
  channelFilter: string | null,
): Promise<ChannelRow[]> {
  if (channelFilter) {
    const { rows } = await sql<ChannelRow>`
      SELECT id, name FROM channels
       WHERE workspace_id = ${workspaceId}::uuid AND id = ${channelFilter}::uuid
    `;
    return rows;
  }
  const { rows } = await sql<ChannelRow>`
    SELECT id, name FROM channels
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY name ASC
  `;
  return rows;
}

async function fetchPublishedCountsLast4w(
  workspaceId: string,
  channelFilter: string | null,
  now: Date,
): Promise<PublishedCountRow[]> {
  const cutoff = new Date(now.getTime() - DEFAULT_CADENCE_WEEKS_WINDOW * 7 * 86_400_000)
    .toISOString();
  if (channelFilter) {
    const { rows } = await sql<PublishedCountRow>`
      SELECT c.id::text AS channel_id, COUNT(*)::int AS count
      FROM schedule_items si
      JOIN schedule_item_channels sic ON sic.item_id = si.id
      JOIN channels c ON c.id = sic.channel_id
      WHERE si.workspace_id = ${workspaceId}::uuid
        AND c.id = ${channelFilter}::uuid
        AND si.status = 'published'
        AND si.scheduled_for IS NOT NULL
        AND si.scheduled_for >= ${cutoff}::timestamptz
      GROUP BY c.id
    `;
    return rows;
  }
  const { rows } = await sql<PublishedCountRow>`
    SELECT c.id::text AS channel_id, COUNT(*)::int AS count
    FROM schedule_items si
    JOIN schedule_item_channels sic ON sic.item_id = si.id
    JOIN channels c ON c.id = sic.channel_id
    WHERE si.workspace_id = ${workspaceId}::uuid
      AND si.status = 'published'
      AND si.scheduled_for IS NOT NULL
      AND si.scheduled_for >= ${cutoff}::timestamptz
    GROUP BY c.id
  `;
  return rows;
}
