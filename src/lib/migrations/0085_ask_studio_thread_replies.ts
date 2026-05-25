import type { Migration } from './types';

/**
 * Ask Studio threads — let users reply within a question card and have
 * the model see the full prior conversation.
 *
 * `parent_id` points at the immediate parent turn (linked list, not a flat
 * thread_id) so we never need a synthesized "thread root" column. Walking
 * to the root is one recursive CTE; the cost is bounded by the per-thread
 * turn count which stays small in practice. Adding a flat thread_id later
 * is a non-blocking optimisation if traffic warrants it.
 *
 * `ON DELETE CASCADE` so deleting a root turn from history also cleans up
 * the thread — matches what the UI delete button already implies.
 *
 * Partial index because root rows (parent_id IS NULL) dominate the table
 * and don't need to be in the parent_id index. We always query "give me
 * the rows that hang off this parent" which is exactly what the partial
 * index supports cheaply.
 */
const migration: Migration = {
  id: '0085_ask_studio_thread_replies',
  description: 'Add parent_id to ask_studio_questions so users can reply within a thread',

  async up(client) {
    await client.query(`
      ALTER TABLE ask_studio_questions
        ADD COLUMN IF NOT EXISTS parent_id UUID
        REFERENCES ask_studio_questions(id) ON DELETE CASCADE
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ask_studio_questions_parent_id
        ON ask_studio_questions(parent_id)
        WHERE parent_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_ask_studio_questions_parent_id`);
    await client.query(`ALTER TABLE ask_studio_questions DROP COLUMN IF EXISTS parent_id`);
  },
};

export default migration;
