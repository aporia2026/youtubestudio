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

// ─── Constants ───────────────────────────────────────────────────────

/** Hard cap on payload size at the wire boundary. Matches the existing
 *  editor route's cap so behavior is identical for clients that
 *  exceed it (413). */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

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
 * Validate the payload, then attempt an optimistic-locked UPDATE.
 * `expectedVersion` is the version the caller read on load. The
 * server stores `version + 1` on success and returns it; on stale
 * version, returns the current row.
 *
 * Workspace + collaborator scoped at the SQL level — a row outside
 * scope is indistinguishable from a deleted row.
 *
 * Asset-map merge (2026-05-22 emergency fix): before the UPDATE we read
 * the current row and union the asset maps (`rowImages`, `rowOverlays`,
 * `rowVideoClips`) with the incoming payload. Incoming entries win on
 * per-key collision (regeneration replaces correctly); existing entries
 * the client didn't send are preserved. This stops one page's debounced
 * full-payload save from silently wiping an asset the OTHER page just
 * wrote through the atomic `row-asset` endpoint, which was the original
 * "all images disappear when navigating back to prod-doc" bug.
 *
 * When the version check fails BUT the non-asset fields in the client's
 * payload match the current row's, we auto-upgrade `expectedVersion` to
 * the current version and proceed with the merge. This collapses the
 * benign race (prod-doc just bumped via row-asset; editor debounce
 * fires at the old version) into a successful merged save instead of a
 * 409. Non-asset divergence still returns conflict as before.
 *
 * See _plans/2026-05-22-editor-prodoc-data-loss-and-fixes.md.
 */
export async function saveProjectPatch(args: {
  id: string;
  session: SessionPayload;
  payload: unknown;
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

  // Read current row up front so we can merge asset maps. Scope-checked
  // here — a row outside the caller's scope returns 0 rows and we fall
  // through to `not_found` below, identical to the post-update probe path.
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

  // Decide which version we'll write against. If the client read at an
  // older version BUT only the asset maps differ from current, auto-merge
  // at the current version instead of returning 409. Any non-asset
  // divergence is a real conflict — return the current payload so the
  // client can reload + retry.
  let targetVersion = expectedVersion;
  let mergeRetried = false;
  if (expectedVersion !== currentVersion) {
    if (nonAssetFieldsEqual(validation.payload, currentPayload)) {
      targetVersion = currentVersion;
      mergeRetried = true;
      logger.info('[project payload save] merge-retry', {
        project_id: id,
        client_version: expectedVersion,
        server_version: currentVersion,
      });
    } else {
      logger.info('[project payload save] conflict', {
        project_id: id,
        client_version: expectedVersion,
        server_version: currentVersion,
      });
      return {
        kind: 'conflict',
        currentVersion,
        currentPayload,
      };
    }
  }

  // Union the three asset maps. Incoming wins on key collision so a
  // regenerated asset's new URL is honored; otherwise existing keys are
  // preserved from the current row.
  const { merged, preserved } = mergeAssetMaps(validation.payload, currentPayload);
  const preservedCount =
    preserved.rowImages.length + preserved.rowOverlays.length + preserved.rowVideoClips.length;
  if (preservedCount > 0) {
    logger.info('[project payload save] merged', {
      project_id: id,
      preserved_row_images: preserved.rowImages,
      preserved_row_overlays: preserved.rowOverlays,
      preserved_row_video_clips: preserved.rowVideoClips,
      merge_retried: mergeRetried,
    });
  }

  const mergedJson = JSON.stringify(merged);
  const bytes = Buffer.byteLength(mergedJson, 'utf8');
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
    target_version: targetVersion,
    merge_retried: mergeRetried,
    bytes,
  });

  const updateResult = await sql<{ new_version: number }>`
    UPDATE user_history
       SET payload = ${mergedJson}::jsonb,
           version = version + 1
     WHERE id = ${id}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
       AND version = ${targetVersion}
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

  // 0 rows after the merged update means another writer bumped the row
  // between our read and our write. Rare (the merge window is small) but
  // possible under heavy autosave + row-asset traffic. Re-probe and
  // return conflict so the client can reload + retry. We intentionally
  // don't loop merge-retry here — at most one auto-merge per call keeps
  // the worst-case latency bounded.
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
    logger.info('[project payload save] target missing (post-merge race)', {
      project_id: id,
      workspace_id: session.ws,
    });
    return { kind: 'not_found' };
  }

  const { payload: probeMigrated } = migratePayload(probe.rows[0].payload);
  logger.info('[project payload save] conflict (post-merge race)', {
    project_id: id,
    client_version: expectedVersion,
    target_version: targetVersion,
    server_version: probe.rows[0].version,
  });
  return {
    kind: 'conflict',
    currentVersion: probe.rows[0].version,
    currentPayload: probeMigrated,
  };
}

// ─── Asset merge helpers ────────────────────────────────────────────

/**
 * Union the three asset maps (`rowImages`, `rowOverlays`, `rowVideoClips`)
 * from `current` onto `incoming`. Incoming wins on key collision so a
 * regenerated asset's new URL replaces the old one; existing keys the
 * client never sent are preserved.
 *
 * Returns the merged payload plus the per-map list of keys preserved
 * from current, so the caller can emit a diagnostic log only when the
 * merge actually did work (the common no-drift case stays quiet).
 */
function mergeAssetMaps(
  incoming: ProjectPayload,
  current: ProjectPayload,
): {
  merged: ProjectPayload;
  preserved: {
    rowImages: number[];
    rowOverlays: number[];
    rowVideoClips: number[];
  };
} {
  const preserved = {
    rowImages: [] as number[],
    rowOverlays: [] as number[],
    rowVideoClips: [] as number[],
  };

  const mergedRowImages = { ...incoming.rowImages };
  for (const [k, v] of Object.entries(current.rowImages)) {
    const key = Number(k);
    if (!(key in mergedRowImages)) {
      mergedRowImages[key] = v;
      preserved.rowImages.push(key);
    }
  }

  const mergedRowOverlays = { ...incoming.rowOverlays };
  for (const [k, v] of Object.entries(current.rowOverlays)) {
    const key = Number(k);
    if (!(key in mergedRowOverlays)) {
      mergedRowOverlays[key] = v;
      preserved.rowOverlays.push(key);
    }
  }

  const mergedRowVideoClips = { ...incoming.rowVideoClips };
  for (const [k, v] of Object.entries(current.rowVideoClips)) {
    const key = Number(k);
    if (!(key in mergedRowVideoClips)) {
      mergedRowVideoClips[key] = v;
      preserved.rowVideoClips.push(key);
    }
  }

  return {
    merged: {
      ...incoming,
      rowImages: mergedRowImages,
      rowOverlays: mergedRowOverlays,
      rowVideoClips: mergedRowVideoClips,
    },
    preserved,
  };
}

/**
 * Structural equality on everything EXCEPT the three asset maps. Used to
 * decide whether a version-drifted save is safe to auto-merge: if the
 * client's non-asset fields match the current row's, the only divergence
 * is in the asset maps and the merge handles it without losing user
 * intent. Otherwise the conflict is real (concurrent edits to doc rows,
 * brand kit, flags, etc.) and we surface it.
 */
function nonAssetFieldsEqual(a: ProjectPayload, b: ProjectPayload): boolean {
  const strip = (p: ProjectPayload) => {
    const { rowImages: _ri, rowOverlays: _ro, rowVideoClips: _rvc, ...rest } = p;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
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
