'use client';

/**
 * ShortClipSurface — Mode A.
 *
 * The single UI shared by the Ideas + Scripts sections when
 * `medium=short_clip`. Lets the user:
 *
 *   1. Pick an OAuth-connected channel (auto-selected if only one).
 *   2. Pick a recent video from that channel.
 *   3. Run the clip scorer over the transcript.
 *   4. See top-N candidate moments with hook + payoff + score +
 *      timecode + a YouTube Studio deep link, plus a "Save to inbox"
 *      button per candidate.
 *
 * The "Save" action persists as `kind='channel_clip_recommendation'`,
 * `medium='short_clip'` so the global Shorts inbox + per-project tray
 * pick them up.
 *
 * Section-specific framing: Ideas treats the result as ideation
 * starting points; Scripts treats it as cut-this-clip recommendations.
 * The surface itself is identical; the parent page can pass a custom
 * `headline` to recolour the framing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

interface ChannelListItem {
  id: string;
  channel_id: string | null;
  name: string;
  handle: string | null;
  oauth_connected: boolean;
}

interface VideoListItem {
  id: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  duration: string;
  thumbnailUrl: string;
}

interface ClipCandidate {
  startMs: number;
  endMs: number;
  text: string;
  hookText: string;
  score: number;
  hookScore: number;
  payoffScore: number;
  standaloneScore: number;
  densityScore: number;
  wordCount: number;
  durationSeconds: number;
}

interface Props {
  /** Optional project id to attach candidates to when saving. When omitted,
   *  candidates land in the workspace's inbox without a project link. */
  projectId?: string;
  /** Section-specific headline. */
  headline?: string;
  /** Section-specific sub-line. */
  subhead?: string;
}

function formatMsAsTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function studioDeepLink(youtubeVideoId: string, startMs: number): string {
  // YouTube Studio's clip-editor URL — `t=` accepts a seconds value.
  const t = Math.max(0, Math.floor(startMs / 1000));
  return `https://studio.youtube.com/video/${encodeURIComponent(youtubeVideoId)}/edit?t=${t}`;
}

export function ShortClipSurface({ projectId, headline, subhead }: Props) {
  const [channels, setChannels] = useState<ChannelListItem[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [candidates, setCandidates] = useState<ClipCandidate[]>([]);
  const [finding, setFinding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load channels on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads channels
        const res = await fetch('/api/channels');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const list: ChannelListItem[] = (data.channels || []).filter(
          (c: ChannelListItem) => c.oauth_connected,
        );
        setChannels(list);
        if (list.length === 1) setSelectedChannelId(list[0]!.id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load channels');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load videos when channel changes.
  useEffect(() => {
    if (!selectedChannelId) {
      setVideos([]);
      setSelectedVideoId('');
      setCandidates([]);
      return;
    }
    let cancelled = false;
    setVideosLoading(true);
    setError(null);
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads channel videos
        const res = await fetch(
          `/api/shorts/channel-videos?channelDbId=${encodeURIComponent(selectedChannelId)}&limit=25`,
        );
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setVideos(data.videos || []);
        setSelectedVideoId('');
        setCandidates([]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load videos');
      } finally {
        if (!cancelled) setVideosLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedChannelId]);

  const findClips = useCallback(async () => {
    if (!selectedVideoId) return;
    setFinding(true);
    setError(null);
    setCandidates([]);
    try {
      const res = await fetch('/api/shorts/find-clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtubeVideoId: selectedVideoId,
          projectId,
          persist: false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setCandidates(data.candidates || []);
      if ((data.candidates || []).length === 0) {
        toast.info('No clip candidates found in this transcript.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to score clips');
    } finally {
      setFinding(false);
    }
  }, [selectedVideoId, projectId]);

  const saveCandidate = useCallback(
    async (candidate: ClipCandidate) => {
      if (!selectedVideoId) return;
      setSaving(true);
      try {
        const res = await fetch('/api/shorts/find-clips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            youtubeVideoId: selectedVideoId,
            projectId,
            persist: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        toast.success(`Saved ${data.persisted ?? 'candidates'} to the Shorts inbox.`);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to save');
      } finally {
        setSaving(false);
      }
    },
    [selectedVideoId, projectId],
  );

  const selectedVideo = useMemo(
    () => videos.find((v) => v.id === selectedVideoId),
    [videos, selectedVideoId],
  );

  const noChannels = channels.length === 0;

  return (
    <section
      style={{
        marginTop: 16,
        padding: 20,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
        maxWidth: 920,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
        {headline ?? 'Find Short clips inside an existing video'}
      </h2>
      {subhead && (
        <p style={{ marginTop: 6, marginBottom: 0, fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
          {subhead}
        </p>
      )}

      {noChannels && (
        <div
          style={{
            marginTop: 16,
            padding: 14,
            borderRadius: 10,
            border: '1px solid rgba(245,158,11,0.3)',
            background: 'rgba(245,158,11,0.06)',
            fontSize: 13,
          }}
        >
          Connect a channel via OAuth on a Channel page first — Mode A reads videos
          from your own connected channels only.
        </div>
      )}

      {!noChannels && (
        <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>Channel</span>
            <select
              value={selectedChannelId}
              onChange={(e) => setSelectedChannelId(e.target.value)}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <option value="">Pick a channel…</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.6))' }}>
              Video {videosLoading && '(loading…)'}
            </span>
            <select
              value={selectedVideoId}
              onChange={(e) => setSelectedVideoId(e.target.value)}
              disabled={!selectedChannelId || videosLoading || videos.length === 0}
              style={{
                padding: '8px 10px',
                borderRadius: 8,
                background: 'rgba(0,0,0,0.2)',
                color: 'inherit',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <option value="">Pick a video…</option>
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {selectedVideo && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          {selectedVideo.thumbnailUrl && (
            <img
              src={selectedVideo.thumbnailUrl}
              alt=""
              style={{ width: 80, height: 45, borderRadius: 6, objectFit: 'cover' }}
            />
          )}
          <div style={{ fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
            {selectedVideo.title}
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              {selectedVideo.viewCount.toLocaleString()} views
            </div>
          </div>
          <button
            type="button"
            onClick={findClips}
            disabled={finding}
            style={{
              marginLeft: 'auto',
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              cursor: finding ? 'wait' : 'pointer',
              fontWeight: 600,
              fontSize: 13,
              background: finding ? 'rgba(124,58,237,0.5)' : 'rgba(124,58,237,0.95)',
              color: '#fff',
            }}
          >
            {finding ? 'Scoring…' : 'Find clips'}
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 8,
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.08)',
            fontSize: 12,
            color: '#fca5a5',
          }}
        >
          {error}
        </div>
      )}

      {candidates.length > 0 && (
        <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {candidates.map((c, idx) => (
            <article
              key={`${c.startMs}-${c.endMs}`}
              style={{
                padding: 14,
                borderRadius: 12,
                background: 'rgba(0,0,0,0.18)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <header style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(124,58,237,0.18)',
                    color: '#c4b5fd',
                    fontWeight: 600,
                  }}
                >
                  #{idx + 1} • score {(c.score * 100).toFixed(0)}
                </span>
                <span>
                  {formatMsAsTimestamp(c.startMs)}–{formatMsAsTimestamp(c.endMs)} •{' '}
                  {c.durationSeconds}s • {c.wordCount} words
                </span>
                <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
                  hook {(c.hookScore * 100).toFixed(0)} • payoff {(c.payoffScore * 100).toFixed(0)} • density{' '}
                  {(c.densityScore * 100).toFixed(0)}
                </span>
              </header>
              <p style={{ marginTop: 10, marginBottom: 0, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                <strong style={{ color: '#fbbf24' }}>{c.hookText}</strong>
                {c.text.length > c.hookText.length && (
                  <span style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
                    {' '}
                    {c.text.slice(c.hookText.length).trim()}
                  </span>
                )}
              </p>
              <footer style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <a
                  href={selectedVideoId ? studioDeepLink(selectedVideoId, c.startMs) : '#'}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.15)',
                    background: 'transparent',
                    color: 'inherit',
                    textDecoration: 'none',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  Open in YouTube Studio →
                </a>
                <button
                  type="button"
                  onClick={() => saveCandidate(c)}
                  disabled={saving}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: 'none',
                    background: 'rgba(34,197,94,0.18)',
                    color: '#86efac',
                    cursor: saving ? 'wait' : 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                >
                  {saving ? 'Saving…' : 'Save all to inbox'}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
