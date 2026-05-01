import type { Migration } from './types';

/**
 * 1:1 chat between the workspace owner and each collaborator (narrators,
 * editors, reviewers, …). Thread is implicit — derived from the
 * `(from_collaborator_id, to_collaborator_id)` pair, sorted by created_at.
 *
 * Why a single `messages` table and not a separate `threads` table:
 *  - Thread metadata (last message, unread count) is cheap to compute
 *    on demand from the message rows — there are at most a few hundred
 *    messages per (owner, collaborator) pair.
 *  - Avoids the orphan-thread problem when one party is deleted; the
 *    cascading FK on collaborators handles cleanup uniformly.
 *
 * `read_at` is per-message: any message the recipient hasn't seen counts
 * toward their unread badge. The recipient PATCHes the thread to mark
 * everything addressed-to-them as read in one shot.
 *
 * `workspace_id` is filled by the application layer (post-0011) so the
 * tenancy rollout in 0012/0013 has nothing to backfill — but we still
 * register it in `_workspace_scoped_tables` so the NOT NULL pass in
 * 0013 enforces it once new rows start carrying it.
 */
const migration: Migration = {
  id: '0017_create_messages',
  description: '1:1 chat between owner and collaborators',

  async up(client) {
    // collaborators is the unified user table — both ends of every chat
    // resolve to a row here. ON DELETE CASCADE wipes a deleted user's
    // messages so we don't leave dangling halves of a conversation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID,
        from_collaborator_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        to_collaborator_id UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Inbox query: "unread messages addressed to me". Partial index keeps
    // it small even when a project has thousands of historic read messages.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_to_unread
        ON messages(to_collaborator_id) WHERE read_at IS NULL
    `);
    // Thread queries hit one of these two indexes depending on which side
    // of the pair we're scoping by. Both index `created_at DESC` so the
    // chat panel can render newest-first or chronologically without a sort.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_pair_a
        ON messages(from_collaborator_id, to_collaborator_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_pair_b
        ON messages(to_collaborator_id, from_collaborator_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS messages`);
  },
};

export default migration;
