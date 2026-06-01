import { hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Migration } from './types';

const BCRYPT_COST = 11; // ~250ms on hobby tier; tune to 10 if cold-start is too slow

interface AdminRow {
  id: string;
}
interface WorkspaceRow {
  id: string;
}

/**
 * Bootstrap migration — runs exactly once. Reads `ADMIN_EMAIL` and
 * `ADMIN_PASSWORD` from the environment, creates the first admin user, the
 * default workspace, and the owner membership row.
 *
 * Invariants:
 *   - If a row with `system_role='admin'` already exists, this is a no-op.
 *     This is a safety net beyond schema_migrations bookkeeping; running the
 *     migration twice will not duplicate the admin even if the tracking row
 *     is somehow lost.
 *   - If `ADMIN_EMAIL` or `ADMIN_PASSWORD` is missing AND no admin exists,
 *     the migration FAILS LOUDLY — the deployment cannot proceed without an
 *     admin to sign into `/admin`. The runner's transactional wrapper rolls
 *     back schema_migrations so the migration is re-runnable after the
 *     operator sets the env vars.
 *
 * After this migration succeeds, the env vars become inert. To create
 * additional admins, sign into `/admin` and create users with system_role='admin'.
 */
const migration: Migration = {
  id: '0005_bootstrap_admin_and_default_workspace',
  description: 'Create the bootstrap admin user, default workspace, and owner membership',

  async up(client) {
    // -- Idempotency safety net ----------------------------------------------
    const { rows: existingAdmins } = await client.query<AdminRow>(
      `SELECT id FROM collaborators WHERE system_role = 'admin' LIMIT 1`,
    );
    if (existingAdmins.length > 0) return;

    // -- Env var validation -------------------------------------------------
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || '';

    if (!adminEmail || !adminPassword) {
      throw new Error(
        'Bootstrap requires ADMIN_EMAIL and ADMIN_PASSWORD env vars on first run. ' +
          'Set them in .env.local (dev) or Vercel project settings (prod) and re-run ' +
          '`npm run db:migrate`. After the admin is created the env vars become inert.',
      );
    }
    if (!adminEmail.includes('@')) {
      throw new Error(`ADMIN_EMAIL is not a valid email: ${JSON.stringify(adminEmail)}`);
    }
    if (adminPassword.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    }

    // -- Create admin user --------------------------------------------------
    const passwordHash = await hash(adminPassword, BCRYPT_COST);
    const unsubscribeToken = randomBytes(24).toString('hex');
    const personalToken = randomBytes(24).toString('hex');
    const defaultName = adminEmail.split('@')[0] || 'Admin';

    const { rows: adminRows } = await client.query<AdminRow>(
      `INSERT INTO collaborators
         (name, email, role, system_role, status, password_hash, color)
       VALUES ($1, $2, 'admin', 'admin', 'active', $3, '#0ea5e9')
       RETURNING id`,
      [defaultName, adminEmail, passwordHash],
    );
    const adminId = adminRows[0]!.id;

    // Best-effort: backfill the legacy token columns if they exist (added by
    // ensureTeamSchema). If they don't yet, skip silently — they'll be
    // populated on first read via the existing self-heal path. The admin
    // doesn't use the narrator/editor portal, so a NULL personal_token is OK
    // either way.
    //
    // The UPDATE runs inside a SAVEPOINT: on a never-booted database these
    // columns don't exist, and a failed statement in Postgres poisons the
    // whole transaction — the bare try/catch swallows the JS error but the
    // next command (the workspace INSERT) then dies with "current transaction
    // is aborted". ROLLBACK TO SAVEPOINT rewinds just this statement so the
    // surrounding bootstrap transaction stays usable. This path is exercised
    // by any from-scratch migrate (disaster recovery, a new region failover).
    try {
      await client.query('SAVEPOINT bootstrap_token_backfill');
      await client.query(
        `UPDATE collaborators
         SET unsubscribe_token = COALESCE(unsubscribe_token, $1),
             personal_token = COALESCE(personal_token, $2)
         WHERE id = $3`,
        [unsubscribeToken, personalToken, adminId],
      );
      await client.query('RELEASE SAVEPOINT bootstrap_token_backfill');
    } catch {
      // Columns may not exist on a never-booted database. Non-fatal: undo just
      // this statement so the transaction can proceed.
      await client.query('ROLLBACK TO SAVEPOINT bootstrap_token_backfill');
    }

    // -- Create default workspace ------------------------------------------
    const { rows: workspaceRows } = await client.query<WorkspaceRow>(
      `INSERT INTO workspaces (name, owner_user_id) VALUES ($1, $2) RETURNING id`,
      ['Default', adminId],
    );
    const workspaceId = workspaceRows[0]!.id;

    // -- Owner membership row ----------------------------------------------
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [workspaceId, adminId],
    );
  },

  // No `down`: removing the bootstrap admin would lock everyone out of /admin.
};

export default migration;
