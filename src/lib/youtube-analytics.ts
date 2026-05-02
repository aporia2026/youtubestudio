/**
 * YouTube Analytics ingestion. Pulls per-video stats from two APIs and
 * caches the merged result in the `video_analytics` table.
 *
 *   - Data API v3 (`youtube.readonly`): public stats — views, likes,
 *     comments, duration, publish date, title, thumbnail. Always available
 *     once the channel is OAuth-connected.
 *
 *   - Analytics API v2 (`yt-analytics.readonly`): performance metrics —
 *     impressions, CTR, average view duration / percentage, subscribers
 *     gained, and the elapsed-time × audience-watch retention curve.
 *     Requires the analytics scope. Channels that completed OAuth before
 *     PR #3 was deployed don't have it; the sync silently degrades to
 *     Data-API-only (`data_source = 'data'`) in that case so the user sees
 *     at least something.
 *
 * The lib is split into:
 *   - PURE parsers (parseDataApiResponse, parseAnalyticsRow,
 *     parseRetentionRows, parseIso8601Duration, chooseDataSource).
 *     All testable without HTTP.
 *   - I/O layer (fetchDataApi*, fetchAnalyticsApi*, syncVideoAnalytics,
 *     readVideoAnalyticsRow). Touch the YouTube API and the DB.
 */
import { sql } from '@vercel/postgres';
import { getValidAccessToken } from './google-oauth';

const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const DATA_API_BASE = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com/v2/reports';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataApiSnapshot {
  views: number | null;
  likes: number | null;
  comments: number | null;
  duration_seconds: number | null;
  published_at: string | null;
  title: string | null;
  thumbnail_url: string | null;
}

export interface AnalyticsApiSnapshot {
  impressions: number | null;
  ctr_percentage: number | null;
  average_view_duration_seconds: number | null;
  average_view_percentage: number | null;
  subscribers_gained: number | null;
}

export interface RetentionPoint {
  position: number;
  retention: number;
}

export type DataSource = 'data' | 'analytics' | 'mixed' | 'partial';

export interface VideoAnalyticsRow extends DataApiSnapshot, AnalyticsApiSnapshot {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  schedule_item_id: string | null;
  retention_curve: RetentionPoint[] | null;
  data_source: DataSource;
  fetched_at: Date;
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/**
 * Parse an ISO 8601 duration like "PT1H2M3S" into seconds. Returns null
 * for malformed / non-ISO inputs (a missing "PT" prefix, empty bodies,
 * etc.).
 */
export function parseIso8601Duration(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, h, mm, s] = m;
  if (!h && !mm && !s) return null; // "PT" alone is meaningless
  return (Number(h) || 0) * 3600 + (Number(mm) || 0) * 60 + (Number(s) || 0);
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse a YouTube Data API v3 `videos.list` response — extract the first
 * item's snapshot stats. Tolerant of missing fields and string/number
 * variation in `statistics.*Count`.
 */
export function parseDataApiResponse(raw: unknown): DataApiSnapshot {
  const empty: DataApiSnapshot = {
    views: null,
    likes: null,
    comments: null,
    duration_seconds: null,
    published_at: null,
    title: null,
    thumbnail_url: null,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return empty;
  const item = items[0] as Record<string, unknown>;
  const snippet = (item.snippet ?? {}) as Record<string, unknown>;
  const stats = (item.statistics ?? {}) as Record<string, unknown>;
  const contentDetails = (item.contentDetails ?? {}) as Record<string, unknown>;
  const thumbs = (snippet.thumbnails ?? {}) as Record<string, { url?: unknown } | undefined>;

  const pickThumb = (): string | null => {
    for (const size of ['maxres', 'standard', 'high', 'medium', 'default'] as const) {
      const t = thumbs[size];
      if (t && typeof t.url === 'string' && t.url.length > 0) return t.url;
    }
    return null;
  };

  const title = typeof snippet.title === 'string' ? snippet.title : null;
  const publishedAt = typeof snippet.publishedAt === 'string' ? snippet.publishedAt : null;
  const duration = parseIso8601Duration(
    typeof contentDetails.duration === 'string' ? contentDetails.duration : null,
  );

  return {
    views: toFiniteNumber(stats.viewCount),
    likes: toFiniteNumber(stats.likeCount),
    comments: toFiniteNumber(stats.commentCount),
    duration_seconds: duration,
    published_at: publishedAt,
    title,
    thumbnail_url: pickThumb(),
  };
}

/** Build a column-name → row-index map from an Analytics API response. */
function indexColumns(raw: unknown): { idx: Record<string, number>; rows: unknown[][] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { columnHeaders?: unknown; rows?: unknown };
  if (!Array.isArray(r.columnHeaders)) return null;
  const idx: Record<string, number> = {};
  for (let i = 0; i < r.columnHeaders.length; i++) {
    const h = r.columnHeaders[i] as { name?: unknown } | undefined;
    if (h && typeof h.name === 'string') idx[h.name] = i;
  }
  const rows = Array.isArray(r.rows) ? (r.rows as unknown[][]) : [];
  return { idx, rows };
}

/**
 * Parse the single-row Analytics API response shape (one `rows` entry,
 * one column per metric). CTR comes back as a 0..1 ratio; we surface a
 * 0..100 percentage instead. Values > 1 are treated as already-percent
 * (some Analytics endpoints scale at the source).
 */
export function parseAnalyticsRow(raw: unknown): AnalyticsApiSnapshot {
  const empty: AnalyticsApiSnapshot = {
    impressions: null,
    ctr_percentage: null,
    average_view_duration_seconds: null,
    average_view_percentage: null,
    subscribers_gained: null,
  };
  const map = indexColumns(raw);
  if (!map || map.rows.length === 0) return empty;
  const row = map.rows[0]!;
  const get = (col: string): number | null => {
    const i = map.idx[col];
    if (i === undefined) return null;
    return toFiniteNumber(row[i]);
  };
  const rawCtr = get('impressionsCtr');
  const ctr =
    rawCtr === null ? null : rawCtr > 1 ? rawCtr : Number((rawCtr * 100).toFixed(3));
  return {
    impressions: get('impressions'),
    ctr_percentage: ctr,
    average_view_duration_seconds: get('averageViewDuration'),
    average_view_percentage: get('averageViewPercentage'),
    subscribers_gained: get('subscribersGained'),
  };
}

/** Parse the multi-row retention-curve response. */
export function parseRetentionRows(raw: unknown): RetentionPoint[] | null {
  const map = indexColumns(raw);
  if (!map) return null;
  const posIdx = map.idx['elapsedVideoTimeRatio'];
  const retIdx = map.idx['audienceWatchRatio'];
  if (posIdx === undefined || retIdx === undefined) return null;
  const out: RetentionPoint[] = [];
  for (const row of map.rows) {
    const position = toFiniteNumber(row[posIdx]);
    const retention = toFiniteNumber(row[retIdx]);
    if (position === null || retention === null) continue;
    out.push({ position, retention });
  }
  return out.length > 0 ? out : null;
}

/** Decide what `data_source` value to record based on what came back. */
export function chooseDataSource(
  data: DataApiSnapshot,
  analytics: AnalyticsApiSnapshot,
  retention: RetentionPoint[] | null,
  hadAnalyticsScope: boolean,
): DataSource {
  const dataNonEmpty =
    data.views !== null ||
    data.likes !== null ||
    data.comments !== null ||
    data.duration_seconds !== null ||
    data.title !== null;
  const analyticsNonEmpty =
    analytics.impressions !== null ||
    analytics.ctr_percentage !== null ||
    analytics.average_view_duration_seconds !== null ||
    analytics.average_view_percentage !== null ||
    analytics.subscribers_gained !== null ||
    (retention !== null && retention.length > 0);
  if (dataNonEmpty && analyticsNonEmpty) return 'mixed';
  if (dataNonEmpty) return 'data';
  if (analyticsNonEmpty) return 'analytics';
  // Both empty — note hadAnalyticsScope is informational; even with the
  // scope we may have got nothing if the video has zero views.
  void hadAnalyticsScope;
  return 'partial';
}

// ---------------------------------------------------------------------------
// HTTP fetchers
// ---------------------------------------------------------------------------

async function fetchDataApiVideo(accessToken: string, videoId: string): Promise<unknown> {
  const url =
    `${DATA_API_BASE}/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(videoId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Data API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

function buildDateRange(daysBack: number): DateRange {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { startDate: start, endDate: end };
}

async function fetchAnalyticsApiVideo(
  accessToken: string,
  youtubeChannelId: string,
  videoId: string,
  range: DateRange,
): Promise<unknown> {
  const params = new URLSearchParams({
    ids: `channel==${youtubeChannelId}`,
    metrics: 'impressions,impressionsCtr,averageViewDuration,averageViewPercentage,subscribersGained',
    filters: `video==${videoId}`,
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const res = await fetch(`${ANALYTICS_API_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Analytics API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchRetentionCurve(
  accessToken: string,
  youtubeChannelId: string,
  videoId: string,
  range: DateRange,
): Promise<unknown> {
  const params = new URLSearchParams({
    ids: `channel==${youtubeChannelId}`,
    metrics: 'audienceWatchRatio',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const res = await fetch(`${ANALYTICS_API_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Retention curve isn't always available (very fresh video, < threshold
    // views, etc.). Treat HTTP errors as "no curve" rather than throwing.
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Sync + read
// ---------------------------------------------------------------------------

export interface SyncOptions {
  workspaceId: string;
  channelDbId: string;
  scheduleItemId: string | null;
  /** YouTube channel external id (UC…). Required for the Analytics API. */
  youtubeChannelId: string | null;
  youtubeVideoId: string;
  /** How many days of history to query. 28 is the YouTube-default trailing. */
  daysBack?: number;
}

/**
 * Pull fresh stats from both APIs and upsert into video_analytics. Returns
 * the persisted row.
 *
 * Failure modes handled:
 *   - No OAuth token for the channel → throws ('oauth-connected …') so the
 *     route handler can surface a 409 with an actionable message.
 *   - Data API failure → throws (we genuinely can't sync without basic
 *     stats; the row would be useless).
 *   - Analytics API failure or missing scope → silently skipped; the row
 *     gets data_source='data' and the analytics columns stay NULL.
 */
export async function syncVideoAnalytics(opts: SyncOptions): Promise<VideoAnalyticsRow> {
  const tokenInfo = await getValidAccessToken(opts.channelDbId, true);
  if (!tokenInfo) {
    throw new Error(
      'Channel is not OAuth-connected. Open /channel and connect this channel first.',
    );
  }

  const range = buildDateRange(opts.daysBack ?? 28);

  // Data API is mandatory.
  const dataRaw = await fetchDataApiVideo(tokenInfo.token, opts.youtubeVideoId);
  const data = parseDataApiResponse(dataRaw);

  // Analytics API is best-effort. Bail if the channel can't provide it.
  const hadAnalyticsScope = tokenInfo.scopes.includes(ANALYTICS_SCOPE);
  let analytics: AnalyticsApiSnapshot = {
    impressions: null,
    ctr_percentage: null,
    average_view_duration_seconds: null,
    average_view_percentage: null,
    subscribers_gained: null,
  };
  let retention: RetentionPoint[] | null = null;

  if (hadAnalyticsScope && opts.youtubeChannelId) {
    try {
      const analyticsRaw = await fetchAnalyticsApiVideo(
        tokenInfo.token,
        opts.youtubeChannelId,
        opts.youtubeVideoId,
        range,
      );
      analytics = parseAnalyticsRow(analyticsRaw);
    } catch {
      // soft-fail; data_source will reflect the absence
    }
    try {
      const curveRaw = await fetchRetentionCurve(
        tokenInfo.token,
        opts.youtubeChannelId,
        opts.youtubeVideoId,
        range,
      );
      retention = curveRaw ? parseRetentionRows(curveRaw) : null;
    } catch {
      retention = null;
    }
  }

  const dataSource = chooseDataSource(data, analytics, retention, hadAnalyticsScope);

  await sql`
    INSERT INTO video_analytics (
      workspace_id, youtube_video_id, channel_id, schedule_item_id,
      views, likes, comments, duration_seconds, published_at, title, thumbnail_url,
      impressions, ctr_percentage, average_view_duration_seconds,
      average_view_percentage, subscribers_gained, retention_curve,
      data_source, fetched_at
    ) VALUES (
      ${opts.workspaceId}::uuid, ${opts.youtubeVideoId}, ${opts.channelDbId}::uuid,
      ${opts.scheduleItemId}::uuid,
      ${data.views}, ${data.likes}, ${data.comments}, ${data.duration_seconds},
      ${data.published_at}, ${data.title}, ${data.thumbnail_url},
      ${analytics.impressions}, ${analytics.ctr_percentage},
      ${analytics.average_view_duration_seconds},
      ${analytics.average_view_percentage}, ${analytics.subscribers_gained},
      ${retention ? JSON.stringify(retention) : null}::jsonb,
      ${dataSource}, NOW()
    )
    ON CONFLICT (workspace_id, youtube_video_id) DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      schedule_item_id = COALESCE(EXCLUDED.schedule_item_id, video_analytics.schedule_item_id),
      views = EXCLUDED.views,
      likes = EXCLUDED.likes,
      comments = EXCLUDED.comments,
      duration_seconds = EXCLUDED.duration_seconds,
      published_at = EXCLUDED.published_at,
      title = EXCLUDED.title,
      thumbnail_url = EXCLUDED.thumbnail_url,
      impressions = COALESCE(EXCLUDED.impressions, video_analytics.impressions),
      ctr_percentage = COALESCE(EXCLUDED.ctr_percentage, video_analytics.ctr_percentage),
      average_view_duration_seconds = COALESCE(
        EXCLUDED.average_view_duration_seconds,
        video_analytics.average_view_duration_seconds
      ),
      average_view_percentage = COALESCE(
        EXCLUDED.average_view_percentage,
        video_analytics.average_view_percentage
      ),
      subscribers_gained = COALESCE(
        EXCLUDED.subscribers_gained,
        video_analytics.subscribers_gained
      ),
      retention_curve = COALESCE(EXCLUDED.retention_curve, video_analytics.retention_curve),
      data_source = EXCLUDED.data_source,
      fetched_at = EXCLUDED.fetched_at
  `;

  const row = await readVideoAnalyticsRow(opts.workspaceId, opts.youtubeVideoId);

  // Fire-and-forget workflow trigger so rules like "if CTR drops below 4%
  // run a fix-the-dip" can react. Lazy import to avoid pulling the
  // workflow stack into every analytics consumer; failure must never
  // propagate (analytics sync is the source of truth).
  if (row) {
    void (async () => {
      try {
        const { dispatchWorkflowEvent } = await import('./workflows');
        await dispatchWorkflowEvent(opts.workspaceId, {
          type: 'video_analytics_synced',
          payload: {
            video_id: row.youtube_video_id,
            channel_db_id: opts.channelDbId,
            ctr_percentage: row.ctr_percentage,
            average_view_percentage: row.average_view_percentage,
            views: row.views,
            data_source: row.data_source,
          },
        });
      } catch {
        /* workflow plumbing failure must never block the sync result */
      }
    })();
  }

  return row;
}

/** Read the cached row. Throws if not found — call POST sync first. */
export async function readVideoAnalyticsRow(
  workspaceId: string,
  youtubeVideoId: string,
): Promise<VideoAnalyticsRow> {
  const { rows } = await sql<VideoAnalyticsRow>`
    SELECT
      workspace_id, youtube_video_id, channel_id, schedule_item_id,
      views, likes, comments, duration_seconds, published_at,
      title, thumbnail_url,
      impressions, ctr_percentage, average_view_duration_seconds,
      average_view_percentage, subscribers_gained, retention_curve,
      data_source, fetched_at
    FROM video_analytics
    WHERE workspace_id = ${workspaceId}::uuid
      AND youtube_video_id = ${youtubeVideoId}
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new Error('No analytics cached for this video. Run a sync first.');
  }
  return rows[0]!;
}
