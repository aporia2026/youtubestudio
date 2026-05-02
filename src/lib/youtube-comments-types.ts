/**
 * Client-safe types for the comment-management surface.
 */

export type CommentIntent =
  | 'question'
  | 'support'
  | 'troll'
  | 'fan'
  | 'spam'
  | 'feedback'
  | 'self_promo'
  | 'other';

export type CommentModerationStatus =
  | 'heldForReview'
  | 'published'
  | 'rejected'
  | 'likelySpam'
  | null;

export interface YoutubeCommentRow {
  id: string;
  workspace_id: string;
  channel_db_id: string | null;

  youtube_video_id: string;
  youtube_comment_id: string;
  parent_yt_comment_id: string | null;

  author_name: string | null;
  author_channel_id: string | null;
  text: string;
  like_count: number;
  reply_count: number;
  published_at: string | null;
  updated_at_yt: string | null;

  moderation_status: CommentModerationStatus;
  author_is_channel_owner: boolean;

  intent: CommentIntent | null;
  intent_confidence: number | null;
  intent_classified_at: string | null;
  suggested_reply: string | null;
  ai_model: string | null;

  replied: boolean;
  replied_at: string | null;
  replied_with_yt_comment_id: string | null;
  our_reply_text: string | null;

  first_seen_at: string;
  last_synced_at: string;
}

export interface CommentSyncRunRow {
  id: string;
  workspace_id: string;
  channel_db_id: string | null;
  youtube_video_id: string;
  status: 'running' | 'completed' | 'failed';
  error_message: string | null;
  comments_fetched: number;
  comments_inserted: number;
  comments_updated: number;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
}

/** Display labels + colors for the intent enum — used by the UI to
 *  render the per-intent filter pills consistently. */
export const COMMENT_INTENT_META: Record<
  CommentIntent,
  { label: string; color: string; description: string }
> = {
  question: {
    label: 'Question',
    color: '#60a5fa',
    description: 'The viewer is asking something — usually deserves a reply.',
  },
  support: {
    label: 'Help / support',
    color: '#fbbf24',
    description: "Viewer needs help (broken link, can't find a thing). Reply or pin a known fix.",
  },
  fan: {
    label: 'Fan / praise',
    color: '#4ade80',
    description: 'Positive engagement. Heart for the algorithm.',
  },
  feedback: {
    label: 'Constructive feedback',
    color: '#a78bfa',
    description: 'Substantive criticism worth reading carefully.',
  },
  troll: {
    label: 'Troll / hostile',
    color: '#f87171',
    description: 'Bait or insult. Usually best to ignore — sometimes hold-for-review.',
  },
  spam: {
    label: 'Spam',
    color: '#94a3b8',
    description: 'Bot, scam, link spam. Reject.',
  },
  self_promo: {
    label: 'Self-promo',
    color: '#94a3b8',
    description: "Other creator pushing their channel. Hide unless it's relevant.",
  },
  other: {
    label: 'Other',
    color: '#94a3b8',
    description: "Doesn't fit a clear bucket.",
  },
};

export const COMMENT_INTENT_VALUES: CommentIntent[] = Object.keys(
  COMMENT_INTENT_META,
) as CommentIntent[];

export function isCommentIntent(v: unknown): v is CommentIntent {
  return typeof v === 'string' && (COMMENT_INTENT_VALUES as string[]).includes(v);
}

export const MAX_REPLY_LENGTH = 9500; // YouTube's hard limit
