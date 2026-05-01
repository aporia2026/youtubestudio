import type { Migration } from './types';

/**
 * Extend the existing `collaborators` table with authentication fields.
 *
 * We deliberately DO NOT rename `collaborators` to `users`: 60+ sites in the
 * codebase reference the table by name (FK declarations, JOINs, query
 * strings). Extending in place is the lower-risk path — the new auth code
 * speaks "users" while existing code keeps speaking "collaborators".
 *
 * Every ALTER is gated with IF NOT EXISTS / DROP IF EXISTS so the migration
 * is safe to re-run against any state of the legacy `ensureTeamSchema`.
 */
const migration: Migration = {
  id: '0003_extend_collaborators_with_auth',
  description: 'Add password / Google OAuth / system_role / status fields to collaborators',

  async up(client) {
    // -- Identity columns ---------------------------------------------------
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS google_sub TEXT`);
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);

    // -- System-level role (admin vs user) ---------------------------------
    // Distinct from the legacy `role` column (which carries the workflow role
    // used by existing app code). `system_role` only gates access to /admin.
    await client.query(`
      ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS system_role TEXT NOT NULL DEFAULT 'user'
    `);
    await client.query(`ALTER TABLE collaborators DROP CONSTRAINT IF EXISTS collaborators_system_role_check`);
    await client.query(`
      ALTER TABLE collaborators ADD CONSTRAINT collaborators_system_role_check
        CHECK (system_role IN ('admin','user'))
    `);

    // -- Account status ----------------------------------------------------
    await client.query(`
      ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    `);
    await client.query(`ALTER TABLE collaborators DROP CONSTRAINT IF EXISTS collaborators_status_check`);
    await client.query(`
      ALTER TABLE collaborators ADD CONSTRAINT collaborators_status_check
        CHECK (status IN ('active','suspended','invited'))
    `);

    // -- Allow 'admin' as a legacy role value too --------------------------
    // The bootstrap admin needs a value for the existing `role` column. The
    // existing CHECK only permits editor/narrator/reviewer/client. Extend it
    // so admin records can satisfy NOT NULL without a meaningless workflow
    // role. Existing rows are unaffected.
    await client.query(`ALTER TABLE collaborators DROP CONSTRAINT IF EXISTS collaborators_role_check`);
    await client.query(`
      ALTER TABLE collaborators ADD CONSTRAINT collaborators_role_check
        CHECK (role IN ('admin','editor','narrator','reviewer','client'))
    `);

    // -- Encrypted per-user settings (replaces cookie-based API key storage)
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS encrypted_settings TEXT`);

    // -- Invite + password reset tokens (one-shot, expiring) ---------------
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS invite_token TEXT`);
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS password_reset_token TEXT`);
    await client.query(`ALTER TABLE collaborators ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ`);

    // -- Indexes ------------------------------------------------------------
    // Email is case-insensitive unique when present. Partial index keeps the
    // legacy NULL-email collaborators valid (token-only contractors).
    // If duplicates exist in the existing data, fail loudly — the operator
    // must dedupe before retrying. Better than silently losing the constraint.
    await client.query(`
      DO $do$
      DECLARE dupes int;
      BEGIN
        SELECT COUNT(*) INTO dupes FROM (
          SELECT LOWER(email) FROM collaborators
          WHERE email IS NOT NULL
          GROUP BY LOWER(email)
          HAVING COUNT(*) > 1
        ) d;
        IF dupes > 0 THEN
          RAISE EXCEPTION 'Cannot create unique email index: % duplicate email(s) found in collaborators. Deduplicate before re-running.', dupes;
        END IF;
      END
      $do$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_email_lower
        ON collaborators (LOWER(email))
        WHERE email IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_google_sub
        ON collaborators (google_sub)
        WHERE google_sub IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_invite_token
        ON collaborators (invite_token)
        WHERE invite_token IS NOT NULL
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaborators_password_reset_token
        ON collaborators (password_reset_token)
        WHERE password_reset_token IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_collaborators_system_role
        ON collaborators (system_role)
    `);
  },

  // No `down` — these are additive columns/indexes the rest of Phase 1 depends
  // on. If a roll-back is needed, restore the pre-Phase-1 Neon DB branch.
};

export default migration;
