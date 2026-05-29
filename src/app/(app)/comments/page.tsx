'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  COMMENT_INTENT_META,
  COMMENT_INTENT_VALUES,
  type CommentIntent,
  type YoutubeCommentRow,
} from '@/lib/youtube-comments-types';

interface ChannelOpt {
  id: string;
  name: string;
  oauth_connected: boolean;
}

interface VideoOpt {
  youtube_video_id: string;
  title: string | null;
  channel_id: string | null;
  average_view_percentage: number | null;
}

export default function CommentsPage() {
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [videos, setVideos] = useState<VideoOpt[]>([]);
  const [comments, setComments] = useState<YoutubeCommentRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [channelDbId, setChannelDbId] = useState('');
  const [youtubeVideoId, setYoutubeVideoId] = useState('');
  const [intent, setIntent] = useState<CommentIntent | ''>('');
  const [unrepliedOnly, setUnrepliedOnly] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [triaging, setTriaging] = useState(false);

  const filteredVideos = useMemo(
    () => (channelDbId ? videos.filter((v) => v.channel_id === channelDbId) : videos),
    [videos, channelDbId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chRes, vidRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads channels
          fetch('/api/channels'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads video-analytics
          fetch('/api/video-analytics?limit=80'),
        ]);
        if (cancelled) return;
        if (chRes.ok) setChannels(((await chRes.json()).channels as ChannelOpt[]) || []);
        if (vidRes.ok) {
          const data = await vidRes.json();
          const list = (data?.rows ?? data?.analytics ?? []) as VideoOpt[];
          setVideos(list);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshComments() {
    try {
      const params = new URLSearchParams();
      if (youtubeVideoId) params.set('videoId', youtubeVideoId);
      if (channelDbId) params.set('channelDbId', channelDbId);
      if (intent) params.set('intent', intent);
      if (unrepliedOnly) params.set('unrepliedOnly', '1');
      params.set('limit', '200');
      // eslint-disable-next-line no-restricted-syntax -- GET, loads comments
      const res = await fetch(`/api/comments?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setComments((data.comments as YoutubeCommentRow[]) || []);
      setCounts((data.counts as Record<string, number>) || {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load comments');
    }
  }

  // Refresh when filters change.
  useEffect(() => {
    void refreshComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [youtubeVideoId, channelDbId, intent, unrepliedOnly]);

  async function syncVideo() {
    if (!youtubeVideoId) {
      setError('Pick or paste a YouTube video id first.');
      return;
    }
    setSyncing(true);
    setError(null);
    setInfo(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited sync POST - RPC
      const res = await fetch('/api/comments/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeVideoId, channelDbId: channelDbId || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setInfo(`Synced ${data.fetched} comments — ${data.inserted} new, ${data.updated} updated.`);
      await refreshComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  async function triageBatch() {
    setTriaging(true);
    setError(null);
    setInfo(null);
    try {
      const video = filteredVideos.find((v) => v.youtube_video_id === youtubeVideoId);
      const channel = channels.find((c) => c.id === channelDbId);
      // eslint-disable-next-line no-restricted-syntax -- awaited triage POST - RPC
      const res = await fetch('/api/comments/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: youtubeVideoId || undefined,
          limit: 25,
          contextual: {
            videoTitle: video?.title ?? undefined,
            channelName: channel?.name ?? undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const failedSummary = data.failed?.length ? ` (${data.failed.length} failed)` : '';
      setInfo(`Classified ${data.triaged.length} of ${data.considered}${failedSummary}.`);
      await refreshComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Triage failed');
    } finally {
      setTriaging(false);
    }
  }

  async function reply(c: YoutubeCommentRow, text: string) {
    if (!text.trim()) return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited reply POST - RPC
      const res = await fetch(`/api/comments/${c.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replyText: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      await refreshComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reply failed');
    }
  }

  async function moderate(c: YoutubeCommentRow, status: 'rejected' | 'heldForReview') {
    if (status === 'rejected' && !confirm('Reject this comment? It will be hidden from viewers.')) {
      return;
    }
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited moderate POST - RPC
      const res = await fetch(`/api/comments/${c.id}/moderate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      await refreshComments();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Moderate failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Comments</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Sync, AI-triage, reply, and moderate YouTube comments across all your channels in one place.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}
      {info && !error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(74,222,128,0.10)', color: '#4ade80' }}>
          {info}
        </div>
      )}

      <div className="glass rounded-xl p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Field label="Channel">
            <select
              value={channelDbId}
              onChange={(e) => setChannelDbId(e.target.value)}
              className="input-field"
            >
              <option value="">— any channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id} disabled={!c.oauth_connected}>
                  {c.name}{c.oauth_connected ? '' : ' (not connected)'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Video">
            <select
              value={youtubeVideoId}
              onChange={(e) => setYoutubeVideoId(e.target.value)}
              className="input-field"
            >
              <option value="">— any video —</option>
              {filteredVideos.map((v) => (
                <option key={v.youtube_video_id} value={v.youtube_video_id}>
                  {(v.title ?? v.youtube_video_id).slice(0, 80)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="…or paste video id">
            <input
              type="text"
              value={youtubeVideoId}
              onChange={(e) => setYoutubeVideoId(e.target.value)}
              className="input-field font-mono text-xs"
              placeholder="dQw4w9WgXcQ"
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={syncVideo}
            disabled={syncing || !youtubeVideoId}
            className="btn-primary text-sm"
          >
            {syncing ? 'Syncing…' : '↻ Sync from YouTube'}
          </button>
          <button
            type="button"
            onClick={triageBatch}
            disabled={triaging || comments.length === 0}
            className="text-sm px-3 py-1.5 rounded"
            style={{ background: 'rgba(168,85,247,0.12)', color: '#c084fc' }}
          >
            {triaging ? 'Triaging…' : '✨ AI-triage 25'}
          </button>
          <label className="ml-auto text-xs flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={unrepliedOnly}
              onChange={(e) => setUnrepliedOnly(e.target.checked)}
            />
            Unreplied only
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <FilterPill
          label="All"
          count={Object.values(counts).reduce((a, b) => a + b, 0)}
          active={!intent}
          onClick={() => setIntent('')}
        />
        {COMMENT_INTENT_VALUES.map((i) => (
          <FilterPill
            key={i}
            label={COMMENT_INTENT_META[i].label}
            count={counts[i] ?? 0}
            color={COMMENT_INTENT_META[i].color}
            active={intent === i}
            onClick={() => setIntent(intent === i ? '' : i)}
          />
        ))}
        {counts._unclassified ? (
          <FilterPill
            label="Unclassified"
            count={counts._unclassified}
            active={false}
            onClick={() => {
              setIntent('');
              setUnrepliedOnly(false);
            }}
          />
        ) : null}
      </div>

      {comments.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          {youtubeVideoId
            ? 'No comments yet. Click "Sync from YouTube" to pull them.'
            : 'Pick a video to see comments.'}
        </div>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <CommentRow
              key={c.id}
              comment={c}
              onReply={(text) => reply(c, text)}
              onReject={() => moderate(c, 'rejected')}
              onHold={() => moderate(c, 'heldForReview')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function FilterPill({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  const c = color ?? 'var(--text-secondary)';
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-3 py-1 rounded-full inline-flex items-center gap-1.5"
      style={{
        background: active ? `${c}22` : 'var(--bg-card)',
        color: active ? c : 'var(--text-secondary)',
        border: `1px solid ${active ? c : 'var(--border)'}`,
      }}
    >
      {label}
      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{count}</span>
    </button>
  );
}

function CommentRow({
  comment,
  onReply,
  onReject,
  onHold,
}: {
  comment: YoutubeCommentRow;
  onReply: (text: string) => void;
  onReject: () => void;
  onHold: () => void;
}) {
  const [draft, setDraft] = useState(comment.suggested_reply ?? '');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setDraft(comment.suggested_reply ?? '');
  }, [comment.suggested_reply]);

  const intentMeta = comment.intent ? COMMENT_INTENT_META[comment.intent] : null;
  return (
    <div
      className="glass rounded-xl p-4"
      style={{ borderLeft: intentMeta ? `3px solid ${intentMeta.color}` : '3px solid transparent' }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {comment.author_name ?? 'unknown'}
          </span>
          {intentMeta && (
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: `${intentMeta.color}22`, color: intentMeta.color }}
            >
              {intentMeta.label}
              {comment.intent_confidence !== null && comment.intent_confidence < 0.7 && (
                <span style={{ opacity: 0.6 }}> · low conf</span>
              )}
            </span>
          )}
          {comment.replied && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(74,222,128,0.15)', color: '#4ade80' }}>
              replied
            </span>
          )}
          {comment.moderation_status === 'rejected' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
              rejected
            </span>
          )}
        </div>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {comment.like_count > 0 && `❤ ${comment.like_count} · `}
          {comment.published_at && new Date(comment.published_at).toLocaleString()}
        </span>
      </div>
      <p className="text-sm mb-2 whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
        {comment.text}
      </p>
      {comment.our_reply_text && (
        <div
          className="text-xs italic p-2 rounded mb-2"
          style={{ background: 'rgba(74,222,128,0.08)', color: 'var(--text-secondary)' }}
        >
          ↳ You: {comment.our_reply_text}
        </div>
      )}
      <div className="flex items-center gap-2">
        {!comment.replied && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}
          >
            {open ? 'Hide reply' : 'Reply'}
          </button>
        )}
        {comment.moderation_status !== 'rejected' && (
          <>
            <button
              type="button"
              onClick={onHold}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'rgba(251,191,36,0.10)', color: '#fbbf24' }}
              title="Hold for review (hides from viewers until you publish)"
            >
              Hold
            </button>
            <button
              type="button"
              onClick={onReject}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
            >
              Reject
            </button>
          </>
        )}
      </div>
      {open && !comment.replied && (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="input-field font-sans text-sm w-full"
            placeholder="Type your reply…"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onReply(draft);
                setOpen(false);
              }}
              disabled={!draft.trim()}
              className="btn-primary text-xs"
            >
              Send reply
            </button>
            {comment.suggested_reply && draft !== comment.suggested_reply && (
              <button
                type="button"
                onClick={() => setDraft(comment.suggested_reply!)}
                className="text-xs px-2 py-1 rounded"
                style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
              >
                ↶ Restore AI suggestion
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
