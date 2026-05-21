import type { Migration } from './types';

/**
 * Phase 1 of `_plans/2026-05-21-user-defined-styles-with-reference-images.md`.
 *
 * Extends the existing `production_doc_styles` table so a user can save a
 * style that carries a plain-English descriptor + 5–8 reference images, and
 * adds two new tables to hold those refs and the per-style test renders.
 *
 * Shape (after this migration):
 *
 *   production_doc_styles
 *     + owner_id              UUID → collaborators(id) ON DELETE CASCADE
 *                             NULL  ⇒ workspace-wide (legacy / shared)
 *                             NOT NULL ⇒ private to that collaborator
 *     + draft                 BOOLEAN  true while the editor is open;
 *                             listAllStyles() filters draft=true out
 *     + approved_at           TIMESTAMPTZ  soft signal — last time the user
 *                             clicked "this is good" in the editor. Not a
 *                             save-gate (the council rejected gate-on-approval
 *                             as theatre that turns a free action paid).
 *     + version               INT  bumps on every mutating edit. Test
 *                             renders and (future) generated images pin to
 *                             the version they ran against. Default 1 so
 *                             every existing row is "v1".
 *     + style_prompt          TEXT  the user's plain-English descriptor.
 *                             Separate from ai_image_suffix so the legacy
 *                             prompt-builder code path keeps working
 *                             unchanged for built-ins.
 *     + preferred_cloud_model TEXT  e.g. 'flux2-pro-i2i'. Dispatcher reads
 *                             this; falls back to user/workspace default
 *                             when NULL.
 *
 *   style_reference_images   NEW
 *     5–8 R2-backed images per style. Position controls order (slot 0
 *     is the strongest anchor for single-ref models like Ideogram remix).
 *     role + weight are reserved in the schema for forward-compat with
 *     IP-Adapter multi-role conditioning; v1 hardcodes role='style',
 *     weight=1.0 and the UI hides them.
 *
 *     `rejected_by_provider` / `rejection_reason` / `rejection_provider`
 *     / `rejected_at` track operational rejections — Kie.ai or Replicate
 *     refusing to use a ref (NSFW filter, copyrighted-character detection,
 *     etc.). The dispatcher excludes rejected refs by default and surfaces
 *     a "Regenerate without rejected refs" button in the UI. Per the user
 *     decision on 2026-05-21 we do NOT ship the full rights-attestation
 *     UI / takedown flow — but we DO carry per-ref provenance + provider
 *     refusal state because it saves a debugging day per month at scale.
 *
 *   style_test_renders        NEW
 *     Small bounded gallery (cap enforced at the application layer)
 *     showing the last few times the user clicked "Run test render" in
 *     the editor. `style_version` pins each render to the version of the
 *     style that produced it, so a thumb taken at version 1 doesn't lie
 *     about behaviour at version 3.
 *
 * Backfill is implicit:
 *   - owner_id        → NULL (existing rows stay workspace-wide)
 *   - draft           → false (DEFAULT)
 *   - approved_at     → NULL
 *   - version         → 1 (DEFAULT)
 *   - style_prompt    → NULL
 *   - preferred_cloud_model → NULL
 *
 * `IF NOT EXISTS` / `IF EXISTS` everywhere so the migration is idempotent
 * for the production-doc style table — matching the project convention
 * (see 0022, 0079).
 */
const migration: Migration = {
  id: '0080_extend_production_doc_styles_with_refs',
  description: 'User-defined styles: refs + draft + version on production_doc_styles, plus style_reference_images and style_test_renders tables',

  async up(client) {
    // ── production_doc_styles ───────────────────────────────────────────
    await client.query(`
      ALTER TABLE production_doc_styles
        ADD COLUMN IF NOT EXISTS owner_id UUID
          REFERENCES collaborators(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS draft BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS style_prompt TEXT,
        ADD COLUMN IF NOT EXISTS preferred_cloud_model TEXT
    `);

    // listAllStyles() filters by (workspace_id, draft=false, owner ownership)
    // — index supports the common path: list a workspace's visible styles
    // ordered by recency. Partial index on draft=false keeps the working
    // set lean (draft rows churn during editor sessions).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_production_doc_styles_workspace_visible
        ON production_doc_styles(workspace_id, owner_id, updated_at DESC)
        WHERE draft = FALSE
    `);

    // ── style_reference_images ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS style_reference_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        style_id UUID NOT NULL
          REFERENCES production_doc_styles(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL
          REFERENCES workspaces(id) ON DELETE CASCADE,

        position SMALLINT NOT NULL,
        role TEXT NOT NULL DEFAULT 'style'
          CHECK (role IN ('style','character','palette','composition')),
        weight REAL NOT NULL DEFAULT 1.0
          CHECK (weight >= 0 AND weight <= 1),

        r2_bucket TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        size_bytes INTEGER,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,

        rejected_by_provider BOOLEAN NOT NULL DEFAULT FALSE,
        rejection_reason TEXT,
        rejection_provider TEXT,
        rejected_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT style_reference_images_style_position_unique
          UNIQUE (style_id, position)
      )
    `);

    // Hot path: list every ref for a style, in position order. The PK
    // covers point lookups by id; this index covers the list path.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_style_reference_images_style
        ON style_reference_images(style_id, position)
    `);

    // ── style_test_renders ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS style_test_renders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        style_id UUID NOT NULL
          REFERENCES production_doc_styles(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL
          REFERENCES workspaces(id) ON DELETE CASCADE,

        style_version INT NOT NULL,
        test_prompt TEXT NOT NULL,
        output_url TEXT NOT NULL,
        r2_key TEXT,
        model_used TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        cost_usd NUMERIC(10, 4),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Gallery query: last N renders for a style, newest first.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_style_test_renders_style
        ON style_test_renders(style_id, created_at DESC)
    `);
  },

  async down(client) {
    // Drop in dependency order: tables that FK into production_doc_styles
    // first, then strip the added columns. We don't drop the parent table
    // (it predates this migration — see 0022).
    await client.query(`DROP TABLE IF EXISTS style_test_renders`);
    await client.query(`DROP TABLE IF EXISTS style_reference_images`);

    await client.query(`
      DROP INDEX IF EXISTS idx_production_doc_styles_workspace_visible
    `);

    await client.query(`
      ALTER TABLE production_doc_styles
        DROP COLUMN IF EXISTS preferred_cloud_model,
        DROP COLUMN IF EXISTS style_prompt,
        DROP COLUMN IF EXISTS version,
        DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS draft,
        DROP COLUMN IF EXISTS owner_id
    `);
  },
};

export default migration;
