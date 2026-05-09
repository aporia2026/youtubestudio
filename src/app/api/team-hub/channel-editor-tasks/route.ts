/**
 * GET /api/team-hub/channel-editor-tasks?id=<channelEditorId>&channel=<channelId>
 *
 * Workspace-scoped detail for a single channel editor on a single channel.
 * The query takes both ids because a person can edit multiple channels —
 * the team-hub roster surfaces them as separate entries (composite id
 * `<editor>@<channel>`). Both ids are validated as UUIDs.
 */
import { apiRoute } from '@/lib/route-helpers';
import { NextResponse } from 'next/server';
import { getChannelEditorTasks } from '@/lib/team-hub-tasks-db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = apiRoute.authed(async (session, req) => {
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const channel = req.nextUrl.searchParams.get('channel') ?? '';
  if (!UUID_RE.test(id) || !UUID_RE.test(channel)) {
    return NextResponse.json({ error: 'Invalid id or channel' }, { status: 400 });
  }
  try {
    const task = await getChannelEditorTasks(session.ws, id, channel);
    if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    logger.error('GET /api/team-hub/channel-editor-tasks', {
      detail: err instanceof Error ? err.message : String(err),
      workspace_id: session.ws,
      channel_editor_id: id,
      channel_id: channel,
    });
    return NextResponse.json({ error: 'Failed to load channel editor task' }, { status: 500 });
  }
});
