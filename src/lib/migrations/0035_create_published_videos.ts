import type { Migration } from './types';

/**
 * Direct-to-YouTube publishing pipeline.
 *
 * One row per upload attempt. The user clicks "Publish" in the app →
 * we INSERT a row in `queued`, kick off the YouTube `videos.insert`
 * call, and update status as the upload progresses. After
 * `videos.insert` returns, the YouTube backend keeps processing the
 * file for some minutes — a polling cron (or the status route on
 * demand) calls `videos.list?part=status` and flips the row to `live`
 * when YouTube reports `uploadStatus = uploaded` AND
 * `processingStatus = succeeded`.
 *
 * Status state machine:
 *   queued → uploading → processing → live    (happy path)
 *           ↓           ↓            ↓
 *          failed      failed       failed   (error at any step)
 *
 * The optional `playlist_id` adds the freshly-uploaded video to one of
 * the channel's playlists (e.g. "Latest uploads"). Optional
 * `thumbnail_url` overrides YouTube's auto-generated thumbnail.
 *
 * `source_video_url` is where the MP4 lives — usually a Vercel Blob
 * URL produced by /api/render/* or a uploaded file.
 *
 * `youtube_video_id` is set after `videos.insert` succeeds. `youtube_url`
 * is the canonical https://youtu.be/<id> link, materialised so the UI
 * doesn't have to construct it.
 */
const migration: Migration = {
  id: '0035_create_published_videos',
  description: 'Direct-to-YouTube publishing pipeline — published_videos table',

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS published_videos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        channel_db_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,

        -- Optional links to where this came from
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        schedule_item_id UUID REFERENCES schedule_items(id) ON DELETE SET NULL,

        -- Source MP4 (Vercel Blob URL or external https URL)
        source_video_url TEXT NOT NULL,

        -- videos.insert snippet
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        category_id TEXT NOT NULL DEFAULT '22',
        default_language TEXT,

        -- videos.insert status
        privacy_status TEXT NOT NULL DEFAULT 'private',
        publish_at TIMESTAMPTZ,
        made_for_kids BOOLEAN NOT NULL DEFAULT FALSE,

        -- Optional thumbnail override + playlist add
        thumbnail_url TEXT,
        playlist_id TEXT,

        -- YouTube response
        youtube_video_id TEXT,
        youtube_url TEXT,

        -- Lifecycle
        status TEXT NOT NULL DEFAULT 'queued',
        upload_status TEXT,
        processing_status TEXT,
        privacy_status_actual TEXT,
        error_message TEXT,

        -- Audit (collaborator id, NOT a hard FK so deleting a user
        -- doesn't drop their publish history).
        initiated_by UUID,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        uploaded_at TIMESTAMPTZ,
        live_at TIMESTAMPTZ
      )
    `);

    /**
     * Workspace + time index — primary read path is "show me recent
     * publishes for this workspace, newest first".
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_published_videos_workspace_time
        ON published_videos(workspace_id, created_at DESC)
    `);

    /**
     * Pending-status partial index for the polling cron — only rows
     * still in flight need to be re-checked, so the index stays small.
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_published_videos_pending
        ON published_videos(workspace_id, status)
        WHERE status IN ('queued', 'uploading', 'processing')
    `);

    /**
     * Per-channel timeline so a channel page can show "what's been
     * published from this channel lately".
     */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_published_videos_channel_time
        ON published_videos(channel_db_id, created_at DESC)
    `);
  },

  async down(client) {
    await client.query(`DROP TABLE IF EXISTS published_videos`);
  },
};

export default migration;
