/**
 * Phase 9.3 — per-video search-query performance.
 *
 * Pulls `insightTrafficSourceDetail` filtered by
 * `insightTrafficSourceType==YT_SEARCH` from YouTube Analytics. Each
 * row is one (video, query) pair with impressions / views, and we
 * recompute CTR ourselves (the detail dimension doesn't return it
 * directly).
 *
 * The point: surface SEO opportunities. A query with HIGH impressions
 * (audience is searching for it) but LOW CTR (title doesn't pull the
 * click) is a free upgrade — rewriting the title can lift the
 * existing impressions into more views with no extra distribution.
 *
 * Pure helpers (`scoreSeoOpportunities`, `parseSearchTermRows`) are
 * exported for unit tests so the math stays honest. The AI title-rewrite
 * suggestion is a separate function that takes top-N opportunities +
 * the current title and asks the workspace's configured model for a
 * rewrite — through the spend log + the model-defaults system like
 * every other AI call in the app.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { logger } from './logger';
import { getEffectiveModelId } from './model-defaults';
import { parseLlmJson } from './parse-llm-json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchTermRow {
  workspace_id: string;
  youtube_video_id: string;
  channel_id: string | null;
  search_term: string;
  impressions: number | null;
  views: number | null;
  ctr_percentage: number | null;
  captured_at: string;
}

export interface SeoOpportunity {
  search_term: string;
  impressions: number;
  views: number;
  ctr_percentage: number;
  /** 0..1 — higher = better SEO upgrade target. Combines impression
   *  volume (the bigger the audience, the more this matters) with
   *  ctr-shortfall (the gap between this query's CTR and the
   *  channel's typical CTR baseline). Pure math; computed at read
   *  time. */
  opportunity_score: number;
}

export interface TitleRewriteSuggestion {
  /** The new title, ≤100 chars per YouTube limits. */
  title: string;
  /** One-line rationale tying the rewrite to the underperforming
   *  queries — surfaces the "why" so the user can judge before
   *  applying. */
  rationale: string;
  /** The opportunities this rewrite is targeting, in the order the
   *  model considered them. */
  targets: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the YouTube Analytics `insightTrafficSourceDetail` x (impressions,
 * views) response into normalised rows. CTR is computed here because
 * the detail dimension doesn't return it directly. Drops malformed
 * rows; lowercases the term for stable trajectory grouping.
 */
export function parseSearchTermRows(raw: unknown): Array<{
  search_term: string;
  impressions: number;
  views: number;
  ctr_percentage: number;
}> {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as { rows?: unknown };
  if (!Array.isArray(obj.rows)) return [];
  const out: Array<{
    search_term: string;
    impressions: number;
    views: number;
    ctr_percentage: number;
  }> = [];
  for (const r of obj.rows) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const term = typeof r[0] === 'string' ? r[0].trim().toLowerCase() : null;
    const impressions = typeof r[1] === 'number' ? r[1] : Number(r[1]);
    const views = typeof r[2] === 'number' ? r[2] : Number(r[2]);
    if (!term || !Number.isFinite(impressions) || !Number.isFinite(views)) continue;
    if (impressions <= 0) continue; // queries with no impressions are noise
    const ctr = (views / impressions) * 100;
    out.push({
      search_term: term.slice(0, 240), // bound it
      impressions,
      views,
      ctr_percentage: Number.isFinite(ctr) ? ctr : 0,
    });
  }
  return out;
}

/**
 * Score and rank SEO opportunities. Higher score = better rewrite
 * target.
 *
 * The score combines two signals:
 *   - **Impression weight** (log-scaled so a 10× volume difference
 *     doesn't completely dominate)
 *   - **CTR shortfall** vs the supplied `baselineCtr` (the channel's
 *     overall CTR, typically 4-8%). Negative shortfall = above
 *     baseline (no opportunity); positive = candidate.
 *
 * Returns the candidates sorted by score desc, capped at `limit`.
 *
 * Pure: no DB, no I/O. Caller pre-filters to one video's rows from
 * the most-recent capture.
 */
export function scoreSeoOpportunities(
  rows: Array<{
    search_term: string;
    impressions: number;
    views: number;
    ctr_percentage: number;
  }>,
  opts: {
    baselineCtr?: number;
    minImpressions?: number;
    limit?: number;
  } = {},
): SeoOpportunity[] {
  const baseline = opts.baselineCtr ?? 5;
  const minImpressions = opts.minImpressions ?? 100;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);

  const scored: SeoOpportunity[] = [];
  for (const r of rows) {
    if (r.impressions < minImpressions) continue;
    const shortfall = baseline - r.ctr_percentage;
    if (shortfall <= 0) continue; // CTR is at or above baseline — skip
    // log10(impressions) keeps the volume signal bounded; shortfall
    // is in percentage points (so a 3pp gap counts more than 1pp).
    const score = Math.log10(r.impressions) * shortfall;
    scored.push({
      search_term: r.search_term,
      impressions: r.impressions,
      views: r.views,
      ctr_percentage: r.ctr_percentage,
      opportunity_score: score,
    });
  }
  scored.sort((a, b) => b.opportunity_score - a.opportunity_score);
  // Normalise score to 0..1 so the UI doesn't have to know the magnitude.
  if (scored.length > 0) {
    const max = scored[0]!.opportunity_score;
    if (max > 0) {
      for (const s of scored) s.opportunity_score = s.opportunity_score / max;
    }
  }
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// HTTP fetch (Analytics API)
// ---------------------------------------------------------------------------

const ANALYTICS_API_BASE =
  'https://youtubeanalytics.googleapis.com/v2/reports';

interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Fetch the per-query (insightTrafficSourceDetail) breakdown for one
 * video, filtered to YT_SEARCH so we only get search queries (not
 * playlist names, end-screen sources, etc). Soft-fails to null on any
 * HTTP error (the parent sync continues; this row stays empty).
 */
async function fetchSearchTermRows(
  accessToken: string,
  youtubeChannelId: string,
  videoId: string,
  range: DateRange,
): Promise<unknown> {
  const params = new URLSearchParams({
    ids: `channel==${youtubeChannelId}`,
    metrics: 'impressions,views',
    dimensions: 'insightTrafficSourceDetail',
    filters: `video==${videoId};insightTrafficSourceType==YT_SEARCH`,
    startDate: range.startDate,
    endDate: range.endDate,
    maxResults: '50',
    sort: '-impressions',
  });
  const res = await fetch(`${ANALYTICS_API_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// DB sync + read
// ---------------------------------------------------------------------------

const PER_SYNC_ROW_CAP = 50;

/**
 * Sync search-term rows for one video. Called from syncVideoAnalytics
 * after the live row upsert; soft-fails on any error so the parent
 * sync still completes. Returns the number of rows written (0 on
 * soft-fail / no data).
 */
export async function syncSearchTermsForVideo(opts: {
  workspaceId: string;
  channelDbId: string;
  youtubeChannelId: string;
  youtubeVideoId: string;
  accessToken: string;
  startDate: string;
  endDate: string;
}): Promise<number> {
  let raw: unknown;
  try {
    raw = await fetchSearchTermRows(
      opts.accessToken,
      opts.youtubeChannelId,
      opts.youtubeVideoId,
      { startDate: opts.startDate, endDate: opts.endDate },
    );
  } catch (err) {
    logger.warn('search-terms fetch failed', {
      youtube_video_id: opts.youtubeVideoId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  const parsed = parseSearchTermRows(raw);
  if (parsed.length === 0) return 0;

  const capped = parsed.slice(0, PER_SYNC_ROW_CAP);
  // Single transaction: insert all rows for one captured_at tick.
  // We use ON CONFLICT DO NOTHING so a race in the cron (rare —
  // captured_at is per-call NOW()) doesn't break.
  let inserted = 0;
  for (const r of capped) {
    try {
      const result = await sql`
        INSERT INTO video_search_terms (
          workspace_id, youtube_video_id, channel_id,
          search_term, impressions, views, ctr_percentage
        ) VALUES (
          ${opts.workspaceId}::uuid,
          ${opts.youtubeVideoId},
          ${opts.channelDbId}::uuid,
          ${r.search_term},
          ${r.impressions},
          ${r.views},
          ${r.ctr_percentage}
        )
        ON CONFLICT (workspace_id, youtube_video_id, search_term, captured_at) DO NOTHING
      `;
      if ((result.rowCount ?? 0) > 0) inserted += 1;
    } catch (err) {
      logger.warn('search-terms insert failed for one row', {
        youtube_video_id: opts.youtubeVideoId,
        search_term: r.search_term,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return inserted;
}

/**
 * Pull the most recent search-term snapshot for one video. Used by
 * the SEO opportunities panel + the AI title-rewrite suggestion.
 *
 * "Most recent" = the rows whose captured_at is within 1 hour of the
 * latest captured_at for this video — handles the case where the
 * sync writes 50 rows in a tight loop (each gets a slightly different
 * timestamp via DEFAULT NOW()).
 */
export async function getLatestSearchTerms(
  workspaceId: string,
  youtubeVideoId: string,
): Promise<SearchTermRow[]> {
  const { rows } = await sql<SearchTermRow>`
    WITH latest AS (
      SELECT MAX(captured_at) AS max_at
        FROM video_search_terms
       WHERE workspace_id = ${workspaceId}::uuid
         AND youtube_video_id = ${youtubeVideoId}
    )
    SELECT
      workspace_id, youtube_video_id, channel_id,
      search_term, impressions, views, ctr_percentage,
      captured_at::text AS captured_at
    FROM video_search_terms, latest
    WHERE workspace_id = ${workspaceId}::uuid
      AND youtube_video_id = ${youtubeVideoId}
      AND captured_at > (latest.max_at - INTERVAL '1 hour')
    ORDER BY impressions DESC
    LIMIT 100
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// AI title-rewrite suggestion
// ---------------------------------------------------------------------------

/**
 * Ask the workspace's configured model to rewrite a title that
 * targets the top-N SEO opportunities. Returns null on parse failure
 * or empty input.
 *
 * Goes through `getEffectiveModelId(ws, 'seo-title-rewrite')` so
 * workspace owners can override the default; spend is logged through
 * the standard `spend` context.
 */
export async function suggestTitleRewrite(opts: {
  workspaceId: string;
  projectId?: string | null;
  channelDbId?: string | null;
  currentTitle: string;
  opportunities: SeoOpportunity[];
}): Promise<TitleRewriteSuggestion | null> {
  if (opts.opportunities.length === 0) return null;

  const modelId = await getEffectiveModelId(opts.workspaceId, 'seo-title-rewrite');

  const top = opts.opportunities.slice(0, 5);
  const oppLines = top
    .map(
      (o, i) =>
        `${i + 1}. "${o.search_term}" — ${o.impressions.toLocaleString()} impressions, CTR ${o.ctr_percentage.toFixed(1)}%`,
    )
    .join('\n');

  // System prompt is byte-stable so prompt caching applies.
  const system = `You rewrite YouTube titles to capture missed search demand without misrepresenting the content.

Strict rules:
1. Output STRICTLY this JSON shape:
{
  "title": "<new title, ≤100 chars>",
  "rationale": "<one short line explaining which queries you targeted and why this rewrite captures them>",
  "targets": ["<query 1>", "<query 2>"]
}
2. Title must be ≤100 chars (YouTube limit).
3. Title must not promise content the original doesn't deliver — read the current title carefully and stay within scope.
4. Prefer naturally weaving the highest-impression query into the first 50 chars (where mobile truncates).
5. Don't stuff multiple queries clumsily. One or two well-placed phrases beat three crammed ones.
6. NEVER use clickbait that doesn't match the original meaning.

Output JSON only.`;

  const user = `Current title:
"""
${opts.currentTitle}
"""

Top underperforming search queries (high impressions, low CTR — the audience is searching but not clicking):
${oppLines}

Output JSON only.`;

  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 800,
    temperature: 0.5,
    cache: true,
    spend: {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId ?? null,
      channelDbId: opts.channelDbId ?? null,
      featureArea: 'seo_title_rewrite',
      metadata: { opportunity_count: top.length },
    },
  });

  try {
    const parsed = parseLlmJson(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as { title?: unknown; rationale?: unknown; targets?: unknown };
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 100) : '';
    const rationale = typeof o.rationale === 'string' ? o.rationale.trim().slice(0, 300) : '';
    const targets = Array.isArray(o.targets)
      ? o.targets.filter((t): t is string => typeof t === 'string').slice(0, 5)
      : [];
    if (!title) return null;
    return { title, rationale, targets };
  } catch (err) {
    logger.warn('SEO title-rewrite parse failed', {
      detail: err instanceof Error ? err.message : String(err),
      raw_preview: raw.slice(0, 200),
    });
    return null;
  }
}
