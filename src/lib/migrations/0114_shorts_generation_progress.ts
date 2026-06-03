import type { Migration } from './types';

/**
 * Phase 15.13 — live progress for the Doodle / Paint asset pipeline.
 *
 * Adds `shorts.generation_progress JSONB` so the asset pipeline can
 * write per-step state mid-flight (planning → base → variant N/M →
 * done | error). The editor polls the row every ~2s while a job is
 * in flight and renders a progress strip — replacing the silent
 * "polling every 12s" pill with real visibility into what's running.
 *
 * Shape (see `GenerationProgressState` in `shorts-types.ts`):
 *   { job_id, phase, current?, total?, label, started_at, updated_at,
 *     error_message?, last_log? }
 *
 * Default '{}' = no job in flight. The application layer (`progress-ops.ts`)
 * defensively defaults missing keys so future fields can land without
 * a migration.
 *
 * Down migration drops the column cleanly.
 */
const migration: Migration = {
  id: '0114_shorts_generation_progress',
  description: 'shorts.generation_progress JSONB for live progress visibility on the asset pipeline (Phase 15.13)',

  async up(client) {
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS generation_progress JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS generation_progress`);
  },
};

export default migration;
