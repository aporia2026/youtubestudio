/**
 * Publishing pipeline — list + create.
 *
 * GET  → recent publishes for the workspace, newest first. Filterable
 *        by channelDbId, scheduleItemId, projectId, status[].
 * POST → kick off a publish. Returns the created row id + initial
 *        status. Status will be 'processing' on success or 'failed' on
 *        validation/upload error. The client polls
 *        /api/publishing/[id] to watch the row flip to 'live' once
 *        YouTube finishes processing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import {
  listPublishedVideos,
  publishVideoToYouTube,
  type PublishStatus,
} from '@/lib/publishing';

// Worst-case path: fetch a 256MB MP4 + multipart-upload it to YouTube.
// 300s is the Vercel Pro ceiling and matches the existing render route.
export const maxDuration = 300;

const VALID_STATUSES = new Set<PublishStatus>(['queued', 'uploading', 'processing', 'live', 'failed']);

export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const channelDbId = searchParams.get('channelDbId') || undefined;
  const scheduleItemId = searchParams.get('scheduleItemId') || undefined;
  const projectId = searchParams.get('projectId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;

  const statusParam = searchParams.get('status'); // comma-separated
  const statuses = statusParam
    ? statusParam.split(',').map((s) => s.trim()).filter((s): s is PublishStatus => VALID_STATUSES.has(s as PublishStatus))
    : undefined;

  const publishes = await listPublishedVideos(session.ws, {
    channelDbId,
    scheduleItemId,
    projectId,
    statuses,
    limit,
  });
  return NextResponse.json({ publishes });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const channelDbId = typeof b.channelDbId === 'string' ? b.channelDbId.trim() : '';
  const sourceVideoUrl = typeof b.sourceVideoUrl === 'string' ? b.sourceVideoUrl.trim() : '';
  const title = typeof b.title === 'string' ? b.title : '';
  if (!channelDbId) return NextResponse.json({ error: 'channelDbId is required' }, { status: 400 });
  if (!sourceVideoUrl) return NextResponse.json({ error: 'sourceVideoUrl is required' }, { status: 400 });
  if (!title.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 });

  const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : null;
  const scheduleItemId = typeof b.scheduleItemId === 'string' && b.scheduleItemId ? b.scheduleItemId : null;

  // Ownership for every FK before kicking off a long upload — better
  // to 404 fast than to insert a row that can never be reconciled.
  try {
    await assertOwnsResource('channels', channelDbId, session.ws);
    if (projectId) await assertOwnsResource('projects', projectId, session.ws);
    if (scheduleItemId) await assertOwnsResource('schedule_items', scheduleItemId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Resource not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  try {
    const result = await publishVideoToYouTube({
      workspaceId: session.ws,
      channelDbId,
      projectId,
      scheduleItemId,
      sourceVideoUrl,
      title,
      description: typeof b.description === 'string' ? b.description : undefined,
      tags: Array.isArray(b.tags) ? (b.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
      categoryId: typeof b.categoryId === 'string' && b.categoryId ? b.categoryId : undefined,
      defaultLanguage: typeof b.defaultLanguage === 'string' && b.defaultLanguage ? b.defaultLanguage : undefined,
      privacyStatus:
        b.privacyStatus === 'private' || b.privacyStatus === 'unlisted' || b.privacyStatus === 'public'
          ? b.privacyStatus
          : undefined,
      publishAt: typeof b.publishAt === 'string' && b.publishAt ? b.publishAt : null,
      madeForKids: b.madeForKids === true,
      thumbnailUrl: typeof b.thumbnailUrl === 'string' && b.thumbnailUrl ? b.thumbnailUrl : null,
      playlistId: typeof b.playlistId === 'string' && b.playlistId ? b.playlistId : null,
      initiatedBy: session.uid,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'publishing: create',
      knownPatterns: [
        // Validation throws from the orchestrator (re-raised as one
        // string from the validator) → 400.
        { match: /required|must be|chars or fewer|tags allowed|http\(s\)|future|valid RFC3339/i, status: 400 },
      ],
      fallbackMessage: 'Could not start the YouTube upload — please try again.',
    });
  }
});
