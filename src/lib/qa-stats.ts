/**
 * Query helpers for the QA-stats page.
 *
 * All queries are workspace-scoped at the database level. The page (server
 * component) calls these from inside `requireUser()`'s session, which
 * provides `session.ws` — never trust a workspace id passed from the client.
 *
 * The stats answer one question: is QA hardening actually working?
 * Specifically we surface:
 *   - First-pass score distribution per preset (last 200 panels). The
 *     Lever B (pre-QA self-check) and Lever A (rubric tightening) should
 *     move this distribution rightward over time.
 *   - Iteration counts per video. The number of qa_retry loops to pass.
 *     Lever B should reduce this; if it doesn't, we know to keep tuning.
 *   - Pre-QA self-check decision tally. Are rewrites happening, or is the
 *     self-critic too lenient and keeping everything as-is?
 *
 * Queries are bounded (LIMIT N) so a workspace with thousands of historical
 * runs still loads the page in one trip. The page is read-only, no caching
 * primitives wired in — Next.js's default request memo is enough.
 */
import { sql } from '@vercel/postgres';

export interface FirstPassScoreRow {
  preset_id: string | null;
  preset_name: string;
  score: number;
  aggressiveness: 'standard' | 'brutal' | 'nuclear';
  completed_at: string;
}

export interface IterationRow {
  retry_count: number;
  terminal_stage: string;
  completed_at: string;
}

export interface SelfCheckTallyRow {
  decision: 'kept' | 'rewrote';
  count: number;
}

export interface QaStatsSnapshot {
  firstPassScores: FirstPassScoreRow[];
  iterations: IterationRow[];
  selfCheckTally: SelfCheckTallyRow[];
  /** Workspace's total auto-pipeline videos in the queried window — the
   *  denominator when reporting percentages. */
  totalAutoVideos: number;
}

/**
 * Snapshot the workspace's recent auto-pipeline QA outcomes. Bound by
 * `panelLimit` and `videoLimit` to keep the query fast even on a busy
 * workspace.
 */
export async function loadQaStatsSnapshot(
  workspaceId: string,
  opts: { panelLimit?: number; videoLimit?: number } = {},
): Promise<QaStatsSnapshot> {
  const panelLimit = opts.panelLimit ?? 200;
  const videoLimit = opts.videoLimit ?? 200;

  // First-pass scores: the panel that ran on a pipeline_run_video's pass 1.
  // We join through pipeline_run_videos so we only count panels created by
  // the auto-pipeline (the manual /qa page also writes critic_panels but
  // doesn't link them through a pipeline_run_video — those are excluded
  // from this view).
  const firstPassRes = await sql<FirstPassScoreRow & { score_raw: string | null }>`
    SELECT
      pr.preset_id::text AS preset_id,
      pp.name           AS preset_name,
      (cp.verdict->>'overall_score') AS score_raw,
      cp.aggressiveness AS aggressiveness,
      cp.completed_at::text AS completed_at
    FROM critic_panels cp
    JOIN pipeline_run_videos prv ON prv.critic_panel_id = cp.id
    JOIN pipeline_runs pr        ON pr.id = prv.pipeline_run_id
    LEFT JOIN pipeline_presets pp ON pp.id = pr.preset_id
    WHERE cp.workspace_id = ${workspaceId}::uuid
      AND cp.pass_number = 1
      AND cp.status = 'completed'
      AND cp.verdict IS NOT NULL
    ORDER BY cp.completed_at DESC
    LIMIT ${panelLimit}
  `;
  const firstPassScores: FirstPassScoreRow[] = firstPassRes.rows
    .map(r => ({
      preset_id: r.preset_id,
      preset_name: r.preset_name || 'Unknown preset',
      score: Number(r.score_raw) || 0,
      aggressiveness: r.aggressiveness,
      completed_at: r.completed_at,
    }))
    .filter(r => Number.isFinite(r.score));

  // Iteration counts: every pipeline_run_video that has reached a stage
  // past running_qa. retry_count is the number of qa_retry loops it took
  // to clear QA (0 means it passed on the first attempt).
  const POST_QA_STAGES = [
    'narration_complete',
    'waiting_narration',
    'narration_overdue',
    'generating_production_doc',
    'generating_thumbnail',
    'assigning_to_editor',
    'generating_seo',
    'done',
    'qa_failed_after_max_retries',
  ];
  const iterRes = await sql.query<IterationRow>(
    `
    SELECT
      retry_count,
      stage AS terminal_stage,
      updated_at::text AS completed_at
    FROM pipeline_run_videos
    WHERE workspace_id = $1::uuid
      AND stage = ANY($2::text[])
    ORDER BY updated_at DESC
    LIMIT $3
    `,
    [workspaceId, POST_QA_STAGES, videoLimit],
  );

  // Pre-QA self-check decisions: read from pipeline_stage_artefacts where
  // artefact_kind = 'pre_qa_self_check'. The metadata JSONB carries the
  // decision (kept | rewrote). Skipped/disabled cases are NOT written as
  // artefacts (see generate-script.ts) so they don't appear here.
  const selfCheckRes = await sql<SelfCheckTallyRow & { count_raw: string }>`
    SELECT
      metadata_jsonb->>'decision' AS decision,
      COUNT(*)::text              AS count_raw
    FROM pipeline_stage_artefacts psa
    JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
    WHERE prv.workspace_id = ${workspaceId}::uuid
      AND psa.artefact_kind = 'pre_qa_self_check'
    GROUP BY metadata_jsonb->>'decision'
  `;
  const selfCheckTally: SelfCheckTallyRow[] = selfCheckRes.rows
    .map(r => ({ decision: r.decision, count: Number(r.count_raw) || 0 }))
    .filter(r => r.decision === 'kept' || r.decision === 'rewrote');

  // Total auto-pipeline videos in the queried window. Used as the
  // denominator for "X out of Y videos reached this stage."
  const totalRes = await sql<{ total: string }>`
    SELECT COUNT(*)::text AS total
    FROM pipeline_run_videos
    WHERE workspace_id = ${workspaceId}::uuid
  `;
  const totalAutoVideos = Number(totalRes.rows[0]?.total) || 0;

  return {
    firstPassScores,
    iterations: iterRes.rows,
    selfCheckTally,
    totalAutoVideos,
  };
}

/**
 * Compute a histogram from raw scores. Buckets chosen to be visually
 * obvious: anything below 60 is "weak," 60-75 is "mediocre," 75-85 is
 * "solid," 85-94 is "strong," 95-100 is "ship-ready." Matches the
 * critic-panel scoring calibration in src/lib/script-critics/prompts.ts.
 */
export const SCORE_BUCKETS = [
  { min: 0,  max: 59,  label: '<60' },
  { min: 60, max: 74,  label: '60-74' },
  { min: 75, max: 84,  label: '75-84' },
  { min: 85, max: 94,  label: '85-94' },
  { min: 95, max: 100, label: '95-100' },
] as const;

export function bucketScores(scores: number[]): Array<{ label: string; count: number; pct: number }> {
  if (scores.length === 0) return SCORE_BUCKETS.map(b => ({ label: b.label, count: 0, pct: 0 }));
  return SCORE_BUCKETS.map(b => {
    const count = scores.filter(s => s >= b.min && s <= b.max).length;
    return { label: b.label, count, pct: (count / scores.length) * 100 };
  });
}

export function bucketIterations(retryCounts: number[]): Array<{ label: string; count: number; pct: number }> {
  if (retryCounts.length === 0) {
    return ['0 retries', '1 retry', '2 retries', '3+ retries'].map(label => ({ label, count: 0, pct: 0 }));
  }
  const buckets = [
    { label: '0 retries', test: (n: number) => n === 0 },
    { label: '1 retry',   test: (n: number) => n === 1 },
    { label: '2 retries', test: (n: number) => n === 2 },
    { label: '3+ retries', test: (n: number) => n >= 3 },
  ];
  return buckets.map(b => {
    const count = retryCounts.filter(b.test).length;
    return { label: b.label, count, pct: (count / retryCounts.length) * 100 };
  });
}

export function meanScore(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
