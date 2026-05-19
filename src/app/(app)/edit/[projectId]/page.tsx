import { notFound } from 'next/navigation';
import { getSession } from '@/lib/session';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { logger } from '@/lib/logger';
import { loadProject } from '@/lib/project/persist';
import EditorClient from './EditorClient';

/**
 * Shot-graph editor — server entry.
 *
 * Phase 1 of `_plans/2026-05-18-shot-graph-editor.md`. The route is
 * gated by `EDITOR_V1_ENABLED` (default off); when disabled the page
 * returns a 404 indistinguishable from a non-existent route — no
 * leak about the editor's existence.
 *
 * Project resolution: `projectId` is the `user_history.id` of a
 * `kind = 'production_doc'` entry. v1 enforces single-owner-edits
 * (operator confirmed 2026-05-18) — only the original author of the
 * history row can open the editor; teammates get 404, not 403, so
 * the row's existence stays private.
 *
 * Data flow: the doc + the `version` integer are loaded once on the
 * server and handed to the client component as props. Subsequent
 * client-side saves include the version so the server can reject
 * stale writes (Phase 2 wires the save endpoint).
 */
export default async function EditorPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  if (!EDITOR_V1_ENABLED) {
    notFound();
  }

  const { projectId } = await params;

  // Light UUID-shape check before the SQL call. Saves a round-trip
  // on a typo'd URL and avoids burning a query slot on garbage input.
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    notFound();
  }

  const session = await getSession();
  if (!session) {
    // (app)/layout.tsx already redirects unauthed sessions to /login;
    // this is defense-in-depth in case the editor route ever moves
    // outside that group.
    notFound();
  }

  // Route through the canonical persist layer so legacy payloads are
  // migrated on read and the editor receives a typed `ProjectPayload`.
  // The earlier inline SQL block here only returned the raw JSONB,
  // which forced every consumer (including the editor's parsePayload)
  // to do its own defensive shape-checking; consolidating in
  // `loadProject` means the migration logic lives in one place.
  const result = await loadProject(projectId, session);
  if (result.kind === 'not_found') {
    logger.info('[editor route] project not found', {
      project_id: projectId,
      workspace_id: session.ws,
    });
    notFound();
  }

  logger.info('[editor route] project loaded', {
    project_id: projectId,
    version: result.version,
    dropped_field_count: result.diagnostics.droppedFields.length,
    defaulted_field_count: result.diagnostics.appliedDefaults.length,
  });

  return (
    <EditorClient
      projectId={projectId}
      version={result.version}
      payload={result.payload}
    />
  );
}
