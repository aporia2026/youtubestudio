/**
 * Server-side project persistence — load + version-checked save for
 * the canonical `ProjectPayload`.
 *
 * Phase 1 of `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * Before this module, the two routes that touch the project row
 * (`/api/edit/[projectId]` and `/api/history/[id]`) had their own
 * inline `sql` blocks with subtly different scoping rules. Both ran
 * with workspace + collaborator scoping, but only the editor route
 * version-checked. The result was that production-doc autosaves
 * could silently clobber editor edits.
 *
 * This module centralizes both routes' SQL. Both load and save
 * enforce:
 *
 * - `workspace_id` + `collaborator_id` match the session (defense-in-
 *   depth on top of the route-level auth wrapper).
 * - `kind = 'production_doc'`.
 * - The row's `version` integer matches what the caller read on load,
 *   for SAVE. A mismatch returns a `{ kind: 'conflict' }` result with
 *   the current row, so the client can show "newer version exists —
 *   reload?".
 *
 * Rule 13 (security): scoping mismatches return `notFound` semantics,
 * never `forbidden`, so a leaked id from another tenant doesn't even
 * confirm the row's existence.
 *
 * Rule 14 (observability): every entry/exit logs through the shared
 * `logger` with the `[project payload …]` namespace so a console
 * paste from a user reporting "where's my X" gives the full trail.
 */

import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { SessionPayload } from '@/lib/session';
import {
  migratePayload,
  PROJECT_PAYLOAD_VERSION,
  validatePayload,
  type ProjectPayload,
} from './payload';
import { backfillFromPayload, loadProjectAssets } from './assets';

// ─── Constants ───────────────────────────────────────────────────────

/** Hard cap on payload size at the wire boundary. Matches the existing
 *  editor route's cap so behavior is identical for clients that
 *  exceed it (413). */
// 2026-05-24: raised from 5 MB → 10 MB to match row-asset/route.ts
// after a user hit the cap on a 184-shot project. Editor PATCH must
// not be stricter than row-asset, otherwise text edits would fail
// while image uploads succeed (or vice versa). Long-term plan: move
// asset URLs out of the jsonb payload entirely; see the planned
// `project_assets` table extraction.
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

// ─── Load ────────────────────────────────────────────────────────────

export type LoadResult =
  | {
      kind: 'loaded';
      payload: ProjectPayload;
      version: number;
      diagnostics: { droppedFields: string[]; appliedDefaults: string[] };
    }
  | { kind: 'not_found' };

/**
 * Read + migrate a project row. Workspace + collaborator scoped — a
 * row outside the caller's scope returns `not_found`, never the row's
 * contents. The returned payload is always canonical: the migrator
 * fills defaults for missing fields and drops unknown keys.
 */
export async function loadProject(
  id: string,
  session: SessionPayload,
): Promise<LoadResult> {
  logger.info('[project payload load] start', {
    project_id: id,
    workspace_id: session.ws,
  });

  const { rows } = await sql<{ payload: unknown; version: number }>`
    SELECT payload, version
      FROM user_history
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (rows.length === 0) {
    logger.info('[project payload load] not found', {
      project_id: id,
      workspace_id: session.ws,
    });
    return { kind: 'not_found' };
  }

  const { payload: migrated, droppedFields, appliedDefaults } = migratePayload(
    rows[0].payload,
  );

  // Only emit the migrate log when we actually changed something.
  // Clean payloads on the new shape are the common case after rollout;
  // logging "migrated 0 fields" on every load is noise.
  if (droppedFields.length > 0 || appliedDefaults.length > 0) {
    logger.info('[project payload migrate] applied', {
      project_id: id,
      to_version: PROJECT_PAYLOAD_VERSION,
      dropped: droppedFields,
      defaulted: appliedDefaults,
    });
  }

  // 2026-05-24 project_assets extraction: source of truth for
  // per-row asset URLs is now the project_assets table, not the
  // payload's rowImages / rowOverlays / rowVideoClips fields.
  //
  // Lazy backfill: if the project has no rows in project_assets
  // AND the payload still carries non-empty asset maps (legacy),
  // run a one-shot per-project INSERT to migrate. Idempotent —
  // future loads skip the backfill.
  //
  // After backfill, the table's rows are authoritative; the
  // payload's asset maps become stale (and are overwritten in
  // the returned payload below). We keep the payload columns
  // untouched on disk for a graceful rollback path; the cleanup
  // migration that strips them is a follow-up.
  // See `_plans/2026-05-24-project-assets-extraction.md`.
  const hasLegacyAssets =
    Object.keys(migrated.rowImages).length > 0 ||
    Object.keys(migrated.rowOverlays).length > 0 ||
    Object.keys(migrated.rowVideoClips).length > 0;
  if (hasLegacyAssets) {
    try {
      await backfillFromPayload(id, migrated);
    } catch (err) {
      logger.warn('[project-assets backfill] failed (continuing with legacy maps)', {
        project_id: id,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Assemble the asset maps from the table. After backfill, this
  // contains everything the payload had plus any subsequent
  // row-asset writes; before backfill (fresh projects with no
  // legacy maps), it's empty and the editor renders cleanly.
  let assetMaps;
  try {
    assetMaps = await loadProjectAssets(id);
  } catch (err) {
    logger.warn('[project-assets load] failed (falling back to payload maps)', {
      project_id: id,
      detail: err instanceof Error ? err.message : String(err),
    });
    // Defensive fallback: keep the payload's maps so the editor
    // doesn't render blank everywhere if the new table query has
    // an unexpected error.
    assetMaps = {
      rowImages: migrated.rowImages,
      rowOverlays: migrated.rowOverlays,
      rowVideoClips: migrated.rowVideoClips,
    };
  }
  // Overwrite the payload's asset maps with the assembled values
  // from project_assets. Same shape as before — every read site
  // (editor, production-doc, renderer, OTIO export, etc.) gets
  // exactly what it always got, sourced from the table now.
  migrated.rowImages = assetMaps.rowImages;
  migrated.rowOverlays = assetMaps.rowOverlays;
  migrated.rowVideoClips = assetMaps.rowVideoClips;

  logger.info('[project payload load] loaded', {
    project_id: id,
    version: rows[0].version,
    hasVO: Boolean(migrated.voiceoverUrl),
    hasCaptions: Boolean(migrated.captions),
    hasAlignment: Boolean(migrated.voiceoverAlignment),
    hasMusic: Boolean(migrated.musicUrl),
    imageCount: Object.keys(migrated.rowImages).length,
    clipCount: Object.keys(migrated.rowVideoClips).length,
    overlayCount: Object.keys(migrated.rowOverlays).length,
    rowCount: migrated.doc.rows.length,
  });

  return {
    kind: 'loaded',
    payload: migrated,
    version: rows[0].version,
    diagnostics: { droppedFields, appliedDefaults },
  };
}

// ─── Save (version-checked) ─────────────────────────────────────────

export type SaveResult =
  | { kind: 'saved'; newVersion: number }
  | {
      kind: 'conflict';
      currentVersion: number;
      currentPayload: ProjectPayload;
    }
  | { kind: 'not_found' }
  | { kind: 'invalid'; field: string; reason: string }
  | { kind: 'too_large'; bytes: number };

/**
 * Validate the payload, then write it last-write-wins.
 *
 * Server contract (2026-05-23):
 *
 *   - `rowImages`, `rowOverlays`, `rowVideoClips` from the incoming
 *     payload are IGNORED. The server always preserves the current
 *     row's asset maps verbatim. All asset writes go through the
 *     dedicated atomic endpoint at `/api/edit/[projectId]/row-asset`,
 *     which uses `jsonb_set` to merge a single slot at a time. This
 *     stops the data-loss class entirely: no full-payload save —
 *     editor's or prod-doc's — can wipe an asset, because no
 *     full-payload save touches asset maps anymore.
 *
 *   - `doc.rows`: refuses to overwrite a non-empty rows array with
 *     an empty one. The only legitimate path to "empty rows" is the
 *     initial save during doc creation. Any later save that ships
 *     `rows: []` is almost certainly a client-state bug — refuse it
 *     loudly rather than corrupt the production doc.
 *
 *   - Every other field (voiceover, captions, brand kit, flags, doc
 *     metadata, etc.): LAST WRITE WINS. We DON'T optimistic-lock on
 *     version anymore. The expectedVersion parameter is kept for
 *     call-site compatibility but ignored. Rationale: with the
 *     asset-blind rule, the only fields the client owns are
 *     scalars + doc shape + flags. Server-side writers (VO regen,
 *     captions regen, row-asset POSTs) bump version without going
 *     through this endpoint, which used to produce phantom 409s
 *     that trapped the user behind a conflict banner with no real
 *     editing conflict to resolve. Two-tab edits can lose one tab's
 *     non-asset changes — acceptable trade-off given asset writes
 *     are already atomic-merged and version-safe.
 *
 *   - The return type still carries `conflict` so call sites don't
 *     break, but this function will never return it under the new
 *     contract.
 *
 * Workspace + collaborator scoped at the SQL level — a row outside
 * scope is indistinguishable from a deleted row.
 */
export async function saveProjectPatch(args: {
  id: string;
  session: SessionPayload;
  payload: unknown;
  /** Kept for call-site compatibility; ignored by the new
   *  last-write-wins contract. */
  expectedVersion: number;
}): Promise<SaveResult> {
  const { id, session, payload, expectedVersion } = args;

  const validation = validatePayload(payload);
  if (!validation.ok) {
    logger.info('[project payload save] invalid', {
      project_id: id,
      field: validation.field,
      reason: validation.reason,
    });
    return { kind: 'invalid', field: validation.field, reason: validation.reason };
  }

  // Read current row up front so we can copy its asset maps onto the
  // outgoing payload (the server is the authority on those) and so we
  // can compare row counts before allowing an empty-rows overwrite.
  const current = await sql<{ version: number; payload: unknown }>`
    SELECT version, payload
      FROM user_history
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (current.rows.length === 0) {
    logger.info('[project payload save] target missing', {
      project_id: id,
      workspace_id: session.ws,
    });
    return { kind: 'not_found' };
  }

  const currentVersion = current.rows[0].version;
  const { payload: currentPayload } = migratePayload(current.rows[0].payload);

  // No version check — last write wins. Log the divergence so we can
  // still audit which clients are saving with stale versions (might
  // signal a real bug elsewhere even if it's no longer a hard error).
  if (expectedVersion !== currentVersion) {
    logger.info('[project payload save] version drift (allowed under LWW)', {
      project_id: id,
      client_version: expectedVersion,
      server_version: currentVersion,
    });
  }

  // Catastrophic-loss guard: never let an empty doc.rows array overwrite
  // a non-empty one. The only legitimate path to empty rows is initial
  // creation (current is also empty). A save that arrives with rows: []
  // against a populated current is almost always the editor saving
  // before its load completed, or a state-reset bug. Reject loudly so
  // the user gets a clear error instead of silently losing the doc.
  const incomingRows = validation.payload.doc.rows.length;
  const currentRows = currentPayload.doc.rows.length;
  if (incomingRows === 0 && currentRows > 0) {
    logger.warn('[project payload save] refused empty-rows overwrite', {
      project_id: id,
      current_rows: currentRows,
      client_version: expectedVersion,
    });
    return {
      kind: 'invalid',
      field: 'doc.rows',
      reason: `refusing to overwrite ${currentRows} saved rows with an empty array — reload the project and retry`,
    };
  }

  // Build the outgoing payload: client wins on non-asset fields, server
  // keeps full authority over the three asset maps. The row-asset
  // endpoint is the only path that mutates these.
  const outgoing: ProjectPayload = {
    ...validation.payload,
    rowImages: currentPayload.rowImages,
    rowOverlays: currentPayload.rowOverlays,
    rowVideoClips: currentPayload.rowVideoClips,
  };

  const outgoingJson = JSON.stringify(outgoing);
  const bytes = Buffer.byteLength(outgoingJson, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    logger.info('[project payload save] too large', {
      project_id: id,
      bytes,
      cap: MAX_PAYLOAD_BYTES,
    });
    return { kind: 'too_large', bytes };
  }

  logger.info('[project payload save] patch', {
    project_id: id,
    expected_version: expectedVersion,
    server_version: currentVersion,
    current_rows: currentRows,
    incoming_rows: incomingRows,
    bytes,
  });

  // Diagnostic warning for "I edited and now rows are missing" reports.
  // A save that strictly SHRINKS doc.rows is suspicious — could be
  // legitimate (user deleted rows in this tab) but is far more often
  // a stale-tab overwrite (production-doc tab loaded before another
  // tab inserted rows, then PATCHed its older snapshot back under
  // last-write-wins). Log loudly so a single repro shows up in the
  // ops dashboard. 2026-05-23.
  if (incomingRows < currentRows) {
    logger.warn('[project payload save] row count shrank', {
      project_id: id,
      collaborator_id: session.uid,
      workspace_id: session.ws,
      expected_version: expectedVersion,
      server_version: currentVersion,
      current_rows: currentRows,
      incoming_rows: incomingRows,
      stale_version_drift: expectedVersion !== currentVersion,
    });
  }

  // Last-write-wins UPDATE: no version predicate. The row's version
  // still increments so other observers (the prod-doc page's reactive
  // sync, for instance) can detect "something changed" without us
  // needing to broadcast it.
  const updateResult = await sql<{ new_version: number }>`
    UPDATE user_history
       SET payload = ${outgoingJson}::jsonb,
           version = version + 1
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     RETURNING (version) AS new_version
  `;

  if (updateResult.rows.length === 1) {
    const newVersion = updateResult.rows[0].new_version;
    logger.info('[project payload save] committed', {
      project_id: id,
      new_version: newVersion,
    });
    return { kind: 'saved', newVersion };
  }

  // The UPDATE returned 0 rows. Without a version predicate this can
  // only mean the scope match failed (row was deleted or moved out of
  // scope between our read and write). Re-probe to disambiguate.
  const probe = await sql<{ version: number; payload: unknown }>`
    SELECT version, payload
      FROM user_history
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;

  if (probe.rows.length === 0) {
    logger.info('[project payload save] target missing (post-update race)', {
      project_id: id,
      workspace_id: session.ws,
    });
    return { kind: 'not_found' };
  }

  // Genuinely unreachable: row still exists in our scope but the
  // UPDATE wrote zero rows. Treat as not_found defensively.
  const { payload: probeMigrated } = migratePayload(probe.rows[0].payload);
  logger.warn('[project payload save] unreachable: row present but UPDATE wrote 0 rows', {
    project_id: id,
    client_version: expectedVersion,
    server_version: probe.rows[0].version,
  });
  return {
    kind: 'conflict',
    currentVersion: probe.rows[0].version,
    currentPayload: probeMigrated,
  };
}

// ─── Save (force, no version check) ─────────────────────────────────

/**
 * Unversioned write — used by callers that own the row exclusively
 * (e.g. the initial save during doc generation, or the legacy
 * `/api/history/[id]` PATCH path that hasn't been migrated yet).
 *
 * Distinct function so the call site is explicit about giving up
 * optimistic concurrency. Most code should call `saveProjectPatch`
 * instead.
 */
export async function saveProjectUnversioned(args: {
  id: string;
  session: SessionPayload;
  payload: unknown;
}): Promise<SaveResult> {
  const { id, session, payload } = args;
  const validation = validatePayload(payload);
  if (!validation.ok) {
    logger.info('[project payload save] invalid (unversioned)', {
      project_id: id,
      field: validation.field,
      reason: validation.reason,
    });
    return { kind: 'invalid', field: validation.field, reason: validation.reason };
  }

  const payloadJson = JSON.stringify(validation.payload);
  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { kind: 'too_large', bytes };
  }

  const result = await sql<{ new_version: number }>`
    UPDATE user_history
       SET payload = ${payloadJson}::jsonb,
           version = version + 1
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     RETURNING (version) AS new_version
  `;

  if (result.rows.length === 1) {
    logger.info('[project payload save] committed (unversioned)', {
      project_id: id,
      new_version: result.rows[0].new_version,
      bytes,
    });
    return { kind: 'saved', newVersion: result.rows[0].new_version };
  }

  logger.info('[project payload save] target missing (unversioned)', {
    project_id: id,
    workspace_id: session.ws,
  });
  return { kind: 'not_found' };
}
