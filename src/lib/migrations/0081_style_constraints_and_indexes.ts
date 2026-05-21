import type { Migration } from './types';

/**
 * Post-QA hardening of the v2 user-defined styles schema from
 * migration 0080. The original schema had three real gaps that
 * surfaced during the robust code review pass on 2026-05-22:
 *
 *   1. The legacy `production_doc_styles_workspace_name_unique`
 *      constraint (from 0022) treats `(workspace_id, name)` as the
 *      uniqueness key — but doesn't account for `owner_id` added in
 *      0080. Once private styles exist, user A's "My Style" blocks
 *      user B from creating *their own* private "My Style" in the
 *      same workspace, AND the resulting 23505 → 409 leaks the
 *      existence of A's private row. We replace it with two partial
 *      unique indexes: one for workspace-wide styles (owner_id IS
 *      NULL), one per-owner for private styles (owner_id IS NOT
 *      NULL). Same workspace-name-per-owner uniqueness, no cross-
 *      user collision, no enumeration via 409.
 *
 *   2. The `draft` flag from 0080 has no CHECK preventing the
 *      illegal-by-convention combination `draft=TRUE AND owner_id IS
 *      NULL`. The application-side flow always creates drafts as
 *      owner-private, but the schema didn't enforce it — leaving the
 *      door open for a misconfigured route or migration to land
 *      workspace-wide drafts that any workspace member could hijack
 *      via the editor's PATCH path. Adding a CHECK closes that.
 *
 *   3. The new `style_reference_images` and `style_test_renders`
 *      tables both have a `workspace_id` FK but no index on it. When
 *      a workspace is deleted, the FK cascade does a seq scan per
 *      child table. Same for `production_doc_styles.owner_id` —
 *      collaborator delete cascade pays the same cost. Adding
 *      single-column indexes brings the cascade cost to log-time.
 *
 * Down migration restores the legacy single-column unique
 * constraint and drops everything we added — but note that any
 * application data that violates the legacy constraint (e.g., two
 * private styles with the same name in the same workspace) will
 * cause the down to fail. That's correct behaviour — the down is
 * lossless only when the data still fits the older shape.
 */
const migration: Migration = {
  id: '0081_style_constraints_and_indexes',
  description: 'Owner-aware name uniqueness + draft owner CHECK + cascade indexes on the v2 styles schema',

  async up(client) {
    // 1. Replace the legacy (workspace_id, name) UNIQUE with two
    //    partial unique indexes. The constraint dropped here was
    //    added by migration 0022.
    await client.query(`
      ALTER TABLE production_doc_styles
        DROP CONSTRAINT IF EXISTS production_doc_styles_workspace_name_unique
    `);
    // Workspace-wide styles — name unique per workspace. `owner_id IS
    // NULL` is the workspace-wide marker; a row with owner_id set is
    // excluded from this index.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS production_doc_styles_workspace_name_unique_shared
        ON production_doc_styles(workspace_id, name)
        WHERE owner_id IS NULL
    `);
    // Owner-private styles — name unique per (workspace, owner). Two
    // users in the same workspace can each have their own "My Style".
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS production_doc_styles_workspace_owner_name_unique_private
        ON production_doc_styles(workspace_id, owner_id, name)
        WHERE owner_id IS NOT NULL
    `);

    // 2. Draft must have an owner. The application-side flow already
    //    creates drafts as owner-private; this just closes the door
    //    on the illegal state at the schema layer.
    await client.query(`
      ALTER TABLE production_doc_styles
        ADD CONSTRAINT production_doc_styles_draft_has_owner
        CHECK (NOT (draft = TRUE AND owner_id IS NULL)) NOT VALID
    `);
    // Validate separately — NOT VALID lets the ADD succeed even when
    // existing rows might violate (unlikely here, but bulletproof).
    // Once validated the constraint applies to all rows.
    await client.query(`
      ALTER TABLE production_doc_styles
        VALIDATE CONSTRAINT production_doc_styles_draft_has_owner
    `);

    // 3. Indexes on cascade-FK columns. PostgreSQL doesn't auto-index
    //    referencing-side FKs (only referenced-side primary keys), so
    //    cascading deletes seq-scan without these.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_style_reference_images_workspace
        ON style_reference_images(workspace_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_style_test_renders_workspace
        ON style_test_renders(workspace_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_production_doc_styles_owner
        ON production_doc_styles(owner_id)
        WHERE owner_id IS NOT NULL
    `);
  },

  async down(client) {
    // Reverse order. The CHECK + new indexes come off first; the
    // legacy UNIQUE constraint goes back on last.
    await client.query(`DROP INDEX IF EXISTS idx_production_doc_styles_owner`);
    await client.query(`DROP INDEX IF EXISTS idx_style_test_renders_workspace`);
    await client.query(`DROP INDEX IF EXISTS idx_style_reference_images_workspace`);
    await client.query(`
      ALTER TABLE production_doc_styles
        DROP CONSTRAINT IF EXISTS production_doc_styles_draft_has_owner
    `);
    await client.query(`DROP INDEX IF EXISTS production_doc_styles_workspace_owner_name_unique_private`);
    await client.query(`DROP INDEX IF EXISTS production_doc_styles_workspace_name_unique_shared`);
    // Restore the legacy single-column unique constraint. Will fail
    // on data that doesn't fit the older shape — intentional, see
    // the file-header note.
    await client.query(`
      ALTER TABLE production_doc_styles
        ADD CONSTRAINT production_doc_styles_workspace_name_unique
        UNIQUE (workspace_id, name)
    `);
  },
};

export default migration;
