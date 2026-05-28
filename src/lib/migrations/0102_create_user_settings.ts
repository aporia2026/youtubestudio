import type { Migration } from './types';

/**
 * Per-user, cross-machine settings sync table.
 *
 * Phase 3.1 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md) moves the user's UI
 * preferences out of `localStorage` (per-browser, lost on device
 * switch, lost on incognito) into a server-side table that the app
 * loads on mount and writes through `mutate()` (Phase 1.2).
 *
 * Today's localStorage-only keys that this table will hold:
 *   - `prodoc_image_model`         (image model picker default)
 *   - `prodoc_overlays_disabled_pref`
 *   - `video_brand_kit`            (brand kit JSON)
 *   - editor settings from src/lib/editor/settings.ts (zoom level,
 *     show thumbnails, auto-regen captions, playback rate, narration
 *     strip visibility, minimap, etc.)
 *   - thumbnails draft state
 *
 * Schema choices:
 *
 *   - `(user_id, key)` composite PK. One row per (user, setting key).
 *     This matches the access pattern — the UI reads a specific key
 *     or loads all keys for the user; never "all values of key X
 *     across users."
 *
 *   - `user_id UUID REFERENCES collaborators(id) ON DELETE CASCADE`.
 *     Settings are personal data; cascade-delete on account removal.
 *
 *   - `value JSONB NOT NULL`. Free-form so the same table holds a
 *     boolean toggle (`{"value": true}`) next to a complex object
 *     (the full brand kit). Wrapping primitives in an object keeps
 *     the column type uniform without forcing every read site to
 *     branch on `typeof`.
 *
 *   - `updated_at TIMESTAMPTZ`. Last-write-wins conflict resolution
 *     across machines: when two devices write the same key offline
 *     then drain their outboxes, the row with the later `updated_at`
 *     wins. The app reads it on mount; no CRDT, no merge logic. This
 *     is the right call for this app's use case (single user, no
 *     concurrent editing of settings UI) — see the LLM Council
 *     verdict in the plan.
 *
 *   - No `workspace_id` column. Settings in scope here are per-USER
 *     preferences (image model default, editor zoom level), not
 *     per-workspace policy. Workspace-scoped settings already live
 *     in `workspaces.tts_settings` (migration 0089) and that pattern
 *     should be reused for any future workspace-level controls.
 *
 *   - No `value_schema_version` column. The plan calls for the
 *     application layer to validate JSON shape before write, and
 *     migrations to update existing rows in place. Adding a version
 *     column now would be premature — we can add it via ALTER TABLE
 *     once we hit a setting whose shape genuinely needs versioning.
 *
 * Indexes:
 *
 *   - PK on `(user_id, key)` covers the dominant read pattern
 *     ("load setting K for user U") and the write path
 *     ("upsert K for U").
 *
 *   - `(user_id)` for the "load all settings for this user" GET
 *     used on app mount. The PK index already serves this as a
 *     prefix scan, but the explicit single-column index keeps the
 *     planner from choosing a more expensive sort for the
 *     `ORDER BY key` variant the load query may use.
 *
 * Security:
 *   - This table will eventually hold sensitive settings (per Phase
 *     3.1: Perplexity API key, ElevenLabs key currently in
 *     localStorage). Those will live behind app-level encryption
 *     (pgcrypto-based, key from env) BEFORE being moved here. This
 *     migration creates the table; the encryption layer is a Phase
 *     3.1 work item, gated on user decision per the plan's open
 *     question.
 *
 * Not in this migration:
 *   - No automatic backfill from existing `localStorage` values —
 *     that happens client-side on first load when the GET returns
 *     no rows for the user (the bootstrap copies known localStorage
 *     keys up, then app reads from the table going forward).
 */
const migration: Migration = {
  id: '0102_create_user_settings',
  description: 'Per-user cross-machine settings sync table — replaces localStorage-only prefs',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id     UUID NOT NULL REFERENCES collaborators(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value       JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      )
    `);

    // "Load all settings for this user" on app mount.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_settings_user
        ON user_settings(user_id)
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_user_settings_user`);
    await client.query(`DROP TABLE IF EXISTS user_settings`);
  },
};

export default migration;
