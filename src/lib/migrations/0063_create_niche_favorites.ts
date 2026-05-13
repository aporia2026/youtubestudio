import type { Migration } from './types';

/**
 * Phase 14 — Niche Finder favorites: the operator's editorial collection
 * of niches (and the videos beneath them) that are candidates for actual
 * content production.
 *
 * Three tables, deliberately separate from `niche_watchlist`:
 *
 *   1. `niche_favorites` — one row per (workspace, niche). PK
 *      `(workspace_id, niche_slug)` so re-favouriting is idempotent.
 *      Carries the status pipeline (considering/committed/parked/passed)
 *      AND the post-brief learning loop fields (`verdict`, `outcome`,
 *      `outcome_video_id`). The learning fields are optional in v1 —
 *      they exist so a future retrospective can answer "did the AI
 *      briefs predict actual production winners?" without a schema
 *      change. Soft-delete via `deleted_at` + 30-day purge cron.
 *
 *   2. `niche_favorite_videos` — proof videos saved beneath a favourite
 *      niche. (workspace_id, niche_slug, video_id) is unique so the
 *      same video can't be added twice. `is_removed_upstream` +
 *      `last_validated_at` support the ghost-reference guard (PR3) —
 *      we periodically HEAD-check that the YouTube video still exists
 *      and flag it for the UI + exports without deleting the row.
 *
 *   3. `niche_favorite_briefs` — versioned AI Niche Briefs. One row
 *      per generation; the latest row is the active brief. Older rows
 *      remain for version history + the future retrospective.
 *      `operator_context` captures the workspace inputs we fed into
 *      the prompt (interest tags, channel description, niches we've
 *      already produced in) so a future audit can answer "what did
 *      the model actually see?".
 *
 * Why not extend `niche_watchlist`: the watchlist is a monitoring
 * primitive (weekly re-score + alarm thresholds). Favorites is an
 * editorial primitive (we are considering this for production). They
 * can co-exist — a niche can be both watchlisted and favorited — but
 * conflating them would muddle two query patterns and bloat watchlist
 * rows with brief blobs. Per planning rule 4 (alternatives weighed),
 * the three-table option was chosen over column-extension and
 * single-denormalised-jsonb.
 *
 * `created_by_user_id` is nullable + `ON DELETE SET NULL` so a
 * departing user does NOT take their workspace's favorites with them.
 * The workspace owns the favorites; the user column is just provenance.
 */
const migration: Migration = {
  id: '0063_create_niche_favorites',
  description: 'Phase 14 — niche favorites + proof videos + versioned AI briefs',

  async up(client) {
    // -----------------------------------------------------------------------
    // niche_favorites — one row per favorited niche.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_favorites (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        niche_slug TEXT NOT NULL,

        niche_name TEXT NOT NULL,

        -- Which tab the operator was on when they favorited. Useful for
        -- both UX analytics later AND for the hybrid niche-assignment
        -- heuristic ("auto-attach when context is unambiguous").
        source_tab TEXT NOT NULL
          CHECK (source_tab IN ('type','interests','channel','category','outliers','manual')),

        -- Snapshot of NicheScores at the moment of saving so the
        -- Favorites tab can render score chips without re-running the
        -- v0.5 deep-dive on every render. Updated when the operator
        -- regenerates / re-saves.
        scores JSONB NOT NULL,

        -- Free-text operator notes (autosaved). NULL = no notes.
        notes TEXT,

        -- Editorial status pipeline. Operator-controlled. The PR2 brief
        -- and the PR3 verdict/outcome fields below do NOT auto-transition
        -- this — the operator does, via a dropdown.
        status TEXT NOT NULL DEFAULT 'considering'
          CHECK (status IN ('considering','committed','parked','passed')),

        -- Learning-loop fields. Optional in v1; populated when the
        -- operator reacts to the brief and again when the production
        -- outcome is known. Enables month-3 retrospective: "did the AI
        -- briefs predict actual production winners?"
        verdict TEXT
          CHECK (verdict IS NULL OR verdict IN ('accept','override','reject')),
        verdict_reason TEXT,
        outcome TEXT
          CHECK (outcome IS NULL OR outcome IN ('producing','produced','parked','killed')),
        outcome_video_id TEXT,
        outcome_reason TEXT,

        -- Provenance. Nullable + SET NULL so user departure does not
        -- cascade-delete the workspace's favorites.
        created_by_user_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Soft-delete. Cleanup cron (PR3) purges rows where
        -- deleted_at < NOW() - INTERVAL '30 days'.
        deleted_at TIMESTAMPTZ,

        PRIMARY KEY (workspace_id, niche_slug)
      )
    `);

    // List view: workspace + status filter chips + most-recent sort.
    // Partial index excludes soft-deleted rows so the hot path never
    // pays for them.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorites_workspace_status_updated
        ON niche_favorites(workspace_id, status, updated_at DESC)
        WHERE deleted_at IS NULL
    `);

    // Recently-removed view (the 30-day restore bin).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorites_deleted_at
        ON niche_favorites(deleted_at)
        WHERE deleted_at IS NOT NULL
    `);

    // -----------------------------------------------------------------------
    // niche_favorite_videos — proof videos beneath each favorite niche.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_favorite_videos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        workspace_id UUID NOT NULL,
        niche_slug TEXT NOT NULL,

        -- YouTube video id (11 chars typically). Treated as opaque text.
        video_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,

        -- Snapshotted at add time. Kept in sync if the operator
        -- re-adds the same video. Never auto-refreshed (videos can
        -- drift; we don't want stale view counts overwriting the
        -- captured signal that made this video worth saving).
        title TEXT NOT NULL,
        thumbnail_url TEXT,
        view_count BIGINT,
        published_at TIMESTAMPTZ,
        outlier_score NUMERIC,
        classification TEXT
          CHECK (classification IS NULL OR classification IN ('underperformer','normal','breakout','viral')),
        duration_iso TEXT,
        channel_title TEXT,
        subscriber_count BIGINT,

        -- Ghost-reference guard (PR3). Cron HEAD-checks each video; if
        -- YouTube reports it gone (404/private/age-restricted), we set
        -- is_removed_upstream=true so the UI dims it and the export
        -- excludes it. Never auto-deleted — operator may have value
        -- in seeing the historical record.
        is_removed_upstream BOOLEAN NOT NULL DEFAULT FALSE,
        last_validated_at TIMESTAMPTZ,

        added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        added_by_user_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,

        -- Cascade with the parent favorite. If the operator hard-purges
        -- a favorite (post-30d) the videos go with it.
        FOREIGN KEY (workspace_id, niche_slug)
          REFERENCES niche_favorites(workspace_id, niche_slug)
          ON DELETE CASCADE,

        -- Dedupe: same video can't be added twice to the same favorite.
        UNIQUE (workspace_id, niche_slug, video_id)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorite_videos_workspace_niche
        ON niche_favorite_videos(workspace_id, niche_slug, added_at DESC)
    `);

    // Ghost-reference guard scanning index: cron picks videos whose
    // last_validated_at is NULL or stale.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorite_videos_validation_due
        ON niche_favorite_videos(last_validated_at NULLS FIRST)
        WHERE is_removed_upstream = FALSE
    `);

    // -----------------------------------------------------------------------
    // niche_favorite_briefs — versioned AI Niche Briefs.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS niche_favorite_briefs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        workspace_id UUID NOT NULL,
        niche_slug TEXT NOT NULL,

        -- Which AI model produced this brief. Resolved from the per-
        -- feature model picker at generation time. Stored as the
        -- canonical model id from src/lib/ai-models.ts (e.g.
        -- 'perplexity-sonar-deep-research').
        model_id TEXT NOT NULL,

        -- The structured brief output. Shape (validated at write time
        -- in src/lib/niche-finder/brief.ts):
        --   { headline: string,
        --     market_demand: string, competition: string,
        --     monetization: string, operator_fit: string,
        --     risks: string, recommended_angle: string,
        --     next_steps: string[] }
        sections JSONB NOT NULL,

        -- 0..100, weighted from the section confidences + scores
        -- snapshot. Stored separately from sections so the Summary
        -- sheet column + the heat-band color can render without
        -- parsing the JSON.
        promise_score INTEGER NOT NULL CHECK (promise_score >= 0 AND promise_score <= 100),

        -- Per-section confidence labels: { market_demand: 'low'|
        -- 'medium'|'high', competition: ..., ... }. Combats the
        -- "credible-looking citations on synthesized analysis" risk
        -- by letting the model declare uncertainty up front.
        section_confidences JSONB NOT NULL,

        -- Perplexity-returned citations, each tagged by domain quality:
        --   [{ url, title, domain, domain_quality: 'high'|'medium'|'low' }]
        -- Tagged at write time in brief.ts based on a hardcoded
        -- domain → quality map (YouTube/news=high, Reddit=medium,
        -- SEO-blog/listicle=low). NULL on briefs that failed before
        -- citations came back.
        citations JSONB,

        -- Snapshot of what we fed into the prompt for this generation.
        -- { interest_tags: string[], channel_description: string|null,
        --   produced_niches: string[] }
        -- Frozen so the audit trail survives interest-tag edits later.
        operator_context JSONB NOT NULL,

        -- NicheScores at generation time so the export can say
        -- "as of {date}, demand was {label}" even if scores have drifted.
        scores_snapshot JSONB NOT NULL,

        -- Cost tracking (PR2 monthly tally + per-brief tooltip).
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        cost_usd NUMERIC(10,4),

        -- Lifecycle. The cron retry safety net picks rows where
        -- status IN ('pending','running','failed') AND attempts < 3.
        status TEXT NOT NULL
          CHECK (status IN ('pending','running','ready','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,

        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        FOREIGN KEY (workspace_id, niche_slug)
          REFERENCES niche_favorites(workspace_id, niche_slug)
          ON DELETE CASCADE
      )
    `);

    // Version-history view: most-recent brief per niche.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorite_briefs_workspace_niche_generated
        ON niche_favorite_briefs(workspace_id, niche_slug, generated_at DESC)
    `);

    // Cron retry scan. Partial index keeps it tiny — only incomplete
    // briefs that haven't exhausted retries.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorite_briefs_retry_due
        ON niche_favorite_briefs(generated_at ASC)
        WHERE status IN ('pending','running','failed') AND attempts < 3
    `);

    // Monthly cost tally (Favorites tab header caption).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_niche_favorite_briefs_workspace_month
        ON niche_favorite_briefs(workspace_id, generated_at DESC)
        WHERE cost_usd IS NOT NULL
    `);
  },

  async down(client) {
    // Drop in reverse-FK order so cascades don't trip on missing parents.
    await client.query(`DROP TABLE IF EXISTS niche_favorite_briefs`);
    await client.query(`DROP TABLE IF EXISTS niche_favorite_videos`);
    await client.query(`DROP TABLE IF EXISTS niche_favorites`);
  },
};

export default migration;
