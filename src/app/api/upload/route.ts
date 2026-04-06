import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { sql } from '@/lib/db';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const type = formData.get('type') as string || 'upload';
    const projectId = formData.get('projectId') as string;

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    // Validate file type
    const allowedTypes = {
      voiceover: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm'],
      image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg'],
      document: ['application/pdf', 'text/plain', 'application/msword'],
    };

    const allowed = allowedTypes[type as keyof typeof allowedTypes] || [];
    if (allowed.length > 0 && !allowed.includes(file.type)) {
      return NextResponse.json({ error: `Invalid file type for ${type}` }, { status: 400 });
    }

    // Upload to Vercel Blob
    const filename = `${type}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const blob = await put(filename, file, {
      access: 'public',
      addRandomSuffix: true,
    });

    // Save to DB if projectId provided
    if (projectId) {
      await sql`
        INSERT INTO media_assets (project_id, type, source, name, url, blob_pathname, size_bytes)
        VALUES (
          ${projectId}, ${type}, 'upload', ${file.name},
          ${blob.url}, ${blob.pathname}, ${file.size}
        )
      `;
      await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${projectId}`;
    }

    return NextResponse.json({
      url: blob.url,
      pathname: blob.pathname,
      name: file.name,
      size: file.size,
      type,
    });
  } catch (err: unknown) {
    console.error('Upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
