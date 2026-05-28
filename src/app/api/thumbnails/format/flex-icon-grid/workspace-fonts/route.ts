import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createWorkspaceFont,
  listWorkspaceFonts,
  validateWorkspaceFontInput,
} from '@/lib/flex-icon-grid-workspace-fonts-db';
import { getImagesBucket, getImagesDownloadUrl, isR2Configured } from '@/lib/r2';

/**
 * Flex Icon Grid — workspace-scoped registered fonts (Phase 4.8b).
 *
 *   GET  — list registered fonts for the caller's workspace.
 *   POST — register a font from an already-uploaded R2 key. The
 *          panel calls this right after a successful upload so the
 *          new font appears in the picker chip row next time.
 *
 * GET response includes a fresh presigned `downloadUrl` per entry —
 * the panel uses this verbatim as `customFontUrl` in the config.
 * R2 presigned URLs have a long TTL (7 days), but re-listing always
 * mints fresh ones so a refreshed panel never carries stale URLs.
 *
 * Authed: anonymous callers can't read or write workspace data.
 */

export const GET = apiRoute.authed(async (session) => {
  if (!isR2Configured()) {
    return NextResponse.json(
      { error: 'Cloudflare R2 storage is not configured.', code: 'R2_NOT_CONFIGURED' },
      { status: 503 },
    );
  }
  const rows = await listWorkspaceFonts(session.ws);
  // Mint fresh presigned download URLs per entry. Keeps panel-side
  // configs aligned with current R2 lifecycle — if the file's been
  // deleted, the URL will still be issued but resolve to 404 on use
  // and surface as a fontWarning at render time.
  const fonts = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      downloadUrl: await getImagesDownloadUrl(row.r2_key),
      updated_at: row.updated_at,
    })),
  );
  return NextResponse.json({ fonts });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateWorkspaceFontInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const result = await createWorkspaceFont({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    const downloadUrl = await getImagesDownloadUrl(result.r2_key);
    return NextResponse.json(
      {
        id: result.id,
        name: result.name,
        mime_type: result.mime_type,
        size_bytes: result.size_bytes,
        downloadUrl,
        updated_at: result.updated_at,
      },
      { status: 201 },
    );
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'flex-icon-grid workspace-font: create',
      knownPatterns: [
        {
          match: /flex_icon_grid_workspace_fonts_workspace_id_name_key|duplicate key/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Failed to register font.',
    });
  }
});

// Reference to silence unused imports if the route ever drops the
// R2 helper before someone notices — keeps the contract obvious.
void getImagesBucket;
