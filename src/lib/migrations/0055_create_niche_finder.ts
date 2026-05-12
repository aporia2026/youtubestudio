import type { Migration } from './types';

/**
 * Phase NF.1 — niche finder v0.5 (deep-dive only).
 *
 * Two tables:
 *
 *   - `niche_reports` — the persisted result of a deep-dive run. PK
 *     `(workspace_id, slug)` so re-visiting the same niche slug
 *     within a workspace returns the cached report instead of re-
 *     burning YouTube quota + AI tokens. Stores the four-dimension
 *     niche-level scores, the per-cluster breakdown, and the AI
 *     strategy memo. Idempotent regeneration: a manual "regenerate"
 *     button on the UI does `ON CONFLICT (workspace_id, slug) DO
 *     UPDATE` to overwrite the row.
 *
 *   - `niche_finder_api_cache` — 7-day cache for YouTube Data API
 *     responses keyed by request-URL hash. Shared across every
 *     niche-finder operation so multiple deep-dives that overlap on
 *     channels or videos pay quota once. Bounded by the daily
 *     cleanup pass in the discovery route handler (rows older than
 *     7 days are deleted on every cache read — cheap because the
 *     index covers it).
 *
 * Discovery + watchlist tables (`niche_seeds`, `niche_candidates`,
 * `niche_watchlist`) intentionally NOT in this migration — they
 * land in Phase 2 migration 0056 when the discovery surface ships.
 * YAGNI per the project conventions: unused tables would be
 * misleading.
 */
const migration: Migration = {
  id: '0055_create_niche_finder',
  description: 'Niche finder v0.5 — niche_reports + niche_finder_api_cache',

  async up(client) {
    // ── Niche reports ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_reports (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        -- URL-safe slug derived from the operator's input. Stable
        -- key — re-entering the same niche text yields the same slug
        -- (after normalisation) so the cache hits.
        slug TEXT NOT NULL,

        -- Human-friendly name (preserves casing, punctuation).
        name TEXT NOT NULL,

        -- Niche-level rolled-up scores. Shape matches NicheScores
        -- in src/lib/niche-finder/types.ts.
        scores JSONB NOT NULL,

        -- Per-cluster breakdown. Array of { centroidTerm, sample
        -- stats, scores }. Used to render the cluster-by-cluster
        -- panel on the deep-dive page.
        clusters JSONB NOT NULL DEFAULT '[]'::jsonb,

        -- AI strategy memo (Markdown). Sanitised before render via
        -- the existing markdownToBasicHtml helper.
        ai_memo TEXT NOT NULL DEFAULT '',

        -- Which model produced the memo. Recorded for spend
        -- attribution + later A/B comparison across model upgrades.
        ai_model TEXT NOT NULL DEFAULT '',

        -- Spend in USD cents, captured at generation time from the
        -- ai_spend_log writer. NULL when the row was a cache hit
        -- (no new AI call).
        spend_usd_cents INTEGER,

        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        regenerated_at TIMESTAMPTZ,

        PRIMARY KEY (workspace_id, slug)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_reports_workspace_time
        ON niche_reports(workspace_id, generated_at DESC)
    `);

    // ── YouTube API response cache ────────────────────────────────
    //
    // Keyed by SHA-256 hash of the request URL + relevant headers.
    // Hashing means cache keys don't expose API keys or PII even if
    // the table leaks. The route handlers fall back to a fresh
    // fetch on cache miss; cache writes are best-effort and never
    // fail the request.
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_finder_api_cache (
        cache_key TEXT PRIMARY KEY,
        response JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_finder_api_cache_age
        ON niche_finder_api_cache(fetched_at)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS niche_finder_api_cache`);
    await client.query(`DROP TABLE IF EXISTS niche_reports`);
  },
};

export default migration;
