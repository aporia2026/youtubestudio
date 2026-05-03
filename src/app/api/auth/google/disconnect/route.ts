import { NextRequest, NextResponse } from 'next/server';
import { revokeOAuth } from '@/lib/google-oauth';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    const { channelId } = await req.json();
    if (!channelId) {
      return NextResponse.json({ error: 'channelId is required' }, { status: 400 });
    }

    await revokeOAuth(channelId);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    logger.error('OAuth disconnect error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Disconnect failed' },
      { status: 500 },
    );
  }
}
