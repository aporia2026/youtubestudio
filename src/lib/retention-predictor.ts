/**
 * Retention-curve predictor.
 *
 * Given a script + niche + the channel that will publish it, the model
 * forecasts the audience-retention curve the video will produce when it
 * lands on YouTube. The accuracy comes from few-shot RAG over the
 * workspace's own past videos: we pull (script, real retention_curve)
 * pairs from the most recent published videos on the same channel, feed
 * them as in-context examples, and ask the model to extrapolate the
 * pattern.
 *
 * Output shape mirrors `video_analytics.retention_curve` so the existing
 * `RetentionCurve` SVG component renders predictions with no fork.
 *
 * The pure parts (prompt builder, parser, segment derivation, duration
 * estimator) are exported for unit tests so the LLM call is the only
 * thing that needs to be mocked.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import {
  MAX_FEW_SHOT_EXAMPLES,
  MIN_SCRIPT_CHARS,
  RETENTION_WORDS_PER_SECOND,
  type RetentionPoint,
  type RetentionPrediction,
  type RetentionPredictionRow,
  type SegmentExplanation,
} from './retention-predictor-types';

export type {
  RetentionPoint,
  RetentionPrediction,
  RetentionPredictionRow,
  SegmentExplanation,
} from './retention-predictor-types';

/** Cheap fast model is fine here — predictor accuracy lives in the
 *  few-shot examples, not in raw model strength. Override per-call by
 *  passing `modelId` to `predictRetention`. */
const DEFAULT_PREDICTION_MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Few-shot retrieval
// ---------------------------------------------------------------------------

export interface FewShotExample {
  youtube_video_id: string;
  title: string | null;
  duration_seconds: number | null;
  retention_curve: RetentionPoint[];
  /** Script snippet — typically the first ~2000 chars. The full script
   *  isn't available (we don't archive scripts of published videos), so
   *  the title + curve do most of the work. */
  script_excerpt?: string;
}

interface RawAnalyticsRow {
  youtube_video_id: string;
  title: string | null;
  duration_seconds: number | null;
  retention_curve: unknown;
}

/**
 * Pull the most recent published-video history rows that have a usable
 * retention curve. Scoped to the workspace (always); optionally narrowed
 * to a single channel for per-channel pattern matching.
 */
export async function findFewShotExamples(opts: {
  workspaceId: string;
  channelDbId?: string | null;
  limit?: number;
}): Promise<FewShotExample[]> {
  const limit = Math.min(Math.max(opts.limit ?? MAX_FEW_SHOT_EXAMPLES, 1), 20);
  const rows: RawAnalyticsRow[] = opts.channelDbId
    ? (
        await sql<RawAnalyticsRow>`
          SELECT youtube_video_id, title, duration_seconds, retention_curve
            FROM video_analytics
           WHERE workspace_id = ${opts.workspaceId}::uuid
             AND channel_id = ${opts.channelDbId}::uuid
             AND retention_curve IS NOT NULL
             AND jsonb_array_length(retention_curve) > 5
           ORDER BY published_at DESC NULLS LAST
           LIMIT ${limit}
        `
      ).rows
    : (
        await sql<RawAnalyticsRow>`
          SELECT youtube_video_id, title, duration_seconds, retention_curve
            FROM video_analytics
           WHERE workspace_id = ${opts.workspaceId}::uuid
             AND retention_curve IS NOT NULL
             AND jsonb_array_length(retention_curve) > 5
           ORDER BY published_at DESC NULLS LAST
           LIMIT ${limit}
        `
      ).rows;

  return rows
    .map((r) => {
      const curve = normalizeCurve(r.retention_curve);
      if (curve.length < 6) return null;
      return {
        youtube_video_id: r.youtube_video_id,
        title: r.title,
        duration_seconds: r.duration_seconds,
        retention_curve: curve,
      } satisfies FewShotExample;
    })
    .filter((x): x is FewShotExample => x !== null);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function countSpokenWords(text: string): number {
  return text.split(/\s+/).map((s) => s.trim()).filter(Boolean).length;
}

export function estimateDurationSeconds(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / RETENTION_WORDS_PER_SECOND));
}

/**
 * Coerce arbitrary JSON into a RetentionPoint[] with bounded values. Drops
 * any entry that doesn't have finite numeric position + retention. Sorts
 * ascending by position so the curve is monotonic-x even when the input
 * arrived shuffled.
 */
export function normalizeCurve(raw: unknown): RetentionPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: RetentionPoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const p = typeof e.position === 'number' ? e.position : null;
    const r = typeof e.retention === 'number' ? e.retention : null;
    if (p === null || r === null || !Number.isFinite(p) || !Number.isFinite(r)) continue;
    out.push({
      position: Math.max(0, Math.min(1, p)),
      retention: Math.max(0, Math.min(1, r)),
    });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

/** Average view percentage = area under the retention curve (trapezoidal
 *  rule across the 0-1 position axis). Returns null when the curve is
 *  too sparse to integrate. */
export function curveAvdPercentage(curve: RetentionPoint[]): number | null {
  if (curve.length < 2) return null;
  let area = 0;
  for (let i = 1; i < curve.length; i++) {
    const dx = curve[i]!.position - curve[i - 1]!.position;
    const avgY = (curve[i]!.retention + curve[i - 1]!.retention) / 2;
    area += dx * avgY;
  }
  // The area is on a 0-1 scale; convert to percentage.
  return Math.max(0, Math.min(100, area * 100));
}

export function buildRetentionPredictionPrompt(args: {
  script: string;
  niche?: string;
  examples: FewShotExample[];
  estimatedDurationSeconds: number;
}): { system: string; user: string } {
  const exampleBlock = args.examples
    .map((ex, i) => {
      const sampled = downsampleCurve(ex.retention_curve, 12);
      const curveStr = sampled
        .map((p) => `[${p.position.toFixed(2)}, ${p.retention.toFixed(3)}]`)
        .join(', ');
      const dur = ex.duration_seconds ? `${ex.duration_seconds}s` : 'unknown duration';
      const title = ex.title ? `"${ex.title.slice(0, 80)}"` : '(untitled)';
      return `Example ${i + 1} — ${title}, ${dur}\n  curve: [${curveStr}]`;
    })
    .join('\n');

  return {
    system: `You are a YouTube retention analyst with a 99th-percentile track record predicting audience drop-off curves from script text. You take a script + the channel's recent retention history and forecast how the new video will retain viewers.

The retention curve is an array of {position, retention} samples where:
- position is 0-1 (0 = first frame, 1 = last frame)
- retention is 0-1 (1 = 100% of viewers still watching)

Strict rules for accurate prediction:
1. Anchor on the channel's recent history. Most channels have a characteristic curve shape that doesn't change wildly between videos — your job is to predict THIS video's deviations from that shape, not to invent a new shape.
2. Identify the 3-5 highest-risk segments in the script (slow opens, ad breaks, jargon walls, recap loops, weak CTAs) and forecast a measurable drop at each.
3. NEVER predict a flat curve. Real YouTube curves drop at least 30-50% by position 0.3 in the median case. A flat curve is a sign of model laziness.
4. NEVER predict retention going UP across a segment unless there's a re-engagement spike (cliffhanger, payoff). Even then cap the bounce at +5%.
5. Predict the AVD (average view percentage) by integrating under the curve.

Output STRICTLY this JSON shape with no prose:

{
  "curve": [{"position": 0.0, "retention": 1.0}, {"position": 0.05, "retention": 0.78}, ...],
  "predicted_avd_percentage": <0-100 float>,
  "segment_explanations": [
    {
      "start_seconds": <integer>,
      "end_seconds": <integer>,
      "excerpt": "<first ~120 chars of the script segment>",
      "predicted_drop_pct": <0-100 float, percentage points lost across this segment>,
      "reason": "<one short phrase, e.g. 'rambling intro', 'jargon wall', 'second ad break'>",
      "fix": "<one concrete edit, or empty string if segment is healthy>"
    }
  ],
  "biggest_drop_index": <integer index into segment_explanations of the worst segment, or null>,
  "suggested_fixes": ["<global fix 1>", "<global fix 2>", "<global fix 3>"]
}

Provide 12-25 curve samples (denser around the first 30% of the video where most drops happen). Provide 4-8 segment_explanations.`,
    user: `Channel niche: ${args.niche ?? 'unknown'}
Estimated video duration: ${args.estimatedDurationSeconds}s

Recent retention history from this channel (most recent first):
${exampleBlock || '(none — no published-video history available; rely on niche conventions)'}

NEW SCRIPT to predict for:
"""
${args.script}
"""

Output JSON only.`,
  };
}

/** Sample a curve down to ~N points by picking evenly-spaced positions.
 *  Used to keep prompt tokens reasonable when feeding past curves as
 *  few-shot examples — full curves can be 100+ samples. */
function downsampleCurve(curve: RetentionPoint[], targetCount: number): RetentionPoint[] {
  if (curve.length <= targetCount) return curve;
  const step = (curve.length - 1) / (targetCount - 1);
  const out: RetentionPoint[] = [];
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.round(i * step);
    out.push(curve[Math.min(curve.length - 1, idx)]!);
  }
  return out;
}

interface RawPredictionOutput {
  curve?: unknown;
  predicted_avd_percentage?: unknown;
  segment_explanations?: unknown;
  biggest_drop_index?: unknown;
  suggested_fixes?: unknown;
}

/** Parse the LLM's prediction JSON. Tolerates fenced output, extra prose,
 *  and minor schema drift; throws with a unified error prefix when the
 *  output is unrecoverable. */
export function parseRetentionPrediction(
  raw: string,
  estimatedDurationSeconds: number,
): RetentionPrediction {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from retention prediction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Retention prediction is not a JSON object.');
  }
  const obj = parsed as RawPredictionOutput;

  const curve = normalizeCurve(obj.curve);
  if (curve.length < 3) {
    throw new Error('Predicted curve has fewer than 3 samples — model output unusable.');
  }

  const segments = normaliseSegments(obj.segment_explanations);
  const biggestDropIdx =
    typeof obj.biggest_drop_index === 'number' &&
    Number.isFinite(obj.biggest_drop_index) &&
    obj.biggest_drop_index >= 0 &&
    obj.biggest_drop_index < segments.length
      ? Math.floor(obj.biggest_drop_index)
      : segments.length > 0
        ? indexOfMaxDrop(segments)
        : null;
  const biggestDrop = biggestDropIdx !== null ? segments[biggestDropIdx]! : null;

  const claimedAvd =
    typeof obj.predicted_avd_percentage === 'number' && Number.isFinite(obj.predicted_avd_percentage)
      ? Math.max(0, Math.min(100, obj.predicted_avd_percentage))
      : null;
  const computedAvd = curveAvdPercentage(curve);
  // Trust the computed value over the claimed one — LLMs misintegrate.
  const avdPercentage = computedAvd ?? claimedAvd ?? 0;
  const avdSeconds = Math.round(estimatedDurationSeconds * (avdPercentage / 100));

  const suggestedFixes = Array.isArray(obj.suggested_fixes)
    ? obj.suggested_fixes
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.slice(0, 240))
        .filter(Boolean)
        .slice(0, 5)
    : [];

  return {
    curve,
    predicted_avd_percentage: avdPercentage,
    predicted_avd_seconds: avdSeconds,
    segment_explanations: segments,
    biggest_drop: biggestDrop,
    suggested_fixes: suggestedFixes,
    // Filled in by the orchestrator; left empty here so the parser is pure.
    few_shot_video_ids: [],
    few_shot_count: 0,
  };
}

function normaliseSegments(raw: unknown): SegmentExplanation[] {
  if (!Array.isArray(raw)) return [];
  const out: SegmentExplanation[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const start = typeof e.start_seconds === 'number' ? Math.max(0, Math.round(e.start_seconds)) : 0;
    const end =
      typeof e.end_seconds === 'number'
        ? Math.max(start, Math.round(e.end_seconds))
        : start;
    const excerpt = typeof e.excerpt === 'string' ? e.excerpt.slice(0, 220) : '';
    const drop =
      typeof e.predicted_drop_pct === 'number' && Number.isFinite(e.predicted_drop_pct)
        ? Math.max(0, Math.min(100, e.predicted_drop_pct))
        : 0;
    const reason = typeof e.reason === 'string' ? e.reason.slice(0, 160) : '';
    const fix = typeof e.fix === 'string' ? e.fix.slice(0, 240) : undefined;
    if (!excerpt && !reason) continue; // skip empty entries
    out.push({
      start_seconds: start,
      end_seconds: end,
      excerpt,
      predicted_drop_pct: drop,
      reason,
      fix: fix || undefined,
    });
  }
  return out.slice(0, 12);
}

function indexOfMaxDrop(segments: SegmentExplanation[]): number {
  let bestIdx = 0;
  let bestDrop = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.predicted_drop_pct > bestDrop) {
      bestDrop = segments[i]!.predicted_drop_pct;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface PredictRetentionArgs {
  workspaceId: string;
  scriptText: string;
  niche?: string;
  channelDbId?: string | null;
  projectId?: string | null;
  sourceScriptId?: string | null;
  modelId?: string;
  notes?: string | null;
}

export async function predictRetention(args: PredictRetentionArgs): Promise<{
  id: string;
  prediction: RetentionPrediction;
}> {
  const script = args.scriptText.trim();
  if (script.length < MIN_SCRIPT_CHARS) {
    throw new Error(`Script too short — need at least ${MIN_SCRIPT_CHARS} characters for a meaningful prediction.`);
  }

  const wordCount = countSpokenWords(script);
  const estDuration = estimateDurationSeconds(wordCount);
  const modelId = args.modelId || DEFAULT_PREDICTION_MODEL;

  const examples = await findFewShotExamples({
    workspaceId: args.workspaceId,
    channelDbId: args.channelDbId,
    limit: MAX_FEW_SHOT_EXAMPLES,
  });

  const { system, user } = buildRetentionPredictionPrompt({
    script,
    niche: args.niche,
    examples,
    estimatedDurationSeconds: estDuration,
  });

  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 4000,
    temperature: 0.4,
  });

  let prediction: RetentionPrediction;
  try {
    prediction = parseRetentionPrediction(raw, estDuration);
  } catch (err) {
    logger.error('retention prediction parse failed', {
      detail: err instanceof Error ? err.message : String(err),
      raw_preview: raw.slice(0, 400),
    });
    throw err;
  }

  prediction.few_shot_video_ids = examples.map((e) => e.youtube_video_id);
  prediction.few_shot_count = examples.length;

  // Postgres TEXT[] literal — `{a,b,c}` form. Each id is a YouTube video id
  // (alphanumeric + dash + underscore), so quoting isn't strictly required,
  // but we still strip anything weird out of defence in depth.
  const idsLiteral = `{${prediction.few_shot_video_ids
    .map((id) => id.replace(/[^A-Za-z0-9_-]/g, ''))
    .filter(Boolean)
    .join(',')}}`;

  const { rows } = await sql<{ id: string }>`
    INSERT INTO retention_predictions (
      workspace_id, project_id, source_script_id, channel_db_id,
      script_text, niche, word_count, estimated_duration_seconds,
      predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
      segment_explanations, biggest_drop, suggested_fixes,
      few_shot_video_ids, few_shot_count,
      ai_model, generation_params, notes
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.projectId ?? null}::uuid,
      ${args.sourceScriptId ?? null}::uuid,
      ${args.channelDbId ?? null}::uuid,
      ${script},
      ${args.niche ?? null},
      ${wordCount},
      ${estDuration},
      ${JSON.stringify(prediction.curve)}::jsonb,
      ${prediction.predicted_avd_percentage},
      ${prediction.predicted_avd_seconds},
      ${JSON.stringify(prediction.segment_explanations)}::jsonb,
      ${prediction.biggest_drop ? JSON.stringify(prediction.biggest_drop) : null}::jsonb,
      ${JSON.stringify(prediction.suggested_fixes)}::jsonb,
      ${idsLiteral}::text[],
      ${prediction.few_shot_count},
      ${modelId},
      ${JSON.stringify({ niche: args.niche, channel_db_id: args.channelDbId })}::jsonb,
      ${args.notes ?? null}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id, prediction };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

const SELECT_PREDICTION_COLS = `
  id, workspace_id, project_id, source_script_id, channel_db_id,
  script_text, niche, word_count, estimated_duration_seconds,
  predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
  segment_explanations, biggest_drop, suggested_fixes,
  few_shot_video_ids, few_shot_count,
  ai_model, notes,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function getRetentionPrediction(
  id: string,
  workspaceId: string,
): Promise<RetentionPredictionRow | null> {
  // sql template doesn't allow raw column-list interpolation — keep
  // SELECTs in lock-step with SELECT_PREDICTION_COLS.
  const { rows } = await sql<RetentionPredictionRow>`
    SELECT
      id, workspace_id, project_id, source_script_id, channel_db_id,
      script_text, niche, word_count, estimated_duration_seconds,
      predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
      segment_explanations, biggest_drop, suggested_fixes,
      few_shot_video_ids, few_shot_count,
      ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM retention_predictions
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listRetentionPredictions(
  workspaceId: string,
  opts: { projectId?: string; channelDbId?: string; limit?: number } = {},
): Promise<RetentionPredictionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.channelDbId) {
    const { rows } = await sql<RetentionPredictionRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, channel_db_id,
        script_text, niche, word_count, estimated_duration_seconds,
        predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
        segment_explanations, biggest_drop, suggested_fixes,
        few_shot_video_ids, few_shot_count,
        ai_model, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM retention_predictions
      WHERE workspace_id = ${workspaceId}::uuid
        AND channel_db_id = ${opts.channelDbId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.projectId) {
    const { rows } = await sql<RetentionPredictionRow>`
      SELECT
        id, workspace_id, project_id, source_script_id, channel_db_id,
        script_text, niche, word_count, estimated_duration_seconds,
        predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
        segment_explanations, biggest_drop, suggested_fixes,
        few_shot_video_ids, few_shot_count,
        ai_model, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM retention_predictions
      WHERE workspace_id = ${workspaceId}::uuid
        AND project_id = ${opts.projectId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<RetentionPredictionRow>`
    SELECT
      id, workspace_id, project_id, source_script_id, channel_db_id,
      script_text, niche, word_count, estimated_duration_seconds,
      predicted_curve, predicted_avd_percentage, predicted_avd_seconds,
      segment_explanations, biggest_drop, suggested_fixes,
      few_shot_video_ids, few_shot_count,
      ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM retention_predictions
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function deleteRetentionPrediction(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await sql`
    DELETE FROM retention_predictions
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}

// Marker to keep SELECT_PREDICTION_COLS reachable; useful for future
// extraction into a helper but unreferenced today.
export const _PREDICTION_SELECT_DOC = SELECT_PREDICTION_COLS;
