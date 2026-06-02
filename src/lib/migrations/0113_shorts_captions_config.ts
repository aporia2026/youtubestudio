import type { Migration } from './types';

/**
 * Phase 15.11 — caption editor.
 *
 * Adds `shorts.captions_config JSONB` to hold:
 *   - global style: font family, size scale, weight, position, color,
 *     outline, shadow, transform, background pill, entry effect
 *   - per-chunk overrides: text replacement, timing override, hide
 *
 * Default '{}' = no overrides, render matches Phase 5.5 Minimal. The
 * shape is fully optional so future fields (per-word highlighting, etc.)
 * slot in without a migration.
 *
 * Schema choices:
 *   - JSONB (vs new columns per style field) because the shape is
 *     deliberately evolving — the user explicitly asked for "extremely
 *     more robust" controls, so we'll add fields over time. JSONB
 *     means no migrations for each addition.
 *   - No DB-level CHECK constraint — validation lives in the application
 *     layer (`applyCaptionsConfig` clamps / defaults defensively).
 *
 * Down migration drops the column cleanly.
 */
const migration: Migration = {
  id: '0113_shorts_captions_config',
  description: 'shorts.captions_config JSONB for the Phase 15.11 caption editor (style + per-chunk overrides)',

  async up(client) {
    await client.query(
      `ALTER TABLE shorts ADD COLUMN IF NOT EXISTS captions_config JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
  },

  async down(client) {
    await client.query(`ALTER TABLE shorts DROP COLUMN IF EXISTS captions_config`);
  },
};

export default migration;
