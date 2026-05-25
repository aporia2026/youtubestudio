import type { Migration } from './types';

/**
 * Add `tts_settings JSONB DEFAULT '{}'` to workspaces. Holds the
 * per-workspace TTS preferences introduced in the 2026-05-25 Google
 * TTS provider migration — see
 * `_plans/2026-05-25-google-tts-voiceover-provider.md`.
 *
 * Schema (kept in JSONB so future settings land without a new column):
 *
 *   {
 *     defaultProvider?:     'elevenlabs' | 'google',
 *     defaultVoiceId?:      string,         // provider-native id
 *     defaultVoiceProvider?:'elevenlabs' | 'google',
 *     defaultLanguageCode?: string,         // BCP-47
 *     defaultTier?:         VoiceTier,
 *     allowStudioTier?:     boolean,        // gates Google Studio $160/1M
 *     enabledProviders?:    ('elevenlabs' | 'google')[]  // NDA workspaces
 *   }
 *
 * Reads default to {} so brand-new workspaces and pre-migration rows
 * both behave the same way: nothing configured → caller falls back to
 * sensible defaults (ElevenLabs Multilingual v2 / Chirp 3 HD as the
 * picker default, Studio hidden, both providers enabled).
 *
 * Why JSONB rather than a column per setting:
 *   - Future-proof: adding `showProviderInPicker` or
 *     `studioMonthlyCapUsd` later doesn't require another migration.
 *   - Reads are a single column on a row we already select for auth.
 *   - The API layer validates the JSON shape before write so the DB
 *     never holds invalid data even though Postgres won't enforce it.
 */
const migration: Migration = {
  id: '0089_add_workspace_tts_settings',
  description: 'Add tts_settings JSONB column to workspaces (default {})',

  async up(client) {
    await client.query(`
      ALTER TABLE workspaces
        ADD COLUMN IF NOT EXISTS tts_settings JSONB NOT NULL DEFAULT '{}'::jsonb
    `);
  },

  async down(client) {
    await client.query(`ALTER TABLE workspaces DROP COLUMN IF EXISTS tts_settings`);
  },
};

export default migration;
