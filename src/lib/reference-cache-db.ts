import { sql } from '@vercel/postgres';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Reference video cache.
//
// Anytime the user adds a YouTube URL as a reference video, the analyze
// route (a) returns the deep analysis to the caller and (b) writes the full
// payload here keyed by youtube_id. Subsequent uses of the same video skip
// the transcript fetch + AI round-trip entirely and pull straight from this
// table — turning what was a 30-90s wait into an instant lookup.
//
// The cache also doubles as a personal library: the user can browse
// previously-analyzed videos and re-attach them to a new generation
// without retyping the URL.
//
// Keyed by YouTube video_id (not URL) so youtu.be / youtube.com / shorts
// links all hit the same row.
// ---------------------------------------------------------------------------

export interface ReferenceCacheRow {
  id: string;
  youtube_id: string;
  url: string;
  title: string;
  channel_title: string;
  view_count: number;
  like_count: number | null;
  comment_count: number | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  description: string | null;
  tags: string[] | null;
  has_transcript: boolean;
  transcript_word_count: number | null;
  // The structured analysis JSON returned by the AI (or null when AI was skipped).
  analysis: Record<string, unknown> | null;
  // Pre-built human-readable summary that gets fed to script-generation prompts.
  style_analysis: string | null;
  // Which model produced the analysis. Useful when the user wants to
  // re-analyze with a stronger model later.
  model_id: string | null;
  notes: string | null;
  /** User-added free-text tags so they can search/group their library. */
  user_tags: string[];
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

let migrated = false;
export async function ensureReferenceCacheSchema() {
  if (migrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS reference_video_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        youtube_id TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        channel_title TEXT NOT NULL DEFAULT '',
        view_count BIGINT NOT NULL DEFAULT 0,
        like_count BIGINT,
        comment_count BIGINT,
        duration_seconds INTEGER,
        thumbnail_url TEXT,
        description TEXT,
        tags JSONB,
        has_transcript BOOLEAN NOT NULL DEFAULT false,
        transcript_word_count INTEGER,
        analysis JSONB,
        style_analysis TEXT,
        model_id TEXT,
        notes TEXT,
        user_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_reference_cache_youtube_id ON reference_video_cache(youtube_id)`; } catch {}
    try { await sql`CREATE INDEX IF NOT EXISTS idx_reference_cache_last_used ON reference_video_cache(last_used_at DESC NULLS LAST)`; } catch {}
    migrated = true;
  } catch (err) {
    logger.error('ensureReferenceCacheSchema error', { detail: err instanceof Error ? err.message : String(err) });
  }
}

function normalizeRow(row: Record<string, unknown>): ReferenceCacheRow {
  return {
    ...row,
    tags: Array.isArray(row.tags) ? row.tags as string[] : (row.tags ? row.tags as string[] : null),
    user_tags: Array.isArray(row.user_tags) ? row.user_tags as string[] : [],
    analysis: (row.analysis as Record<string, unknown> | null) ?? null,
  } as ReferenceCacheRow;
}

export async function getCachedReference(youtubeId: string): Promise<ReferenceCacheRow | null> {
  await ensureReferenceCacheSchema();
  const { rows } = await sql`SELECT * FROM reference_video_cache WHERE youtube_id = ${youtubeId} LIMIT 1`;
  if (!rows[0]) return null;
  return normalizeRow(rows[0] as Record<string, unknown>);
}

export interface UpsertFields {
  youtube_id: string;
  url: string;
  title: string;
  channel_title?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  duration_seconds?: number;
  thumbnail_url?: string;
  description?: string;
  tags?: string[];
  has_transcript?: boolean;
  transcript_word_count?: number;
  analysis?: Record<string, unknown> | null;
  style_analysis?: string | null;
  model_id?: string | null;
}

/**
 * Insert or update a cached reference. Always bumps updated_at; does NOT
 * touch use_count or last_used_at (those are bumped via touchReference
 * whenever the cached entry is actually returned to a caller).
 */
export async function upsertCachedReference(fields: UpsertFields): Promise<ReferenceCacheRow> {
  await ensureReferenceCacheSchema();
  const tagsJson = JSON.stringify(fields.tags ?? []);
  const analysisJson = fields.analysis ? JSON.stringify(fields.analysis) : null;
  const { rows } = await sql`
    INSERT INTO reference_video_cache (
      youtube_id, url, title, channel_title, view_count, like_count, comment_count,
      duration_seconds, thumbnail_url, description, tags, has_transcript,
      transcript_word_count, analysis, style_analysis, model_id, updated_at
    ) VALUES (
      ${fields.youtube_id}, ${fields.url}, ${fields.title}, ${fields.channel_title ?? ''},
      ${fields.view_count ?? 0}, ${fields.like_count ?? null}, ${fields.comment_count ?? null},
      ${fields.duration_seconds ?? null}, ${fields.thumbnail_url ?? null}, ${fields.description ?? null},
      ${tagsJson}::jsonb, ${fields.has_transcript ?? false},
      ${fields.transcript_word_count ?? null}, ${analysisJson}::jsonb,
      ${fields.style_analysis ?? null}, ${fields.model_id ?? null}, NOW()
    )
    ON CONFLICT (youtube_id) DO UPDATE SET
      url = EXCLUDED.url,
      title = EXCLUDED.title,
      channel_title = EXCLUDED.channel_title,
      view_count = EXCLUDED.view_count,
      like_count = EXCLUDED.like_count,
      comment_count = EXCLUDED.comment_count,
      duration_seconds = EXCLUDED.duration_seconds,
      thumbnail_url = EXCLUDED.thumbnail_url,
      description = EXCLUDED.description,
      tags = EXCLUDED.tags,
      has_transcript = EXCLUDED.has_transcript,
      transcript_word_count = EXCLUDED.transcript_word_count,
      analysis = COALESCE(EXCLUDED.analysis, reference_video_cache.analysis),
      style_analysis = COALESCE(EXCLUDED.style_analysis, reference_video_cache.style_analysis),
      model_id = COALESCE(EXCLUDED.model_id, reference_video_cache.model_id),
      updated_at = NOW()
    RETURNING *
  `;
  return normalizeRow(rows[0] as Record<string, unknown>);
}

/** Bump usage stats — call when a cache hit is served to the user. */
export async function touchReference(youtubeId: string): Promise<void> {
  await ensureReferenceCacheSchema();
  try {
    await sql`
      UPDATE reference_video_cache
      SET use_count = use_count + 1, last_used_at = NOW()
      WHERE youtube_id = ${youtubeId}
    `;
  } catch {}
}

export async function listCachedReferences(opts: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<ReferenceCacheRow[]> {
  await ensureReferenceCacheSchema();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // Search hits title, channel_title, and notes case-insensitively. Empty
  // search returns the most-recently-used first (with brand-new entries
  // sorted by created_at since last_used_at starts NULL).
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim()}%`;
    const { rows } = await sql`
      SELECT * FROM reference_video_cache
      WHERE title ILIKE ${q} OR channel_title ILIKE ${q} OR notes ILIKE ${q}
      ORDER BY COALESCE(last_used_at, created_at) DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(r => normalizeRow(r as Record<string, unknown>));
  }
  const { rows } = await sql`
    SELECT * FROM reference_video_cache
    ORDER BY COALESCE(last_used_at, created_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(r => normalizeRow(r as Record<string, unknown>));
}

export async function deleteCachedReference(id: string): Promise<void> {
  await ensureReferenceCacheSchema();
  await sql`DELETE FROM reference_video_cache WHERE id = ${id}`;
}

export async function updateReferenceMetadata(id: string, fields: Partial<{ notes: string; user_tags: string[] }>): Promise<ReferenceCacheRow | null> {
  await ensureReferenceCacheSchema();
  const userTagsJson = fields.user_tags ? JSON.stringify(fields.user_tags) : null;
  const { rows } = await sql`
    UPDATE reference_video_cache
    SET notes = COALESCE(${fields.notes ?? null}, notes),
        user_tags = COALESCE(${userTagsJson}::jsonb, user_tags),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? normalizeRow(rows[0] as Record<string, unknown>) : null;
}
