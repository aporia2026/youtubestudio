import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createSavedTemplate,
  listSavedTemplates,
  validateSavedTemplateInput,
} from '@/lib/flex-icon-grid-saved-templates-db';

/**
 * Flex Icon Grid — workspace-scoped saved starting templates.
 *
 *   GET  — list templates for the caller's workspace.
 *   POST — create a new template. Body: { name: string; config: object }.
 *
 * Mirrors the contract of the sibling saved-palettes route so the
 * panel callers can reuse the same fetch shape.
 *
 * Authed: anonymous callers can't read or write workspace data.
 */

export const GET = apiRoute.authed(async (session) => {
  const templates = await listSavedTemplates(session.ws);
  return NextResponse.json({ templates });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateSavedTemplateInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const result = await createSavedTemplate({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'flex-icon-grid saved-template: create',
      knownPatterns: [
        {
          match: /flex_icon_grid_saved_templates_workspace_id_name_key|duplicate key/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Failed to save template.',
    });
  }
});
