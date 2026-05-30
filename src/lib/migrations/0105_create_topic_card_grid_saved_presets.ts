import type { Migration } from './types';

/**
 * Workspace-scoped saved style presets for the Topic Card Grid format
 * (port-plan Phase 4d). Companion to the Flex Icon Grid
 * `flex_icon_grid_saved_templates` table (migration 0103) but scoped to
 * just the visual style (postProcess + titleBar). A preset is what the
 * Copy / Paste style buttons (port-plan Phase 4a) put on the clipboard —
 * but persisted, named, and reusable across sessions and devices.
 *
 * What a preset stores:
 *   - postProcess: filter / vignette / grain settings
 *   - titleBar: text + position + typography + shadow settings
 *
 * What a preset does NOT store (intentionally):
 *   - grid size, image model, brightness, detail, style preset — those
 *     are video-specific or already persisted as personal defaults in
 *     localStorage. The Style clipboard envelope (Phase 4a) is the
 *     direct precedent: presets are named, persisted versions of that
 *     same payload.
 *
 * Schema choices mirror flex_icon_grid_saved_templates exactly:
 *   - workspace_id NOT NULL with CASCADE on workspaces.
 *   - preset_jsonb stores the postProcess + titleBar object.
 *   - UNIQUE(workspace_id, name) so the picker can prevent dupes
 *     (allows the same preset name in two different workspaces).
 *   - Index on (workspace_id, updated_at DESC) for recency sort.
 */
const migration: Migration = {
  id: '0105_create_topic_card_grid_saved_presets',
  description: 'Create topic_card_grid_saved_presets — workspace-scoped reusable style presets for the Topic Card Grid format',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS topic_card_grid_saved_presets (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        preset_jsonb  JSONB NOT NULL,
        created_by    UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, name)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_topic_card_grid_saved_presets_workspace
        ON topic_card_grid_saved_presets (workspace_id, updated_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS topic_card_grid_saved_presets CASCADE`);
  },
};

export default migration;
