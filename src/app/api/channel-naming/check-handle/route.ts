import { NextRequest, NextResponse } from 'next/server';
import { checkHandleAvailable } from '@/lib/youtube';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';

export async function POST(req: NextRequest) {
  const { limited } = checkRateLimit(`handle-check:${getClientIP(req)}`, 30, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: { handle?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.handle) return NextResponse.json({ error: 'handle required' }, { status: 400 });

  const result = await checkHandleAvailable(body.handle);
  return NextResponse.json(result);
}
