import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { discoverFromChannel } from '@/lib/niche-finder/discover-from-channel';
import type { OperatorFit } from '@/lib/niche-finder/types';

/**
 * POST /api/niche-finder/discover/from-channel
 *
 * Mode B (channel-paste discovery). Body:
 *   {
 *     channelUrl: string,      // required — URL, @handle, or channel id
 *     language?: string,
 *     region?: string,
 *     fit?: OperatorFit,
 *     force?: boolean
 *   }
 *
 * Returns { discovery, cached, fetchOk }.
 *
 * `fetchOk: false` indicates the channel resolution or upload fetch
 * failed (bad URL, private channel, YouTube API down). The UI
 * renders a "couldn't fetch this channel" banner; we never 500 on
 * the YouTube path so the operator always gets a response shape.
 */
const MAX_URL_LEN = 300;

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
  const channelUrl = parseOptionalString(raw.channelUrl, MAX_URL_LEN);
  if (!channelUrl) {
    return NextResponse.json({ error: 'channelUrl is required' }, { status: 400 });
  }

  try {
    const result = await discoverFromChannel({
      workspaceId: session.ws,
      channelUrl,
      language: parseOptionalString(raw.language, 16),
      region: parseOptionalString(raw.region, 16),
      fit: parseFit(raw.fit),
      force: raw.force === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'niche-finder: discover/from-channel',
      fallbackMessage: 'Could not discover from this channel. Try again in a moment.',
    });
  }
});
