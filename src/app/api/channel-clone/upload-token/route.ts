/**
 * POST /api/channel-clone/upload-token
 *
 * @vercel/blob client-upload token endpoint. The browser calls
 * `upload(filename, file, { handleUploadUrl: '/api/channel-clone/upload-token' })`
 * which makes a request here to mint a short-lived signed token,
 * then uploads the bytes DIRECTLY to Vercel Blob — bypassing our
 * function's body-size limit and bandwidth.
 *
 * Constraints we enforce:
 *   - allowedContentTypes: video/* only (no images, no zips).
 *   - maximumSizeInBytes: 500 MB per file. A 480p ~30-min explainer
 *     fits in ~50 MB; 500 MB covers 1080p uploads if the operator
 *     drops in higher-quality refs.
 *
 * Auth: `apiRoute.authed` enforces a valid session; the token mint
 * itself doesn't carry session info to the client.
 */

import { handleUpload } from '@vercel/blob/client';
import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';

export const maxDuration = 30;

const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024;

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  const body = await req.json();
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => ({
        allowedContentTypes: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
        maximumSizeInBytes: MAX_FILE_SIZE_BYTES,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({
          workspaceId: session.ws,
          userId: session.uid,
          pathname,
        }),
      }),
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // No DB writes here — the row gets created when the client
        // POSTs to /api/channel-clone/intake-upload with the Blob
        // URLs. We just log so unmatched orphan uploads are
        // discoverable.
        logger.info('[channel-clone upload-token] blob completed', {
          urlSnippet: blob.url.slice(0, 60),
          tokenPayload,
        });
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    logger.error('[channel-clone upload-token] failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload token mint failed' },
      { status: 400 },
    );
  }
});
