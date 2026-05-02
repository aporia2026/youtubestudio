/**
 * YouTube comment management — sync, AI triage, reply, moderate.
 *
 * Read path uses the public Data API (YOUTUBE_API_KEY) — no OAuth
 * needed, costs 1 quota unit per page of 100. Write paths
 * (comments.insert / setModerationStatus) require the channel's
 * `youtube.force-ssl` OAuth scope; we resolve it from the channel's
 * stored OAuth tokens via getValidAccessToken.
 *
 * Intent triage is a separate AI step (src/lib/comment-triage.ts) that
 * caches the result on the comment row so re-classification is opt-in.
 *
 * The pure parts (URL list builder, Kie/YT response parser) are
 * exported for unit tests so wire-format edge cases are testable
 * without a YouTube API key.
 */
import { sql } from '@vercel/postgres';
import { logger } from './logger';
import { getValidAccessToken } from './google-oauth';
import {
  MAX_REPLY_LENGTH,
  type CommentIntent,
  type CommentModerationStatus,
  type CommentSyncRunRow,
  type YoutubeCommentRow,
} from './youtube-comments-types';

export type {
  CommentIntent,
  CommentModerationStatus,
  CommentSyncRunRow,
  YoutubeCommentRow,
} from './youtube-comments-types';

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

interface RawCommentThreadItem {
  id?: string;
  snippet?: {
    videoId?: string;
    totalReplyCount?: number;
    topLevelComment?: {
      id?: string;
      snippet?: {
        textOriginal?: string;
        textDisplay?: string;
        authorDisplayName?: string;
        authorChannelId?: { value?: string };
        likeCount?: number;
        publishedAt?: string;
        updatedAt?: string;
        moderationStatus?: string;
        viewerRating?: string;
      };
    };
  };
}

interface RawCommentThreadResponse {
  items?: RawCommentThreadItem[];
  nextPageToken?: string;
}

/**
 * Parse a single commentThread item into the canonical row shape we
 * upsert into `youtube_comments`. Drops items that don't have the
 * required (id, text) fields. Pure function — exported for tests.
 */
export function parseCommentThreadItem(
  videoId: string,
  item: RawCommentThreadItem,
): Partial<YoutubeCommentRow> | null {
  const top = item.snippet?.topLevelComment;
  const id = top?.id;
  const snip = top?.snippet;
  if (!id || !snip || (!snip.textOriginal && !snip.textDisplay)) return null;
  return {
    youtube_video_id: videoId,
    youtube_comment_id: id,
    parent_yt_comment_id: null,
    author_name: snip.authorDisplayName ?? null,
    author_channel_id: snip.authorChannelId?.value ?? null,
    text: (snip.textOriginal ?? snip.textDisplay ?? '').slice(0, 10000),
    like_count: typeof snip.likeCount === 'number' ? snip.likeCount : 0,
    reply_count: typeof item.snippet?.totalReplyCount === 'number' ? item.snippet.totalReplyCount : 0,
    published_at: snip.publishedAt ?? null,
    updated_at_yt: snip.updatedAt ?? null,
    moderation_status: (snip.moderationStatus as CommentModerationStatus) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sync (read-path)
// ---------------------------------------------------------------------------

interface SyncCommentsArgs {
  workspaceId: string;
  channelDbId: string | null;
  youtubeVideoId: string;
  /** Cap pages fetched. Each page = up to 100 comments + 1 quota unit. */
  maxPages?: number;
}

interface SyncCommentsResult {
  run_id: string;
  fetched: number;
  inserted: number;
  updated: number;
}

/**
 * Pull comment threads for a video and upsert into youtube_comments.
 * Records a `comment_sync_runs` row with totals so the UI can show
 * "last sync: 47 comments, 3 new, 250ms".
 *
 * Uses YOUTUBE_API_KEY (public, no OAuth needed) — sync is read-only.
 * If the workspace ever wants to fetch HELD-for-review comments (only
 * visible to the channel owner), we'd need to switch to OAuth. Out of
 * scope for v1.
 */
export async function syncCommentsForVideo(args: SyncCommentsArgs): Promise<SyncCommentsResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is not configured.');
  const maxPages = Math.max(1, Math.min(args.maxPages ?? 5, 20));
  const startedAt = Date.now();

  const { rows: runInsert } = await sql<{ id: string }>`
    INSERT INTO comment_sync_runs (
      workspace_id, channel_db_id, youtube_video_id, status
    ) VALUES (
      ${args.workspaceId}::uuid,
      ${args.channelDbId}::uuid,
      ${args.youtubeVideoId},
      'running'
    )
    RETURNING id
  `;
  const runId = runInsert[0]!.id;

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pageToken: string | undefined = undefined;

  try {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${YT_API_BASE}/commentThreads`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('videoId', args.youtubeVideoId);
      url.searchParams.set('maxResults', '100');
      url.searchParams.set('order', 'time');
      url.searchParams.set('key', apiKey);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 403 with "commentsDisabled" = comments off on the video.
        // Surface that as a graceful empty result, not a hard error.
        if (res.status === 403 && body.includes('commentsDisabled')) break;
        throw new Error(`YouTube commentThreads ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as RawCommentThreadResponse;
      const items = data.items ?? [];
      fetched += items.length;

      for (const it of items) {
        const parsed = parseCommentThreadItem(args.youtubeVideoId, it);
        if (!parsed) continue;
        const upsert = await sql<{ inserted: boolean }>`
          INSERT INTO youtube_comments (
            workspace_id, channel_db_id, youtube_video_id, youtube_comment_id, parent_yt_comment_id,
            author_name, author_channel_id, text,
            like_count, reply_count,
            published_at, updated_at_yt, moderation_status,
            last_synced_at
          ) VALUES (
            ${args.workspaceId}::uuid,
            ${args.channelDbId}::uuid,
            ${parsed.youtube_video_id ?? args.youtubeVideoId},
            ${parsed.youtube_comment_id!},
            ${parsed.parent_yt_comment_id ?? null},
            ${parsed.author_name ?? null},
            ${parsed.author_channel_id ?? null},
            ${parsed.text ?? ''},
            ${parsed.like_count ?? 0},
            ${parsed.reply_count ?? 0},
            ${parsed.published_at ?? null}::timestamptz,
            ${parsed.updated_at_yt ?? null}::timestamptz,
            ${parsed.moderation_status ?? null},
            NOW()
          )
          ON CONFLICT (workspace_id, youtube_comment_id) DO UPDATE
            SET text = EXCLUDED.text,
                like_count = EXCLUDED.like_count,
                reply_count = EXCLUDED.reply_count,
                updated_at_yt = EXCLUDED.updated_at_yt,
                moderation_status = EXCLUDED.moderation_status,
                last_synced_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `;
        if (upsert.rows[0]?.inserted) inserted += 1;
        else updated += 1;
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    const duration = Date.now() - startedAt;
    await sql`
      UPDATE comment_sync_runs
         SET status = 'completed',
             comments_fetched = ${fetched},
             comments_inserted = ${inserted},
             comments_updated = ${updated},
             duration_ms = ${duration},
             completed_at = NOW()
       WHERE id = ${runId}::uuid
    `;
    return { run_id: runId, fetched, inserted, updated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE comment_sync_runs
         SET status = 'failed',
             error_message = ${msg.slice(0, 1000)},
             comments_fetched = ${fetched},
             comments_inserted = ${inserted},
             comments_updated = ${updated},
             duration_ms = ${Date.now() - startedAt},
             completed_at = NOW()
       WHERE id = ${runId}::uuid
    `;
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// Write paths (require channel OAuth)
// ---------------------------------------------------------------------------

export interface ReplyToCommentArgs {
  id: string; // our internal row id
  workspaceId: string;
  replyText: string;
}

/**
 * Post a reply to a comment via OAuth. Resolves the channel's access
 * token from the comment's channel_db_id, then calls comments.insert.
 * Caches the reply on our row so the UI can show "you replied 3 hours
 * ago" without another YouTube round-trip.
 */
export async function replyToComment(args: ReplyToCommentArgs): Promise<{ replyYtCommentId: string }> {
  const text = args.replyText.trim();
  if (!text) throw new Error('replyText is required.');
  if (text.length > MAX_REPLY_LENGTH) {
    throw new Error(`Reply exceeds YouTube's ${MAX_REPLY_LENGTH}-char limit.`);
  }

  const { rows } = await sql<{ youtube_comment_id: string; channel_db_id: string | null }>`
    SELECT youtube_comment_id, channel_db_id
      FROM youtube_comments
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
     LIMIT 1
  `;
  const comment = rows[0];
  if (!comment) throw new Error('Comment not found in this workspace.');
  if (!comment.channel_db_id) {
    throw new Error('Comment has no associated channel — cannot OAuth.');
  }
  const accessToken = await getValidAccessToken(comment.channel_db_id);
  if (!accessToken) throw new Error('YouTube OAuth not connected for this channel.');

  const res = await fetch(`${YT_API_BASE}/comments?part=snippet`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      snippet: {
        parentId: comment.youtube_comment_id,
        textOriginal: text,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as { error?: { message?: string } }).error?.message || `YouTube ${res.status}`;
    throw new Error(`YouTube reply failed: ${msg}`);
  }
  const data = (await res.json()) as { id?: string };
  const replyId = data.id ?? '';
  if (!replyId) throw new Error('YouTube returned no reply id.');

  await sql`
    UPDATE youtube_comments
       SET replied = TRUE,
           replied_at = NOW(),
           replied_with_yt_comment_id = ${replyId},
           our_reply_text = ${text}
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  return { replyYtCommentId: replyId };
}

export interface SetModerationArgs {
  id: string;
  workspaceId: string;
  status: 'heldForReview' | 'published' | 'rejected';
  banAuthor?: boolean;
}

/**
 * Hold/publish/reject a comment via OAuth. Wraps
 * comments.setModerationStatus. `banAuthor` (only meaningful with
 * status='rejected') silences the author's future comments on the
 * channel.
 */
export async function setCommentModeration(args: SetModerationArgs): Promise<void> {
  const { rows } = await sql<{ youtube_comment_id: string; channel_db_id: string | null }>`
    SELECT youtube_comment_id, channel_db_id
      FROM youtube_comments
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
     LIMIT 1
  `;
  const comment = rows[0];
  if (!comment) throw new Error('Comment not found in this workspace.');
  if (!comment.channel_db_id) throw new Error('Comment has no associated channel — cannot OAuth.');
  const accessToken = await getValidAccessToken(comment.channel_db_id);
  if (!accessToken) throw new Error('YouTube OAuth not connected for this channel.');

  const url = new URL(`${YT_API_BASE}/comments/setModerationStatus`);
  url.searchParams.set('id', comment.youtube_comment_id);
  url.searchParams.set('moderationStatus', args.status);
  if (args.status === 'rejected' && args.banAuthor) {
    url.searchParams.set('banAuthor', 'true');
  }

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube setModerationStatus ${res.status}: ${body.slice(0, 200)}`);
  }

  await sql`
    UPDATE youtube_comments
       SET moderation_status = ${args.status}
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

const SELECT_COMMENT_COLS = `
  id, workspace_id, channel_db_id,
  youtube_video_id, youtube_comment_id, parent_yt_comment_id,
  author_name, author_channel_id, text, like_count, reply_count,
  published_at::text AS published_at,
  updated_at_yt::text AS updated_at_yt,
  moderation_status, author_is_channel_owner,
  intent, intent_confidence,
  intent_classified_at::text AS intent_classified_at,
  suggested_reply, ai_model,
  replied,
  replied_at::text AS replied_at,
  replied_with_yt_comment_id, our_reply_text,
  first_seen_at::text AS first_seen_at,
  last_synced_at::text AS last_synced_at
`;
// SELECT_COMMENT_COLS retained as documentation reference for the
// duplicated SELECTs below (sql template can't accept raw column
// strings). Update them in lock-step.
export const _SELECT_COMMENT_COLS = SELECT_COMMENT_COLS;

export interface ListCommentsOpts {
  videoId?: string;
  channelDbId?: string;
  intent?: CommentIntent;
  unrepliedOnly?: boolean;
  limit?: number;
}

export async function listComments(
  workspaceId: string,
  opts: ListCommentsOpts = {},
): Promise<YoutubeCommentRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds: string[] = ['workspace_id = $1::uuid', 'parent_yt_comment_id IS NULL'];
  const vals: unknown[] = [workspaceId];
  let i = 2;
  if (opts.videoId) {
    conds.push(`youtube_video_id = $${i++}`);
    vals.push(opts.videoId);
  }
  if (opts.channelDbId) {
    conds.push(`channel_db_id = $${i++}::uuid`);
    vals.push(opts.channelDbId);
  }
  if (opts.intent) {
    conds.push(`intent = $${i++}`);
    vals.push(opts.intent);
  }
  if (opts.unrepliedOnly) {
    conds.push(`replied = FALSE`);
  }
  vals.push(limit);
  const { rows } = await sql.query<YoutubeCommentRow>(
    `SELECT
        id, workspace_id, channel_db_id,
        youtube_video_id, youtube_comment_id, parent_yt_comment_id,
        author_name, author_channel_id, text, like_count, reply_count,
        published_at::text AS published_at,
        updated_at_yt::text AS updated_at_yt,
        moderation_status, author_is_channel_owner,
        intent, intent_confidence,
        intent_classified_at::text AS intent_classified_at,
        suggested_reply, ai_model,
        replied,
        replied_at::text AS replied_at,
        replied_with_yt_comment_id, our_reply_text,
        first_seen_at::text AS first_seen_at,
        last_synced_at::text AS last_synced_at
     FROM youtube_comments
     WHERE ${conds.join(' AND ')}
     ORDER BY published_at DESC NULLS LAST
     LIMIT $${i}`,
    vals,
  );
  return rows;
}

export async function getComment(id: string, workspaceId: string): Promise<YoutubeCommentRow | null> {
  const { rows } = await sql<YoutubeCommentRow>`
    SELECT
      id, workspace_id, channel_db_id,
      youtube_video_id, youtube_comment_id, parent_yt_comment_id,
      author_name, author_channel_id, text, like_count, reply_count,
      published_at::text AS published_at,
      updated_at_yt::text AS updated_at_yt,
      moderation_status, author_is_channel_owner,
      intent, intent_confidence,
      intent_classified_at::text AS intent_classified_at,
      suggested_reply, ai_model,
      replied,
      replied_at::text AS replied_at,
      replied_with_yt_comment_id, our_reply_text,
      first_seen_at::text AS first_seen_at,
      last_synced_at::text AS last_synced_at
    FROM youtube_comments
    WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Aggregate counts per intent for the workspace (or a single video) —
 *  drives the per-intent filter pill counts in the UI. */
export async function commentIntentCounts(
  workspaceId: string,
  opts: { videoId?: string; channelDbId?: string } = {},
): Promise<Record<string, number>> {
  if (opts.videoId) {
    const { rows } = await sql<{ intent: string | null; total: string }>`
      SELECT intent, COUNT(*)::text AS total
        FROM youtube_comments
       WHERE workspace_id = ${workspaceId}::uuid
         AND youtube_video_id = ${opts.videoId}
         AND parent_yt_comment_id IS NULL
       GROUP BY intent
    `;
    return Object.fromEntries(rows.map((r) => [r.intent ?? '_unclassified', Number(r.total)]));
  }
  if (opts.channelDbId) {
    const { rows } = await sql<{ intent: string | null; total: string }>`
      SELECT intent, COUNT(*)::text AS total
        FROM youtube_comments
       WHERE workspace_id = ${workspaceId}::uuid
         AND channel_db_id = ${opts.channelDbId}::uuid
         AND parent_yt_comment_id IS NULL
       GROUP BY intent
    `;
    return Object.fromEntries(rows.map((r) => [r.intent ?? '_unclassified', Number(r.total)]));
  }
  const { rows } = await sql<{ intent: string | null; total: string }>`
    SELECT intent, COUNT(*)::text AS total
      FROM youtube_comments
     WHERE workspace_id = ${workspaceId}::uuid
       AND parent_yt_comment_id IS NULL
     GROUP BY intent
  `;
  return Object.fromEntries(rows.map((r) => [r.intent ?? '_unclassified', Number(r.total)]));
}

/** Update a comment's intent + suggested_reply after AI classification.
 *  Used by comment-triage.ts. */
export async function persistIntentClassification(args: {
  id: string;
  workspaceId: string;
  intent: CommentIntent;
  confidence: number;
  suggestedReply: string | null;
  modelId: string;
}): Promise<void> {
  await sql`
    UPDATE youtube_comments
       SET intent = ${args.intent},
           intent_confidence = ${args.confidence.toFixed(3)},
           intent_classified_at = NOW(),
           suggested_reply = ${args.suggestedReply},
           ai_model = ${args.modelId}
     WHERE id = ${args.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
}

/** Pick N most-recent unclassified comments to feed into batch
 *  triage. Skips already-classified ones unless reclassify=true. */
export async function listCommentsForTriage(
  workspaceId: string,
  opts: { limit?: number; videoId?: string; reclassify?: boolean } = {},
): Promise<YoutubeCommentRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  if (opts.videoId) {
    if (opts.reclassify) {
      const { rows } = await sql<YoutubeCommentRow>`
        SELECT
          id, workspace_id, channel_db_id,
          youtube_video_id, youtube_comment_id, parent_yt_comment_id,
          author_name, author_channel_id, text, like_count, reply_count,
          published_at::text AS published_at,
          updated_at_yt::text AS updated_at_yt,
          moderation_status, author_is_channel_owner,
          intent, intent_confidence,
          intent_classified_at::text AS intent_classified_at,
          suggested_reply, ai_model,
          replied,
          replied_at::text AS replied_at,
          replied_with_yt_comment_id, our_reply_text,
          first_seen_at::text AS first_seen_at,
          last_synced_at::text AS last_synced_at
        FROM youtube_comments
        WHERE workspace_id = ${workspaceId}::uuid
          AND youtube_video_id = ${opts.videoId}
          AND parent_yt_comment_id IS NULL
        ORDER BY published_at DESC NULLS LAST
        LIMIT ${limit}
      `;
      return rows;
    }
    const { rows } = await sql<YoutubeCommentRow>`
      SELECT
        id, workspace_id, channel_db_id,
        youtube_video_id, youtube_comment_id, parent_yt_comment_id,
        author_name, author_channel_id, text, like_count, reply_count,
        published_at::text AS published_at,
        updated_at_yt::text AS updated_at_yt,
        moderation_status, author_is_channel_owner,
        intent, intent_confidence,
        intent_classified_at::text AS intent_classified_at,
        suggested_reply, ai_model,
        replied,
        replied_at::text AS replied_at,
        replied_with_yt_comment_id, our_reply_text,
        first_seen_at::text AS first_seen_at,
        last_synced_at::text AS last_synced_at
      FROM youtube_comments
      WHERE workspace_id = ${workspaceId}::uuid
        AND youtube_video_id = ${opts.videoId}
        AND parent_yt_comment_id IS NULL
        AND intent IS NULL
      ORDER BY published_at DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows;
  }
  if (opts.reclassify) {
    const { rows } = await sql<YoutubeCommentRow>`
      SELECT
        id, workspace_id, channel_db_id,
        youtube_video_id, youtube_comment_id, parent_yt_comment_id,
        author_name, author_channel_id, text, like_count, reply_count,
        published_at::text AS published_at,
        updated_at_yt::text AS updated_at_yt,
        moderation_status, author_is_channel_owner,
        intent, intent_confidence,
        intent_classified_at::text AS intent_classified_at,
        suggested_reply, ai_model,
        replied,
        replied_at::text AS replied_at,
        replied_with_yt_comment_id, our_reply_text,
        first_seen_at::text AS first_seen_at,
        last_synced_at::text AS last_synced_at
      FROM youtube_comments
      WHERE workspace_id = ${workspaceId}::uuid
        AND parent_yt_comment_id IS NULL
      ORDER BY published_at DESC NULLS LAST
      LIMIT ${limit}
    `;
    return rows;
  }
  const { rows } = await sql<YoutubeCommentRow>`
    SELECT
      id, workspace_id, channel_db_id,
      youtube_video_id, youtube_comment_id, parent_yt_comment_id,
      author_name, author_channel_id, text, like_count, reply_count,
      published_at::text AS published_at,
      updated_at_yt::text AS updated_at_yt,
      moderation_status, author_is_channel_owner,
      intent, intent_confidence,
      intent_classified_at::text AS intent_classified_at,
      suggested_reply, ai_model,
      replied,
      replied_at::text AS replied_at,
      replied_with_yt_comment_id, our_reply_text,
      first_seen_at::text AS first_seen_at,
      last_synced_at::text AS last_synced_at
    FROM youtube_comments
    WHERE workspace_id = ${workspaceId}::uuid
      AND parent_yt_comment_id IS NULL
      AND intent IS NULL
    ORDER BY published_at DESC NULLS LAST
    LIMIT ${limit}
  `;
  return rows;
}

// Re-export logger for the triage module to share.
export { logger };
