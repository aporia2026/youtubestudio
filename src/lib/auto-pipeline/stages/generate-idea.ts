/**
 * Stage handler: idea generation.
 *
 * Active for stages `queued` and `generating_idea` (rows that
 * started fresh, with no idea_id). Existing-idea rows skip this
 * handler entirely — they start at `generating_script`.
 *
 * Calls `ideaGenerationPrompt` + `generateTextWithFallback` with
 * the chain configured on the preset (or DEFAULT_FALLBACK_CHAINS
 * if none). Inserts ONE idea into `video_ideas` per video row —
 * the LLM may return N ideas but we only need one per video; the
 * batch-level "give me K fresh ideas to rank" is handled at the
 * pipeline-run level (one video row per requested idea), not
 * here.
 *
 * On success: video.idea_id set, advance to `generating_script`.
 * On refusal/unknown failure: terminal `idea_generation_failed`.
 * (Earlier versions mis-routed these to `production_doc_failed`,
 * which broke the Retry button: my reset logic would push the row
 * to `generating_production_doc` and the invariant guard there
 * would fire with "no script_id or project_id". Fixed 2026-05-26.)
 */
import { sql } from '@vercel/postgres';
import { ideaGenerationPrompt } from '../../prompts';
import { generateTextWithFallback } from '../../ai';
import { GenerateFailure } from '../../ai-fallback';
import { resolveChain } from '../resolve-chain';
import type { StageHandlerContext, StageOutcome } from '../types';

export async function handleGenerateIdea(ctx: StageHandlerContext): Promise<StageOutcome> {
  const { video, preset } = ctx;

  // Resolve the model chain. Preset override > registry default >
  // single-model fallback via the Phase 6.2 resolver.
  const chain = await resolveChain('idea-generator', preset);

  // Idea-gen context from the preset.
  const ctxJson = (preset.idea_context_jsonb ?? {}) as {
    niche?: string;
    audience?: string;
    focus?: 'trending' | 'evergreen' | 'controversial' | 'beginner' | 'mixed';
    videoType?: string;
    referenceContext?: string;
    redditContext?: string;
  };
  const niche = preset.niche || ctxJson.niche;
  if (!niche) {
    return {
      kind: 'fail',
      terminalStage: 'idea_generation_failed',
      failureClass: 'config_missing',
      failureMessage: 'Preset is missing a niche — required for idea generation.',
    };
  }

  let result: Awaited<ReturnType<typeof generateTextWithFallback>>;
  try {
    result = await generateTextWithFallback(chain, (modelId) => {
      const prompt = ideaGenerationPrompt({
        niche,
        count: 1,
        audience: ctxJson.audience,
        focus: ctxJson.focus,
        videoType: ctxJson.videoType,
        referenceContext: ctxJson.referenceContext,
        redditContext: ctxJson.redditContext,
      });
      return {
        modelId,
        prompt: prompt.user,
        systemPrompt: prompt.system,
        maxTokens: 2000,
        temperature: 0.9,
        spend: {
          workspaceId: video.workspace_id,
          projectId: video.project_id,
          featureArea: 'pipeline_idea_generation',
        },
      };
    });
  } catch (err) {
    if (err instanceof GenerateFailure) {
      return {
        kind: 'fail',
        terminalStage: 'idea_generation_failed',
        failureClass: err.failureClass,
        failureMessage: err.message.slice(0, 500),
      };
    }
    throw err;
  }

  const parsed = parseFirstIdea(result.text);
  if (!parsed) {
    return {
      kind: 'fail',
      terminalStage: 'idea_generation_failed',
      failureClass: 'empty_or_malformed',
      failureMessage: 'Model returned no parseable idea.',
    };
  }

  // Insert the idea into video_ideas. Workspace-scoped per the
  // multi-tenant pattern. is_saved=true so it shows up in the
  // user's saved-ideas surface; is_used=false (the pipeline will
  // mark it used when the video reaches 'done').
  const { rows } = await sql.query<{ id: string }>(
    `
    INSERT INTO video_ideas
      (workspace_id, niche, title, hook, description, target_audience,
       estimated_views_potential, trend_relevance, difficulty, tags, is_saved, is_used)
    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, true, false)
    RETURNING id::text AS id
    `,
    [
      video.workspace_id,
      niche,
      parsed.title,
      parsed.hook ?? null,
      parsed.description ?? null,
      ctxJson.audience ?? null,
      parsed.estimated_views_potential ?? null,
      parsed.trend_relevance ?? null,
      parsed.difficulty ?? null,
      parsed.tags ? JSON.stringify(parsed.tags) : '[]',
    ],
  );

  return {
    kind: 'advance',
    nextStage: 'generating_script',
    persist: { idea_id: rows[0].id },
  };
}

interface ParsedIdea {
  title: string;
  hook?: string;
  description?: string;
  estimated_views_potential?: string;
  trend_relevance?: string;
  difficulty?: string;
  tags?: string[];
}

/**
 * Pull the first idea out of the model's response. The LLM is
 * asked for N ideas as a JSON array; we take the first one and
 * normalise the field shape. Defensive against malformed output.
 */
function parseFirstIdea(text: string): ParsedIdea | null {
  // Strip ```json fences if present.
  let body = text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ideas?: unknown }).ideas)
    ? (parsed as { ideas: unknown[] }).ideas
    : null;
  if (!arr || arr.length === 0) return null;
  const first = arr[0];
  if (typeof first !== 'object' || first === null) return null;
  const f = first as Record<string, unknown>;
  const title = typeof f.title === 'string' ? f.title.trim() : '';
  if (!title) return null;
  return {
    title,
    hook: typeof f.hook === 'string' ? f.hook : undefined,
    description: typeof f.description === 'string' ? f.description : undefined,
    estimated_views_potential: typeof f.estimated_views_potential === 'string' ? f.estimated_views_potential : undefined,
    trend_relevance: typeof f.trend_relevance === 'string' ? f.trend_relevance : undefined,
    difficulty: typeof f.difficulty === 'string' ? f.difficulty : undefined,
    tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t === 'string') : undefined,
  };
}

