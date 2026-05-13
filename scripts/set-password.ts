/**
 * Set a user's password directly from the command line.
 *
 * Usage:
 *   npm run set-password -- <email> <new-password>
 *
 * The password is hashed with bcrypt and written to `collaborators.password_hash`,
 * any pending reset token is cleared, and an `invited` account is flipped to
 * `active`. Same code path the admin UI uses (`setUserPassword` in
 * src/lib/users.ts), so the result is identical to setting it through the
 * web admin.
 *
 * Bail-outs (all surfaced with a clear message, no stack trace):
 *   - missing args
 *   - password shorter than 12 chars (the helper's minimum)
 *   - no user with that email — prints the list of known emails so a typo
 *     is obvious at a glance
 *
 * For local dev use only. Prefer the "Forgot password?" email flow in prod
 * so the audit log carries an authenticated trail.
 */
import { sql } from '@vercel/postgres';
import { findUserByEmail, setUserPassword } from '../src/lib/users';

function fail(msg: string): never {
  process.stderr.write(`set-password: ${msg}\n`);
  process.exit(1);
}

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    fail('usage: npm run set-password -- <email> <new-password>');
  }

  if (password.length < 12) {
    fail(`password must be at least 12 characters (got ${password.length}).`);
  }

  const user = await findUserByEmail(email.trim().toLowerCase());
  if (!user) {
    process.stderr.write(`set-password: no user found with email ${email}\n`);
    const { rows } = await sql<{ email: string | null }>`
      SELECT email FROM collaborators WHERE email IS NOT NULL ORDER BY email ASC
    `;
    if (rows.length > 0) {
      process.stderr.write(`Known emails:\n`);
      for (const r of rows) process.stderr.write(`  - ${r.email}\n`);
    }
    process.exit(1);
  }

  await setUserPassword(user.id, password);
  process.stdout.write(`Password updated for ${user.email}.\n`);
}

main().catch((err) => {
  process.stderr.write(`set-password: failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
