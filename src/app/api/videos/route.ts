/**
 * POST /api/videos
 *
 * Creates a new video (a `projects` row) with optional channel link and
 * optional schedule item. Used by the Command Center's "+ New video"
 * dialog so the user can start a video from the kanban without going to
 * /ideas first.
 *
 * Body:
 *   {
 *     title: string (required, 1-300 chars),
 *     niche: string (optional, defaults to '' — feature pages prompt for
 *            it later),
 *     channelId?: UUID — links the new project to this channel,
 *     scheduledFor?: ISO datetime — creates a schedule_items row with
 *            this publish date.
 *   }
 *
 * Returns: { videoId, scheduleItemId? }
 *
 * Workspace-scoped at the helper level: session.ws is the only workspace
 * id that reaches the database, and channelId is verified against
 * session.ws before the link is created. A client passing a foreign
 * channel id is rejected with 400.
 *
 * The video's initial stage is implicit (no `video_stage_transitions`
 * row is written here) — `resolveStage()` in video-context.ts defaults
 * to 'script' for projects with no script, schedule, or pipeline yet,
 * which is the right initial state for a manual creation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: { title?: unknown; niche?: unknown; channelId?: unknown; scheduledFor?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 300) {
    return NextResponse.json({ error: 'title is required (1-300 chars)' }, { status: 400 });
  }
  const niche = typeof body.niche === 'string' ? body.niche.trim().slice(0, 200) : '';

  const channelId =
    typeof body.channelId === 'string' && UUID_RE.test(body.channelId) ? body.channelId : null;
  const scheduledFor =
    typeof body.scheduledFor === 'string' && body.scheduledFor.trim().length > 0
      ? body.scheduledFor.trim()
      : null;

  // Validate scheduledFor parses cleanly. A malformed date wins us a
  // 400 here instead of a Postgres error at INSERT time.
  if (scheduledFor !== null) {
    const ts = Date.parse(scheduledFor);
    if (!Number.isFinite(ts)) {
      return NextResponse.json({ error: 'scheduledFor must be an ISO datetime string' }, { status: 400 });
    }
  }

  // Validate channel belongs to this workspace before linking — never
  // trust a client-supplied channel id to come from the right workspace.
  if (channelId !== null) {
    const channelCheck = await sql`
      SELECT 1 FROM channels
       WHERE id = ${channelId}::uuid
         AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (channelCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Channel not found in this workspace' }, { status: 400 });
    }
  }

  // Insert project. niche is NOT NULL in the schema; empty string is a
  // valid placeholder — feature pages (generator, QA, etc.) will prompt
  // the user to fill it before they run.
  const projectInsert = await sql<{ id: string }>`
    INSERT INTO projects (workspace_id, title, niche, topic, status)
    VALUES (${session.ws}::uuid, ${title}, ${niche || ''}, ${title}, 'draft')
    RETURNING id::text AS id
  `;
  const videoId = projectInsert.rows[0]?.id;
  if (!videoId) {
    return NextResponse.json({ error: 'Failed to create video' }, { status: 500 });
  }

  // Link to channel via project_channels (composite PK, idempotent).
  if (channelId !== null) {
    await sql`
      INSERT INTO project_channels (project_id, channel_id)
      VALUES (${videoId}::uuid, ${channelId}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }

  // Create the schedule slot if a publish date was supplied. The
  // schedule item also gets a multi-channel link via
  // schedule_item_channels — matching the existing pattern in
  // /api/schedule/[id]/route.ts.
  let scheduleItemId: string | null = null;
  if (scheduledFor !== null) {
    const itemInsert = await sql<{ id: string }>`
      INSERT INTO schedule_items
        (workspace_id, title, scheduled_for, status, project_id, notes, tags, custom_fields, position)
      VALUES
        (${session.ws}::uuid, ${title}, ${scheduledFor}::timestamptz, 'idea',
         ${videoId}::uuid, '', '[]'::jsonb, '{}'::jsonb, 0)
      RETURNING id::text AS id
    `;
    scheduleItemId = itemInsert.rows[0]?.id ?? null;
    if (scheduleItemId && channelId !== null) {
      await sql`
        INSERT INTO schedule_item_channels (item_id, channel_id)
        VALUES (${scheduleItemId}::uuid, ${channelId}::uuid)
        ON CONFLICT DO NOTHING
      `;
    }
  }

  logger.info('[api videos POST] created', {
    video_id: videoId,
    workspace_id: session.ws,
    title_chars: title.length,
    has_channel: channelId !== null,
    has_schedule: scheduleItemId !== null,
  });

  return NextResponse.json({ videoId, scheduleItemId });
});
