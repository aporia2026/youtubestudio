import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import {
  createSavedNLevelsPreset,
  listSavedNLevelsPresets,
  validateSavedPresetInput,
} from '@/lib/n-levels-saved-presets-db';

/**
 * N Levels Explained — workspace-scoped saved style presets.
 *
 *   GET  — list presets for the caller's workspace.
 *   POST — create a new preset. Body: { name: string; preset: object }.
 *
 * Sibling to the Topic Card Grid saved-presets route — same contract,
 * separate table (n_levels_saved_presets per migration 0106). Validation
 * shared via thumbnail-saved-presets-validate.ts.
 *
 * Authed: anonymous callers can't read or write workspace data.
 */

export const GET = apiRoute.authed(async (session) => {
  const presets = await listSavedNLevelsPresets(session.ws);
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
    const result = await createSavedNLevelsPreset({
      workspaceId: session.ws,
      createdBy: session.uid,
      input: validation.value,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'n-levels saved-preset: create',
      knownPatterns: [
        {
          match: /n_levels_saved_presets_workspace_id_name_key|duplicate key/i,
          status: 409,
        },
      ],
      fallbackMessage: 'Failed to save preset.',
    });
  }
});
