/** Read-only — show the admin user's email + creation time. */
import { createClient } from '@vercel/postgres';

async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING not set');
  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      name: string;
      email: string;
      system_role: string;
      status: string;
      created_at: Date;
      has_password_hash: boolean;
    }>(
      `SELECT id, name, email, system_role, status, created_at,
              (password_hash IS NOT NULL AND length(password_hash) > 10) AS has_password_hash
         FROM collaborators
        WHERE system_role = 'admin'
        ORDER BY created_at ASC`,
    );
    process.stdout.write(`Admin rows: ${rows.length}\n`);
    for (const r of rows) {
      process.stdout.write(
        `  ${r.email}  (${r.name})  status=${r.status}  hasPasswordHash=${r.has_password_hash}  createdAt=${r.created_at.toISOString()}\n`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err}\n`);
  process.exit(1);
});
