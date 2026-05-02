import type { Migration } from './types';

/**
 * Per-shot AI-generated B-roll clips for the Production Doc.
 *
 * The Production Doc itself is in-memory only — rows are regenerated each
 * session. B-roll clips, however, are slow + expensive to render (Veo 3 /
 * Sora 2 take 1-5 minutes and the user pays per clip), so they MUST persist
 * across reloads. We therefore key clips off the script (which IS persisted)
 * plus an opaque `row_signature` the client computes from the row's stable
 * fields (timecode + visual_description). When the doc is regenerated the
 * signature usually still matches and the clip rehydrates onto the new row;
 * if it doesn't, the clip remains in the project's library and the user can
 * reattach manually.
 *
 * Generation is asynchronous: provider task ids are stored in `task_id` and
 * polled by GET /api/broll/[id]. Status drives the UI:
 *   pending     — row created, task not yet submitted (transient)
 *   generating  — Kie has the job, polling for state
 *   ready       — video_url filled in, clip is playable
 *   failed      — error_message populated, user can retry
 *
 * `source_script_id` ON DELETE CASCADE: if the user deletes the script the
 * clips are orphaned anyway (their prompts referenced row contents that no
 * longer exist), so we may as well reclaim the rows + Blob storage.
 */
const migration: Migration = {
  id: '0023_create_broll_clips',
  description: 'Per-shot AI-generated B-roll clips (Veo 3 / Sora 2 via Kie.ai) for the Production Doc',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS broll_clips (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        source_script_id UUID REFERENCES scripts(id) ON DELETE CASCADE,

        row_signature TEXT,
        row_index INTEGER,

        prompt TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'kie',
        aspect_ratio TEXT NOT NULL DEFAULT '16:9',
        duration_seconds INTEGER,

        status TEXT NOT NULL DEFAULT 'generating',
        task_id TEXT,
        error_message TEXT,

        video_url TEXT,
        blob_pathname TEXT,
        thumbnail_url TEXT,
        width INTEGER,
        height INTEGER,

        generation_params JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,

        CONSTRAINT broll_clips_status_chk
          CHECK (status IN ('pending','generating','ready','failed'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_broll_clips_workspace
        ON broll_clips(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_broll_clips_script
        ON broll_clips(source_script_id) WHERE source_script_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_broll_clips_project
        ON broll_clips(project_id) WHERE project_id IS NOT NULL
    `);
    // Pending/generating-only index — the poller scans this to find jobs that
    // need a status check. Keeps the scan O(in-flight) regardless of how many
    // historical clips the workspace has accumulated.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_broll_clips_inflight
        ON broll_clips(updated_at) WHERE status IN ('pending','generating')
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS broll_clips`);
  },
};

export default migration;
