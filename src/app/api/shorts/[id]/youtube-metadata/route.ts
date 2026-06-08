import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { updateShortYoutubeMetadata, updateShortPublishAt } from '@/lib/shorts-batches';
import type { YoutubeUploadMetadata } from '@/lib/shorts-batches-types';

/**
 * PATCH /api/shorts/[id]/youtube-metadata
 *
 * Per-short metadata edit from the review queue. Two distinct
 * patches in a single body:
 *   - `metadata` — merged into the short's `youtube_metadata` JSONB.
 *     Validation happens at upload time, not here, so the user can
 *     save partial edits without being blocked.
 *   - `publishAt` — null clears the schedule; an ISO string sets it.
 *     The string is stored verbatim; future-vs-past validation
 *     happens at upload time.
 */
export const PATCH = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    let body: { metadata?: Partial<YoutubeUploadMetadata>; publishAt?: string | null } = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body.metadata && body.publishAt === undefined) {
      return NextResponse.json(
        { error: 'PATCH body must include `metadata` and/or `publishAt`.' },
        { status: 400 },
      );
    }

    let mergedMetadata: YoutubeUploadMetadata | null = null;
    if (body.metadata) {
      mergedMetadata = await updateShortYoutubeMetadata(id, session.ws, body.metadata);
      if (!mergedMetadata) {
        return NextResponse.json({ error: 'Short not found' }, { status: 404 });
      }
    }

    if (body.publishAt !== undefined) {
      // Allow explicit null to clear. ISO string parsing happens at
      // upload time so an in-progress edit isn't blocked.
      await updateShortPublishAt(id, session.ws, body.publishAt);
    }

    return NextResponse.json({ metadata: mergedMetadata, publishAt: body.publishAt ?? undefined });
  },
);
