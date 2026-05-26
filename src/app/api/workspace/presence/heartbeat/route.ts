/**
 * POST /api/workspace/presence/heartbeat
 *
 * The browser fires this every ~20s while a user has a video open
 * (the VideoContextStrip mounts the effect). Body:
 *   { videoId: string | null }
 *
 * When videoId is null, the user's presence is cleared from every
 * video in the workspace (called when leaving a tool page).
 *
 * Returns the current presence snapshot for the workspace so the
 * caller can render badges without a separate GET. The Command Center
 * uses the dedicated /snapshot endpoint instead because it polls more
 * frequently than it heartbeats.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { findUserById } from '@/lib/users';
import {
  recordPresence,
  clearPresenceForUser,
  snapshotWorkspacePresence,
  maybeSweep,
} from '@/lib/presence';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: { videoId?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const videoIdRaw = body.videoId;
  const videoId =
    typeof videoIdRaw === 'string' && UUID_RE.test(videoIdRaw)
      ? videoIdRaw
      : null;

  // Resolve user's display name once per heartbeat. Cheap — the user row
  // is small. If the lookup fails (deleted user, etc.), fall back to id.
  let name: string | null = null;
  try {
    const me = await findUserById(session.uid);
    name = me?.name ?? null;
  } catch {
    name = null;
  }

  if (videoId === null) {
    clearPresenceForUser({ workspaceId: session.ws, userId: session.uid });
  } else {
    recordPresence({
      workspaceId: session.ws,
      videoId,
      userId: session.uid,
      name,
      color: null,
    });
  }

  maybeSweep();
  const presence = snapshotWorkspacePresence(session.ws);
  return NextResponse.json({ presence });
});
