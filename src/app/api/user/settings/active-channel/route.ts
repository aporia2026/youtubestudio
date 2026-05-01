import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  getActiveChannelId,
  setActiveChannelId,
  ChannelNotInWorkspaceError,
} from '@/lib/active-channel';

/**
 * GET /api/user/settings/active-channel
 *
 * Returns the user's currently pinned channel id, or null for "All channels".
 */
export const GET = apiRoute.authed(async (session) => {
  const id = await getActiveChannelId(session.uid);
  return NextResponse.json({ active_channel_id: id });
});

/**
 * POST /api/user/settings/active-channel  body: { channelId: string | null }
 *
 * Pin a channel (or clear with null). The channel must belong to the user's
 * workspace — cross-tenant pin is rejected with 403 even though the proxy
 * already gated this route by session.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const raw = (body as { channelId?: unknown } | null)?.channelId;
  let channelId: string | null;
  if (raw === null || raw === undefined || raw === '') {
    channelId = null;
  } else if (typeof raw === 'string') {
    channelId = raw;
  } else {
    return NextResponse.json(
      { error: 'channelId must be a string or null' },
      { status: 400 },
    );
  }

  try {
    await setActiveChannelId(session.uid, channelId, session.ws);
  } catch (err) {
    if (err instanceof ChannelNotInWorkspaceError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true, active_channel_id: channelId });
});
