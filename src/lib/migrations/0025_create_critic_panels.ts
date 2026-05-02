import type { Migration } from './types';

/**
 * Live Court of Critics — persisted panels + append-only event log.
 *
 * The existing 4-phase script-panel runner (charter → drafts → deliberation
 * → chair) blocks for ~90-120s and persists nothing beyond the final
 * verdict. The "live" upgrade streams events to the client as each phase
 * completes AND persists every event so the courtroom transcript can be
 * replayed on reload (and a client that disconnects mid-run can rejoin).
 *
 * `critic_panels` is the parent row — one per panel run. Status flips
 * running → completed (or failed) once the chair phase finishes (or a
 * fatal error occurs). The final verdict + charter live in JSONB on this
 * row to avoid a JOIN-then-aggregate on every read.
 *
 * `critic_panel_events` is append-only. Sequence numbers are monotonic
 * per-panel so the replay endpoint can serve "everything after N" cheaply.
 * Phase + event_type are CHECK-constrained so a typo in the runner can't
 * silently introduce a phantom phase the UI doesn't know how to render.
 *
 * `source_script_id` ON DELETE SET NULL — a script can be regenerated /
 * deleted while the panel transcript is still useful as the historical
 * artifact ("here's why we said pass-1 didn't ship").
 */
const migration: Migration = {
  id: '0025_create_critic_panels',
  description: 'Live Court of Critics — persisted panel runs + append-only event transcript',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS critic_panels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        source_script_id UUID REFERENCES scripts(id) ON DELETE SET NULL,

        script_text TEXT NOT NULL,
        niche TEXT NOT NULL,
        pass_number INTEGER NOT NULL DEFAULT 1,
        aggressiveness TEXT NOT NULL DEFAULT 'standard',
        model_id TEXT NOT NULL,

        status TEXT NOT NULL DEFAULT 'running',
        error_message TEXT,

        verdict JSONB,
        charter JSONB,

        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT critic_panels_status_chk
          CHECK (status IN ('running','completed','failed')),
        CONSTRAINT critic_panels_aggressiveness_chk
          CHECK (aggressiveness IN ('standard','brutal','nuclear'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panels_workspace
        ON critic_panels(workspace_id, started_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panels_project
        ON critic_panels(project_id) WHERE project_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panels_running
        ON critic_panels(updated_at) WHERE status = 'running'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS critic_panel_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        panel_id UUID NOT NULL REFERENCES critic_panels(id) ON DELETE CASCADE,

        sequence_no INTEGER NOT NULL,
        phase TEXT NOT NULL,
        critic_id TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,

        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT critic_panel_events_phase_chk
          CHECK (phase IN ('panel','charter','draft','deliberation','chair')),
        CONSTRAINT critic_panel_events_type_chk
          CHECK (event_type IN ('start','complete','error')),
        CONSTRAINT critic_panel_events_seq_unique
          UNIQUE (panel_id, sequence_no)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panel_events_panel_seq
        ON critic_panel_events(panel_id, sequence_no)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_critic_panel_events_workspace
        ON critic_panel_events(workspace_id, captured_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS critic_panel_events`);
    await client.query(`DROP TABLE IF EXISTS critic_panels`);
  },
};

export default migration;
