import type { Migration } from './types';

/**
 * Editor telemetry — Phase 0 of `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * Single polymorphic event table for the shot-graph editor effort.
 * Before any editor code ships we collect 2 weeks of data on whether
 * creators actually export to CapCut after a render. Two probes feed
 * this table:
 *
 *   `render_clicked`        — fired on the production-doc page when
 *                             the creator triggers the final render.
 *                             Payload: { shot_count, voiceover_seconds,
 *                             has_overlays, has_music }.
 *
 *   `external_edit_intent`  — fired from the post-render survey when
 *                             the creator picks CapCut / Premiere /
 *                             Other. Payload: { destination, project_id }.
 *
 *   `stayed_here`           — fired when the creator dismisses the
 *                             post-render survey without picking an
 *                             external editor (implicit "I'll finish
 *                             this here").
 *
 * The schema is intentionally minimal. Events are polymorphic; the
 * `event` column is TEXT so the editor itself can add new event names
 * later (`editor_open`, `edit_applied`, `otio_exported`, etc.) without
 * a schema migration.
 *
 * Workspace scope is mandatory for tenancy hygiene (matches every
 * post-0011 table). `collaborator_id` is nullable on the off chance
 * the event fires before session resolution; in practice the API
 * route requires auth so it will always be present.
 *
 * Retention: this is product-analytics data, not user content. We do
 * NOT log raw prompts, transcripts, or PII into `payload_jsonb` —
 * just counters and discriminators that survive a casual log dump.
 * A 90-day retention sweep can be added later if volume warrants;
 * Phase 0 expects single-digit rows-per-creator-per-day.
 */
const migration: Migration = {
  id: '0078_create_editor_telemetry',
  description: 'Editor telemetry (Phase 0 of shot-graph editor) — render_clicked + external_edit_intent + stayed_here probes',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS editor_telemetry (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL,
        project_id      UUID,
        event           TEXT NOT NULL,
        payload_jsonb   JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Hot path: "show me this workspace's recent telemetry, newest first."
    // The Phase 0 readout queries this index every time.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_editor_telemetry_workspace_created
        ON editor_telemetry (workspace_id, created_at DESC)
    `);

    // Filter-by-event during analysis: "how many `external_edit_intent`
    // events did we see last week, grouped by destination?"
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_editor_telemetry_event
        ON editor_telemetry (event)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS editor_telemetry`);
  },
};

export default migration;
