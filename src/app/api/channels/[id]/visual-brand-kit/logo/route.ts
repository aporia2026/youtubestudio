import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import {
  isR2Configured,
  getImagesUploadUrl,
  getImagesDownloadUrl,
} from '@/lib/r2';

/**
 * POST /api/channels/[id]/visual-brand-kit/logo
 *
 * Issue a presigned PUT URL so the browser can upload a channel logo
 * directly to the R2 images bucket. Returns the public/signed read URL
 * the brand-kit settings form persists into the channel's
 * `visual_brand_kit.logoUrl` field.
 *
 * Mirrors `/api/production-doc/thumbnail/upload` — same allowlist of
 * image types, same 5 MB cap, same image-bucket prefix convention. The
 * logo is intrinsic to ONE channel; the R2 key embeds the channel id so
 * a workspace can sanity-check ownership by URL inspection.
 *
 * Workspace scoping is explicit here (not implicit like the production-
 * doc thumbnail route) because the channel id is part of the route —
 * we verify the channel belongs to the caller's workspace before
 * issuing a presigned URL. Otherwise anyone with any channel UUID
 * could mint upload URLs into the R2 bucket.
 *
 * Body (JSON):
 *   fileName    : string  — original file name, sanitised for the R2 key
 *   contentType : string  — image/jpeg | image/png | image/webp | image/svg+xml
 *   fileSize    : number  — bytes; rejected if > 2 MB (logos are small)
 *
 * Returns: { uploadUrl, downloadUrl, r2Key }
 */

const ALLOWED_LOGO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
] as const;
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2 MB — logos are usually tiny

export const maxDuration = 30;

export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
        { status: 503 },
      );
    }

    // Verify the channel belongs to the caller's workspace before
    // issuing an upload URL. 404, not 403 — don't leak channel existence.
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM channels
       WHERE id = ${id}::uuid AND workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;

    const fileName = typeof b.fileName === 'string' ? b.fileName : '';
    const contentType = typeof b.contentType === 'string' ? b.contentType : '';
    const fileSize = typeof b.fileSize === 'number' ? b.fileSize : -1;

    if (!fileName) {
      return NextResponse.json({ error: 'fileName is required' }, { status: 400 });
    }
    if (!ALLOWED_LOGO_TYPES.includes(contentType as typeof ALLOWED_LOGO_TYPES[number])) {
      return NextResponse.json(
        { error: `Unsupported image type: ${contentType}. Use JPEG, PNG, WebP, or SVG.` },
        { status: 400 },
      );
    }
    if (fileSize < 0 || fileSize > MAX_LOGO_SIZE) {
      return NextResponse.json(
        { error: `Logo too large or fileSize missing. Max ${MAX_LOGO_SIZE / 1024 / 1024} MB.` },
        { status: 400 },
      );
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 60) || 'logo.png';
    const r2Key = `channel-logos/${id}/${Date.now()}-${safeName}`;

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

    return NextResponse.json({ uploadUrl, downloadUrl, r2Key }, { status: 201 });
  },
);
