import type { Migration } from './types';

/**
 * Phase 13.2 — niche-finder discovery cache.
 *
 * One table, three discovery modes (A interest-based, B channel-paste,
 * C category-browse). Each row is a cached run keyed by
 * `(workspace_id, kind, input_hash)` so re-querying the same input
 * within TTL collapses to a single quota burn.
 *
 *   - `kind` is the discovery mode discriminator.
 *   - `input_hash` is a SHA-256 of the normalised input (e.g. for
 *     channel-paste it's the canonical channel id; for interests
 *     it's the joined, sorted, lowercased interest list; for
 *     categories it's the category slug). Hashed so the row never
 *     leaks raw operator interests across the audit log.
 *   - `input_summary` is a short human-readable label so the UI can
 *     render "Recent discoveries: …" without storing PII.
 *   - `results` is the JSONB list of niche slugs + scores the
 *     discovery surfaced. Slugs link out to the v0.5 deep-dive page.
 *
 * Mode D (outliers) does NOT use this table — it fetches on demand
 * and reuses the existing `niche_finder_api_cache` for the YouTube
 * payload caching layer.
 */
const migration: Migration = {
  id: '0058_create_niche_discoveries',
  description: 'Phase 13.2 — niche discovery cache (interests / channel / category)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_discoveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        -- Discovery mode discriminator. CHECK keeps future code
        -- honest if a typo sneaks into a route.
        kind TEXT NOT NULL CHECK (kind IN ('interests', 'channel', 'category')),

        -- SHA-256 of the normalised input. 64 hex chars.
        input_hash TEXT NOT NULL,

        -- Short human label for the UI. Trimmed at write time.
        input_summary TEXT NOT NULL,

        -- JSONB list of { slug, name, scores } returned by the
        -- discovery. Slug points at /insights/niches/[slug] for the
        -- v0.5 deep-dive.
        results JSONB NOT NULL DEFAULT '[]'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (workspace_id, kind, input_hash)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_discoveries_workspace_time
        ON niche_discoveries(workspace_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS niche_discoveries`);
  },
};

export default migration;
