import type { Migration } from './types';

/**
 * Persisted Shorts content-QA result. Lets a short row carry the last
 * QA run (composite score + per-dimension breakdown + critical issues +
 * fact-check verdicts) so re-opening the editor's QA tab shows the
 * previous result without re-spending on the AI grader.
 *
 *   qa_result  — full JSONB payload (see ShortsContentQaResult in
 *                src/lib/shorts-content-qa.ts). Schema lives in code,
 *                not the DB, so additive shape changes don't need a
 *                migration.
 *   qa_score   — 0..100 composite, denormalised onto its own column so
 *                the editor tab badge + list views can sort/filter
 *                without parsing JSONB.
 *   qa_run_at  — wall-clock timestamp of the most recent run. Drives
 *                the "last run X minutes ago" pill + the per-short
 *                cooldown that stops the Re-run button from burning
 *                Brave + LLM credits on mash-clicks.
 *
 * Partial index on (workspace_id, qa_score) so workspace-scoped listings
 * that filter on "QA below threshold" stay cheap as the table grows.
 */
const migration: Migration = {
  id: '0120_add_shorts_qa_result',
  description: 'Persist Shorts content-QA results (composite + dimensions + fact-check) on the shorts row',

  async up(client) {
    await client.query(`
      ALTER TABLE shorts
        ADD COLUMN IF NOT EXISTS qa_result JSONB,
        ADD COLUMN IF NOT EXISTS qa_score INTEGER,
        ADD COLUMN IF NOT EXISTS qa_run_at TIMESTAMPTZ
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_shorts_qa_score
        ON shorts(workspace_id, qa_score) WHERE qa_score IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_shorts_qa_score`);
    await client.query(`
      ALTER TABLE shorts
        DROP COLUMN IF EXISTS qa_result,
        DROP COLUMN IF EXISTS qa_score,
        DROP COLUMN IF EXISTS qa_run_at
    `);
  },
};

export default migration;
