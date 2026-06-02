import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { getEffectiveModelId } from '@/lib/model-defaults';
import {
  HOOK_STYLES,
  POVS,
  TONES,
  buildShortsIdeasPrompt,
  clampCount,
  clampTargetLength,
  parseShortsIdeas,
  type FormatHints,
  type HookStyle,
  type NicheContext,
  type PovStyle,
  type Tone,
} from '@/lib/shorts-ideas';
import { getSeries } from '@/lib/shorts-series';

/**
 * POST /api/shorts/ideas
 *
 * Hook-first Shorts idea generation. Single AI call. Phase 15.8 widened
 * the body shape with format hints, niche-row context, series intro/outro,
 * and inspired-by / avoid title lists. All new fields are OPTIONAL — the
 * old { niche, context, count } shape still works.
 *
 * Body (all 15.8 additions optional):
 *   - niche:           required, trimmed
 *   - context:         optional extra prompt context
 *   - count:           optional, clamped to [3, 15]
 *   - modelId:         optional override
 *   - nicheRowId:      optional UUID — auto-loads description + keywords
 *                      from the workspace's niches table
 *   - formatHints:     optional { targetLengthSec, hookStyle, tone, pov }
 *   - seriesId:        optional UUID — overrides intro/outro from the
 *                      series row (Phase 15.6)
 *   - inspiredByTitles: optional string[] — top performers to pattern
 *   - avoidTitles:     optional string[] — recent titles to skip
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: {
    niche?: string;
    context?: string;
    count?: number;
    modelId?: string;
    nicheRowId?: string;
    formatHints?: {
      targetLengthSec?: number;
      hookStyle?: string;
      tone?: string;
      pov?: string;
    };
    seriesId?: string;
    inspiredByTitles?: string[];
    avoidTitles?: string[];
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.niche !== 'string' || body.niche.trim().length === 0) {
    return NextResponse.json({ error: 'niche required' }, { status: 400 });
  }

  try {
    // Optionally pull the niche row's description + keywords.
    let nicheContext: NicheContext | undefined;
    if (body.nicheRowId) {
      const { rows } = await sql<{ description: string | null; keywords: string[] | null }>`
        SELECT description, keywords
          FROM niches
         WHERE id = ${body.nicheRowId}::uuid
           AND workspace_id = ${session.ws}::uuid
         LIMIT 1
      `;
      if (rows[0]) {
        nicheContext = {
          description: rows[0].description ?? undefined,
          keywords: rows[0].keywords ?? undefined,
        };
      }
    }

    // Optionally pull series intro/outro.
    let seriesIntro: string | undefined;
    let seriesOutro: string | undefined;
    if (body.seriesId) {
      const series = await getSeries(body.seriesId, session.ws);
      if (series) {
        seriesIntro = series.intro_text ?? undefined;
        seriesOutro = series.outro_text ?? undefined;
      }
    }

    // Validate format hints — drop any unknown enum values silently
    // instead of 400ing (forward-compat with future hint vocabularies).
    const formatHints: FormatHints = {};
    if (body.formatHints) {
      const tl = clampTargetLength(body.formatHints.targetLengthSec);
      if (tl != null) formatHints.targetLengthSec = tl;
      if (typeof body.formatHints.hookStyle === 'string'
        && (HOOK_STYLES as readonly string[]).includes(body.formatHints.hookStyle)) {
        formatHints.hookStyle = body.formatHints.hookStyle as HookStyle;
      }
      if (typeof body.formatHints.tone === 'string'
        && (TONES as readonly string[]).includes(body.formatHints.tone)) {
        formatHints.tone = body.formatHints.tone as Tone;
      }
      if (typeof body.formatHints.pov === 'string'
        && (POVS as readonly string[]).includes(body.formatHints.pov)) {
        formatHints.pov = body.formatHints.pov as PovStyle;
      }
    }

    const modelId = body.modelId || (await getEffectiveModelId(session.ws, 'shorts-ideas'));
    const count = clampCount(body.count);
    const { system, user } = buildShortsIdeasPrompt({
      niche: body.niche.trim(),
      context: body.context?.trim(),
      count,
      formatHints: Object.keys(formatHints).length > 0 ? formatHints : undefined,
      nicheContext,
      seriesIntro,
      seriesOutro,
      inspiredByTitles: Array.isArray(body.inspiredByTitles)
        ? body.inspiredByTitles.filter((t): t is string => typeof t === 'string')
        : undefined,
      avoidTitles: Array.isArray(body.avoidTitles)
        ? body.avoidTitles.filter((t): t is string => typeof t === 'string')
        : undefined,
    });

    const raw = await generateText({
      modelId,
      systemPrompt: system,
      prompt: user,
      maxTokens: 3000,
      temperature: 0.85,
      spend: {
        workspaceId: session.ws,
        projectId: null,
        featureArea: 'shorts_ideas',
        metadata: {
          count,
          niche: body.niche.trim().slice(0, 60),
          format_hints: formatHints,
          niche_row_id: body.nicheRowId ?? null,
          series_id: body.seriesId ?? null,
          inspired_count: body.inspiredByTitles?.length ?? 0,
          avoid_count: body.avoidTitles?.length ?? 0,
        },
      },
    });

    const ideas = parseShortsIdeas(raw);
    logger.info('[shorts ideas]', {
      workspaceId: session.ws,
      modelId,
      niche: body.niche.trim().slice(0, 60),
      countRequested: count,
      countReturned: ideas.length,
      formatHints,
      seriesId: body.seriesId ?? null,
    });
    return NextResponse.json({ ideas, modelId });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'shorts: ideas',
      fallbackMessage: 'Failed to generate Shorts ideas.',
    });
  }
});
