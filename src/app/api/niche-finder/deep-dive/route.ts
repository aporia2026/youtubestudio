import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { runDeepDive } from '@/lib/niche-finder/run-deep-dive';
import type { OperatorFit } from '@/lib/niche-finder/types';

/**
 * POST /api/niche-finder/deep-dive
 *
 * Runs the orchestrator for a niche. Returns the persisted report.
 *
 * Body:
 *   {
 *     nicheText: string,            // required — free-text niche name
 *     fit?: OperatorFit,            // optional — interests + LLM fit score
 *     language?: string,            // optional — defaults to 'en'
 *     region?: string,              // optional — defaults to 'US'
 *     force?: boolean,              // optional — bypass the cache
 *   }
 *
 * Returns:
 *   200 { report, cached, clusterSource }   — happy path
 *   400                                     — missing or oversized input
 *   502                                     — orchestrator failure
 *
 * Workspace-scoped via `apiRoute.authed`; cross-workspace deep-dives
 * never share state because `niche_reports.workspace_id` is part of
 * the PK.
 */
const MAX_NICHE_TEXT_LEN = 120;

function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseFit(value: unknown): OperatorFit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const interestsRaw = Array.isArray(obj.interests) ? obj.interests : [];
  const interests: string[] = [];
  for (const i of interestsRaw) {
    if (typeof i === 'string' && i.trim().length > 0 && interests.length < 10) {
      interests.push(i.trim().slice(0, 80));
    }
  }
  const llmFitScoreRaw = obj.llmFitScore;
  const llmFitScore =
    typeof llmFitScoreRaw === 'number' && Number.isFinite(llmFitScoreRaw)
      ? Math.max(0, Math.min(1, llmFitScoreRaw))
      : 0.5;
  const llmRationale =
    typeof obj.llmRationale === 'string' ? obj.llmRationale.slice(0, 300) : '';
  const language = parseOptionalString(obj.language, 16) ?? 'en';
  const region = parseOptionalString(obj.region, 16) ?? 'US';
  return { interests, language, region, llmFitScore, llmRationale };
}

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const raw = body as Record<string, unknown>;
  const nicheText = parseOptionalString(raw.nicheText, MAX_NICHE_TEXT_LEN);
  if (!nicheText) {
    return NextResponse.json({ error: 'nicheText is required' }, { status: 400 });
  }

  const fit = parseFit(raw.fit);
  const language = parseOptionalString(raw.language, 16);
  const region = parseOptionalString(raw.region, 16);
  const force = raw.force === true;

  try {
    const result = await runDeepDive({
      workspaceId: session.ws,
      nicheText,
      fit,
      language,
      region,
      force,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: deep-dive',
      fallbackMessage: 'Could not generate the niche report. Try again in a moment.',
    });
  }
});
