import type { Migration } from './types';

/**
 * Tag every B-roll clip with the production-doc instance it was generated
 * for, so the production-doc page can hydrate `rowVideoClips` from the
 * database on mount instead of relying solely on per-cell localStorage.
 *
 * Closes the Phase 1 gap: when a user opens the doc on a different
 * device, in incognito, or after `localStorage` is cleared, the per-cell
 * `prodoc_broll_v1` map is empty — so the page can't find the clips it
 * already paid for. With this column + the new `?productionDocId=` GET
 * filter on `/api/broll`, the page can sweep the DB for clips tied to
 * the current `historyEntryId` and seed state. See plan
 * `_plans/2026-05-17-broll-doc-id-hydration.md`.
 *
 * `production_doc_id` is `TEXT`, not UUID — `ProductionDocHistoryEntry.id`
 * is a string in the existing code (e.g. `prodoc_<random>`), not a UUID.
 *
 * `NULL` allowed because:
 *   - Existing rows pre-date this column and stay as orphans (the
 *     plan's chosen retrofit policy: leave-as-orphans).
 *   - Docs that haven't been saved to history yet don't have an entry
 *     id; their clips persist with NULL and remain reachable through
 *     the per-cell localStorage path. Plan opted for graceful fallback
 *     over forcing an implicit save on first clip generation.
 *
 * The partial index excludes the legacy NULLs so the new lookup
 * (`WHERE workspace_id = $1 AND production_doc_id = $2`) stays narrow.
 */
const migration: Migration = {
  id: '0072_broll_clips_production_doc_id',
  description: 'Add production_doc_id to broll_clips for cross-device clip hydration',

  async up(client) {
    await client.query(
      `ALTER TABLE IF EXISTS broll_clips ADD COLUMN IF NOT EXISTS production_doc_id TEXT`,
    );
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_broll_clips_production_doc
        ON broll_clips(workspace_id, production_doc_id)
        WHERE production_doc_id IS NOT NULL
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_broll_clips_production_doc`);
    await client.query(`ALTER TABLE IF EXISTS broll_clips DROP COLUMN IF EXISTS production_doc_id`);
  },
};

export default migration;
