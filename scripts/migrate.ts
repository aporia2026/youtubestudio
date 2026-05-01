/**
 * CLI entrypoint for the migration runner.
 *
 * Usage:
 *   npm run db:migrate          # apply pending migrations
 *   npm run db:status           # show status of every declared migration
 *
 * Reads POSTGRES_URL_NON_POOLING (preferred) or POSTGRES_URL from the
 * environment. For local development, populate `.env.local`; for Vercel
 * deploys, the env vars are already provisioned.
 */
import { applyPending, getStatus } from '../src/lib/migrations/index';

const subcommand = process.argv[2] ?? 'up';

async function main() {
  switch (subcommand) {
    case 'up':
    case 'apply': {
      const result = await applyPending();
      if (result.applied.length === 0) {
        process.stdout.write(
          `No pending migrations. ${result.alreadyApplied.length} already applied.\n`,
        );
      } else {
        process.stdout.write(
          `Applied ${result.applied.length} migration(s):\n` +
            result.applied.map((id) => `  + ${id}\n`).join(''),
        );
      }
      return;
    }

    case 'status': {
      const rows = await getStatus();
      const w = Math.max(...rows.map((r) => r.id.length));
      for (const r of rows) {
        const mark = r.applied ? '✓' : '·';
        const when = r.appliedAt ? r.appliedAt.toISOString() : 'pending';
        process.stdout.write(`  ${mark} ${r.id.padEnd(w)}  ${when}  ${r.description}\n`);
      }
      return;
    }

    default: {
      process.stderr.write(`Unknown subcommand: ${subcommand}\nUsage: migrate [up|status]\n`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.cause) {
    process.stderr.write(`Caused by: ${String(err.cause)}\n`);
  }
  process.exit(1);
});
