import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextRequest, NextResponse } from 'next/server';

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
 * Token-issuing endpoint for direct browser → Vercel Blob voiceover uploads.
 *
 * The previous flow piped the file through /api/upload which was capped at
 * Vercel's 4.5 MB request body limit (413 on real audio files). With a
 * client-side upload the file goes browser → Blob storage directly using a
 * one-time token we mint here, bypassing the API request body entirely.
 *
 * After the client upload finishes the page POSTs the resulting URL to the
 * existing /api/projects/[id]/media route to create the media_assets row —
 * we don't use Blob's onUploadCompleted webhook because it can't reach a
 * local dev server, and the explicit registration call works the same in
 * dev and prod.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as HandleUploadBody;
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_AUDIO,
        // 500 MB ceiling — enough for very long-form spoken audio files
        // while still rejecting clearly-wrong drag-drops.
        maximumSizeInBytes: 500 * 1024 * 1024,
        addRandomSuffix: true,
      }),
    });
    return NextResponse.json(json);
  } catch (err) {
    console.error('voiceover-upload-token error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to issue upload token' },
      { status: 400 },
    );
  }
}
