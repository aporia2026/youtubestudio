/**
 * Niche Brief persistence — separate file from `favorites.ts` because
 * brief CRUD has its own access patterns (versioning, cron retries,
 * monthly spend rollup) that aren't called from the wider favorites
 * surface.
 *
 * Every query is workspace-scoped. The brief table cascades on the
 * parent favorite — when the operator hard-purges a favorite, every
 * historical brief goes with it.
 */
import { sql } from '@vercel/postgres';
import type { NicheScores } from './types';
import type {
  BriefSections,
  ConfidenceLabel,
  OperatorContext,
  ParsedBrief,
  PromiseLabel,
  SectionConfidences,
} from './brief';
import type { BriefCitation, PerplexityUsage } from '@/lib/ai/perplexity-deep-research';

/** Lifecycle status of a brief row. Mirrors the CHECK constraint in
 *  migration 0063. */
export type BriefStatus = 'pending' | 'running' | 'ready' | 'failed';

/** Maximum attempts before the cron stops retrying a failed brief. */
export const MAX_BRIEF_ATTEMPTS = 3;

export interface BriefRow {
  id: string;
  workspace_id: string;
  niche_slug: string;
  model_id: string;
  sections: BriefSections;
  promise_score: number;
  promise_label: PromiseLabel;
  section_confidences: SectionConfidences;
  citations: BriefCitation[] | null;
  operator_context: OperatorContext;
  scores_snapshot: NicheScores;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  status: BriefStatus;
  attempts: number;
  error_message: string | null;
  generated_at: string;
}

/** Insert a fresh `status='pending'` row. The brief generator picks
 *  it up immediately (inline kickoff) OR the cron picks it up within
 *  5 min (safety net). Returns the new row's id. */
export async function createPendingBrief(args: {
  workspaceId: string;
  nicheSlug: string;
  modelId: string;
  operatorContext: OperatorContext;
  scoresSnapshot: NicheScores;
}): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO niche_favorite_briefs (
      workspace_id, niche_slug, model_id,
      sections, promise_score, section_confidences,
      operator_context, scores_snapshot,
      status
    )
    VALUES (
      ${args.workspaceId}::uuid,
      ${args.nicheSlug},
      ${args.modelId},
      '{}'::jsonb,
      0,
      '{}'::jsonb,
      ${JSON.stringify(args.operatorContext)}::jsonb,
      ${JSON.stringify(args.scoresSnapshot)}::jsonb,
      'pending'
    )
    RETURNING id::text
  `;
  return rows[0].id;
}

/** Move a 'pending' brief to 'running' immediately before the
 *  Perplexity call. Idempotent on the (workspace, brief id) match;
 *  returns false when the row no longer qualifies (already-completed
 *  by another worker / failed too many times). */
export async function markBriefRunning(args: {
  workspaceId: string;
  briefId: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE niche_favorite_briefs
       SET status = 'running',
           attempts = attempts + 1
     WHERE id = ${args.briefId}::uuid
       AND workspace_id = ${args.workspaceId}::uuid
       AND status IN ('pending', 'failed')
       AND attempts < ${MAX_BRIEF_ATTEMPTS}
  `;
  return (rowCount ?? 0) > 0;
}

/** Write the successful brief output back. */
export async function completeBrief(args: {
  workspaceId: string;
  briefId: string;
  parsed: ParsedBrief;
}): Promise<void> {
  const p = args.parsed;
  await sql`
    UPDATE niche_favorite_briefs
       SET sections             = ${JSON.stringify(p.sections)}::jsonb,
           promise_score        = ${p.promise_score},
           section_confidences  = ${JSON.stringify(p.section_confidences)}::jsonb,
           citations            = ${JSON.stringify(p.citations)}::jsonb,
           prompt_tokens        = ${p.usage.prompt_tokens},
           completion_tokens    = ${p.usage.completion_tokens},
           cost_usd             = ${p.cost_usd},
           status               = 'ready',
           error_message        = NULL,
           generated_at         = NOW()
     WHERE id = ${args.briefId}::uuid
       AND workspace_id = ${args.workspaceId}::uuid
  `;
  // Bump the parent favorite so the Favorites tab sort reflects the
  // fresh brief activity.
  await sql`
    UPDATE niche_favorites
       SET updated_at = NOW()
     WHERE workspace_id = ${args.workspaceId}::uuid
       AND niche_slug   = (
         SELECT niche_slug FROM niche_favorite_briefs WHERE id = ${args.briefId}::uuid LIMIT 1
       )
  `;
}

/** Mark a brief as failed + record the error. The cron retries up to
 *  MAX_BRIEF_ATTEMPTS before leaving it permanently failed. */
export async function failBrief(args: {
  workspaceId: string;
  briefId: string;
  errorMessage: string;
}): Promise<void> {
  await sql`
    UPDATE niche_favorite_briefs
       SET status        = 'failed',
           error_message = ${args.errorMessage.slice(0, 2000)}
     WHERE id = ${args.briefId}::uuid
       AND workspace_id = ${args.workspaceId}::uuid
  `;
}

/** Fetch a brief row by id, scoped to the workspace. Used by the
 *  background runner + retry cron to pick up the row's stored
 *  `model_id` + `niche_slug` after a fresh claim. */
export async function getBriefById(
  workspaceId: string,
  briefId: string,
): Promise<BriefRow | null> {
  const { rows } = await sql<RawBriefRow>`
    SELECT
      id::text, workspace_id::text, niche_slug, model_id,
      sections, promise_score, section_confidences, citations,
      operator_context, scores_snapshot,
      prompt_tokens, completion_tokens, cost_usd::float8 AS cost_usd,
      status, attempts, error_message,
      generated_at::text AS generated_at
    FROM niche_favorite_briefs
    WHERE workspace_id = ${workspaceId}::uuid
      AND id           = ${briefId}::uuid
    LIMIT 1
  `;
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Most recent successful brief for a niche, or `null` if none. The
 *  brief card UI uses this for the active brief display. */
export async function getActiveBrief(
  workspaceId: string,
  nicheSlug: string,
): Promise<BriefRow | null> {
  const { rows } = await sql<RawBriefRow>`
    SELECT
      id::text, workspace_id::text, niche_slug, model_id,
      sections, promise_score, section_confidences, citations,
      operator_context, scores_snapshot,
      prompt_tokens, completion_tokens, cost_usd::float8 AS cost_usd,
      status, attempts, error_message,
      generated_at::text AS generated_at
    FROM niche_favorite_briefs
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
      AND status       = 'ready'
    ORDER BY generated_at DESC
    LIMIT 1
  `;
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Latest brief row regardless of status — used by the UI to render
 *  shimmer / error states when a brief is in flight. */
export async function getLatestBrief(
  workspaceId: string,
  nicheSlug: string,
): Promise<BriefRow | null> {
  const { rows } = await sql<RawBriefRow>`
    SELECT
      id::text, workspace_id::text, niche_slug, model_id,
      sections, promise_score, section_confidences, citations,
      operator_context, scores_snapshot,
      prompt_tokens, completion_tokens, cost_usd::float8 AS cost_usd,
      status, attempts, error_message,
      generated_at::text AS generated_at
    FROM niche_favorite_briefs
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
    ORDER BY generated_at DESC
    LIMIT 1
  `;
  return rows[0] ? hydrate(rows[0]) : null;
}

/** Version history for the brief panel's "View previous versions"
 *  affordance. Capped at 20 — beyond that we're hoarding. */
export async function listBriefVersions(
  workspaceId: string,
  nicheSlug: string,
): Promise<BriefRow[]> {
  const { rows } = await sql<RawBriefRow>`
    SELECT
      id::text, workspace_id::text, niche_slug, model_id,
      sections, promise_score, section_confidences, citations,
      operator_context, scores_snapshot,
      prompt_tokens, completion_tokens, cost_usd::float8 AS cost_usd,
      status, attempts, error_message,
      generated_at::text AS generated_at
    FROM niche_favorite_briefs
    WHERE workspace_id = ${workspaceId}::uuid
      AND niche_slug   = ${nicheSlug}
    ORDER BY generated_at DESC
    LIMIT 20
  `;
  return rows.map(hydrate);
}

/** Briefs the cron should retry: pending or failed, under the attempt
 *  cap, sitting for at least 30s (so the inline kickoff has had a
 *  chance to finish before the cron piles on). Capped at
 *  `MAX_BRIEFS_PER_RUN` so a single cron tick doesn't exhaust the
 *  Vercel function budget. */
export async function listBriefsDueForRetry(
  maxPerRun: number,
): Promise<Pick<BriefRow, 'id' | 'workspace_id' | 'niche_slug' | 'model_id'>[]> {
  const { rows } = await sql<{
    id: string;
    workspace_id: string;
    niche_slug: string;
    model_id: string;
  }>`
    SELECT id::text, workspace_id::text, niche_slug, model_id
      FROM niche_favorite_briefs
     WHERE status IN ('pending', 'failed')
       AND attempts < ${MAX_BRIEF_ATTEMPTS}
       AND generated_at < NOW() - INTERVAL '30 seconds'
     ORDER BY generated_at ASC
     LIMIT ${maxPerRun}
  `;
  return rows;
}

/** Sum of cost_usd across all 'ready' briefs in the current calendar
 *  month for the workspace. Powers the Favorites tab header caption
 *  ("Spent this month on briefs: $X.XX"). */
export async function getMonthlyBriefSpend(workspaceId: string): Promise<number> {
  const { rows } = await sql<{ total: number | null }>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total
      FROM niche_favorite_briefs
     WHERE workspace_id = ${workspaceId}::uuid
       AND status       = 'ready'
       AND cost_usd IS NOT NULL
       AND generated_at >= date_trunc('month', NOW())
  `;
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Row hydration — Postgres returns JSONB columns as objects already, but
// we still validate the shapes coming back so downstream type assertions
// don't blow up on a hand-edited row.
// ---------------------------------------------------------------------------

interface RawBriefRow {
  id: string;
  workspace_id: string;
  niche_slug: string;
  model_id: string;
  sections: unknown;
  promise_score: number;
  section_confidences: unknown;
  citations: unknown;
  operator_context: unknown;
  scores_snapshot: unknown;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  status: BriefStatus;
  attempts: number;
  error_message: string | null;
  generated_at: string;
}

function hydrate(raw: RawBriefRow): BriefRow {
  return {
    id: raw.id,
    workspace_id: raw.workspace_id,
    niche_slug: raw.niche_slug,
    model_id: raw.model_id,
    sections: (raw.sections ?? {}) as BriefSections,
    promise_score: raw.promise_score,
    promise_label: promiseLabelFor(raw.promise_score),
    section_confidences: (raw.section_confidences ?? {}) as SectionConfidences,
    citations: raw.citations === null ? null : (raw.citations as BriefCitation[]),
    operator_context: (raw.operator_context ?? {
      channel_description: null,
      channel_name: null,
      produced_niches: [],
      interest_tags: [],
    }) as OperatorContext,
    scores_snapshot: (raw.scores_snapshot ?? null) as NicheScores,
    prompt_tokens: raw.prompt_tokens,
    completion_tokens: raw.completion_tokens,
    cost_usd: raw.cost_usd,
    status: raw.status,
    attempts: raw.attempts,
    error_message: raw.error_message,
    generated_at: raw.generated_at,
  };
}

/** Mirrors the same function in brief.ts but stays local here so this
 *  module doesn't import the prompt-builder layer. */
function promiseLabelFor(score: number): PromiseLabel {
  if (score >= 80) return 'Strong';
  if (score >= 60) return 'Solid';
  if (score >= 40) return 'Marginal';
  return 'Weak';
}

// Re-export ConfidenceLabel so the UI layer can import everything
// brief-related from this file without a second import path.
export type { ConfidenceLabel };

/** Usage tuple stored on the row — re-exported for clients that need
 *  to read the SDK shape back out without crossing the brief.ts
 *  prompt-layer boundary. */
export type BriefUsage = PerplexityUsage;
