import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { assertOwnsResource, ResourceNotInWorkspaceError } from '@/lib/workspace-scope';
import { createAbTest, listAbTests } from '@/lib/ab-tests';

export const maxDuration = 30;

/**
 * GET /api/ab-tests?scheduleItemId=&youtubeVideoId=&limit=
 *
 * List A/B tests in the current workspace, newest first. Filterable by
 * the schedule item that spawned them or by YouTube video id.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const scheduleItemId = searchParams.get('scheduleItemId') || undefined;
  const youtubeVideoId = searchParams.get('youtubeVideoId') || undefined;
  const limit = Number.parseInt(searchParams.get('limit') ?? '50', 10) || 50;
  const tests = await listAbTests(session.ws, { scheduleItemId, youtubeVideoId, limit });
  return NextResponse.json({ tests });
});

/**
 * POST /api/ab-tests
 *
 * Body: {
 *   scheduleItemId?: string,
 *   channelDbId?: string,
 *   youtubeVideoId: string,
 *   variantATitle: string,
 *   variantBTitle: string,
 *   variantAThumbnailUrl?: string,
 *   variantBThumbnailUrl?: string,
 *   aiModel?: string,
 *   notes?: string,
 * }
 *
 * Creates the test row in 'draft' status. The variants aren't pushed to
 * YouTube until the operator calls /swap with toVariant='a'.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const youtubeVideoId = typeof b.youtubeVideoId === 'string' ? b.youtubeVideoId.trim() : '';
  if (!youtubeVideoId) {
    return NextResponse.json({ error: 'youtubeVideoId is required' }, { status: 400 });
  }

  const variantATitle = typeof b.variantATitle === 'string' ? b.variantATitle : '';
  const variantBTitle = typeof b.variantBTitle === 'string' ? b.variantBTitle : '';
  const variantAThumbnailUrl =
    typeof b.variantAThumbnailUrl === 'string' && b.variantAThumbnailUrl ? b.variantAThumbnailUrl : null;
  const variantBThumbnailUrl =
    typeof b.variantBThumbnailUrl === 'string' && b.variantBThumbnailUrl ? b.variantBThumbnailUrl : null;
  const scheduleItemId = typeof b.scheduleItemId === 'string' && b.scheduleItemId ? b.scheduleItemId : null;
  const channelDbId = typeof b.channelDbId === 'string' && b.channelDbId ? b.channelDbId : null;
  const aiModel = typeof b.aiModel === 'string' && b.aiModel ? b.aiModel : null;
  const notes = typeof b.notes === 'string' && b.notes ? b.notes : null;

  // Ownership checks for the optional FK fields.
  try {
    if (scheduleItemId) await assertOwnsResource('schedule_items', scheduleItemId, session.ws);
    if (channelDbId) await assertOwnsResource('channels', channelDbId, session.ws);
  } catch (err) {
    if (err instanceof ResourceNotInWorkspaceError) {
      return NextResponse.json({ error: 'Resource not found in this workspace' }, { status: 404 });
    }
    throw err;
  }

  try {
    const result = await createAbTest({
      workspaceId: session.ws,
      scheduleItemId,
      channelDbId,
      youtubeVideoId,
      variantATitle,
      variantBTitle,
      variantAThumbnailUrl,
      variantBThumbnailUrl,
      aiModel,
      notes,
    });
    return NextResponse.json({ ...result, status: 'draft' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
});
