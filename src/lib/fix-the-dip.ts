/**
 * Fix-the-dip: post-publish retention analysis.
 *
 * Companion to retention-predictor.ts. Where the predictor forecasts a
 * curve from a script before publishing, this module does the reverse:
 * it takes the REAL retention curve from `video_analytics` for an
 * already-published video, finds the largest drops, aligns each one to
 * the script section that was on screen at that moment, and asks the
 * model for a per-dip root cause + concrete fix.
 *
 * Two stages:
 *
 *   1. `detectRawDips` — pure, deterministic, no LLM. Walks the curve
 *      with a sliding window and returns every drop that exceeds the
 *      MIN_DIP_DROP_PCT threshold. The output is what we feed the model
 *      (so the model never has to redo the math).
 *
 *   2. `analyzeRetentionDips` — orchestrator. Loads the curve from the
 *      DB, runs detectRawDips, asks the model to align each dip to the
 *      script and propose a fix, persists the result.
 *
 * The pure parts (dip detection, prompt builder, parser, script-time
 * alignment) are exported for unit tests so the LLM call is the only
 * thing that needs mocking.
 */
import { sql } from '@vercel/postgres';
import { generateText } from './ai';
import { parseLlmJson } from './parse-llm-json';
import { logger } from './logger';
import {
  countSpokenWords,
  estimateDurationSeconds,
  normalizeCurve,
} from './retention-predictor';
import type { RetentionPoint } from './retention-predictor-types';
import {
  MAX_DIPS_PER_ANALYSIS,
  MAX_DIP_DURATION_SECONDS,
  MIN_DIP_DROP_PCT,
  type DipAnalysis,
  type DipAnalysisRow,
  type DipPattern,
  type DipSeverity,
  type RetentionDip,
} from './fix-the-dip-types';

export type {
  DipAnalysis,
  DipAnalysisRow,
  DipPattern,
  DipSeverity,
  RetentionDip,
} from './fix-the-dip-types';

const DEFAULT_DIP_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function severityFromDrop(dropPct: number): DipSeverity {
  if (dropPct >= 25) return 'cliff';
  if (dropPct >= 12) return 'major';
  if (dropPct >= 6) return 'moderate';
  return 'minor';
}

interface RawDip {
  start_seconds: number;
  end_seconds: number;
  retention_before: number;
  retention_after: number;
  drop_pct: number;
  severity: DipSeverity;
}

/**
 * Find every significant drop in the retention curve. A "drop" is a span
 * where retention falls by at least MIN_DIP_DROP_PCT within a short
 * window (≤ MAX_DIP_DURATION_SECONDS). Slow gradual declines are NOT
 * dips — those reflect natural audience attrition, not a specific
 * problem moment.
 *
 * Algorithm: walk the curve, find local maxima → next minima within the
 * window. Each (max, min) pair becomes a dip if the drop crosses the
 * threshold. Returns dips sorted by magnitude (worst first), capped at
 * MAX_DIPS_PER_ANALYSIS.
 *
 * Pure function — exported for tests.
 */
export function detectRawDips(
  curve: RetentionPoint[],
  videoDurationSeconds: number,
): RawDip[] {
  if (curve.length < 4 || videoDurationSeconds <= 0) return [];

  const dips: RawDip[] = [];
  let i = 0;
  while (i < curve.length - 1) {
    // Find local max (or current point if it's already declining).
    let maxIdx = i;
    while (maxIdx + 1 < curve.length && curve[maxIdx + 1]!.retention >= curve[maxIdx]!.retention) {
      maxIdx += 1;
    }
    // From the local max, walk forward looking for the floor of this descent.
    const maxRetention = curve[maxIdx]!.retention;
    const maxPositionSec = curve[maxIdx]!.position * videoDurationSeconds;
    let minIdx = maxIdx;
    let j = maxIdx + 1;
    while (j < curve.length) {
      const elapsed = curve[j]!.position * videoDurationSeconds - maxPositionSec;
      if (elapsed > MAX_DIP_DURATION_SECONDS) break;
      if (curve[j]!.retention < curve[minIdx]!.retention) minIdx = j;
      // Stop early if retention rises back above 90% of the local max —
      // the descent is over.
      if (curve[j]!.retention >= maxRetention * 0.97) break;
      j += 1;
    }
    if (minIdx > maxIdx) {
      const minRetention = curve[minIdx]!.retention;
      const dropPct = (maxRetention - minRetention) * 100;
      if (dropPct >= MIN_DIP_DROP_PCT) {
        dips.push({
          start_seconds: Math.round(curve[maxIdx]!.position * videoDurationSeconds),
          end_seconds: Math.round(curve[minIdx]!.position * videoDurationSeconds),
          retention_before: maxRetention,
          retention_after: minRetention,
          drop_pct: dropPct,
          severity: severityFromDrop(dropPct),
        });
      }
      i = minIdx + 1;
    } else {
      i += 1;
    }
  }

  dips.sort((a, b) => b.drop_pct - a.drop_pct);
  return dips.slice(0, MAX_DIPS_PER_ANALYSIS);
}

/**
 * Given a script and the assumed words-per-second pacing, return the
 * substring spoken between two timestamps. Used to attach script context
 * to each detected dip so the model has something to alignment-match
 * against.
 *
 * Heuristic: count words consumed up to start_seconds, count words from
 * start to end. Slice on word boundaries. Returns at most ~280 chars so
 * the prompt doesn't bloat for long dips.
 */
export function scriptExcerptForDip(
  scriptText: string,
  videoDurationSeconds: number,
  dipStartSeconds: number,
  dipEndSeconds: number,
): string {
  const words = scriptText.split(/\s+/).filter(Boolean);
  if (words.length === 0 || videoDurationSeconds <= 0) return '';
  const wordsPerSecond = words.length / videoDurationSeconds;
  const startWord = Math.max(0, Math.floor(wordsPerSecond * dipStartSeconds));
  const endWord = Math.min(
    words.length,
    Math.max(startWord + 1, Math.ceil(wordsPerSecond * dipEndSeconds) + 8), // +8 for runway
  );
  const excerpt = words.slice(startWord, endWord).join(' ');
  if (excerpt.length <= 280) return excerpt;
  return excerpt.slice(0, 277).trimEnd() + '…';
}

export function buildDipFixPrompt(args: {
  videoTitle: string | null;
  videoDurationSeconds: number;
  scriptText: string;
  rawDips: Array<RawDip & { script_excerpt: string }>;
  observedAvpPercentage: number | null;
}): { system: string; user: string } {
  const dipBlock = args.rawDips
    .map((d, i) => {
      const before = (d.retention_before * 100).toFixed(1);
      const after = (d.retention_after * 100).toFixed(1);
      const range = `${fmtTime(d.start_seconds)} → ${fmtTime(d.end_seconds)}`;
      return `Dip ${i + 1} (${d.severity}, −${d.drop_pct.toFixed(1)} pts) ${range} — ${before}% → ${after}%
  Script at this moment:
  """
  ${d.script_excerpt}
  """`;
    })
    .join('\n\n');

  return {
    system: `You are a YouTube retention analyst. The user shows you a published video that lost viewers at specific timecodes — your job is to diagnose WHY each drop happened and prescribe a concrete fix.

Strict rules:
1. Each fix must be specific. NEVER say "make it more engaging". Tell the editor exactly what to cut, what to add, where to insert a B-roll cut, what jargon to define.
2. Pattern-match the script content at each dip against known retention killers: ad breaks, slow recap loops, jargon walls without analogies, false-promise hooks, abrupt subject changes, weak CTA placements, mid-segment volume/energy drops.
3. If multiple dips share a pattern (e.g. "all 3 dips happen at the same script structure"), surface that pattern at the top — it's more valuable than 3 isolated fixes.
4. Estimate the retention lift each fix would produce (percentage points). Be conservative — single fixes usually move the needle 1-3 points; bigger lifts require structural changes.
5. NEVER claim a dip was "natural attrition" — every drop the user sees has a cause that an editor can act on. If you genuinely have no hypothesis, say "ambiguous: try A/B testing the hook for this segment".

Output STRICTLY this JSON shape:

{
  "dips": [
    {
      "index": <int — matches the input dip number>,
      "why": "<one short clause; the root-cause hypothesis>",
      "fix": "<one concrete edit; cite specific timestamps or script phrases>",
      "estimated_lift_pct": <0-15 float>
    }
  ],
  "patterns": [
    {
      "pattern": "<short label, e.g. 'ad-break attrition'>",
      "affected_dip_indices": [<int>, ...],
      "recommendation": "<the cross-cutting fix>"
    }
  ],
  "top_fixes": [
    "<the 1-3 highest-impact actions ranked by estimated lift, as a flat list>"
  ]
}`,
    user: `Video: ${args.videoTitle ?? '(untitled)'}
Duration: ${args.videoDurationSeconds}s${args.observedAvpPercentage !== null ? `\nObserved AVP: ${args.observedAvpPercentage.toFixed(1)}%` : ''}

Detected dips (largest first):

${dipBlock}

Full script for additional context (only if needed):
"""
${args.scriptText}
"""

Output JSON only.`,
  };
}

interface RawDipFixOutput {
  dips?: Array<{
    index?: unknown;
    why?: unknown;
    fix?: unknown;
    estimated_lift_pct?: unknown;
  }>;
  patterns?: Array<{
    pattern?: unknown;
    affected_dip_indices?: unknown;
    recommendation?: unknown;
  }>;
  top_fixes?: unknown;
}

export function parseDipFixOutput(
  raw: string,
  rawDips: Array<RawDip & { script_excerpt: string }>,
): { dips: RetentionDip[]; patterns: DipPattern[]; top_fixes: string[] } {
  let parsed: unknown;
  try {
    parsed = parseLlmJson(raw);
  } catch (err) {
    throw new Error(
      `Could not parse JSON from dip-fix output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Dip-fix output is not a JSON object.');
  }
  const obj = parsed as RawDipFixOutput;

  // Map LLM output back onto the rawDips by index, so the response shape is
  // anchored to the deterministic dip detection (no hallucinated dips).
  const dipsByIndex = new Map<number, { why: string; fix: string; estimated_lift_pct?: number }>();
  for (const entry of obj.dips ?? []) {
    if (!entry) continue;
    const idx = typeof entry.index === 'number' ? Math.floor(entry.index) - 1 : -1;
    if (idx < 0 || idx >= rawDips.length) continue;
    const why = typeof entry.why === 'string' ? entry.why.slice(0, 240) : '';
    const fix = typeof entry.fix === 'string' ? entry.fix.slice(0, 400) : '';
    if (!why && !fix) continue;
    const lift =
      typeof entry.estimated_lift_pct === 'number' && Number.isFinite(entry.estimated_lift_pct)
        ? Math.max(0, Math.min(15, entry.estimated_lift_pct))
        : undefined;
    dipsByIndex.set(idx, { why, fix, estimated_lift_pct: lift });
  }

  const dips: RetentionDip[] = rawDips.map((rd, idx) => {
    const enriched = dipsByIndex.get(idx);
    return {
      start_seconds: rd.start_seconds,
      end_seconds: rd.end_seconds,
      retention_before: rd.retention_before,
      retention_after: rd.retention_after,
      drop_pct: rd.drop_pct,
      severity: rd.severity,
      script_excerpt: rd.script_excerpt,
      why: enriched?.why ?? 'No hypothesis returned.',
      fix: enriched?.fix ?? 'Re-run the analysis or A/B test this segment.',
      estimated_lift_pct: enriched?.estimated_lift_pct,
    };
  });

  const patterns: DipPattern[] = (obj.patterns ?? [])
    .map((p) => {
      if (!p) return null;
      const pattern = typeof p.pattern === 'string' ? p.pattern.slice(0, 160) : '';
      const recommendation = typeof p.recommendation === 'string' ? p.recommendation.slice(0, 320) : '';
      const indices = Array.isArray(p.affected_dip_indices)
        ? p.affected_dip_indices
            .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
            .map((n) => Math.floor(n) - 1)
            .filter((n) => n >= 0 && n < dips.length)
        : [];
      if (!pattern && !recommendation) return null;
      return { pattern, affected_dip_indices: indices, recommendation };
    })
    .filter((p): p is DipPattern => p !== null)
    .slice(0, 6);

  const top_fixes: string[] = Array.isArray(obj.top_fixes)
    ? obj.top_fixes
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.slice(0, 320))
        .filter(Boolean)
        .slice(0, 5)
    : [];

  return { dips, patterns, top_fixes };
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface AnalyzeRetentionDipsArgs {
  workspaceId: string;
  youtubeVideoId: string;
  scriptText: string;
  channelDbId?: string | null;
  projectId?: string | null;
  sourceScriptId?: string | null;
  modelId?: string;
  notes?: string | null;
}

interface VideoAnalyticsLookup {
  channel_id: string | null;
  title: string | null;
  duration_seconds: number | null;
  average_view_percentage: number | null;
  retention_curve: unknown;
}

export async function analyzeRetentionDips(
  args: AnalyzeRetentionDipsArgs,
): Promise<{ id: string; analysis: DipAnalysis }> {
  const script = args.scriptText.trim();
  if (script.length < 200) {
    throw new Error('Script too short — need at least 200 characters to align dips against script content.');
  }

  // 1. Pull the video's analytics row.
  const { rows } = await sql<VideoAnalyticsLookup>`
    SELECT channel_id, title, duration_seconds, average_view_percentage, retention_curve
      FROM video_analytics
     WHERE workspace_id = ${args.workspaceId}::uuid
       AND youtube_video_id = ${args.youtubeVideoId}
     LIMIT 1
  `;
  const va = rows[0];
  if (!va) {
    throw new Error(
      'Video not found in analytics. Open the schedule item and click "Sync analytics" first, then retry.',
    );
  }
  const curve = normalizeCurve(va.retention_curve);
  if (curve.length < 4) {
    throw new Error('Retention curve is unavailable or too sparse — re-sync analytics with the Analytics scope enabled.');
  }
  const duration = va.duration_seconds && va.duration_seconds > 0
    ? va.duration_seconds
    : estimateDurationSeconds(countSpokenWords(script));

  // 2. Detect dips deterministically.
  const rawDips = detectRawDips(curve, duration);
  if (rawDips.length === 0) {
    // No drops worth analyzing — the curve is impressively smooth. Persist
    // an empty analysis so the user can see "nothing to fix here".
    const { rows: emptyRows } = await sql<{ id: string }>`
      INSERT INTO dip_analyses (
        workspace_id, channel_db_id, project_id, source_script_id,
        youtube_video_id, video_title, video_duration_seconds,
        script_text, retention_curve_snapshot, average_view_percentage,
        detected_dips, top_fixes, patterns,
        ai_model, generation_params, notes
      ) VALUES (
        ${args.workspaceId}::uuid,
        ${args.channelDbId ?? va.channel_id ?? null}::uuid,
        ${args.projectId ?? null}::uuid,
        ${args.sourceScriptId ?? null}::uuid,
        ${args.youtubeVideoId},
        ${va.title},
        ${duration},
        ${script},
        ${JSON.stringify(curve)}::jsonb,
        ${va.average_view_percentage ?? null},
        '[]'::jsonb,
        '["No significant dips detected — curve is impressively smooth. Focus on the cold open + final 20% to push the average higher."]'::jsonb,
        '[]'::jsonb,
        ${'(no model call — no dips to analyze)'},
        '{}'::jsonb,
        ${args.notes ?? null}
      )
      RETURNING id
    `;
    return {
      id: emptyRows[0]!.id,
      analysis: {
        detected_dips: [],
        top_fixes: ['No significant dips detected — curve is impressively smooth. Focus on the cold open + final 20% to push the average higher.'],
        patterns: [],
        observed_avp_percentage: va.average_view_percentage ?? null,
      },
    };
  }

  // 3. Attach script excerpts and ask the model.
  const dipsWithExcerpts = rawDips.map((d) => ({
    ...d,
    script_excerpt: scriptExcerptForDip(script, duration, d.start_seconds, d.end_seconds),
  }));

  const modelId = args.modelId || DEFAULT_DIP_MODEL;
  const { system, user } = buildDipFixPrompt({
    videoTitle: va.title,
    videoDurationSeconds: duration,
    scriptText: script,
    rawDips: dipsWithExcerpts,
    observedAvpPercentage: va.average_view_percentage ?? null,
  });

  const raw = await generateText({
    modelId,
    systemPrompt: system,
    prompt: user,
    maxTokens: 4000,
    temperature: 0.3,
  });

  let parsed: { dips: RetentionDip[]; patterns: DipPattern[]; top_fixes: string[] };
  try {
    parsed = parseDipFixOutput(raw, dipsWithExcerpts);
  } catch (err) {
    logger.error('dip-fix parse failed', {
      detail: err instanceof Error ? err.message : String(err),
      raw_preview: raw.slice(0, 400),
    });
    throw err;
  }

  const { rows: insertRows } = await sql<{ id: string }>`
    INSERT INTO dip_analyses (
      workspace_id, channel_db_id, project_id, source_script_id,
      youtube_video_id, video_title, video_duration_seconds,
      script_text, retention_curve_snapshot, average_view_percentage,
      detected_dips, top_fixes, patterns,
      ai_model, generation_params, notes
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.channelDbId ?? va.channel_id ?? null}::uuid,
      ${args.projectId ?? null}::uuid,
      ${args.sourceScriptId ?? null}::uuid,
      ${args.youtubeVideoId},
      ${va.title},
      ${duration},
      ${script},
      ${JSON.stringify(curve)}::jsonb,
      ${va.average_view_percentage ?? null},
      ${JSON.stringify(parsed.dips)}::jsonb,
      ${JSON.stringify(parsed.top_fixes)}::jsonb,
      ${JSON.stringify(parsed.patterns)}::jsonb,
      ${modelId},
      ${JSON.stringify({ raw_dip_count: rawDips.length })}::jsonb,
      ${args.notes ?? null}
    )
    RETURNING id
  `;

  return {
    id: insertRows[0]!.id,
    analysis: {
      detected_dips: parsed.dips,
      top_fixes: parsed.top_fixes,
      patterns: parsed.patterns,
      observed_avp_percentage: va.average_view_percentage ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export async function getDipAnalysis(
  id: string,
  workspaceId: string,
): Promise<DipAnalysisRow | null> {
  const { rows } = await sql<DipAnalysisRow>`
    SELECT
      id, workspace_id, channel_db_id, project_id, source_script_id,
      youtube_video_id, video_title, video_duration_seconds,
      script_text, retention_curve_snapshot, average_view_percentage,
      detected_dips, top_fixes, patterns,
      ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM dip_analyses
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listDipAnalyses(
  workspaceId: string,
  opts: { channelDbId?: string; youtubeVideoId?: string; limit?: number } = {},
): Promise<DipAnalysisRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.youtubeVideoId) {
    const { rows } = await sql<DipAnalysisRow>`
      SELECT
        id, workspace_id, channel_db_id, project_id, source_script_id,
        youtube_video_id, video_title, video_duration_seconds,
        script_text, retention_curve_snapshot, average_view_percentage,
        detected_dips, top_fixes, patterns,
        ai_model, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM dip_analyses
      WHERE workspace_id = ${workspaceId}::uuid
        AND youtube_video_id = ${opts.youtubeVideoId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.channelDbId) {
    const { rows } = await sql<DipAnalysisRow>`
      SELECT
        id, workspace_id, channel_db_id, project_id, source_script_id,
        youtube_video_id, video_title, video_duration_seconds,
        script_text, retention_curve_snapshot, average_view_percentage,
        detected_dips, top_fixes, patterns,
        ai_model, notes,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM dip_analyses
      WHERE workspace_id = ${workspaceId}::uuid
        AND channel_db_id = ${opts.channelDbId}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<DipAnalysisRow>`
    SELECT
      id, workspace_id, channel_db_id, project_id, source_script_id,
      youtube_video_id, video_title, video_duration_seconds,
      script_text, retention_curve_snapshot, average_view_percentage,
      detected_dips, top_fixes, patterns,
      ai_model, notes,
      created_at::text AS created_at,
      updated_at::text AS updated_at
    FROM dip_analyses
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export async function deleteDipAnalysis(id: string, workspaceId: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM dip_analyses
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  return (result.rowCount ?? 0) > 0;
}
