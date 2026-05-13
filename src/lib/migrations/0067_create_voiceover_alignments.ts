import type { Migration } from './types';

/**
 * Voiceover alignment cache (Phase 2 of
 * `_plans/2026-05-13-voiceover-aligned-scene-timing.md`).
 *
 * One row per (audio file + canonical script) pair. Lookups are keyed by
 * a single sha256 over `audioUrl + sha256(canonicalScript)` so:
 *   - re-rendering the same doc with the same voiceover is a free cache
 *     hit (no ElevenLabs call), and
 *   - editing the script invalidates the cache deterministically (the
 *     script hash changes, the lookup misses, a fresh alignment runs).
 *
 * Columns are deliberately minimal — the alignment_json blob carries
 * everything else the consumer needs. `duration_ms` is captured at
 * write time so the cost dashboard can compute "hours aligned this
 * month" without parsing the JSON; `cost_usd` records what we charged
 * the daily spend cap for at the time of writing so the cap math stays
 * accurate even if Scribe pricing changes later.
 *
 * Storage envelope, per the plan's cost estimate: ~50 KB/min audio
 * × ~14 min × ~500 videos ≈ 350 MB total. Trivial for Postgres; no
 * need for a TOAST tuning pass.
 *
 * Cache poisoning mitigation: the key includes the script hash, so an
 * attacker who could swap what URL resolves to (bucket purge + reuse)
 * cannot serve old alignment for a new script. A URL that returns
 * different audio than the script expects produces a high
 * mismatch-rate alignment which the cursor walk falls back through
 * to estimated timing — bad UX but not a security issue.
 *
 * Cleanup: an out-of-band cron can prune rows older than N days that
 * haven't been touched; not part of this migration since the storage
 * envelope is small enough that retention isn't yet a problem.
 */
const migration: Migration = {
  id: '0067_create_voiceover_alignments',
  description: 'Voiceover alignment cache (audio + script → ElevenLabs forced alignment JSON)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS voiceover_alignments (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cache_key      TEXT NOT NULL UNIQUE,
        alignment_json JSONB NOT NULL,
        duration_ms    INTEGER NOT NULL,
        cost_usd       REAL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // The UNIQUE constraint already creates a btree on cache_key; an
    // explicit index would be redundant. created_at index supports the
    // daily-spend-cap aggregate query without scanning the whole table.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_voiceover_alignments_created_at
        ON voiceover_alignments (created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS voiceover_alignments`);
  },
};

export default migration;
