import type { Migration } from './types';

/**
 * Notes-while-watching feature (Phase 2 of
 * `_plans/2026-05-27-voiceover-upgrades-and-notes-feature.md`).
 *
 * Per-creator notes pinned to a production-doc row + a timestamp within
 * that row's scene. The user presses `N` while watching the preview, types
 * a note, optionally tags it (R/T/S/I/P/Q), and resumes playback. Both the
 * grid view at `/production-doc` and the Editor view share the same
 * notes — they hit this table through the same REST endpoints.
 *
 * Stored as its own table (not JSONB on `user_history.payload`) because:
 *   - per-note writes don't race with doc-level autosave;
 *   - the Review queue needs an indexed "unresolved across the doc"
 *     scan, which is awkward over a JSON path;
 *   - per-note delete is a single row write, not a full doc payload
 *     re-serialise.
 *
 * Workspace tenancy: `workspace_id` NOT NULL, ON DELETE CASCADE. Inherited
 * from the parent `user_history` row at INSERT time by the REST layer.
 * Registered as a depth-1 CHILD_TENANT_TABLE in
 * `_workspace_scoped_tables.ts` so any future tenancy backfill /
 * workspace-deletion cascade picks it up.
 *
 * Tag enum lives in the CHECK constraint, NOT a separate table, because
 * the six tags are a fixed product decision — adding a tag means a UI
 * change anyway, so the migration cost is the same.
 */
const migration: Migration = {
  id: '0098_create_production_doc_notes',
  description: 'Per-row notes pinned to production-doc scenes with tag types (R/T/S/I/P/Q) and a resolved flag for the review queue',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_doc_notes (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id          UUID NOT NULL REFERENCES user_history(id) ON DELETE CASCADE,
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_by      UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        row_index       INTEGER NOT NULL CHECK (row_index >= 0),
        scene_ts_ms     INTEGER NOT NULL DEFAULT 0 CHECK (scene_ts_ms >= 0),
        text            TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 5000),
        tag             CHAR(1) CHECK (tag IS NULL OR tag IN ('R','T','S','I','P','Q')),
        resolved        BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // List-by-doc — the hot read path on both the production-doc and the
    // Editor view. `(row_index, scene_ts_ms, created_at)` is the in-app
    // display order; including it in the index avoids a sort node.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pdn_doc_order
        ON production_doc_notes (doc_id, row_index, scene_ts_ms, created_at)
    `);

    // Review queue: "unresolved across this doc." Partial index so it
    // doesn't grow with resolved/archived note volume — resolved notes
    // are the long tail and we only need fast lookup for the open set.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pdn_doc_open
        ON production_doc_notes (doc_id, row_index)
        WHERE resolved = FALSE
    `);

    // Workspace-wide queries (admin debugging, future "all my unresolved
    // notes across all docs" view). Cheap to maintain.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pdn_workspace
        ON production_doc_notes (workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS production_doc_notes`);
  },
};

export default migration;
