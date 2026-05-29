import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import {
  deleteWorkspaceFont,
  deleteWorkspaceFontAndCountSiblings,
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
  // Phase 4.11 caveat fix: when reclaim is requested, do the row
  // delete + sibling-reference count in a single SQL statement (CTE)
  // so postgres' statement atomicity closes the race window where
  // another workspace could INSERT after our SELECT and before our
  // DELETE. Non-reclaim path stays on the simpler single-row DELETE
  // helper since it doesn't need the sibling count.
  let reclaimed = false;
  let skippedDueToRefs = false;
  if (reclaim) {
    const result = await deleteWorkspaceFontAndCountSiblings(id, session.ws);
    if (!result.deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (result.r2_key) {
      if (result.remainingRefs > 0) {
        skippedDueToRefs = true;
        console.info('[flex-icon-grid workspace-font] r2 reclaim skipped — sibling workspace still references key', {
          r2_key: result.r2_key, remaining_refs: result.remainingRefs,
        });
      } else {
        try {
          await deleteImagesObject(result.r2_key);
          reclaimed = true;
          console.info('[flex-icon-grid workspace-font] r2 reclaimed', { r2_key: result.r2_key });
        } catch (err) {
          console.warn('[flex-icon-grid workspace-font] r2 reclaim failed', {
            r2_key: result.r2_key,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  } else {
    const removed = await deleteWorkspaceFont(id, session.ws);
    if (!removed) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, reclaimed, skippedDueToRefs });
});
