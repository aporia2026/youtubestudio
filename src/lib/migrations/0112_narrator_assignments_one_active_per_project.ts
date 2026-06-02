import type { Migration } from './types';

/**
 * Enforce one active narrator assignment per project.
 *
 * Background: `POST /api/narrator/assignments` previously always
 * INSERTed a new row. Re-clicking "Send to narrator" — or the
 * auto-assign deep-link from the script generator — silently created
 * duplicate assignments. The `NarrationTab` UI shows only the most-
 * recently-updated assignment per project, so older rows (and the
 * actual recorded audio attached to them) became invisible to the
 * owner.
 *
 * Fix: a unique partial index on `(project_id) WHERE status IN
 * (<active set>)`. Terminal statuses (`approved`, `completed`) are
 * intentionally excluded so an owner can legitimately start a fresh
 * job after the previous one wraps up.
 *
 * Before installing the index, this migration de-duplicates any
 * existing duplicate sets:
 *
 *   - For each project with >1 active assignment, picks the WINNER
 *     by (take_count DESC, has_full_audio DESC, updated_at DESC,
 *     created_at DESC). The winner is the row most likely to hold
 *     real narration work.
 *   - DELETEs the losers. CASCADE wipes their (empty) sections.
 *   - ABORTs the migration (throws) if any LOSER has take_count > 0
 *     — that's an unsafe auto-merge we won't perform. The build
 *     fails until an operator manually resolves the conflict.
 *
 * Surveyed prod data as of 2026-06-02 shows 3 duplicate sets, all
 * with losers at take_count=0 — fully safe.
 */
const migration: Migration = {
  id: '0112_narrator_assignments_one_active_per_project',
  description: 'Dedupe and enforce one active narrator_assignments row per project',

  async up(client) {
    // 1) Identify duplicate sets.
    //
    // The CTE classifies rows; the SELECT yields one row per (project, candidate-id)
    // with rank=1 marking the winner. We do the deletion in app code (not pure SQL)
    // so we can throw a clear error if a loser carries audio.
    const dupRows = await client.query<{
      project_id: string;
      id: string;
      take_count: number;
      has_full_audio: boolean;
      rank: number;
    }>(
      `WITH active AS (
         SELECT a.id,
                a.project_id,
                a.updated_at,
                a.created_at,
                (a.full_audio_take_id IS NOT NULL) AS has_full_audio,
                (SELECT COUNT(*)::int FROM narrator_takes t
                   JOIN narrator_sections s ON s.id = t.section_id
                  WHERE s.assignment_id = a.id) AS take_count
           FROM narrator_assignments a
          WHERE a.status IN ('assigned','received','recording','submitted','revisions')
       ),
       grouped AS (
         SELECT project_id
           FROM active
          GROUP BY project_id
         HAVING COUNT(*) > 1
       ),
       ranked AS (
         SELECT a.project_id,
                a.id::text AS id,
                a.take_count,
                a.has_full_audio,
                ROW_NUMBER() OVER (
                  PARTITION BY a.project_id
                  ORDER BY a.take_count DESC,
                           a.has_full_audio DESC,
                           a.updated_at DESC,
                           a.created_at DESC
                ) AS rank
           FROM active a
           JOIN grouped g ON g.project_id = a.project_id
       )
       SELECT project_id::text AS project_id, id, take_count, has_full_audio, rank::int AS rank
         FROM ranked
        ORDER BY project_id, rank`,
    );

    // Group rows by project_id so we can log each set as a coherent unit.
    const byProject = new Map<string, { id: string; take_count: number; has_full_audio: boolean; rank: number }[]>();
    for (const r of dupRows.rows) {
      const arr = byProject.get(r.project_id) ?? [];
      arr.push({ id: r.id, take_count: r.take_count, has_full_audio: r.has_full_audio, rank: r.rank });
      byProject.set(r.project_id, arr);
    }

    const loserIdsToDelete: string[] = [];
    for (const [projectId, rows] of byProject.entries()) {
      const winner = rows.find((r) => r.rank === 1);
      const losers = rows.filter((r) => r.rank > 1);
      const unsafeLoser = losers.find((l) => l.take_count > 0);
      if (unsafeLoser) {
        throw new Error(
          `[narrator dedup] Refusing to auto-delete a duplicate assignment that has takes. ` +
          `project_id=${projectId} loser_id=${unsafeLoser.id} loser_take_count=${unsafeLoser.take_count}. ` +
          `Resolve manually (move takes to the winner or archive the loser) and re-run the migration.`,
        );
      }
      // eslint-disable-next-line no-console -- migration-time observability
      console.info(
        `[narrator dedup] project=${projectId} winner=${winner?.id ?? 'n/a'} ` +
          `removing=${losers.map((l) => l.id).join(',')}`,
      );
      for (const l of losers) loserIdsToDelete.push(l.id);
    }

    if (loserIdsToDelete.length > 0) {
      // CASCADE handles narrator_sections (and their takes / comments, which are
      // guaranteed empty by the safety check above).
      await client.query(
        `DELETE FROM narrator_assignments WHERE id = ANY($1::uuid[])`,
        [loserIdsToDelete],
      );
    }

    // 2) Install the unique partial index.
    //
    // Using IF NOT EXISTS so a re-run after a previous partial application is a
    // no-op. The index name is namespaced to make accidental drops obvious in
    // grep output.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS narrator_assignments_one_active_per_project
        ON narrator_assignments (project_id)
        WHERE status IN ('assigned','received','recording','submitted','revisions')
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS narrator_assignments_one_active_per_project`);
    // We do not restore deleted duplicate rows — they were empty by construction.
  },
};

export default migration;
