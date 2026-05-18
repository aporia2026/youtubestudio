import { NextRequest, NextResponse } from 'next/server';
import { checkHandleAvailable } from '@/lib/youtube';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { apiRoute } from '@/lib/route-helpers';

/**
 * Auth wrap: hits the YouTube Data API, which is workspace-shared but
 * still costs quota. Behind apiRoute.authed so anonymous callers can't
 * burn the workspace's daily quota by scripting against this endpoint.
 * Rate limit stays — it caps a single (authed) user per minute.
 */
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  const { limited } = checkRateLimit(`handle-check:${getClientIP(req)}`, 30, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: { handle?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.handle) return NextResponse.json({ error: 'handle required' }, { status: 400 });

  const result = await checkHandleAvailable(body.handle);
  return NextResponse.json(result);
});
