import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/google-oauth';
import { listMyVideosOAuth } from '@/lib/youtube';

export async function GET(req: NextRequest) {
  const channelDbId = req.nextUrl.searchParams.get('channelId');
  if (!channelDbId) {
    return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
  }

  const accessToken = await getValidAccessToken(channelDbId);
  if (!accessToken) {
    return NextResponse.json(
      { error: 'YouTube not connected. Connect your channel via OAuth first.' },
      { status: 401 },
    );
  }

  try {
    const maxResults = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('limit') || '30') || 30, 1), 50);
    const videos = await listMyVideosOAuth(accessToken, maxResults);
    return NextResponse.json({ videos });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch videos' },
      { status: 500 },
    );
  }
}
