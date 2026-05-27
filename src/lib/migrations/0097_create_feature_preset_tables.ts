import type { Migration } from './types';

/**
 * Plan: `_plans/2026-05-27-feature-preset-tables-bundle.md`.
 *
 * Refactor pipeline_presets from "half-bundle / half-inline" into a
 * proper bundle of FKs by extracting four inline-stored configs into
 * dedicated per-feature preset tables:
 *
 *   - script_presets       (tone, audience, custom instructions, ...)
 *   - qa_presets           (min score, max iterations, hardening toggles)
 *   - narration_presets    (deadline days, preferred narrator, voice prefs)
 *   - idea_presets         (niche default, focus, video type, ...)
 *
 * Adds four nullable FK columns on pipeline_presets pointing at each.
 * Stage handlers prefer the bundle; they fall back to the existing
 * inline columns when an FK is null. The inline columns are kept for
 * one release cycle as a rollback path and dropped in a follow-up
 * migration.
 *
 * Workspace tenancy: every new table has workspace_id NOT NULL with
 * CASCADE on workspaces (matches the post-0013 pattern). The four new
 * FKs on pipeline_presets are ON DELETE SET NULL so deleting a
 * feature preset doesn't cascade-orphan pipeline_presets — the
 * handler just falls back to inline fields for that feature.
 *
 * Backfill: for each existing pipeline_presets row, this migration
 * creates one feature-preset row per missing FK (named
 * "{pipeline_preset.name} · {feature}" so the user can recognise where
 * it came from in the UI) and points the pipeline_preset's FK at the
 * new row. Idempotent — only inserts when the FK is currently NULL.
 */

interface PipelinePresetForBackfill {
  id: string;
  workspace_id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  idea_context_jsonb: Record<string, unknown> | null;
  script_rules_jsonb: Record<string, unknown> | null;
  target_spoken_words: number | null;
  qa_min_score: string; // numeric → string from pg
  qa_max_iterations: number;
  script_style_preset_id: string | null;
  narration_deadline_days: number;
  script_preset_id: string | null;
  qa_preset_id: string | null;
  narration_preset_id: string | null;
  idea_preset_id: string | null;
}

const migration: Migration = {
  id: '0097_create_feature_preset_tables',
  description: 'Extract script/qa/narration/idea presets into dedicated tables; bundle them on pipeline_presets',

  async up(client) {
    // ─── script_presets ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS script_presets (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        description                 TEXT,
        tone                        TEXT,
        style_note                  TEXT,
        audience                    TEXT,
        target_duration_minutes     INT,
        additional_context          TEXT,
        reference_context           TEXT,
        script_style_preset_id      UUID REFERENCES production_doc_styles(id) ON DELETE SET NULL,
        constraints_jsonb           JSONB,
        created_by                  UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_script_presets_workspace ON script_presets (workspace_id, updated_at DESC)
    `);

    // ─── qa_presets ───────────────────────────────────────────────────
    // pre_check_enabled / generator_v2_enabled are tri-state TEXT
    // ('on' | 'off' | 'inherit'). NULL is treated as 'inherit' at the
    // handler layer — the workspace_qa_settings table is the next
    // level up in the resolver.
    await client.query(`
      CREATE TABLE IF NOT EXISTS qa_presets (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        description                 TEXT,
        min_score                   NUMERIC(5,2) NOT NULL DEFAULT 75 CHECK (min_score BETWEEN 0 AND 100),
        max_iterations              INT NOT NULL DEFAULT 3 CHECK (max_iterations BETWEEN 0 AND 10),
        pre_check_enabled           TEXT CHECK (pre_check_enabled IN ('on', 'off', 'inherit') OR pre_check_enabled IS NULL),
        generator_v2_enabled        TEXT CHECK (generator_v2_enabled IN ('on', 'off', 'inherit') OR generator_v2_enabled IS NULL),
        created_by                  UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_qa_presets_workspace ON qa_presets (workspace_id, updated_at DESC)
    `);

    // ─── narration_presets ────────────────────────────────────────────
    // voice_settings_jsonb is forward-compat — when we wire AI voiceover
    // defaults into the auto-pipeline narration stage, the settings live
    // here (TTS voice id, pitch, speed, etc.).
    await client.query(`
      CREATE TABLE IF NOT EXISTS narration_presets (
        id                                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                               TEXT NOT NULL,
        description                        TEXT,
        deadline_days                      INT NOT NULL DEFAULT 7 CHECK (deadline_days BETWEEN 1 AND 90),
        preferred_narrator_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        voice_settings_jsonb               JSONB,
        created_by                         UUID,
        created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_narration_presets_workspace ON narration_presets (workspace_id, updated_at DESC)
    `);

    // ─── idea_presets ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS idea_presets (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name                        TEXT NOT NULL,
        description                 TEXT,
        niche_default               TEXT,
        ideas_count_default         INT NOT NULL DEFAULT 5 CHECK (ideas_count_default BETWEEN 1 AND 50),
        focus                       TEXT CHECK (focus IN ('trending', 'evergreen', 'controversial', 'beginner', 'mixed') OR focus IS NULL),
        audience                    TEXT,
        video_type                  TEXT,
        reference_context           TEXT,
        reddit_context              TEXT,
        created_by                  UUID,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_idea_presets_workspace ON idea_presets (workspace_id, updated_at DESC)
    `);

    // ─── pipeline_presets: add the four bundle FKs ────────────────────
    await client.query(`
      ALTER TABLE pipeline_presets
        ADD COLUMN IF NOT EXISTS script_preset_id    UUID REFERENCES script_presets(id)    ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS qa_preset_id        UUID REFERENCES qa_presets(id)        ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS narration_preset_id UUID REFERENCES narration_presets(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS idea_preset_id      UUID REFERENCES idea_presets(id)      ON DELETE SET NULL
    `);

    // ─── Backfill ─────────────────────────────────────────────────────
    // Per-row loop in JS so we can use RETURNING + UPDATE without the
    // CTE name-matching gymnastics. Migrations run in a transaction
    // (see `runOne` in src/lib/migrations/index.ts); a failure inside
    // this loop rolls back the whole migration.
    const { rows: pipelinePresets } = await client.query<PipelinePresetForBackfill>(`
      SELECT id::text                          AS id,
             workspace_id::text                AS workspace_id,
             name,
             niche,
             ideas_count_default,
             idea_context_jsonb,
             script_rules_jsonb,
             target_spoken_words,
             qa_min_score::text                AS qa_min_score,
             qa_max_iterations,
             script_style_preset_id::text      AS script_style_preset_id,
             narration_deadline_days,
             script_preset_id::text            AS script_preset_id,
             qa_preset_id::text                AS qa_preset_id,
             narration_preset_id::text         AS narration_preset_id,
             idea_preset_id::text              AS idea_preset_id
        FROM pipeline_presets
    `);

    for (const pp of pipelinePresets) {
      const rules = (pp.script_rules_jsonb ?? {}) as Record<string, unknown>;
      const ideaCtx = (pp.idea_context_jsonb ?? {}) as Record<string, unknown>;

      // script_presets
      if (!pp.script_preset_id) {
        const knownKeys = new Set([
          'tone',
          'style',
          'audience',
          'additionalContext',
          'referenceContext',
          'targetDurationMinutes',
        ]);
        const constraintsLeftover: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rules)) {
          if (!knownKeys.has(k)) constraintsLeftover[k] = v;
        }
        const { rows: ins } = await client.query<{ id: string }>(
          `
          INSERT INTO script_presets
            (workspace_id, name, tone, style_note, audience, target_duration_minutes,
             additional_context, reference_context, script_style_preset_id, constraints_jsonb)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::jsonb)
          RETURNING id::text AS id
          `,
          [
            pp.workspace_id,
            `${pp.name} · script`,
            typeof rules.tone === 'string' ? rules.tone : null,
            typeof rules.style === 'string' ? rules.style : null,
            typeof rules.audience === 'string' ? rules.audience : null,
            typeof rules.targetDurationMinutes === 'number' && Number.isFinite(rules.targetDurationMinutes)
              ? Math.max(1, Math.min(120, Math.floor(rules.targetDurationMinutes as number)))
              : null,
            typeof rules.additionalContext === 'string' ? rules.additionalContext : null,
            typeof rules.referenceContext === 'string' ? rules.referenceContext : null,
            pp.script_style_preset_id,
            Object.keys(constraintsLeftover).length > 0 ? JSON.stringify(constraintsLeftover) : null,
          ],
        );
        await client.query(
          `UPDATE pipeline_presets SET script_preset_id = $1::uuid WHERE id = $2::uuid`,
          [ins[0].id, pp.id],
        );
      }

      // qa_presets
      if (!pp.qa_preset_id) {
        const { rows: ins } = await client.query<{ id: string }>(
          `
          INSERT INTO qa_presets
            (workspace_id, name, min_score, max_iterations)
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING id::text AS id
          `,
          [pp.workspace_id, `${pp.name} · qa`, parseFloat(pp.qa_min_score), pp.qa_max_iterations],
        );
        await client.query(
          `UPDATE pipeline_presets SET qa_preset_id = $1::uuid WHERE id = $2::uuid`,
          [ins[0].id, pp.id],
        );
      }

      // narration_presets
      if (!pp.narration_preset_id) {
        const { rows: ins } = await client.query<{ id: string }>(
          `
          INSERT INTO narration_presets
            (workspace_id, name, deadline_days)
          VALUES ($1::uuid, $2, $3)
          RETURNING id::text AS id
          `,
          [pp.workspace_id, `${pp.name} · narration`, pp.narration_deadline_days],
        );
        await client.query(
          `UPDATE pipeline_presets SET narration_preset_id = $1::uuid WHERE id = $2::uuid`,
          [ins[0].id, pp.id],
        );
      }

      // idea_presets
      if (!pp.idea_preset_id) {
        const focusValue = typeof ideaCtx.focus === 'string' && ['trending', 'evergreen', 'controversial', 'beginner', 'mixed'].includes(ideaCtx.focus as string)
          ? (ideaCtx.focus as string)
          : null;
        const { rows: ins } = await client.query<{ id: string }>(
          `
          INSERT INTO idea_presets
            (workspace_id, name, niche_default, ideas_count_default, focus, audience,
             video_type, reference_context, reddit_context)
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id::text AS id
          `,
          [
            pp.workspace_id,
            `${pp.name} · idea`,
            pp.niche,
            pp.ideas_count_default,
            focusValue,
            typeof ideaCtx.audience === 'string' ? ideaCtx.audience : null,
            typeof ideaCtx.videoType === 'string' ? ideaCtx.videoType : null,
            typeof ideaCtx.referenceContext === 'string' ? ideaCtx.referenceContext : null,
            typeof ideaCtx.redditContext === 'string' ? ideaCtx.redditContext : null,
          ],
        );
        await client.query(
          `UPDATE pipeline_presets SET idea_preset_id = $1::uuid WHERE id = $2::uuid`,
          [ins[0].id, pp.id],
        );
      }
    }
  },

  async down(client) {
    // Drop the FK columns first (their constraints reference the new
    // tables), then the tables themselves.
    await client.query(`
      ALTER TABLE pipeline_presets
        DROP COLUMN IF EXISTS script_preset_id,
        DROP COLUMN IF EXISTS qa_preset_id,
        DROP COLUMN IF EXISTS narration_preset_id,
        DROP COLUMN IF EXISTS idea_preset_id
    `);
    await client.query(`DROP TABLE IF EXISTS script_presets CASCADE`);
    await client.query(`DROP TABLE IF EXISTS qa_presets CASCADE`);
    await client.query(`DROP TABLE IF EXISTS narration_presets CASCADE`);
    await client.query(`DROP TABLE IF EXISTS idea_presets CASCADE`);
  },
};

export default migration;
