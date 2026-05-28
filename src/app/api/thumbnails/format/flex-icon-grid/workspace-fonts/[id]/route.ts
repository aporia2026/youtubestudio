import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteWorkspaceFont,
  getWorkspaceFont,
} from '@/lib/flex-icon-grid-workspace-fonts-db';
import { deleteImagesObject, getImagesDownloadUrl, isR2Configured } from '@/lib/r2';

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

export const DELETE = apiRoute.authed(async (session, req: NextRequest, ctx) => {
  const { id } = await (ctx as RouteContext).params;
  // Phase 4.9 caveat fix: `?reclaim=true` also deletes the underlying
  // R2 object so the bucket doesn't accumulate orphaned font files.
  // Off by default — the panel surfaces a confirmation toggle so a
  // mis-click can't permanently destroy a font another user might
  // have referenced in a saved template. Failed R2 deletes are
  // non-fatal (registry row is the source of truth; orphaned R2
  // objects can be reaped by a bucket lifecycle rule), but they're
  // logged so ops can spot persistent failures.
  const reclaim = req.nextUrl.searchParams.get('reclaim') === 'true';
  let r2Key: string | null = null;
  if (reclaim) {
    const font = await getWorkspaceFont(id, session.ws);
    if (!font) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    r2Key = font.r2_key;
  }
  const removed = await deleteWorkspaceFont(id, session.ws);
  if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let reclaimed = false;
  if (reclaim && r2Key) {
    try {
      await deleteImagesObject(r2Key);
      reclaimed = true;
      console.info('[flex-icon-grid workspace-font] r2 reclaimed', { r2_key: r2Key });
    } catch (err) {
      console.warn('[flex-icon-grid workspace-font] r2 reclaim failed', {
        r2_key: r2Key,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({ ok: true, reclaimed });
});
