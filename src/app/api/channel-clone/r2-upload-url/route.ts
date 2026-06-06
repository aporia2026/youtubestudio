/**
 * POST /api/channel-clone/r2-upload-url
 *
 * Mints a presigned PUT URL for a single channel-clone upload. The
 * client PUTs the file bytes directly to R2 with this URL; bytes
 * never touch our function (no body-size cap, no function bandwidth
 * spent on the transfer).
 *
 * Body: { filename: string, contentType: string }
 * Response: { key: string, uploadUrl: string }
 *
 * Key structure:
 *   channel-clone-uploads/<workspaceId>/<uuid>.<ext>
 * The workspaceId prefix is defense-in-depth on top of the
 * presigned URL itself — anyone outside the workspace can't even
 * construct a valid signing context.
 *
 * Allowed content types are intentionally a tight whitelist —
 * uploads here are reference videos, never images / archives /
 * arbitrary binaries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { apiRoute } from '@/lib/route-helpers';
import { getReviewBucket, getUploadUrlForBucket, isR2Configured } from '@/lib/r2';
import { logger } from '@/lib/logger';

export const maxDuration = 10;

const ALLOWED_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
]);

const MAX_FILENAME_LEN = 200;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'R2 is not configured on this deployment (missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).' },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const filename = typeof b.filename === 'string' ? b.filename.trim() : '';
  if (!filename || filename.length > MAX_FILENAME_LEN) {
    return NextResponse.json(
      { error: `filename is required and must be ≤ ${MAX_FILENAME_LEN} characters` },
      { status: 400 },
    );
  }

  const contentType = typeof b.contentType === 'string' ? b.contentType.toLowerCase() : '';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json(
      { error: `contentType must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}` },
      { status: 400 },
    );
  }

  // Extension comes from the filename, not the contentType, so a
  // user uploading a .mkv with `video/mp4` content-type ends up
  // with a .mkv key — matches what the runner's ffmpeg autodetect
  // expects.
  const extMatch = /\.([a-z0-9]{2,5})$/i.exec(filename);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
  const key = `channel-clone-uploads/${session.ws}/${randomUUID()}.${ext}`;

  try {
    const uploadUrl = await getUploadUrlForBucket(getReviewBucket(), key, contentType);
    logger.info('[channel-clone r2-upload-url] minted', {
      workspaceId: session.ws,
      key,
      contentType,
    });
    return NextResponse.json({ key, uploadUrl });
  } catch (err) {
    logger.error('[channel-clone r2-upload-url] failed', {
      workspaceId: session.ws,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Could not mint upload URL' },
      { status: 500 },
    );
  }
});
