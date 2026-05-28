import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  buildFlexIconGridFontUploadKey,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

/**
 * Custom label font upload presign for the Flex Icon Grid format
 * (Phase 4.7). Returns a presigned PUT URL so the browser uploads the
 * TTF/OTF/WOFF directly to R2, bypassing Vercel's ~4.5 MB API body
 * cap.
 *
 * Authed: anonymous callers shouldn't mint presigned URLs against our
 * bucket.
 *
 * License posture: this route accepts whatever font the user uploads.
 * Many fonts ship under restrictive licenses (e.g. desktop-only,
 * paid-only, no-redistribution); embedding such a font in a publicly
 * hosted thumbnail can violate the licence. The panel UI surfaces a
 * one-line warning next to the upload control; the caller is
 * responsible for ensuring their specific use is licensed.
 */

const ALLOWED_FONT_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-sfnt',
  'application/x-font-ttf',
  'application/x-font-opentype',
  'application/octet-stream', // some browsers send this for .ttf
]);

const MAX_FONT_SIZE = 5 * 1024 * 1024;

export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }

  const { fileName, contentType, fileSize } = await req.json();
  if (!fileName || !contentType) {
    return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
  }
  if (!ALLOWED_FONT_TYPES.has(String(contentType))) {
    return NextResponse.json(
      { error: `Unsupported font type: ${contentType}` },
      { status: 400 },
    );
  }
  // Belt + braces — also reject by extension. Defends against a stale
  // browser sending `application/octet-stream` for a non-font file.
  if (!/\.(ttf|otf|woff|woff2)$/i.test(String(fileName))) {
    return NextResponse.json(
      { error: 'File extension must be .ttf, .otf, .woff, or .woff2' },
      { status: 400 },
    );
  }
  if (typeof fileSize === 'number' && fileSize > MAX_FONT_SIZE) {
    return NextResponse.json({ error: 'Font too large (max 5MB)' }, { status: 400 });
  }

  const r2Key = buildFlexIconGridFontUploadKey(String(fileName));
  let uploadUrl: string;
  let downloadUrl: string;
  try {
    uploadUrl = await getImagesUploadUrl(r2Key, contentType);
    downloadUrl = await getImagesDownloadUrl(r2Key);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown R2 error';
    return NextResponse.json(
      { error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' },
      { status: 502 },
    );
  }

  console.info('[flex-icon-grid font] presign issued', {
    r2_key: r2Key,
    content_type: contentType,
    size_bytes: fileSize,
  });
  return NextResponse.json({ uploadUrl, downloadUrl, r2Key }, { status: 201 });
});
