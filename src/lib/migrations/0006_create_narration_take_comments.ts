import type { Migration } from './types';

/**
 * Frame.io-style timestamped comments on narrator audio takes.
 *
 * Mirrors the `review_comments` shape (point + range timestamps, threading
 * via parent_id, resolve flow, fix-note linkage) but is scoped per-take so
 * each upload gets its own threaded review surface — point comments anchor
 * to a moment in the audio, range comments span a region.
 *
 * Independent of `narrator_comments` (which stays as the flat per-section
 * chat). The two tables intentionally don't share a row format because:
 *  - take comments need timestamps, narrator chat doesn't
 *  - take comments cascade with the take, chat cascades with the assignment
 *  - migrating the existing chat into this table would lose the section-level
 *    chat surface that NarratorPortal already exposes
 *
 * Author role lives on each comment (`owner` | `narrator`) so the UI can
 * colour-code threads without joining back to share_token + collaborators
 * for every render.
 */
const migration: Migration = {
  id: '0006_create_narration_take_comments',
  description: 'Per-take threaded timestamped comments on narrator audio',

  async up(client) {
    // Belt-and-braces: narrator_takes is currently created lazily by
    // ensureNarratorSchema(). On a fresh DB the FK below would fail before
    // that helper runs, so create the minimum shell here.
    //
    // The shell MUST mirror the real schema's section_id constraints
    // (NOT NULL + FK to narrator_sections ON DELETE CASCADE). Otherwise
    // ensureNarratorSchema's `CREATE TABLE IF NOT EXISTS narrator_takes`
    // would no-op against this shell, leaving narrator_takes with a
    // nullable, FK-less section_id forever — orphan takes become
    // insertable, and section deletes don't cascade to their takes.
    //
    // narrator_sections is also pre-created (without FK to narrator_assignments
    // because that table may not exist yet in this migration's window).
    // ensureNarratorSchema's later CREATE TABLE IF NOT EXISTS will no-op,
    // and the assignment-FK is then added via an idempotent ALTER there.
    await client.query(`
      CREATE TABLE IF NOT EXISTS narrator_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        assignment_id UUID,
        section_number INTEGER NOT NULL,
        label TEXT,
        script_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS narrator_takes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        section_id UUID NOT NULL REFERENCES narrator_sections(id) ON DELETE CASCADE,
        take_number INTEGER NOT NULL,
        audio_url TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS narration_take_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        take_id UUID NOT NULL REFERENCES narrator_takes(id) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        end_timestamp_ms INTEGER,
        text TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_color TEXT NOT NULL DEFAULT '#7c3aed',
        author_role TEXT NOT NULL CHECK (author_role IN ('owner','narrator')),
        resolved BOOLEAN NOT NULL DEFAULT false,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        parent_id UUID REFERENCES narration_take_comments(id) ON DELETE CASCADE,
        fix_for_comment_id UUID REFERENCES narration_take_comments(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_narration_take_comments_take
        ON narration_take_comments(take_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_narration_take_comments_parent
        ON narration_take_comments(parent_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS narration_take_comments`);
  },
};

export default migration;
