import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

export { sql };

/** Idempotent setup for the workflow drafts table. */
let draftsMigrated = false;
export async function ensureDraftsSchema() {
  if (draftsMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS workflow_drafts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        niche TEXT NOT NULL DEFAULT '',
        step TEXT NOT NULL DEFAULT 'idea',
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_workflow_drafts_updated ON workflow_drafts(updated_at DESC)`; } catch {}
    draftsMigrated = true;
  } catch (err) {
    logger.error('ensureDraftsSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Idempotent setup for the saved channel names table. */
let channelNamesMigrated = false;
export async function ensureChannelNamesSchema() {
  if (channelNamesMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS saved_channel_names (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        handle TEXT NOT NULL UNIQUE,
        niche TEXT,
        free_text TEXT,
        seo_score NUMERIC(4,1),
        brand_score NUMERIC(4,1),
        memorability_score NUMERIC(4,1),
        combined_score NUMERIC(4,1),
        reasoning TEXT,
        keyword_coverage JSONB DEFAULT '[]',
        risks TEXT,
        was_available BOOLEAN,
        ai_model TEXT,
        notes TEXT,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    // Add UNIQUE constraint on legacy tables that were created without it
    try { await sql`ALTER TABLE saved_channel_names ADD CONSTRAINT saved_channel_names_handle_unique UNIQUE (handle)`; }
    catch { /* already exists */ }
    try { await sql`CREATE INDEX IF NOT EXISTS idx_saved_names_saved_at ON saved_channel_names(saved_at DESC)`; } catch {}
    channelNamesMigrated = true;
  } catch (err) {
    logger.error('ensureChannelNamesSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Idempotent setup for competitor tables + rich columns. Cheap to call repeatedly. */
let competitorMigrated = false;
export async function ensureCompetitorSchema() {
  if (competitorMigrated) return;
  try {
    // Base tables — create if missing (production DB may not have run initDatabase)
    await sql`
      CREATE TABLE IF NOT EXISTS competitor_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        custom_url TEXT,
        description TEXT,
        subscriber_count INTEGER DEFAULT 0,
        video_count INTEGER DEFAULT 0,
        view_count BIGINT DEFAULT 0,
        thumbnail_url TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS competitor_videos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        competitor_id UUID NOT NULL REFERENCES competitor_channels(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        published_at TIMESTAMPTZ,
        view_count INTEGER DEFAULT 0,
        like_count INTEGER DEFAULT 0,
        comment_count INTEGER DEFAULT 0,
        duration TEXT,
        thumbnail_url TEXT,
        outlier_score NUMERIC(14,2) DEFAULT 0,
        engagement_rate NUMERIC(8,4) DEFAULT 0,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_comp_videos_competitor ON competitor_videos(competitor_id)`; } catch {}

    // Rich-data migrations — add columns missing on older deployments
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS description TEXT`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS category_id TEXT`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 0`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS top_comments JSONB DEFAULT '[]'`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS topic_categories JSONB DEFAULT '[]'`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analysis JSONB`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analyzed_at TIMESTAMPTZ`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analysis_model TEXT`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS thumbnail_analysis JSONB`;
    await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS thumbnail_analyzed_at TIMESTAMPTZ`;
    // Widen outlier_score on pre-existing tables created with NUMERIC(8,2)
    try { await sql`ALTER TABLE competitor_videos ALTER COLUMN outlier_score TYPE NUMERIC(14,2)`; } catch {}

    competitorMigrated = true;
  } catch (err) {
    logger.error('ensureCompetitorSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

export async function initDatabase() {
  // Projects table
  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      niche TEXT NOT NULL,
      topic TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Scripts table (versioned)
  await sql`
    CREATE TABLE IF NOT EXISTS scripts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      word_count INTEGER DEFAULT 0,
      estimated_duration_seconds INTEGER DEFAULT 0,
      ai_model TEXT,
      generation_params JSONB DEFAULT '{}',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // QA sessions table
  await sql`
    CREATE TABLE IF NOT EXISTS qa_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      script_id UUID REFERENCES scripts(id) ON DELETE CASCADE,
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      pass_number INTEGER NOT NULL DEFAULT 1,
      overall_score INTEGER,
      feedback JSONB NOT NULL DEFAULT '{}',
      issues JSONB NOT NULL DEFAULT '[]',
      suggestions JSONB NOT NULL DEFAULT '[]',
      ai_model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Video ideas table
  await sql`
    CREATE TABLE IF NOT EXISTS video_ideas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      niche TEXT NOT NULL,
      title TEXT NOT NULL,
      hook TEXT,
      description TEXT,
      target_audience TEXT,
      estimated_views_potential TEXT,
      trend_relevance TEXT,
      difficulty TEXT,
      tags JSONB DEFAULT '[]',
      is_saved BOOLEAN DEFAULT false,
      is_used BOOLEAN DEFAULT false,
      project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Media assets table (uploads + URL references)
  await sql`
    CREATE TABLE IF NOT EXISTS media_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('voiceover', 'image', 'video', 'reference', 'document')),
      source TEXT NOT NULL CHECK (source IN ('upload', 'url')),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      blob_pathname TEXT,
      size_bytes BIGINT,
      duration_seconds INTEGER,
      notes TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // YouTube references table
  await sql`
    CREATE TABLE IF NOT EXISTS youtube_references (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      youtube_url TEXT NOT NULL,
      video_id TEXT,
      title TEXT,
      channel TEXT,
      description TEXT,
      view_count BIGINT,
      like_count BIGINT,
      duration TEXT,
      thumbnail_url TEXT,
      notes TEXT,
      scraped_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Channels table (for YouTube channel integration)
  await sql`
    CREATE TABLE IF NOT EXISTS channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT UNIQUE,
      name TEXT NOT NULL,
      handle TEXT,
      description TEXT,
      subscriber_count BIGINT,
      video_count INTEGER,
      niche TEXT,
      thumbnail_url TEXT,
      last_synced_at TIMESTAMPTZ,
      api_credentials JSONB DEFAULT '{}',
      account_label TEXT,
      account_email TEXT,
      account_color TEXT DEFAULT '#7c3aed',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Add columns for existing databases (safe to run multiple times)
  try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_label TEXT`; } catch {}
  try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_email TEXT`; } catch {}
  try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_color TEXT DEFAULT '#7c3aed'`; } catch {}
  try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS notes TEXT`; } catch {}
  try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_connected BOOLEAN DEFAULT false`; } catch {}

  // OAuth tokens table (encrypted access + refresh tokens)
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'google',
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      token_expiry TIMESTAMPTZ NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      google_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(channel_id, provider)
    )
  `;

  // Niches table (for flexible niche management)
  await sql`
    CREATE TABLE IF NOT EXISTS niches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      keywords JSONB DEFAULT '[]',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Competitor tracking tables
  await sql`
    CREATE TABLE IF NOT EXISTS competitor_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      channel_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      custom_url TEXT,
      description TEXT,
      subscriber_count INTEGER DEFAULT 0,
      video_count INTEGER DEFAULT 0,
      view_count BIGINT DEFAULT 0,
      thumbnail_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS competitor_videos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      competitor_id UUID NOT NULL REFERENCES competitor_channels(id) ON DELETE CASCADE,
      video_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      published_at TIMESTAMPTZ,
      view_count INTEGER DEFAULT 0,
      like_count INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      duration TEXT,
      thumbnail_url TEXT,
      outlier_score NUMERIC(8,2) DEFAULT 0,
      engagement_rate NUMERIC(8,4) DEFAULT 0,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Index for competitor video lookups
  try {
    await sql`CREATE INDEX IF NOT EXISTS idx_comp_videos_competitor ON competitor_videos(competitor_id)`;
  } catch { /* index may already exist */ }

  // Migration: expand competitor_videos with rich fields for deeper analysis
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS description TEXT`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS category_id TEXT`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 0`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS top_comments JSONB DEFAULT '[]'`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS topic_categories JSONB DEFAULT '[]'`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analysis JSONB`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analyzed_at TIMESTAMPTZ`; } catch {}
  try { await sql`ALTER TABLE competitor_videos ADD COLUMN IF NOT EXISTS video_analysis_model TEXT`; } catch {}

  // Seed default niches if empty
  await sql`
    INSERT INTO niches (name, description, keywords)
    VALUES
      ('Cybersecurity & Antivirus', 'Explainer videos about cybersecurity, antivirus software, digital safety', '["antivirus", "cybersecurity", "malware", "vpn", "privacy", "hacking", "firewall", "ransomware"]'),
      ('General Tech', 'Technology reviews, tutorials and explainers', '["tech", "software", "hardware", "review", "tutorial"]')
    ON CONFLICT (name) DO NOTHING
  `;
}

/** Idempotent setup for the channels table + per-account columns. */
let channelsMigrated = false;
export async function ensureChannelsSchema() {
  if (channelsMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id TEXT UNIQUE,
        name TEXT NOT NULL,
        handle TEXT,
        description TEXT,
        subscriber_count BIGINT,
        video_count INTEGER,
        niche TEXT,
        thumbnail_url TEXT,
        last_synced_at TIMESTAMPTZ,
        api_credentials JSONB DEFAULT '{}',
        account_label TEXT,
        account_email TEXT,
        account_color TEXT DEFAULT '#7c3aed',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_label TEXT`; } catch {}
    try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_email TEXT`; } catch {}
    try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS account_color TEXT DEFAULT '#7c3aed'`; } catch {}
    try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS notes TEXT`; } catch {}
    try { await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS oauth_connected BOOLEAN DEFAULT false`; } catch {}
    channelsMigrated = true;
  } catch (err) {
    logger.error('ensureChannelsSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

/** Idempotent setup for the schedule feature.
 *  One schedule_item per planned video slot (recurring rules expand into concrete items).
 *  Multi-channel via join table so cross-posting doesn't require schema changes.
 *  custom_fields JSONB keeps the spreadsheet view flexible without migrations per column. */
let scheduleMigrated = false;
export async function ensureScheduleSchema() {
  if (scheduleMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schedule_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL DEFAULT '',
        scheduled_for TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'idea',
        notes TEXT,
        tags JSONB NOT NULL DEFAULT '[]',
        custom_fields JSONB NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0,
        idea_id UUID REFERENCES video_ideas(id) ON DELETE SET NULL,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        script_id UUID REFERENCES scripts(id) ON DELETE SET NULL,
        recurrence JSONB,
        recurrence_parent_id UUID REFERENCES schedule_items(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS schedule_item_channels (
        item_id UUID NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
        channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        PRIMARY KEY (item_id, channel_id)
      )
    `;

    // Per-channel status pipelines. If a channel has no rows here, falls back to the default global list.
    await sql`
      CREATE TABLE IF NOT EXISTS channel_statuses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#7c3aed',
        position INTEGER NOT NULL DEFAULT 0,
        UNIQUE (channel_id, key)
      )
    `;

    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_scheduled ON schedule_items(scheduled_for)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_status ON schedule_items(status)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_item_channels_channel ON schedule_item_channels(channel_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_channel_statuses_channel ON channel_statuses(channel_id, position)`; } catch {}

    // --- Extended schema for Tier 1/2 features ---------------------------------
    // Stage stuck-detection: track when the item entered its current status.
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; } catch {}
    // Content pillar tagging (gap-detection target).
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS pillar TEXT`; } catch {}
    // Checklist lives on the item as JSONB [{ id, text, done, stage }].
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'`; } catch {}
    // Thumbnail A/B slots
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS thumbnail_a_url TEXT`; } catch {}
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS thumbnail_b_url TEXT`; } catch {}
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS thumbnail_winner TEXT`; } catch {} // 'a' | 'b' | null
    // Final YouTube metadata captured on the schedule item (for publish handoff).
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS yt_description TEXT`; } catch {}
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS yt_tags JSONB DEFAULT '[]'`; } catch {}
    // Published-video URL so we can pull title/description back from YouTube.
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS youtube_url TEXT`; } catch {}

    // Editor roster — per-channel list of people who edit videos. A schedule
    // item points to one editor (nullable). Deleting an editor unlinks rather
    // than cascades so historical items don't disappear.
    await sql`
      CREATE TABLE IF NOT EXISTS channel_editors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_channel_editors_channel ON channel_editors(channel_id)`; } catch {}
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS editor_id UUID REFERENCES channel_editors(id) ON DELETE SET NULL`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_editor ON schedule_items(editor_id)`; } catch {}

    // Team-based assignments — pick from /team collaborators directly. Wrapped
    // in try/catch in case the collaborators table doesn't exist on a fresh DB
    // (it's created by ensureTeamSchema()).
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS editor_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL`; } catch {}
    try { await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS narrator_collaborator_id UUID REFERENCES collaborators(id) ON DELETE SET NULL`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_editor_collab ON schedule_items(editor_collaborator_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_narrator_collab ON schedule_items(narrator_collaborator_id)`; } catch {}

    // Stage-transition checklist templates (per channel + status).
    await sql`
      CREATE TABLE IF NOT EXISTS schedule_checklist_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        items JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (channel_id, status)
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_cl_tpl_channel ON schedule_checklist_templates(channel_id)`; } catch {}

    // Saved views — user-named filter bundles.
    await sql`
      CREATE TABLE IF NOT EXISTS schedule_saved_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        config JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    // Dependency edges between schedule items (sequel_of, companion_of, uses_broll).
    await sql`
      CREATE TABLE IF NOT EXISTS schedule_dependencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_id UUID NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
        to_id UUID NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'relates_to',
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (from_id, to_id, kind)
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_deps_from ON schedule_dependencies(from_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_deps_to ON schedule_dependencies(to_id)`; } catch {}

    // Public share tokens (read-only scoped view — collaboration without auth).
    await sql`
      CREATE TABLE IF NOT EXISTS schedule_share_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token TEXT NOT NULL UNIQUE,
        channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
        label TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    scheduleMigrated = true;
  } catch (err) {
    logger.error('ensureScheduleSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

export const DEFAULT_SCHEDULE_STATUSES = [
  { key: 'idea', label: 'Idea', color: '#64748b', position: 0 },
  { key: 'scripting', label: 'Scripting', color: '#8b5cf6', position: 1 },
  { key: 'recording', label: 'Recording', color: '#f59e0b', position: 2 },
  { key: 'editing', label: 'Editing', color: '#06b6d4', position: 3 },
  { key: 'ready', label: 'Ready', color: '#10b981', position: 4 },
  { key: 'published', label: 'Published', color: '#3b82f6', position: 5 },
];

/** Idempotent setup for the series feature. A series is a cross-device grouping
 * of ideas/scripts/schedule items that share a continuing narrative (Part 1,
 * Part 2, …). Kept in a dedicated table (not a JSONB blob) so we can query by
 * series_id from any page without scanning. */
let seriesMigrated = false;

/** Returns true iff a table with that name exists in the public schema. Used
 *  to gate ALTER TABLE calls on a fresh deployment where initDatabase may not
 *  have run yet — silently swallowing the error would just defer the failure
 *  until the first INSERT against a column that was never added. */
async function tableExists(name: string): Promise<boolean> {
  try {
    const r = await sql`SELECT to_regclass(${`public.${name}`}) AS oid`;
    return r.rows[0]?.oid != null;
  } catch {
    return false;
  }
}

export async function ensureSeriesSchema() {
  if (seriesMigrated) return;
  try {
    // The series table itself (and its channels FK) always needs initDatabase
    // or ensureChannelsSchema to have created `channels` first. Ensure it now.
    await ensureChannelsSchema();
    await sql`
      CREATE TABLE IF NOT EXISTS series (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        niche TEXT,
        description TEXT,
        total_parts_planned INTEGER,
        channel_id UUID REFERENCES channels(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_series_title ON series(title)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_series_channel ON series(channel_id)`; } catch {}

    // Add series_id/part_number/summary to the content tables. Each ALTER is
    // gated on the table existing so a fresh deployment that hasn't run
    // initDatabase doesn't swallow real errors — the migration simply waits
    // until the base table is created elsewhere, then re-runs on the next call.
    // ON DELETE SET NULL so removing a series unlinks rather than cascades.
    let allOk = true;

    if (await tableExists('scripts')) {
      await sql`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES series(id) ON DELETE SET NULL`;
      await sql`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS part_number INTEGER`;
      await sql`ALTER TABLE scripts ADD COLUMN IF NOT EXISTS series_summary TEXT`;
      try { await sql`CREATE INDEX IF NOT EXISTS idx_scripts_series ON scripts(series_id, part_number)`; } catch {}
    } else {
      allOk = false;
    }

    if (await tableExists('video_ideas')) {
      await sql`ALTER TABLE video_ideas ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES series(id) ON DELETE SET NULL`;
      await sql`ALTER TABLE video_ideas ADD COLUMN IF NOT EXISTS part_number INTEGER`;
      try { await sql`CREATE INDEX IF NOT EXISTS idx_video_ideas_series ON video_ideas(series_id, part_number)`; } catch {}
    } else {
      allOk = false;
    }

    if (await tableExists('schedule_items')) {
      await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS series_id UUID REFERENCES series(id) ON DELETE SET NULL`;
      await sql`ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS part_number INTEGER`;
      try { await sql`CREATE INDEX IF NOT EXISTS idx_schedule_items_series ON schedule_items(series_id, part_number)`; } catch {}
    } else {
      allOk = false;
    }

    // Only mark as migrated when every target table was present. If a base
    // table was missing, leave the flag false so a later call (after the base
    // is created) can apply the pending column additions.
    if (allOk) seriesMigrated = true;
  } catch (err) {
    logger.error('ensureSeriesSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

let googleAuthMigrated = false;
export async function ensureGoogleAuthSchema() {
  if (googleAuthMigrated) return;
  try {
    // Workspace-scoped: every Google OAuth connection belongs to one
    // workspace. The composite UNIQUE allows the same Google account to
    // be connected from multiple workspaces independently.
    //
    // This shape matches the post-0036 schema. On a database where the
    // table was created lazily (by a prior boot of this helper) before
    // 0036 ran, 0036 ALTERs the existing table to match.
    await sql`
      CREATE TABLE IF NOT EXISTS google_auth_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        access_token_encrypted TEXT NOT NULL,
        refresh_token_encrypted TEXT,
        token_expiry TIMESTAMPTZ NOT NULL,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT google_auth_tokens_workspace_email_unique UNIQUE (workspace_id, email)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_google_auth_tokens_workspace
        ON google_auth_tokens(workspace_id)
    `;
    googleAuthMigrated = true;
  } catch (err) {
    logger.error('ensureGoogleAuthSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}
