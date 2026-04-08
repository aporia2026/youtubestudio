import { NextRequest, NextResponse } from 'next/server';
import { getValidAccessToken } from '@/lib/google-oauth';
import { uploadThumbnailOAuth } from '@/lib/youtube';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') || '';

    let channelDbId: string;
    let videoId: string;
    let imageBuffer: Buffer;
    let mimeType: string;

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      channelDbId = formData.get('channelId') as string;
      videoId = formData.get('videoId') as string;
      const file = formData.get('image') as File;

      if (!channelDbId || !videoId || !file) {
        return NextResponse.json({ error: 'channelId, videoId, and image are required' }, { status: 400 });
      }

      mimeType = file.type;
      imageBuffer = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await req.json();
      channelDbId = body.channelId;
      videoId = body.videoId;
      const imageUrl = body.imageUrl;

      if (!channelDbId || !videoId || !imageUrl) {
        return NextResponse.json({ error: 'channelId, videoId, and imageUrl are required' }, { status: 400 });
      }

      // Download the image
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        return NextResponse.json({ error: 'Failed to download image' }, { status: 400 });
      }
      mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    }

    // Validate image type
    if (!mimeType.startsWith('image/')) {
      return NextResponse.json({ error: 'File must be an image' }, { status: 400 });
    }

    // Get OAuth token
    const accessToken = await getValidAccessToken(channelDbId);
    if (!accessToken) {
      return NextResponse.json(
        { error: 'YouTube not connected. Connect your channel via OAuth first.' },
        { status: 401 },
      );
    }

    const result = await uploadThumbnailOAuth(accessToken, videoId, imageBuffer, mimeType);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json({ success: true, thumbnailUrl: result.thumbnailUrl });
  } catch (err: unknown) {
    console.error('Thumbnail upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 },
    );
  }
}
