/**
 * Cross-channel cannibalization detector.
 *
 * Multi-channel YouTubers regularly stub their own toes by uploading two
 * videos that compete for the same audience in the same week. This
 * module:
 *
 *   1. Loads every scheduled (`schedule_items`) and recent published
 *      (`video_analytics`) upload across the workspace, with channel
 *      attribution.
 *   2. Groups them into a publication window (default ±21 days from
 *      today, configurable).
 *   3. Computes pairwise lexical similarity (Jaccard over significant
 *      tokens) for every cross-channel pair within the window. Same-
 *      channel pairs are ignored — that's a release cadence question,
 *      not cannibalization.
 *   4. For pairs above CANNIBAL_LEXICAL_THRESHOLD, asks the model for a
 *      one-paragraph "why this overlaps" + one concrete fix.
 *   5. Persists each evaluated pair as a `cannibalization_alerts` row;
 *      the dedup index skips duplicates within the same workspace.
 *
 * Pure helpers (tokenize, lexicalSimilarity, findCrossChannelPairs)
 * are exported for unit tests so the LLM call is the only thing that
 * needs to be mocked.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import {
  CANNIBAL_DEFAULT_LOOKAHEAD_DAYS,
  CANNIBAL_DEFAULT_LOOKBACK_DAYS,
  CANNIBAL_DEFAULT_WINDOW_DAYS,
  CANNIBAL_LEXICAL_THRESHOLD,
  CANNIBAL_MAX_AI_PAIRS,
  type CannibalSide,
  type CannibalizationAlertRow,
  type CannibalizationScanResult,
  type CannibalRiskLevel,
} from './cannibalization-types';

export type {
  CannibalSide,
  CannibalSideKind,
  CannibalRiskLevel,
  CannibalAlertStatus,
  CannibalizationAlertRow,
  CannibalizationScanResult,
} from './cannibalization-types';

const DEFAULT_CANNIBAL_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Stop-words stripped from titles before similarity scoring. Matters more
 *  for cannibalization than for general NLP — "how to fix your" appearing
 *  in both titles isn't a real overlap signal. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'just', 'me', 'my', 'no',
  'not', 'of', 'on', 'one', 'or', 'so', 'than', 'that', 'the', 'their', 'them',
  'they', 'this', 'to', 'top', 'video', 'videos', 'was', 'we', 'were', 'what',
  'when', 'why', 'will', 'with', 'you', 'your', 'youtube',
]);

/** Lowercase, strip punctuation, drop stop-words, drop tokens shorter than 3. */
export function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/** Jaccard similarity over the tokenized titles. 0 = nothing in common,
 *  1 = identical token sets. Returns 0 for empty inputs. */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface CandidateUpload extends CannibalSide {
  // Inherits everything from CannibalSide.
}

/**
 * Find every cross-channel pair within the window. Two uploads pair only if:
 *   - they're on different channels (same channel = cadence question)
 *   - their publish_at values are within `windowDays` of each other
 *   - both have non-null publish_at (we can't reason about windows otherwise)
 *
 * Pure function — exported for tests.
 */
export function findCrossChannelPairs(
  uploads: CandidateUpload[],
  windowDays: number,
): Array<[CandidateUpload, CandidateUpload]> {
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const withDates = uploads.filter((u) => u.publish_at !== null);
  // Sort by publish_at ascending so we can short-circuit the inner loop.
  withDates.sort((a, b) => (a.publish_at as string).localeCompare(b.publish_at as string));
  const pairs: Array<[CandidateUpload, CandidateUpload]> = [];
  for (let i = 0; i < withDates.length; i++) {
    const a = withDates[i]!;
    const aTime = new Date(a.publish_at as string).getTime();
    if (!Number.isFinite(aTime)) continue;
    for (let j = i + 1; j < withDates.length; j++) {
      const b = withDates[j]!;
      const bTime = new Date(b.publish_at as string).getTime();
      if (!Number.isFinite(bTime)) continue;
      if (bTime - aTime > windowMs) break; // sorted ascending — the rest are further away
      if (a.channel_id && b.channel_id && a.channel_id === b.channel_id) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

export function riskLevelFromScore(score: number): CannibalRiskLevel {
  if (score >= 0.55) return 'high';
  if (score >= 0.32) return 'medium';
  return 'low';
}

export function buildCannibalizationPrompt(args: {
  pair: [CandidateUpload, CandidateUpload];
  similarity: number;
  windowDays: number;
}): { system: string; user: string } {
  const [a, b] = args.pair;
  return {
    system: `You are a YouTube strategist advising a multi-channel creator. The user just detected that two of their channels are about to publish (or recently published) videos that may compete for the same audience.

Your job:
1. Diagnose WHY the two videos overlap — same query intent, same audience moment, same niche subtopic, etc. Not just "similar titles" — root cause.
2. Recommend ONE concrete fix. Options include: delay one by N days, change one's angle (e.g. "make A the beginner version, B the deep-dive"), pillar consolidation (publish only one, redirect the other channel to a different sub-niche), cross-promotion playlist linkage.
3. Rate severity: low (mild title echo, different audiences), medium (probable cannibal, fixable with delay), high (same audience + same week + same query — one will eat the other's CTR).

Output STRICTLY this JSON:
{
  "why": "<one short paragraph, root-cause analysis>",
  "recommended_fix": "<one concrete action the creator can take this week>",
  "risk_level": "low" | "medium" | "high"
}`,
    user: `Channel A: ${a.channel_name ?? 'unknown'}
  Title: "${a.title}"
  Publish: ${a.publish_at ?? 'unknown'}
  Status: ${a.kind === 'video' ? 'already published' : 'scheduled'}

Channel B: ${b.channel_name ?? 'unknown'}
  Title: "${b.title}"
  Publish: ${b.publish_at ?? 'unknown'}
  Status: ${b.kind === 'video' ? 'already published' : 'scheduled'}

Detection signals:
  - Lexical similarity (Jaccard over significant tokens): ${(args.similarity * 100).toFixed(0)}%
  - Both fall within a ±${args.windowDays}-day publication window
  - Different channels (same workspace owner)

Output JSON only.`,
  };
}

interface RawAlertOutput {
  why?: unknown;
  recommended_fix?: unknown;
  risk_level?: unknown;
}

export function parseAlertOutput(raw: string, fallbackRisk: CannibalRiskLevel): {
  why: string;
  recommended_fix: string;
  risk_level: CannibalRiskLevel;
} {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from cannibalization alert: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as RawAlertOutput;
  const why = typeof obj.why === 'string' ? obj.why.slice(0, 800) : '';
  const recommended_fix = typeof obj.recommended_fix === 'string' ? obj.recommended_fix.slice(0, 600) : '';
  const risk_level: CannibalRiskLevel =
    obj.risk_level === 'low' || obj.risk_level === 'medium' || obj.risk_level === 'high'
      ? obj.risk_level
      : fallbackRisk;
  return { why, recommended_fix, risk_level };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface ScheduleItemRow {
  id: string;
  title: string;
  scheduled_for: string | null;
  channel_id: string | null;
  channel_name: string | null;
}

interface PublishedVideoRow {
  youtube_video_id: string;
  title: string | null;
  published_at: string | null;
  channel_id: string | null;
  channel_name: string | null;
}

async function loadScheduledUploads(
  workspaceId: string,
  windowStart: string,
  windowEnd: string,
): Promise<CandidateUpload[]> {
  const { rows } = await sql<ScheduleItemRow>`
    SELECT s.id, s.title, s.scheduled_for::text AS scheduled_for,
           c.id AS channel_id, c.name AS channel_name
      FROM schedule_items s
      LEFT JOIN schedule_item_channels sic ON sic.item_id = s.id
      LEFT JOIN channels c ON c.id = sic.channel_id
     WHERE s.workspace_id = ${workspaceId}::uuid
       AND s.scheduled_for IS NOT NULL
       AND s.scheduled_for >= ${windowStart}::timestamptz
       AND s.scheduled_for <= ${windowEnd}::timestamptz
       AND COALESCE(s.title, '') <> ''
  `;
  return rows.map((r) => ({
    kind: 'schedule_item' as const,
    ref_id: r.id,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    title: r.title,
    publish_at: r.scheduled_for,
  }));
}

async function loadPublishedUploads(
  workspaceId: string,
  windowStart: string,
  windowEnd: string,
): Promise<CandidateUpload[]> {
  const { rows } = await sql<PublishedVideoRow>`
    SELECT v.youtube_video_id, v.title, v.published_at::text AS published_at,
           c.id AS channel_id, c.name AS channel_name
      FROM video_analytics v
      LEFT JOIN channels c ON c.id = v.channel_id
     WHERE v.workspace_id = ${workspaceId}::uuid
       AND v.published_at IS NOT NULL
       AND v.published_at >= ${windowStart}::timestamptz
       AND v.published_at <= ${windowEnd}::timestamptz
       AND COALESCE(v.title, '') <> ''
  `;
  return rows.map((r) => ({
    kind: 'video' as const,
    ref_id: r.youtube_video_id,
    channel_id: r.channel_id,
    channel_name: r.channel_name,
    title: r.title ?? '',
    publish_at: r.published_at,
  }));
}

export async function loadCandidateUploads(opts: {
  workspaceId: string;
  lookbackDays?: number;
  lookaheadDays?: number;
}): Promise<{ uploads: CandidateUpload[]; windowStart: string; windowEnd: string }> {
  const lookback = opts.lookbackDays ?? CANNIBAL_DEFAULT_LOOKBACK_DAYS;
  const lookahead = opts.lookaheadDays ?? CANNIBAL_DEFAULT_LOOKAHEAD_DAYS;
  const now = Date.now();
  const windowStart = new Date(now - lookback * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now + lookahead * 24 * 60 * 60 * 1000).toISOString();
  const [scheduled, published] = await Promise.all([
    loadScheduledUploads(opts.workspaceId, windowStart, windowEnd),
    loadPublishedUploads(opts.workspaceId, windowStart, windowEnd),
  ]);
  return { uploads: [...scheduled, ...published], windowStart, windowEnd };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunCannibalizationScanArgs {
  workspaceId: string;
  windowDays?: number;
  lookbackDays?: number;
  lookaheadDays?: number;
  modelId?: string;
}

export async function runCannibalizationScan(
  args: RunCannibalizationScanArgs,
): Promise<CannibalizationScanResult> {
  const windowDays = args.windowDays ?? CANNIBAL_DEFAULT_WINDOW_DAYS;
  const modelId = args.modelId || DEFAULT_CANNIBAL_MODEL;

  const { uploads, windowStart, windowEnd } = await loadCandidateUploads({
    workspaceId: args.workspaceId,
    lookbackDays: args.lookbackDays,
    lookaheadDays: args.lookaheadDays,
  });

  const allPairs = findCrossChannelPairs(uploads, windowDays);

  // Score every pair, keep those above the lexical threshold, sort by score
  // descending, cap at MAX_AI_PAIRS to bound model spend.
  const scored = allPairs
    .map(([a, b]) => ({ a, b, score: lexicalSimilarity(a.title, b.title) }))
    .filter((p) => p.score >= CANNIBAL_LEXICAL_THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .slice(0, CANNIBAL_MAX_AI_PAIRS);

  const created: CannibalizationAlertRow[] = [];

  for (const pair of scored) {
    let why = '';
    let recommended_fix = '';
    let risk_level = riskLevelFromScore(pair.score);
    try {
      const { system, user } = buildCannibalizationPrompt({
        pair: [pair.a, pair.b],
        similarity: pair.score,
        windowDays,
      });
      const raw = await generateText({
        modelId,
        systemPrompt: system,
        prompt: user,
        maxTokens: 800,
        temperature: 0.3,
        spend: {
          workspaceId: args.workspaceId,
          featureArea: 'cannibalization_alert',
          metadata: { similarity: pair.score },
        },
      });
      const out = parseAlertOutput(raw, risk_level);
      why = out.why;
      recommended_fix = out.recommended_fix;
      risk_level = out.risk_level;
    } catch (err) {
      logger.warn('cannibalization: AI step failed, persisting score-only alert', {
        detail: err instanceof Error ? err.message : String(err),
      });
      why = `(AI explanation unavailable — using lexical signal only. Title token overlap: ${(pair.score * 100).toFixed(0)}%.)`;
      recommended_fix = 'Review manually: consider delaying one upload by 5-7 days or differentiating the angle.';
    }

    // Insert with ON CONFLICT DO NOTHING — the dedup partial unique index
    // will skip pairs we've already alerted on (and not yet dismissed).
    const { rows: insertRows } = await sql<{ id: string; detected_at: string }>`
      INSERT INTO cannibalization_alerts (
        workspace_id, scope_window_start, scope_window_end,
        pair_a_kind, pair_a_ref_id, pair_a_channel_id, pair_a_channel_name, pair_a_title, pair_a_publish_at,
        pair_b_kind, pair_b_ref_id, pair_b_channel_id, pair_b_channel_name, pair_b_title, pair_b_publish_at,
        similarity_score, risk_level, why, recommended_fix,
        ai_model
      ) VALUES (
        ${args.workspaceId}::uuid,
        ${windowStart}::timestamptz,
        ${windowEnd}::timestamptz,
        ${pair.a.kind}, ${pair.a.ref_id}, ${pair.a.channel_id}, ${pair.a.channel_name}, ${pair.a.title}, ${pair.a.publish_at}::timestamptz,
        ${pair.b.kind}, ${pair.b.ref_id}, ${pair.b.channel_id}, ${pair.b.channel_name}, ${pair.b.title}, ${pair.b.publish_at}::timestamptz,
        ${pair.score.toFixed(3)},
        ${risk_level},
        ${why || null},
        ${recommended_fix || null},
        ${modelId}
      )
      ON CONFLICT (workspace_id, pair_a_ref_id, pair_b_ref_id) WHERE status = 'active' DO NOTHING
      RETURNING id, detected_at::text AS detected_at
    `;
    if (insertRows.length === 0) continue; // duplicate, skipped
    created.push({
      id: insertRows[0]!.id,
      workspace_id: args.workspaceId,
      detected_at: insertRows[0]!.detected_at,
      scope_window_start: windowStart,
      scope_window_end: windowEnd,
      pair_a: pair.a,
      pair_b: pair.b,
      similarity_score: pair.score,
      risk_level,
      why: why || null,
      recommended_fix: recommended_fix || null,
      status: 'active',
      dismissed_at: null,
      ai_model: modelId,
      notes: null,
    });
  }

  // Fire-and-forget webhook for every NEW high-risk alert (dedup index
  // ensures we don't re-fire on already-flagged pairs). Lazy import so
  // the webhook code doesn't get bundled into every consumer of this
  // orchestrator.
  const highRiskCreated = created.filter((a) => a.risk_level === 'high');
  if (highRiskCreated.length > 0) {
    void (async () => {
      try {
        const { dispatchWebhookEvent } = await import('./webhooks');
        for (const alert of highRiskCreated) {
          await dispatchWebhookEvent(args.workspaceId, {
            type: 'cannibalization_high_risk',
            title: '⚠️ High-risk cannibalization detected',
            detail: alert.why ?? `Two of your channels overlap on similar titles within a ${windowDays}-day window.`,
            fields: {
              channel_a: alert.pair_a.channel_name ?? 'unknown',
              title_a: alert.pair_a.title.slice(0, 120),
              channel_b: alert.pair_b.channel_name ?? 'unknown',
              title_b: alert.pair_b.title.slice(0, 120),
              similarity: `${(alert.similarity_score * 100).toFixed(0)}%`,
              fix: alert.recommended_fix ?? '(none)',
            },
          });
        }
      } catch {
        /* webhook failure must never block the scan result */
      }
      try {
        const { dispatchWorkflowEvent } = await import('./workflows');
        for (const alert of highRiskCreated) {
          await dispatchWorkflowEvent(args.workspaceId, {
            type: 'cannibalization_high_risk',
            payload: {
              alert_id: alert.id,
              similarity: alert.similarity_score,
              channel_a: alert.pair_a.channel_name,
              channel_b: alert.pair_b.channel_name,
              channel_a_db_id: alert.pair_a.channel_id,
              channel_b_db_id: alert.pair_b.channel_id,
            },
          });
        }
      } catch {
        /* workflow plumbing failure must never block the scan result */
      }
    })();
  }

  return {
    scanned_window_days: windowDays,
    candidates_considered: uploads.length,
    pairs_evaluated: allPairs.length,
    pairs_above_threshold: scored.length,
    alerts_created: created,
  };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

interface FlatAlertRow {
  id: string;
  workspace_id: string;
  detected_at: string;
  scope_window_start: string;
  scope_window_end: string;
  pair_a_kind: 'schedule_item' | 'video';
  pair_a_ref_id: string;
  pair_a_channel_id: string | null;
  pair_a_channel_name: string | null;
  pair_a_title: string;
  pair_a_publish_at: string | null;
  pair_b_kind: 'schedule_item' | 'video';
  pair_b_ref_id: string;
  pair_b_channel_id: string | null;
  pair_b_channel_name: string | null;
  pair_b_title: string;
  pair_b_publish_at: string | null;
  similarity_score: string | number;
  risk_level: CannibalRiskLevel;
  why: string | null;
  recommended_fix: string | null;
  status: 'active' | 'dismissed';
  dismissed_at: string | null;
  ai_model: string | null;
  notes: string | null;
}

function flatToRow(r: FlatAlertRow): CannibalizationAlertRow {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    detected_at: r.detected_at,
    scope_window_start: r.scope_window_start,
    scope_window_end: r.scope_window_end,
    pair_a: {
      kind: r.pair_a_kind,
      ref_id: r.pair_a_ref_id,
      channel_id: r.pair_a_channel_id,
      channel_name: r.pair_a_channel_name,
      title: r.pair_a_title,
      publish_at: r.pair_a_publish_at,
    },
    pair_b: {
      kind: r.pair_b_kind,
      ref_id: r.pair_b_ref_id,
      channel_id: r.pair_b_channel_id,
      channel_name: r.pair_b_channel_name,
      title: r.pair_b_title,
      publish_at: r.pair_b_publish_at,
    },
    similarity_score: typeof r.similarity_score === 'number' ? r.similarity_score : Number(r.similarity_score),
    risk_level: r.risk_level,
    why: r.why,
    recommended_fix: r.recommended_fix,
    status: r.status,
    dismissed_at: r.dismissed_at,
    ai_model: r.ai_model,
    notes: r.notes,
  };
}

export async function listCannibalizationAlerts(
  workspaceId: string,
  opts: { status?: 'active' | 'dismissed'; limit?: number } = {},
): Promise<CannibalizationAlertRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.status === 'active' || opts.status === 'dismissed') {
    const { rows } = await sql<FlatAlertRow>`
      SELECT
        id, workspace_id,
        detected_at::text AS detected_at,
        scope_window_start::text AS scope_window_start,
        scope_window_end::text AS scope_window_end,
        pair_a_kind, pair_a_ref_id, pair_a_channel_id, pair_a_channel_name, pair_a_title, pair_a_publish_at::text AS pair_a_publish_at,
        pair_b_kind, pair_b_ref_id, pair_b_channel_id, pair_b_channel_name, pair_b_title, pair_b_publish_at::text AS pair_b_publish_at,
        similarity_score, risk_level, why, recommended_fix,
        status, dismissed_at::text AS dismissed_at, ai_model, notes
      FROM cannibalization_alerts
      WHERE workspace_id = ${workspaceId}::uuid AND status = ${opts.status}
      ORDER BY detected_at DESC
      LIMIT ${limit}
    `;
    return rows.map(flatToRow);
  }
  const { rows } = await sql<FlatAlertRow>`
    SELECT
      id, workspace_id,
      detected_at::text AS detected_at,
      scope_window_start::text AS scope_window_start,
      scope_window_end::text AS scope_window_end,
      pair_a_kind, pair_a_ref_id, pair_a_channel_id, pair_a_channel_name, pair_a_title, pair_a_publish_at::text AS pair_a_publish_at,
      pair_b_kind, pair_b_ref_id, pair_b_channel_id, pair_b_channel_name, pair_b_title, pair_b_publish_at::text AS pair_b_publish_at,
      similarity_score, risk_level, why, recommended_fix,
      status, dismissed_at::text AS dismissed_at, ai_model, notes
    FROM cannibalization_alerts
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY detected_at DESC
    LIMIT ${limit}
  `;
  return rows.map(flatToRow);
}

export async function dismissCannibalizationAlert(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await sql`
    UPDATE cannibalization_alerts
       SET status = 'dismissed',
           dismissed_at = NOW()
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'active'
  `;
  return (result.rowCount ?? 0) > 0;
}
