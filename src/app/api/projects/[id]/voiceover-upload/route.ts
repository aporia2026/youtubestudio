import { NextRequest, NextResponse } from 'next/server';
import { isR2Configured, getNarrationUploadUrl, getNarrationDownloadUrl } from '@/lib/r2';
import { domainErrorResponse } from '@/lib/route-helpers';

// Audio mime types we accept. Browsers report .m4a as 'audio/x-m4a' on some
// platforms and 'audio/mp4' on others — both included.
const ALLOWED_AUDIO = [
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
];

/**
 * Issue a presigned PUT URL so the browser can upload a voiceover audio
 * file straight to the R2 narration bucket (same bucket narrator takes
 * already use). Bypasses Vercel's 4.5 MB API request body limit and keeps
 * voiceover storage on the same path as the rest of the audio pipeline.
 *
 * After the client upload completes the page calls /api/projects/[id]/media
 * with the resulting r2_bucket / r2_key / signed download url to register
 * the row — that route already populates workspace_id from the project.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
        { status: 503 },
      );
    }

    const { fileName, contentType } = await req.json();
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName + contentType required' }, { status: 400 });
    }
    if (!ALLOWED_AUDIO.includes(contentType)) {
      return NextResponse.json({ error: `Unsupported audio type: ${contentType}` }, { status: 400 });
    }

    // Sanitize filename + namespace by project for cleanup later.
    const sanitized = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2Key = `voiceovers/${id}/${Date.now()}-${sanitized}`;
    const bucket = process.env.R2_NARRATION_BUCKET_NAME || 'narration';

    let uploadUrl: string;
    let downloadUrl: string;
    try {
      uploadUrl = await getNarrationUploadUrl(r2Key, contentType);
      downloadUrl = await getNarrationDownloadUrl(r2Key);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown R2 error';
      return NextResponse.json({ error: `R2 presign failed: ${msg}`, code: 'R2_PRESIGN_FAILED' }, { status: 502 });
    }

    return NextResponse.json({ uploadUrl, downloadUrl, r2Key, r2Bucket: bucket }, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'projects: voiceover-upload presign',
      fallbackMessage: 'Could not issue upload URL — please try again.',
    });
  }
}
