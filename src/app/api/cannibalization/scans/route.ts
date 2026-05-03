import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { runCannibalizationScan } from '@/lib/cannibalization';

// AI step is Haiku — fast — but we cap at 10 pairs per scan, so worst
// case is ~10 sequential calls. 60s ceiling is comfortable.
export const maxDuration = 180;

/**
 * POST /api/cannibalization/scans
 *
 * Body (all optional):
 *   { windowDays?: number, lookbackDays?: number, lookaheadDays?: number, modelId?: string }
 *
 * Runs a full scan. Returns counts + the alerts that were freshly created
 * (existing active alerts for the same pair are deduped silently).
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown = {};
  try {
    if (req.body) body = await req.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const num = (k: string, lo: number, hi: number) => {
    const v = b[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.max(lo, Math.min(hi, Math.round(v)));
  };

  try {
    const result = await runCannibalizationScan({
      workspaceId: session.ws,
      windowDays: num('windowDays', 1, 30),
      lookbackDays: num('lookbackDays', 1, 90),
      lookaheadDays: num('lookaheadDays', 1, 90),
      modelId: typeof b.modelId === 'string' && b.modelId ? b.modelId : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'cannibalization: scan',
      fallbackMessage: 'Cannibalization scan failed — please try again.',
    });
  }
});
