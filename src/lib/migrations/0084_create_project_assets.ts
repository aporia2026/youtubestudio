import type { Migration } from './types';

/**
 * Per-row asset references (image / overlay / clip URLs) for editor
 * projects — extracted OUT of `user_history.payload` JSONB into a
 * dedicated table so the payload size doesn't grow with shot count
 * and per-shot URL strings.
 *
 * Why this exists (2026-05-24):
 *   The editor's per-row asset maps used to live inline on the
 *   payload as `rowImages: Record<number, string>` (plus
 *   `rowOverlays` and `rowVideoClips`). On large projects (184
 *   shots × ~500 byte presigned R2 URLs + overlay/clip metadata),
 *   the payload approaches and exceeds the `MAX_PAYLOAD_BYTES`
 *   cap on both the editor PATCH AND the atomic `row-asset`
 *   merge endpoint. The user's NotPetya project hit 413 "Payload
 *   would exceed size limit after merge" on every image upload —
 *   confirmed via console log on 2026-05-24. The 2 MB → 10 MB
 *   band-aid in commit 030e6ff unblocks the immediate work; this
 *   table eliminates the cap class entirely. See
 *   `_plans/2026-05-24-project-assets-extraction.md`.
 *
 * Schema choices:
 *   - Single table with a `slot` discriminator instead of one
 *     table per slot — three tables would just be three copies
 *     of the same schema, and the editor's read code already
 *     branches on slot.
 *   - `data` JSONB carries the slot's value shape:
 *       image   → string URL
 *       overlay → { status, url? }
 *       clip    → { status, videoUrl?, durationSeconds?, brollClipId? }
 *     Keeps the row narrow and matches what the editor expects
 *     in `payload.rowImages[i]` / `payload.rowOverlays[i]` /
 *     `payload.rowVideoClips[i]` so the GET assembly is a 1-to-1
 *     copy with no shape transformation.
 *   - FK to `user_history(id) ON DELETE CASCADE` so deleting a
 *     project automatically cleans up its assets — no orphans,
 *     no separate cleanup job.
 *   - Composite PK `(project_id, row_index, slot)` so an UPSERT
 *     for a single asset is one statement: writing `image` to
 *     row 5 doesn't disturb the `overlay` on row 5 or `image` on
 *     any other row.
 *
 * Lazy migration:
 *   No big-bang backfill. On first GET after this deploys, the
 *   load path checks `project_assets` for the project; if empty
 *   AND the payload has non-empty asset maps, the server runs a
 *   one-shot per-project INSERT in a transaction, then proceeds.
 *   Idempotent; future GETs see rows in the table and skip the
 *   backfill. Stale projects never touched stay in the payload
 *   until accessed. Avoids downtime / risky bulk migrations on a
 *   large prod table.
 */
const migration: Migration = {
  id: '0084_create_project_assets',
  description: 'Per-row asset URLs (image / overlay / clip) extracted from user_history.payload to bound payload size',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_assets (
        project_id UUID NOT NULL REFERENCES user_history(id) ON DELETE CASCADE,
        row_index  INT  NOT NULL CHECK (row_index >= 0),
        slot       TEXT NOT NULL CHECK (slot IN ('image', 'overlay', 'clip')),
        data       JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (project_id, row_index, slot)
      )
    `);

    // Single covering index for the dominant read pattern:
    // "load all assets for this project" (the editor GET). The PK
    // already covers (project_id, ...) prefixes but a slim
    // single-column index serves the COUNT-and-bulk-load case
    // more efficiently than walking the PK btree.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_project_assets_project
        ON project_assets(project_id)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS project_assets`);
  },
};

export default migration;
