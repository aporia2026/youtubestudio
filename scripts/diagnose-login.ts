/**
 * Diagnose why a login attempt fails. Prints a complete picture of the
 * user's auth state and clears any rate-limit buckets that could be
 * blocking the IP. One-command alternative to digging through DevTools.
 *
 * Usage:
 *   npm run diagnose-login -- <email> <password>
 *
 * The password is checked against the stored bcrypt hash so the output
 * tells you definitively whether the password is correct — separately
 * from "is the user blocked" / "is the user suspended". Local dev tool;
 * never expose this in production.
 */
import { compare } from 'bcryptjs';
import { createClient } from '@vercel/postgres';

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    process.stderr.write('usage: npm run diagnose-login -- <email> <password>\n');
    process.exit(1);
  }

  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) {
    process.stderr.write('POSTGRES_URL not set in .env.local\n');
    process.exit(1);
  }
  // Show the host so it's obvious if the script and the dev server are
  // talking to different databases.
  const host = (() => {
    try { return new URL(cs).host; } catch { return '(unparseable)'; }
  })();

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    process.stdout.write(`db host: ${host}\n\n`);

    const userRes = await client.query<{
      id: string;
      email: string | null;
      name: string;
      status: string;
      system_role: string;
      password_hash: string | null;
      last_login_at: Date | null;
    }>(
      `SELECT id, email, name, status, system_role, password_hash, last_login_at
         FROM collaborators
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1`,
      [email.trim()],
    );

    if (userRes.rows.length === 0) {
      process.stdout.write(`user           : NOT FOUND for ${email}\n`);
      const known = await client.query<{ email: string }>(
        `SELECT email FROM collaborators WHERE email IS NOT NULL ORDER BY email ASC`,
      );
      process.stdout.write('known emails in this database:\n');
      for (const r of known.rows) process.stdout.write(`  - ${r.email}\n`);
      process.exit(2);
    }

    const u = userRes.rows[0];
    process.stdout.write(`user found     : ${u.email}  (id ${u.id})\n`);
    process.stdout.write(`name           : ${u.name}\n`);
    process.stdout.write(`status         : ${u.status}\n`);
    process.stdout.write(`system_role    : ${u.system_role}\n`);
    process.stdout.write(`has password   : ${u.password_hash ? 'yes' : 'NO'}\n`);
    process.stdout.write(`last login     : ${u.last_login_at ? u.last_login_at.toISOString() : 'never'}\n`);

    if (!u.password_hash) {
      process.stdout.write('\nVERDICT: no password set — run `npm run set-password -- <email> <pw>` again.\n');
      process.exit(3);
    }

    const passwordOk = await compare(password, u.password_hash);
    process.stdout.write(`\npassword check : ${passwordOk ? 'MATCH ✓' : 'DOES NOT MATCH ✗'}\n`);

    if (!passwordOk) {
      process.stdout.write(
        '\nVERDICT: the password you typed here does not match what is stored.\n' +
        '  - Re-run set-password with the SAME password you intend to use, e.g.\n' +
        '      npm run set-password -- ' + email + ' MyNewPassword12345\n' +
        '  - Then re-run THIS script with the same password to confirm.\n',
      );
    }

    if (u.status === 'suspended') {
      process.stdout.write('\nVERDICT: account is suspended — login will return 403 regardless of password.\n');
    }

    // Always clear rate-limit buckets first — even if the rest of the
    // diagnostic errors out, the user isn't stuck behind a stale lockout.
    const cleared = await client.query(
      `DELETE FROM rate_limits WHERE bucket_key LIKE 'auth.login:%'`,
    );
    process.stdout.write(`\nrate-limit rows cleared: ${cleared.rowCount ?? 0}\n`);

    // Workspace-membership check. Login's `findPrimaryWorkspaceForUser`
    // queries `workspace_members.workspace_id` — if that column is missing
    // (as happened after the live-site CASCADE described in migration
    // 0036b's header), the login route throws a 500 that the frontend
    // surfaces as a generic "Sign in failed" message. Detect that
    // explicitly here so the verdict is unambiguous.
    const colRes = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ANY (current_schemas(false))
          AND table_name = 'workspace_members'
        ORDER BY ordinal_position`,
    );
    if (colRes.rows.length === 0) {
      process.stdout.write('\nworkspace_members table : DOES NOT EXIST\n');
      process.stdout.write('VERDICT: schema is broken — run the workspace_members fix migration.\n');
      return;
    }
    const cols = colRes.rows.map((r) => r.column_name);
    process.stdout.write(`\nworkspace_members cols : ${cols.join(', ')}\n`);
    if (!cols.includes('workspace_id')) {
      process.stdout.write(
        'VERDICT: `workspace_members.workspace_id` is missing — this is what makes\n' +
        '  the login route 500 after the password check passes. The Phase 1 schema\n' +
        '  drift documented in migration 0036b never re-added this column. A new\n' +
        '  migration (0068) is required to restore it; run `npm run db:migrate`\n' +
        '  once that lands.\n',
      );
      return;
    }

    const wsRes = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_members WHERE user_id = $1 LIMIT 1`,
      [u.id],
    );
    process.stdout.write(`workspace mem.         : ${wsRes.rows.length > 0 ? 'yes' : 'NO (login would fail with 403)'}\n`);

    if (passwordOk && u.status !== 'suspended' && wsRes.rows.length > 0) {
      process.stdout.write('\nALL CHECKS PASSED — sign-in should now succeed. Try the browser again.\n');
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`diagnose-login: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
