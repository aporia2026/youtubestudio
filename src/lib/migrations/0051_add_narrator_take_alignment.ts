import type { Migration } from './types';

/**
 * Add forced-alignment columns to narrator_takes for the karaoke teleprompter
 * feature on the Narration tab.
 *
 * When a narrator uploads the full-audio take, we send the audio + the known
 * script to ElevenLabs Forced Alignment and store the per-word + per-character
 * timing JSON here. The Narration tab's new synced player reads `alignment_json`
 * to highlight the active word in time with playback (vs. the prior approach
 * which guessed by spreading words evenly across the duration).
 *
 * `alignment_status` is the lifecycle flag:
 *   - pending : take exists, alignment not yet attempted (default for new rows
 *               and re-uploads — see narrator-db.ts where full_audio_take_id is
 *               updated).
 *   - running : alignment in flight; used to guard against double-trigger from
 *               two browser tabs / a manual retry racing the auto-trigger.
 *   - ready   : alignment_json is populated and trustworthy.
 *   - failed  : alignment_error explains why; UI shows a "retry" affordance.
 *
 * `alignment_error` is the short, user-safe failure reason. Never store stack
 * traces or signed URLs here — the value is rendered straight to the reviewer.
 *
 * `alignment_started_at` records when the orchestrator claimed the 'running'
 * state. Used to reclaim stale 'running' rows (where the function instance
 * died mid-call without writing 'failed' or 'ready') after a 5-minute
 * timeout — without it, an orphan run would block all retries forever.
 *
 * Additive only. Existing rows default to status='pending' so a subsequent
 * align run will treat the historical full-audio takes as eligible (the
 * trigger from the upload route only fires for new uploads; older takes can
 * be aligned manually via the retry button).
 */
const migration: Migration = {
  id: '0051_add_narrator_take_alignment',
  description: 'Add forced-alignment columns (alignment_json, alignment_status, alignment_error) to narrator_takes',

  async up(client) {
    await client.query(`
      ALTER TABLE narrator_takes
        ADD COLUMN IF NOT EXISTS alignment_json JSONB,
        ADD COLUMN IF NOT EXISTS alignment_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (alignment_status IN ('pending','running','ready','failed')),
        ADD COLUMN IF NOT EXISTS alignment_error TEXT,
        ADD COLUMN IF NOT EXISTS alignment_started_at TIMESTAMPTZ
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE narrator_takes
        DROP COLUMN IF EXISTS alignment_started_at,
        DROP COLUMN IF EXISTS alignment_error,
        DROP COLUMN IF EXISTS alignment_status,
        DROP COLUMN IF EXISTS alignment_json
    `);
  },
};

export default migration;
