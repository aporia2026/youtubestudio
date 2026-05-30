import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createSavedTopicCardGridPreset,
  listSavedTopicCardGridPresets,
  validateSavedPresetInput,
} from '@/lib/topic-card-grid-saved-presets-db';

/**
 * Topic Card Grid — workspace-scoped saved style presets.
 *
 *   GET  — list presets for the caller's workspace.
 *   POST — create a new preset. Body: { name: string; preset: object }.
 *
 * Mirrors the contract of the Flex Icon Grid saved-templates route so
 * the panel caller can reuse the same fetch shape. Validation lives in
 * the shared `thumbnail-saved-presets-validate.ts` module.
 *
 * Authed: anonymous callers can't read or write workspace data.
 */

export const GET = apiRoute.authed(async (session) => {
  const presets = await listSavedTopicCardGridPresets(session.ws);
  return NextResponse.json({ presets });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const validation = validateSavedPresetInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }
  try {
    const result = await createSavedTopicCardGridPreset({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'topic-card-grid saved-preset: create',
      knownPatterns: [
        {
          match: /topic_card_grid_saved_presets_workspace_id_name_key|duplicate key/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Failed to save preset.',
    });
  }
});
