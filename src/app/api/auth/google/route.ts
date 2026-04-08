import { NextRequest, NextResponse } from 'next/server';
import { getAuthorizationUrl } from '@/lib/google-oauth';

export async function GET(req: NextRequest) {
  const channelId = req.nextUrl.searchParams.get('channelId');
  if (!channelId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  try {
    const url = await getAuthorizationUrl(channelId);
    return NextResponse.redirect(url);
  } catch (err: unknown) {
    console.error('OAuth initiation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start OAuth' },
      { status: 500 },
    );
  }
}
