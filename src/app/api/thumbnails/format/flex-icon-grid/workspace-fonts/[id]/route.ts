import { NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteWorkspaceFont,
  getWorkspaceFont,
} from '@/lib/flex-icon-grid-workspace-fonts-db';
import { getImagesDownloadUrl, isR2Configured } from '@/lib/r2';

/**
 * Flex Icon Grid — workspace-registered font by id (Phase 4.8b).
 *
 *   GET     — fetch one font with a fresh presigned `downloadUrl`.
 *             Returns 404 on cross-workspace ids.
 *   DELETE  — remove the registry row (R2 object untouched; bucket
 *             lifecycle rules handle reclamation). Returns 404 on
 *             cross-workspace ids.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = apiRoute.authed(async (session, _req, ctx) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const { id } = await (ctx as RouteContext).params;
  const font = await getWorkspaceFont(id, session.ws);
  if (!font) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const downloadUrl = await getImagesDownloadUrl(font.r2_key);
  return NextResponse.json({
    id: font.id,
    name: font.name,
    mime_type: font.mime_type,
    size_bytes: font.size_bytes,
    downloadUrl,
    updated_at: font.updated_at,
  });
});

export const DELETE = apiRoute.authed(async (session, _req, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  const removed = await deleteWorkspaceFont(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
