import type { Migration } from './types';

/**
 * Per-language dubbed voiceover cache. One row per (script, target_language)
 * — the workspace + voice + audio_url + status all live alongside.
 *
 * Status lifecycle:
 *   translating → generating → ready
 *                              ↘ failed (with error_message)
 *
 * Upserted by the dubbing orchestrator: re-running a dub for the same
 * (script, target_language) overwrites the prior row in place rather than
 * piling up history. If the user wants version-tracked dubs, that's a
 * separate enhancement.
 *
 * `voice_id` is a free-text ElevenLabs voice id (uppercase 20-char hex
 * typical). We don't FK it because ElevenLabs is external; we just record
 * which voice generated this audio for traceability.
 *
 * `audio_url` is the R2/Vercel Blob URL once the audio is uploaded. Nullable
 * during translating/generating; populated when status = 'ready'.
 */
const migration: Migration = {
  id: '0020_create_dubbed_voiceovers',
  description: 'Per-language dubbed voiceover cache (script_id × target_language)',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS dubbed_voiceovers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        script_id UUID NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,

        source_language TEXT NOT NULL DEFAULT 'en',
        target_language TEXT NOT NULL,

        translated_script TEXT,
        voice_id TEXT NOT NULL,
        audio_url TEXT,
        blob_pathname TEXT,
        duration_seconds INTEGER,
        char_count INTEGER,

        status TEXT NOT NULL CHECK (
          status IN ('translating', 'generating', 'ready', 'failed')
        ),
        error_message TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,

        CONSTRAINT dubbed_voiceovers_script_lang_unique
          UNIQUE (script_id, target_language)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dubbed_voiceovers_workspace
        ON dubbed_voiceovers(workspace_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dubbed_voiceovers_script
        ON dubbed_voiceovers(script_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dubbed_voiceovers_project
        ON dubbed_voiceovers(project_id) WHERE project_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS dubbed_voiceovers`);
  },
};

export default migration;
