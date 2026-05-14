import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  getNarrationBucket,
  getReviewBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 60;

/**
 * Generic multipart upload endpoint. Routes file bytes to the R2
 * bucket that matches the requested `type`:
 *   - voiceover → narration bucket
 *   - video     → review/videos bucket
 *   - image     → images bucket
 *   - document  → images bucket (legacy — docs share that bucket
 *                 under a `documents/` prefix; not worth a dedicated
 *                 bucket for the low volume)
 *   - upload    → images bucket (default)
 *
 * Migrated from Vercel Blob to R2 in 2026-05-14 so this works on
 * workspaces with private-access Blob stores. Same migration that
 * carried the thumbnail, voiceover, and render paths.
 */
function resolveBucket(type: string): {
  bucket: string;
  prefix: string;
  publicEnv: string | undefined;
} {
  switch (type) {
    case 'voiceover':
      return { bucket: getNarrationBucket(), prefix: 'voiceover', publicEnv: process.env.R2_NARRATION_PUBLIC_URL };
    case 'video':
      return { bucket: getReviewBucket(), prefix: 'video', publicEnv: process.env.R2_PUBLIC_URL };
    case 'document':
      return { bucket: getImagesBucket(), prefix: 'documents', publicEnv: process.env.R2_IMAGES_PUBLIC_URL };
    case 'image':
    case 'upload':
    default:
      return { bucket: getImagesBucket(), prefix: 'uploads', publicEnv: process.env.R2_IMAGES_PUBLIC_URL };
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const type = (formData.get('type') as string) || 'upload';
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

    // Upload to R2 — bucket + prefix routed by type so audio, video,
    // image, and document uploads end up in their appropriate buckets.
    const { bucket, prefix, publicEnv } = resolveBucket(type);
    const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const r2Key = `${prefix}/${Date.now()}-${randomSuffix}-${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const contentType = file.type || 'application/octet-stream';
    await uploadToBucket(bucket, r2Key, Buffer.from(arrayBuffer), contentType);
    const url = await getDownloadUrlForBucket(bucket, r2Key, publicEnv);

    // Save to DB if projectId provided. workspace_id is NOT NULL on
    // media_assets since migration 0013 — copy it from the parent project.
    // r2_bucket + r2_key are populated so consumers can build a fresh
    // signed URL later via the standard helpers if the original expires.
    if (projectId) {
      await sql`
        INSERT INTO media_assets (
          project_id, type, source, name, url,
          r2_bucket, r2_key, size_bytes, workspace_id
        )
        SELECT ${projectId}::uuid, ${type}, 'upload', ${file.name},
               ${url},
               ${bucket}, ${r2Key}, ${file.size}, p.workspace_id
          FROM projects p WHERE p.id = ${projectId}::uuid
      `;
      await sql`UPDATE projects SET updated_at = NOW() WHERE id = ${projectId}`;
    }

    return NextResponse.json({
      url,
      pathname: r2Key,
      name: file.name,
      size: file.size,
      type,
    });
  } catch (err: unknown) {
    logger.error('Upload error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}
