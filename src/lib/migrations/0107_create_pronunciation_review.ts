import type { Migration } from './types';

/**
 * Pronunciation review tables for the Narration tab.
 *
 * Sits alongside the existing forced-alignment columns added by migration
 * 0051. Where alignment captures word-level timestamps for the karaoke
 * teleprompter, pronunciation review captures *deviations* from the
 * script — substitutions, omissions, insertions, and mispronunciations
 * of proper nouns / technical terms.
 *
 * Two surfaces added:
 *
 *   1. Status columns on `narrator_takes` — mirror the alignment lifecycle
 *      shape so the polling UI can re-use the same patterns.
 *   2. A separate `pronunciation_flags` table — each flag is a discrete
 *      entity with state ('pending' / 'accepted' / 'dismissed') that
 *      needs indexing and per-row updates. Flags don't fit JSONB.
 *
 * Whisper's raw transcription is cached on the take row
 * (`pronunciation_review_whisper_json`) so the Gemini judge step can run
 * (and re-run after a tuning change) without re-paying the Whisper bill.
 *
 * Status semantics:
 *   - none      : never run for this take (default for existing rows and
 *                 new uploads — pronunciation review is opt-in per the
 *                 manual-button design; see _plans/2026-06-01-pronunciation-review.md).
 *   - pending   : user clicked the button, orchestrator hasn't claimed yet.
 *   - running   : claim succeeded, in flight.
 *   - ready     : Whisper + judge complete, flags persisted.
 *   - failed    : pronunciation_review_error explains why.
 *   - cancelled : user hit cancel before completion.
 *
 * Additive only. Existing narrator_takes rows default to 'none' so the
 * polling UI knows to show the "Check pronunciation" button instead of a
 * "review in progress" spinner.
 */
const migration: Migration = {
  id: '0107_create_pronunciation_review',
  description: 'Add pronunciation review columns to narrator_takes + create pronunciation_flags table',

  async up(client) {
    await client.query(`
      ALTER TABLE narrator_takes
        ADD COLUMN IF NOT EXISTS pronunciation_review_status TEXT NOT NULL DEFAULT 'none'
          CHECK (pronunciation_review_status IN ('none','pending','running','ready','failed','cancelled')),
        ADD COLUMN IF NOT EXISTS pronunciation_review_error TEXT,
        ADD COLUMN IF NOT EXISTS pronunciation_review_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS pronunciation_review_cost_usd NUMERIC,
        ADD COLUMN IF NOT EXISTS pronunciation_review_whisper_json JSONB
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pronunciation_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        take_id UUID NOT NULL REFERENCES narrator_takes(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL,
        word_index INTEGER NOT NULL,
        start_sec NUMERIC NOT NULL,
        end_sec NUMERIC NOT NULL,
        category TEXT NOT NULL
          CHECK (category IN ('script_deviation','mispronunciation','omission','insertion')),
        confidence NUMERIC NOT NULL
          CHECK (confidence >= 0 AND confidence <= 1),
        ai_explanation TEXT NOT NULL,
        suggested_comment TEXT NOT NULL,
        user_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (user_status IN ('pending','accepted','dismissed')),
        user_comment TEXT,
        comment_id UUID REFERENCES narration_take_comments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pronunciation_flags_take
        ON pronunciation_flags(take_id, start_sec)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pronunciation_flags_workspace
        ON pronunciation_flags(workspace_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS pronunciation_flags`);
    await client.query(`
      ALTER TABLE narrator_takes
        DROP COLUMN IF EXISTS pronunciation_review_whisper_json,
        DROP COLUMN IF EXISTS pronunciation_review_cost_usd,
        DROP COLUMN IF EXISTS pronunciation_review_started_at,
        DROP COLUMN IF EXISTS pronunciation_review_error,
        DROP COLUMN IF EXISTS pronunciation_review_status
    `);
  },
};

export default migration;
