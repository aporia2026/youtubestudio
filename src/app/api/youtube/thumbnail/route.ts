import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/google-oauth';
import { uploadThumbnailOAuth } from '@/lib/youtube';
import { logger } from '@/lib/logger';

export const maxDuration = 60;

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — YouTube's thumbnail limit

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const channelDbId = formData.get('channelId') as string;
    const videoId = formData.get('videoId') as string;
    const file = formData.get('image') as File;

    if (!channelDbId || !videoId || !file) {
      return NextResponse.json({ error: 'channelId, videoId, and image are required' }, { status: 400 });
    }

    // Validate file type
    if (!file.type.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image (JPEG, PNG, etc.)' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Thumbnail must be under 2MB' }, { status: 400 });
    }

    const imageBuffer = Buffer.from(await file.arrayBuffer());

    // Get OAuth token
    const accessToken = await getValidAccessToken(channelDbId);
    if (!accessToken) {
      return NextResponse.json(
        { error: 'YouTube not connected. Connect your channel via OAuth first.' },
        { status: 401 },
      );
    }

    const result = await uploadThumbnailOAuth(accessToken, videoId, imageBuffer, file.type);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, thumbnailUrl: result.thumbnailUrl });
  } catch (err: unknown) {
    logger.error('Thumbnail upload error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 },
    );
  }
}
