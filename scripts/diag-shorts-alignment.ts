import { createClient } from '@vercel/postgres';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(process.cwd(), '.env.local') });

// Is the shorts caption->audio mapping drifting because the alignment's word
// tokenization differs from our script split? `chunkBoundariesFromAlignment`
// maps script-word index i directly onto alignment word i — which only holds
// if both tokenize identically. This prints, for each recent voiced Short,
// the script word count vs the cached alignment word count and the first/last
// dozen tokens of each, so we can SEE the divergence.
async function main() {
  const cs = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!cs) throw new Error('no POSTGRES_URL');
  const client = createClient({ connectionString: cs });
  await client.connect();

  const { stripProductionMarkers } = await import('../src/lib/script-markers');
  const { buildCanonicalScript } = await import('../src/lib/voiceover-alignment');
  const { deriveCacheKey } = await import('../src/lib/voiceover-alignment-cache');

  const shorts = await client.query<{
    id: string; title: string | null; short_script: string; voiceover_audio_url: string;
  }>(`
    SELECT id::text, title, short_script, voiceover_audio_url
      FROM shorts
     WHERE voiceover_audio_url IS NOT NULL
       AND short_script IS NOT NULL
       AND medium = 'short_native'
     ORDER BY updated_at DESC
     LIMIT 5
  `);

  process.stdout.write(`\n[voiced short_native rows] ${shorts.rows.length}\n`);

  for (const s of shorts.rows) {
    const scriptWords = stripProductionMarkers(s.short_script).split(/\s+/).filter(Boolean);
    const canonical = buildCanonicalScript([s.short_script]);
    const key = deriveCacheKey(s.voiceover_audio_url, canonical);
    const align = await client.query<{ alignment_json: { words: Array<{ text: string; start: number; end: number }> } }>(
      `SELECT alignment_json FROM voiceover_alignments WHERE cache_key = $1 LIMIT 1`,
      [key],
    );
    const alignWords = align.rows[0]?.alignment_json?.words ?? null;

    process.stdout.write(`\n  ${s.id} (${s.title ?? 'untitled'})\n`);
    process.stdout.write(`    script words: ${scriptWords.length}\n`);
    if (!alignWords) {
      process.stdout.write(`    alignment: NONE CACHED (captions fall back to proportional WPM)\n`);
      continue;
    }
    process.stdout.write(`    alignment words: ${alignWords.length}  ${alignWords.length === scriptWords.length ? '(MATCH)' : '(MISMATCH -> index mapping drifts)'}\n`);
    process.stdout.write(`    script[0..11]: ${JSON.stringify(scriptWords.slice(0, 12))}\n`);
    process.stdout.write(`    align [0..11]: ${JSON.stringify(alignWords.slice(0, 12).map((w) => w.text))}\n`);
  }

  await client.end();
}

main().catch((e) => { process.stderr.write(String(e) + '\n'); process.exit(1); });
