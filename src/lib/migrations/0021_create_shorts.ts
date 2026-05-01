import type { Migration } from './types';

/**
 * 60-second vertical Shorts derived from a long-form script.
 *
 * One row per extraction — the same long script can spawn multiple Shorts
 * (different angles, different hooks). A Short carries:
 *   - the extracted script text + structural breakouts (hook, payoff)
 *   - optional voiceover (URL + duration + voice id) — generated on demand
 *     via the existing ElevenLabs lib
 *   - the source long script id for traceability
 *
 * `source_script_id` uses ON DELETE SET NULL: deleting the long script
 * shouldn't wipe the Short — it's a derived asset and the user may have
 * already published the Short elsewhere.
 *
 * Status is implicit from the audio fields: short_script alone = "extracted",
 * + voiceover_audio_url = "voiceover ready". Render output (Remotion 1080×1920)
 * lands in `rendered_video_url` once Phase 3 PR #2's render path ships.
 */
const migration: Migration = {
  id: '0021_create_shorts',
  description: 'Vertical Shorts derived from long-form scripts (extraction + voiceover)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS shorts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        source_script_id UUID REFERENCES scripts(id) ON DELETE SET NULL,

        title TEXT,
        short_script TEXT NOT NULL,
        hook TEXT,
        payoff TEXT,
        word_count INTEGER,
        estimated_duration_seconds INTEGER,

        voiceover_audio_url TEXT,
        voiceover_blob_pathname TEXT,
        voiceover_voice_id TEXT,
        voiceover_duration_seconds INTEGER,

        rendered_video_url TEXT,

        ai_model TEXT,
        generation_params JSONB NOT NULL DEFAULT '{}'::jsonb,
        notes TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_workspace
        ON shorts(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_source_script
        ON shorts(source_script_id) WHERE source_script_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_project
        ON shorts(project_id) WHERE project_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS shorts`);
  },
};

export default migration;
