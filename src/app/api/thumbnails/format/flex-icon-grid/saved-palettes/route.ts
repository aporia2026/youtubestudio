import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createSavedPalette,
  listSavedPalettes,
  validateSavedPaletteInput,
} from '@/lib/flex-icon-grid-saved-palettes-db';

/**
 * Flex Icon Grid — workspace-scoped saved palettes.
 *
 *   GET  — list palettes for the caller's workspace.
 *   POST — create a new palette. Body: { name: string; colors: string[] }.
 *
 * Mirrors the contract of `/api/thumbnail-templates` exactly so the
 * pipeline / panel callers can reuse the same fetch shape.
 *
 * Authed: anonymous callers can't read or write workspace data.
 */

export const GET = apiRoute.authed(async (session) => {
  const palettes = await listSavedPalettes(session.ws);
  return NextResponse.json({ palettes });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateSavedPaletteInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const result = await createSavedPalette({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'flex-icon-grid saved-palette: create',
      knownPatterns: [
        {
          match: /flex_icon_grid_saved_palettes_workspace_id_name_key|duplicate key/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Failed to save palette.',
    });
  }
});
