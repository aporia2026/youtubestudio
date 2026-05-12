import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { discoverFromInterests } from '@/lib/niche-finder/discover-from-interests';
import type { OperatorFit } from '@/lib/niche-finder/types';

/**
 * POST /api/niche-finder/discover/from-interests
 *
 * Mode A (interest-based discovery). Body:
 *   {
 *     interests: string[],     // required — 1 to 5 short phrases
 *     language?: string,
 *     region?: string,
 *     fit?: OperatorFit,
 *     force?: boolean
 *   }
 */
function parseOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function parseInterests(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const i of value) {
    if (typeof i === 'string' && i.trim().length > 0 && out.length < 5) {
      out.push(i.trim().slice(0, 80));
    }
  }
  return out;
}

function parseFit(value: unknown): OperatorFit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const interests = parseInterests(obj.interests);
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
  const interests = parseInterests(raw.interests);
  if (interests.length === 0) {
    return NextResponse.json({ error: 'At least one interest is required' }, { status: 400 });
  }

  try {
    const result = await discoverFromInterests({
      workspaceId: session.ws,
      interests,
      language: parseOptionalString(raw.language, 16),
      region: parseOptionalString(raw.region, 16),
      fit: parseFit(raw.fit),
      force: raw.force === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: discover/from-interests',
      fallbackMessage: 'Could not generate niche ideas. Try again in a moment.',
    });
  }
});
