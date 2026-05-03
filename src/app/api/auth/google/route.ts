import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/lib/google-oauth';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const channelId = req.nextUrl.searchParams.get('channelId');
  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  try {
    const url = await getAuthorizationUrl(channelId);
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    logger.error('OAuth initiation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start OAuth' },
      { status: 500 },
    );
  }
}
