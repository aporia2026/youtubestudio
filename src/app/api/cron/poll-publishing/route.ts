/**
 * Vercel cron entry — drain pending publishes.
 *
 * Polls every row currently in 'processing' across every workspace and
 * flips it to 'live'/'failed' as YouTube reports. Also fails rows
 * stuck in 'queued'/'uploading' for > 1 hour (orchestrator died
 * mid-upload).
 *
 * Wired in vercel.json on the same hourly schedule as run-workflows.
 * Same auth pattern: CRON_SECRET in prod, no auth on localhost dev.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pollAllPendingPublishes } from '@/lib/publishing';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization') ?? '';
  const isLocal =
    process.env.NODE_ENV !== 'production' &&
    (req.nextUrl.hostname === 'localhost' || req.nextUrl.hostname === '127.0.0.1');

  if (!isLocal) {
    if (!cronSecret) {
      return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 503 });
    }
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const result = await pollAllPendingPublishes({ limit: 50 });
  return NextResponse.json(result);
}

export const GET = POST;
