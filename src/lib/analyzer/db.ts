/**
 * Workspace-scoped DB helpers for the YouTube video analyzer cache
 * (table created by migration 0074).
 *
 * Every read AND every write enforces workspace scope. Cross-workspace
 * access returns null (matches the project's 404-not-403 pattern from
 * the Phase 8 audit — never disclose existence of resources in other
 * workspaces).
 *
 * The cache key is `(workspace_id, video_id, analyzer_version,
 * prompt_version)`. Bumping ANALYZER_VERSION or PROMPT_VERSION in
 * `./types.ts` invalidates all prior rows cleanly: cache lookups now
 * miss for the old keys, and the operator's "Re-analyze" UX produces
 * fresh rows under the new version.
 *
 * The `force` argument on `findCachedAnalysis` is the "Re-analyze"
 * escape hatch: when true, an existing `done` row at the current
 * version is DELETEd in the same transaction as the new `analyzing`
 * row insert, so the POST handler can replace stale results without
 * a separate round-trip.
 */

import { sql } from '@/lib/db';
import { ANALYZER_VERSION, PROMPT_VERSION, type AnalysisStage, type AnalyzedVideo } from './types';

export type { AnalysisStage };

export interface YoutubeAnalysisRow {
  id: string;
  workspace_id: string;
  requested_by: string;
  video_id: string;
  video_url: string;
  video_title: string | null;
  channel_title: string | null;
  model_id: string;
  analyzer_version: string;
  prompt_version: string;
  stage: AnalysisStage;
  failure_reason: string | null;
  result_jsonb: AnalyzedVideo | null;
  cost_usd: string;
  created_at: Date;
  completed_at: Date | null;
}

// ─── Reads ─────────────────────────────────────────────────────────

/**
 * Returns the existing row for a (workspace, video) pair at the
 * CURRENT version pair, regardless of stage. The route uses this to
 * branch on stage explicitly:
 *   - `done`      → return cached result (instant cache hit)
 *   - `analyzing` → return 202 (a prior request is in flight)
 *   - `failed`    → treat as silent retry (DELETE + INSERT fresh)
 *
 * Returning the row at every stage avoids a unique-constraint race
 * where a prior `failed` row blocks the next INSERT: filtering
 * `stage <> 'failed'` here would hide it from the cache check, the
 * route would call `insertAnalysisRow(force=false)` which skips the
 * DELETE, and the new INSERT would hit the UNIQUE.
 */
export async function findCachedAnalysis(input: {
  workspaceId: string;
  videoId: string;
}): Promise<YoutubeAnalysisRow | null> {
  const { rows } = await sql<YoutubeAnalysisRow>`
    SELECT id, workspace_id, requested_by, video_id, video_url, video_title,
           channel_title, model_id, analyzer_version, prompt_version, stage,
           failure_reason, result_jsonb, cost_usd, created_at, completed_at
      FROM youtube_analyses
     WHERE workspace_id = ${input.workspaceId}::uuid
       AND video_id = ${input.videoId}
       AND analyzer_version = ${ANALYZER_VERSION}
       AND prompt_version = ${PROMPT_VERSION}
     ORDER BY created_at DESC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Workspace-scoped fetch by primary key. Returns null on cross-
 * workspace access (the GET route maps that to 404).
 */
export async function getAnalysisById(input: {
  workspaceId: string;
  analysisId: string;
}): Promise<YoutubeAnalysisRow | null> {
  const { rows } = await sql<YoutubeAnalysisRow>`
    SELECT id, workspace_id, requested_by, video_id, video_url, video_title,
           channel_title, model_id, analyzer_version, prompt_version, stage,
           failure_reason, result_jsonb, cost_usd, created_at, completed_at
      FROM youtube_analyses
     WHERE id = ${input.analysisId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Reverse-chronological list for the /analyze page's recent-analyses
 * panel. Caps at 50 — the panel is meant to remind the operator of
 * what they've recently looked at, not be a historical archive.
 *
 * Optional `q` does case-insensitive substring matching across both
 * video_title and channel_title — the two fields visible on each row,
 * so the search field matches what the operator can already see.
 * Optional `stage` filters to a single AnalysisStage. Both are
 * additive — passing neither preserves the original "latest N rows"
 * behavior unchanged.
 */
export async function listRecentAnalyses(input: {
  workspaceId: string;
  limit?: number;
  q?: string;
  stage?: AnalysisStage;
}): Promise<YoutubeAnalysisRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
  const trimmedQ = input.q?.trim() ?? '';
  const qLike = trimmedQ ? `%${trimmedQ}%` : null;
  const stage = input.stage ?? null;

  // Single parameterised query covering all four combinations of
  // (q present/absent) × (stage present/absent). Postgres handles
  // the NULL short-circuit cleanly: when qLike is NULL the ILIKE
  // disjunction evaluates to NULL which short-circuits to TRUE under
  // the `OR qLike IS NULL` wrapping; same for stage.
  const { rows } = await sql<YoutubeAnalysisRow>`
    SELECT id, workspace_id, requested_by, video_id, video_url, video_title,
           channel_title, model_id, analyzer_version, prompt_version, stage,
           failure_reason, result_jsonb, cost_usd, created_at, completed_at
      FROM youtube_analyses
     WHERE workspace_id = ${input.workspaceId}::uuid
       AND (
         ${qLike}::text IS NULL
         OR video_title ILIKE ${qLike}
         OR channel_title ILIKE ${qLike}
       )
       AND (${stage}::text IS NULL OR stage = ${stage})
     ORDER BY created_at DESC
     LIMIT ${limit}
  `;
  return rows;
}

/**
 * Workspace-scoped hard delete. Returns true when a row matched and
 * was removed, false when the id didn't exist in this workspace —
 * the route maps `false` to 404, matching the 404-not-403 pattern
 * the rest of the analyzer routes use to avoid disclosing the
 * existence of cross-workspace rows.
 */
export async function deleteAnalysis(input: {
  workspaceId: string;
  analysisId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    DELETE FROM youtube_analyses
     WHERE id = ${input.analysisId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Count of analyses created by a given user in the last 24 hours,
 * inside their workspace. Used to enforce the per-user daily cap.
 */
export async function dailyAnalysisCountForUser(input: {
  workspaceId: string;
  requestedBy: string;
}): Promise<number> {
  const { rows } = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count
      FROM youtube_analyses
     WHERE workspace_id = ${input.workspaceId}::uuid
       AND requested_by = ${input.requestedBy}
       AND created_at > NOW() - INTERVAL '24 hours'
  `;
  return Number(rows[0]?.count ?? '0');
}

/**
 * Per-user daily cap for THIS workspace. Returns the override stored
 * on `workspaces.analyses_per_user_per_day_override` when set,
 * otherwise the supplied default. Admins set the override via
 * `/api/admin/workspaces/[id]/analyzer-cap`.
 *
 * Set to 0 to disable analyses for the workspace; any positive
 * integer raises (or lowers) the per-user cap from the default.
 */
export async function getWorkspaceAnalysisCap(input: {
  workspaceId: string;
  defaultCap: number;
}): Promise<number> {
  const { rows } = await sql<{ override: number | null }>`
    SELECT analyses_per_user_per_day_override AS override
      FROM workspaces
     WHERE id = ${input.workspaceId}::uuid
     LIMIT 1
  `;
  const override = rows[0]?.override;
  if (override == null) return input.defaultCap;
  return override;
}

// ─── Writes ────────────────────────────────────────────────────────

/**
 * Insert a fresh row at `stage = 'analyzing'` and return its id. The
 * caller will either UPDATE it to `done` with the result or `failed`
 * with a reason, depending on how Gemini's call resolves.
 *
 * When `force` is true and a `done` row already exists at this
 * version, the prior row is DELETEd first so the UNIQUE constraint
 * doesn't trip.
 */
export async function insertAnalysisRow(input: {
  workspaceId: string;
  requestedBy: string;
  videoId: string;
  videoUrl: string;
  videoTitle: string | null;
  channelTitle: string | null;
  modelId: string;
  force: boolean;
}): Promise<string> {
  if (input.force) {
    await sql`
      DELETE FROM youtube_analyses
       WHERE workspace_id = ${input.workspaceId}::uuid
         AND video_id = ${input.videoId}
         AND analyzer_version = ${ANALYZER_VERSION}
         AND prompt_version = ${PROMPT_VERSION}
    `;
  }
  const { rows } = await sql<{ id: string }>`
    INSERT INTO youtube_analyses
      (workspace_id, requested_by, video_id, video_url, video_title,
       channel_title, model_id, analyzer_version, prompt_version, stage)
    VALUES
      (${input.workspaceId}::uuid, ${input.requestedBy}, ${input.videoId},
       ${input.videoUrl}, ${input.videoTitle}, ${input.channelTitle},
       ${input.modelId}, ${ANALYZER_VERSION}, ${PROMPT_VERSION}, 'analyzing')
    RETURNING id
  `;
  return rows[0].id;
}

export async function completeAnalysis(input: {
  workspaceId: string;
  analysisId: string;
  result: AnalyzedVideo;
  costUsd: number;
}): Promise<void> {
  await sql`
    UPDATE youtube_analyses
       SET stage = 'done',
           result_jsonb = ${JSON.stringify(input.result)}::jsonb,
           cost_usd = ${input.costUsd},
           completed_at = NOW()
     WHERE id = ${input.analysisId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid
  `;
}

export async function failAnalysis(input: {
  workspaceId: string;
  analysisId: string;
  reason: string;
  costUsd: number;
}): Promise<void> {
  // Cap the reason at 1000 chars to match the orchestrator's pattern
  // (failStage in src/lib/auto-pipeline/db.ts also truncates at 1000).
  await sql`
    UPDATE youtube_analyses
       SET stage = 'failed',
           failure_reason = ${input.reason.slice(0, 1000)},
           cost_usd = ${input.costUsd},
           completed_at = NOW()
     WHERE id = ${input.analysisId}::uuid
       AND workspace_id = ${input.workspaceId}::uuid
  `;
}
