import { sql } from '@vercel/postgres';

export { sql };

/** Idempotent setup for the saved channel names table. */
let channelNamesMigrated = false;
export async function ensureChannelNamesSchema() {
  if (channelNamesMigrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS saved_channel_names (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        handle TEXT NOT NULL,
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
    try { await sql`CREATE INDEX IF NOT EXISTS idx_saved_names_saved_at ON saved_channel_names(saved_at DESC)`; } catch {}
    channelNamesMigrated = true;
  } catch (err) {
    console.error('ensureChannelNamesSchema error:', err);
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
    console.error('ensureCompetitorSchema error:', err);
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
