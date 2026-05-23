import type { Migration } from './types';

/**
 * Append-only audit log of every B-roll (animation) generation kickoff
 * the editor fires, with terminal status filled in once polling
 * resolves. Surfaces in the editor's right-Inspector "History" tab so
 * the user can see "every scene that had a generation or re-generation,
 * when the last one was, and jump to that scene."
 *
 * Why a new table (not columns on `broll_clips`):
 *   `broll_clips` is the per-clip entity — one row per generation
 *   *attempt*, scoped by `(workspace_id, source_script_id, row_signature)`.
 *   The editor's view of history is per-row across attempts: scene 5
 *   was generated, then re-generated twice. Modelling that as more
 *   columns on `broll_clips` conflates "this clip" with "this attempt
 *   in the log" and makes re-generate semantics ambiguous (insert a new
 *   row, or update the existing one?). A separate append-only events
 *   table keeps each entity single-purpose: `broll_clips` is "the
 *   playable clip"; `generation_events` is "an entry in the editor's
 *   history strip."
 *
 * Why FK to `user_history(id)` (not `projects`):
 *   Editor projects are NOT in the `projects` table — they're rows in
 *   `user_history` with `kind = 'production_doc'`. Every editor API
 *   route under `/api/edit/[projectId]/*` joins through user_history
 *   with that exact predicate. Mirroring that here keeps the FK
 *   coherent with how the data actually flows. The `kind` is not
 *   enforced at the DB layer — the API route's WHERE clause is the
 *   authoritative gate (same convention as `row-asset` and friends).
 *
 * Columns:
 *
 *   - `project_id` / `row_index`: where in the editor this fired. The
 *     History panel uses these to render "Scene N" and to jump-to-scene
 *     on click.
 *
 *   - `broll_clip_id`: the `broll_clips` row the kickoff produced.
 *     ON DELETE CASCADE so an old clip getting GC'd takes its log
 *     entry with it. Indexed because the GET endpoint reconciles
 *     stuck `generating` entries by joining back to `broll_clips`
 *     to pick up the real terminal status (covers the "user closed
 *     the tab mid-poll" case so the entry doesn't stay "generating"
 *     forever).
 *
 *   - `model_id`: snapshot of which model was used. Stored here even
 *     though it's also on `broll_clips` because the History panel
 *     reads from this table first and only joins for reconciliation;
 *     having model_id local keeps the common-case render single-table.
 *
 *   - `event_type` ('generate' | 'regenerate'): set at kickoff time
 *     based on whether the row already had a `brollClipId`. Lets the
 *     UI flag re-generations distinctly from first generations.
 *
 *   - `status`: starts at 'generating', PATCHed to 'ready' / 'failed'
 *     when polling resolves. Subset of broll_clips.status — we drop
 *     'pending' because the kickoff has already submitted by the time
 *     we insert.
 *
 *   - `error_message`: copied from broll_clips on failure so the
 *     panel can show "why it broke" inline without a JOIN.
 *
 *   - `prompt_excerpt`: first ~140 chars of the row's script_text /
 *     visual_description at kickoff time. Helps the user identify
 *     "which generation was this?" when scanning a long log of the
 *     same scene index. Truncated server-side so a multi-MB row never
 *     bloats the log table.
 *
 *   - `completed_at`: PATCHed at terminal-status time. NULL while
 *     still generating.
 *
 * Retention: forever (per plan). The log table is small — a few rows
 * per scene per project lifetime — and storage is cheap. If this ever
 * becomes a problem a partial-index-driven sweep on
 * `WHERE completed_at < now() - interval '90 days'` can prune it
 * without touching code.
 */
const migration: Migration = {
  id: '0083_create_generation_events',
  description: 'Append-only log of editor B-roll generation kickoffs and their terminal status, for the History inspector tab',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS generation_events (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID NOT NULL REFERENCES user_history(id) ON DELETE CASCADE,
        row_index       INTEGER NOT NULL,
        broll_clip_id   UUID NOT NULL REFERENCES broll_clips(id) ON DELETE CASCADE,
        model_id        TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        status          TEXT NOT NULL,
        error_message   TEXT,
        prompt_excerpt  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ,

        CONSTRAINT generation_events_event_type_chk
          CHECK (event_type IN ('generate','regenerate')),
        CONSTRAINT generation_events_status_chk
          CHECK (status IN ('generating','ready','failed')),
        CONSTRAINT generation_events_row_index_chk
          CHECK (row_index >= 0)
      )
    `);

    // Hot read path: list a project's events, newest first. The
    // History panel hits this exact shape on mount and on every
    // kickoff / completion, so a covering composite index makes it
    // an index-only scan with no heap fetch.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_generation_events_project_created
        ON generation_events(project_id, created_at DESC)
    `);

    // Reconciliation lookup: when GET sees an entry stuck in
    // 'generating', it joins back through broll_clip_id to pick up
    // the real terminal status (the client crashed before PATCHing).
    // Partial index keeps the index tiny — most events are 'ready'.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_generation_events_inflight
        ON generation_events(broll_clip_id)
        WHERE status = 'generating'
    `);
  },

  async down(client) {
    await client.query(`DROP INDEX IF EXISTS idx_generation_events_inflight`);
    await client.query(`DROP INDEX IF EXISTS idx_generation_events_project_created`);
    await client.query(`DROP TABLE IF EXISTS generation_events`);
  },
};

export default migration;
