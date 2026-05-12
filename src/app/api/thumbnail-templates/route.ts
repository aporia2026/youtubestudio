import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  listThumbnailTemplates,
  createThumbnailTemplate,
  validateThumbnailTemplateInput,
} from '@/lib/thumbnail-templates';

/**
 * GET  — list workspace thumbnail templates.
 * POST — create a new template.
 */

export const GET = apiRoute.authed(async (session) => {
  const templates = await listThumbnailTemplates(session.ws);
  return NextResponse.json({ templates });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateThumbnailTemplateInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const result = await createThumbnailTemplate({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'thumbnail-template: create',
      knownPatterns: [
        { match: /thumbnail_template_presets_workspace_id_name_key|duplicate key/i, status: 409 },
      ],
      fallbackMessage: 'Failed to create thumbnail template.',
    });
  }
});
