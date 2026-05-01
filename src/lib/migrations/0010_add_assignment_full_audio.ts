import type { Migration } from './types';

/**
 * Add columns to narrator_assignments for "single-file" narration uploads —
 * the narrator drops one audio that covers the whole script instead of
 * uploading one take per section. The owner can then comment on it via the
 * standard TakeReview surface.
 *
 * The full audio is persisted as a synthetic "section 0" narrator_take so
 * the existing review/comment plumbing works unchanged. These columns just
 * cache the take id + url for fast access without the section join.
 */
const migration: Migration = {
  id: '0010_add_assignment_full_audio',
  description: 'Add full-audio columns to narrator_assignments for whole-script uploads',

  async up(client) {
    await client.query(`
      ALTER TABLE narrator_assignments
        ADD COLUMN IF NOT EXISTS full_audio_take_id UUID,
        ADD COLUMN IF NOT EXISTS full_audio_url TEXT,
        ADD COLUMN IF NOT EXISTS full_audio_r2_key TEXT,
        ADD COLUMN IF NOT EXISTS full_audio_duration_seconds NUMERIC
    `);
  },

  async down(client) {
    await client.query(`
      ALTER TABLE narrator_assignments
        DROP COLUMN IF EXISTS full_audio_take_id,
        DROP COLUMN IF EXISTS full_audio_url,
        DROP COLUMN IF EXISTS full_audio_r2_key,
        DROP COLUMN IF EXISTS full_audio_duration_seconds
    `);
  },
};

export default migration;
