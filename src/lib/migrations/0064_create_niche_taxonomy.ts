import type { Migration } from './types';

/**
 * Phase 13.2.W — hierarchical niche taxonomy for the Browse Categories tab.
 *
 * Two tables:
 *
 *   niche_taxonomy_nodes
 *     Global (workspace-agnostic) tree of category → sub-niche →
 *     micro-niche names. AI-generated rows live here too — once the
 *     model has brainstormed "long-term rental property analysis"
 *     under "real estate investing strategy", every workspace in the
 *     same (language, region) shares the name. Names are editorial
 *     content the system generates; no per-workspace YouTube derived
 *     data lives in this table, so cross-workspace caching is safe.
 *
 *   niche_taxonomy_scores
 *     Per-workspace per-node demand/supply/monetization/fit scores.
 *     Scoping enforced via a composite PK of (node_id, workspace_id)
 *     so cross-workspace leakage of YouTube-derived signals is
 *     structurally impossible (per the Phase 3 ToS audit).
 *
 * Curated seeds are NOT inserted here. The category-level rows are
 * lazily seeded from `categories.ts` on the first GET for a given
 * (language, region) so the source of truth for curated content stays
 * in code, not in a frozen migration snapshot.
 *
 * Parent uniqueness: `UNIQUE (parent_id, slug, language, region)`
 * doesn't work with `parent_id = NULL` (PostgreSQL treats NULL ≠ NULL
 * in unique constraints). Two partial indexes give the same shape
 * with NULL-safe semantics: one for root-level nodes, one for
 * children.
 */
const migration: Migration = {
  id: '0064_create_niche_taxonomy',
  description: 'Phase 13.2 — hierarchical niche taxonomy (nodes + per-workspace scores)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_taxonomy_nodes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- NULL on root-level (category) nodes; FK to another row in this
        -- same table for sub-niches and micro-niches. CASCADE on delete
        -- so removing a category cleans up its whole subtree.
        parent_id UUID REFERENCES niche_taxonomy_nodes(id) ON DELETE CASCADE,

        -- Stable kebab-case slug, unique among siblings within a locale.
        slug TEXT NOT NULL,

        -- Human-readable name. Capped at 80 chars at write-time. AI
        -- generations are constrained to YouTube-searchable phrases.
        name TEXT NOT NULL,

        -- 'category' (root, parent_id IS NULL), 'subniche' (depth 1),
        -- 'microniche' (depth 2). Enforced by the CHECK below; the
        -- application layer rejects descents past depth 2.
        level TEXT NOT NULL CHECK (level IN ('category', 'subniche', 'microniche')),

        -- 'curated' (from categories.ts), 'ai' (Haiku/Sonnet generation),
        -- 'harvested' (reserved for a future YouTube-Suggest expander).
        source TEXT NOT NULL CHECK (source IN ('curated', 'ai', 'harvested')),

        -- ISO 639-1 language code (en/es/pt/de/fr/hi/id/…). AI generations
        -- differ by language; "frugal living tips" and "consejos para
        -- vivir frugalmente" are separate nodes under the same parent.
        language TEXT NOT NULL,

        -- ISO 3166-1 alpha-2 region code (US/GB/CA/AU/IN/…). Regional
        -- monetization potential varies enough that we keep them
        -- separate at the taxonomy level.
        region TEXT NOT NULL,

        -- Free-form rationale recorded by the AI generator (kept short).
        -- Capped at 200 chars at write-time. Surfaces in the UI as the
        -- card subtitle.
        rationale TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Root-level uniqueness: one (slug, language, region) per locale,
    // applied only to rows with no parent.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_niche_taxonomy_root_unique
        ON niche_taxonomy_nodes (slug, language, region)
        WHERE parent_id IS NULL
    `);

    // Sibling uniqueness: one (slug, language, region) per (parent_id),
    // applied to non-root rows.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_niche_taxonomy_child_unique
        ON niche_taxonomy_nodes (parent_id, slug, language, region)
        WHERE parent_id IS NOT NULL
    `);

    // Hot path: "list the children of node X in locale (L, R)."
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_taxonomy_children
        ON niche_taxonomy_nodes (parent_id, language, region)
    `);

    // Used by the cross-category sweet-spot scanner (PR3) to walk every
    // leaf for a given locale.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_taxonomy_level_locale
        ON niche_taxonomy_nodes (level, language, region)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_taxonomy_scores (
        node_id UUID NOT NULL REFERENCES niche_taxonomy_nodes(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

        scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- NicheScores blob: { demand, supply, monetization, fit, combined }.
        -- Validated by the application layer at read time so a schema
        -- evolution (e.g. adding a new dimension) doesn't require a
        -- migration.
        scores JSONB NOT NULL,

        -- How many videos got pulled to compute the score. Drives the
        -- confidence pill in the UI; sparse samples ("< 10") are
        -- flagged as "rough guess."
        sample_size INTEGER NOT NULL DEFAULT 0,

        -- Reserved for harvested-source nodes (e.g. YouTube Suggest URL
        -- the term came from). Currently always NULL for curated/ai rows.
        source_url TEXT,

        -- Composite PK guarantees one score row per (node, workspace).
        -- A second score for the same pair upserts in place.
        PRIMARY KEY (node_id, workspace_id)
      )
    `);

    // Hot path: "show me my score for a node, if it's fresh." We sort by
    // scored_at so a stale-score sweep (PR3 cron) can pick the oldest.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_taxonomy_scores_workspace
        ON niche_taxonomy_scores (workspace_id, scored_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS niche_taxonomy_scores`);
    await client.query(`DROP TABLE IF EXISTS niche_taxonomy_nodes`);
  },
};

export default migration;
