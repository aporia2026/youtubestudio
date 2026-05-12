import type { Migration } from './types';

/**
 * Adds `author_role` to `review_comments` so the global comments inbox can
 * group by role without a fragile runtime join through review_share_links
 * → collaborators. Mirrors the column that already exists on
 * `narration_take_comments` (migration 0006).
 *
 * Values used going forward: 'owner' | 'editor' | 'reviewer'.
 * No CHECK constraint — we want to extend roles in the future (e.g.
 * 'producer', 'client') without another migration. Application code is
 * responsible for setting a sane value.
 *
 * Backfill order (each step skips rows already set by a previous step):
 *   1. posted_by_owner = true                  → 'owner'
 *   2. fix_for_comment_id IS NOT NULL          → 'editor'
 *      (fix notes are only ever written by editors in this app)
 *   3. author_name case-insensitively matches a collaborator linked to
 *      the project via review_share_links                → that collab's role
 *   4. anything still NULL                     → 'reviewer'
 *      (sensible default for external commenters)
 *
 * Also adds partial indexes tuned for the inbox's hot path:
 * unresolved top-level comments per workspace, newest first.
 */
const migration: Migration = {
  id: '0056_add_author_role_to_review_comments',
  description: 'Add author_role to review_comments and backfill from existing signals',

  async up(client) {
    // Column nullable initially so the backfill can do its work before we
    // tighten the constraint.
    await client.query(`
      ALTER TABLE review_comments
        ADD COLUMN IF NOT EXISTS author_role TEXT
    `);

    // 1. Owner-posted comments — recorded directly on the row.
    await client.query(`
      UPDATE review_comments
         SET author_role = 'owner'
       WHERE author_role IS NULL
         AND posted_by_owner = TRUE
    `);

    // 2. Fix notes — by construction these are submitted via the editor
    //    fix-notes endpoints, so the author is an editor.
    await client.query(`
      UPDATE review_comments
         SET author_role = 'editor'
       WHERE author_role IS NULL
         AND fix_for_comment_id IS NOT NULL
    `);

    // 3. Match author_name against a collaborator known to the project via
    //    a share link. Pick the most recently created share link if a name
    //    happens to match multiple linked collaborators (rare but possible
    //    with duplicate display names). Map narrator → reviewer because
    //    narrators don't author review_comments under normal flows; the
    //    fallback in step 4 catches anything we couldn't resolve.
    await client.query(`
      WITH ranked AS (
        SELECT c.id        AS comment_id,
               col.role    AS col_role,
               ROW_NUMBER() OVER (
                 PARTITION BY c.id
                 ORDER BY rsl.created_at DESC NULLS LAST
               ) AS rn
          FROM review_comments c
          JOIN review_versions v       ON v.id = c.version_id
          JOIN review_share_links rsl  ON rsl.project_id = v.project_id
                                       AND rsl.collaborator_id IS NOT NULL
          JOIN collaborators col       ON col.id = rsl.collaborator_id
         WHERE c.author_role IS NULL
           AND LOWER(c.author_name) = LOWER(col.name)
      )
      UPDATE review_comments c
         SET author_role = CASE
               WHEN ranked.col_role IN ('editor', 'reviewer') THEN ranked.col_role
               ELSE 'reviewer'
             END
        FROM ranked
       WHERE c.id = ranked.comment_id
         AND ranked.rn = 1
    `);

    // 4. Anything left over — most likely anonymous reviewers on legacy
    //    share links — defaults to 'reviewer'. Safe default; the owner can
    //    eyeball misclassifications via the inbox and we can fix specific
    //    rows by hand if needed.
    await client.query(`
      UPDATE review_comments
         SET author_role = 'reviewer'
       WHERE author_role IS NULL
    `);

    // Tighten the constraint now that every row is populated.
    await client.query(`
      ALTER TABLE review_comments
        ALTER COLUMN author_role SET NOT NULL
    `);

    // Partial indexes for the inbox's hot path. Most queries hit unresolved
    // top-level rows; ordering by created_at DESC matches the page's default
    // sort.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_review_comments_inbox_unresolved
        ON review_comments(workspace_id, created_at DESC)
        WHERE parent_id IS NULL AND resolved = FALSE
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_narration_take_comments_inbox_unresolved
        ON narration_take_comments(workspace_id, created_at DESC)
        WHERE parent_id IS NULL AND resolved = FALSE
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_review_comments_inbox_unresolved`);
    await client.query(`DROP INDEX IF EXISTS idx_narration_take_comments_inbox_unresolved`);
    await client.query(`ALTER TABLE review_comments DROP COLUMN IF EXISTS author_role`);
  },
};

export default migration;
