/**
 * Read-only: count variant groups and title cards in a given production_doc.
 */
import { createClient } from '@vercel/postgres';

interface Row {
  visual_type?: string;
  group_id?: string;
  variant_index?: number;
  variant_edit_prompt?: string;
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('Usage: tsx scripts/diag-doc-variants-titles.ts <projectId>');
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('POSTGRES_URL_NON_POOLING / POSTGRES_URL not set');

  const client = createClient({ connectionString: cs });
  await client.connect();
  try {
    const { rows } = await client.query<{ payload: { doc: { rows: Row[] } } }>(
      `SELECT payload FROM user_history WHERE id = $1::uuid`,
      [projectId],
    );
    if (rows.length === 0) {
      process.stdout.write(`No row for ${projectId}\n`);
      return;
    }
    const docRows = rows[0].payload?.doc?.rows ?? [];
    const groups = new Map<string, Row[]>();
    let titleCards = 0;
    const visualTypes = new Map<string, number>();
    for (const r of docRows) {
      visualTypes.set(r.visual_type ?? '(none)', (visualTypes.get(r.visual_type ?? '(none)') ?? 0) + 1);
      if (r.visual_type === 'Title Card') titleCards++;
      if (r.group_id) {
        const list = groups.get(r.group_id) ?? [];
        list.push(r);
        groups.set(r.group_id, list);
      }
    }
    process.stdout.write(`Total rows: ${docRows.length}\n`);
    process.stdout.write(`Title Cards: ${titleCards}\n`);
    process.stdout.write(`Variant groups: ${groups.size}\n`);
    if (groups.size > 0) {
      for (const [gid, rs] of groups) {
        const sizes = rs.map((r) => r.variant_index ?? -1).sort();
        process.stdout.write(`  group=${gid.slice(0, 8)}  size=${rs.length}  variant_indices=[${sizes.join(',')}]\n`);
        if (groups.size > 5) break;
      }
    }
    process.stdout.write(`\nVisual types breakdown:\n`);
    for (const [k, v] of [...visualTypes.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${k.padEnd(20)} ${v}\n`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  process.stderr.write(`\nError: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
