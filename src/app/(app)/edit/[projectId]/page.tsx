import Link from 'next/link';
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
  //
  // 2026-06-04: was `notFound()` for non-UUID ids; that gave the user
  // a bare Next.js 404 with no path back — the failure mode that drove
  // today's silent-loss incident, see _plans/2026-06-04-prevent-
  // production-doc-silent-loss.md. A non-UUID id here is almost always
  // a synthetic local-only id from the offline-save fallback path
  // (shape: `<timestamp>-<random>`); the user's data is still in their
  // browser cache. Render an explanation page that points back to
  // production-doc instead of a dead-end 404.
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    logger.info('[editor route] non-uuid id — rendering recovery page', {
      project_id: projectId,
    });
    return <NonUuidRecoveryPage projectId={projectId} />;
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

/**
 * Renders when the URL's projectId fails the UUID shape check. The
 * common cause is a synthetic local-only id from the offline-save
 * fallback path in `src/lib/history.ts` (shape:
 * `<unix-ms>-<random>`). The user's doc is still in browser cache;
 * navigating to /production-doc?h=<that-id> won't help because the
 * canonical endpoint also rejects non-UUIDs, but the production-doc
 * page CAN drain the offline queue on mount and rebind to a real
 * UUID — so the right next action is "go to production-doc and let
 * the page recover, then come back here with the new id."
 *
 * No data leaks: we render only the id the user passed in (which they
 * already typed into their URL bar), no workspace/collaborator info.
 *
 * 2026-06-04 / _plans/2026-06-04-prevent-production-doc-silent-loss.md
 */
function NonUuidRecoveryPage({ projectId }: { projectId: string }): React.JSX.Element {
  // Mask the id slightly in the display so a screenshot doesn't leak
  // millisecond timestamps that could correlate with other telemetry.
  // Keep enough characters that the user can match it against their
  // browser history entry.
  const displayId =
    projectId.length > 24 ? `${projectId.slice(0, 12)}…${projectId.slice(-8)}` : projectId;
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <div
        className="max-w-lg w-full rounded-xl border p-6 space-y-4"
        style={{ background: 'var(--card-bg)', borderColor: 'var(--card-border)' }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(251, 191, 36, 0.15)' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--fg)' }}>
            This project isn&apos;t synced to the server
          </h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
          The id <code className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'var(--card-border)' }}>{displayId}</code>{' '}
          looks like a local-only draft id (created when the initial
          server save failed). Your work is almost certainly still in
          your browser&apos;s cache.
        </p>
        <p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
          Go to Production Doc and let it drain the offline queue — it
          will rebind your doc to a real server id and you can open it
          in the editor from there.
        </p>
        <div className="flex flex-col gap-2 pt-2">
          <Link
            href="/production-doc"
            className="w-full text-center px-4 py-2 rounded text-sm font-semibold border"
            style={{
              borderColor: 'var(--accent-purple-bright, #a78bfa)',
              color: 'var(--accent-purple-bright, #a78bfa)',
            }}
          >
            Return to Production Doc →
          </Link>
          <p className="text-xs mt-1" style={{ color: 'var(--fg-muted)' }}>
            If your work doesn&apos;t reappear after returning, open
            DevTools → Application → Local Storage and check the
            <code className="px-1 mx-1 rounded text-[10px]" style={{ background: 'var(--card-border)' }}>
              production_doc_history
            </code>
            key — your doc is in there.
          </p>
        </div>
      </div>
    </div>
  );
}
