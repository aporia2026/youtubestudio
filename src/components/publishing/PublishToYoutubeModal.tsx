'use client';

/**
 * Publish-to-YouTube modal. Surfaced from /schedule (ItemDetail) and
 * /projects/[id] — anywhere the user has a finished MP4 they want to
 * upload directly to YouTube without leaving the app.
 *
 * Inputs map 1:1 onto videos.insert + thumbnails.set + playlistItems.insert:
 *   - source video URL (Vercel Blob URL or external https)
 *   - title / description / tags / category / privacy / made-for-kids
 *   - scheduled publishAt (only honoured when privacy=private + future)
 *   - optional thumbnail URL (https) — overrides YouTube's auto-pick
 *   - optional playlist id
 *
 * After submit, the modal stays open and polls /api/publishing/[id]
 * every 5s. Status badge flips queued → uploading → processing → live.
 * Closing the modal cancels the polling but the row keeps progressing
 * server-side (the cron will flip it to live eventually).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { PublishStatus, PublishedVideoRow } from '@/lib/publishing-types';

interface ChannelLite {
  id: string;
  name: string;
  oauth_connected: boolean;
}

export interface PublishToYoutubeModalProps {
  open: boolean;
  onClose: () => void;

  // Optional defaults — pre-filled when known.
  defaultChannelId?: string;
  defaultTitle?: string;
  defaultDescription?: string;
  defaultTags?: string[];
  defaultProjectId?: string;
  defaultScheduleItemId?: string;
  defaultSourceVideoUrl?: string;
  defaultThumbnailUrl?: string;

  /** Called right after the publish row is created. */
  onPublishStarted?: (publishId: string) => void;
}

// YouTube category ids used most often by creator videos. Full list:
// https://developers.google.com/youtube/v3/docs/videoCategories/list
const COMMON_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: '22', label: 'People & Blogs' },
  { id: '24', label: 'Entertainment' },
  { id: '27', label: 'Education' },
  { id: '28', label: 'Science & Technology' },
  { id: '20', label: 'Gaming' },
  { id: '10', label: 'Music' },
  { id: '17', label: 'Sports' },
  { id: '26', label: 'Howto & Style' },
  { id: '23', label: 'Comedy' },
  { id: '25', label: 'News & Politics' },
];

const POLL_INTERVAL_MS = 5_000;

export function PublishToYoutubeModal({
  open,
  onClose,
  defaultChannelId,
  defaultTitle,
  defaultDescription,
  defaultTags,
  defaultProjectId,
  defaultScheduleItemId,
  defaultSourceVideoUrl,
  defaultThumbnailUrl,
  onPublishStarted,
}: PublishToYoutubeModalProps) {
  // ─── Form state ───────────────────────────────────────────────────────
  const [channels, setChannels] = useState<ChannelLite[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [channelDbId, setChannelDbId] = useState(defaultChannelId ?? '');
  const [sourceVideoUrl, setSourceVideoUrl] = useState(defaultSourceVideoUrl ?? '');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [description, setDescription] = useState(defaultDescription ?? '');
  const [tagsText, setTagsText] = useState((defaultTags ?? []).join(', '));
  const [categoryId, setCategoryId] = useState('22');
  const [privacyStatus, setPrivacyStatus] = useState<'private' | 'unlisted' | 'public'>('private');
  const [publishAt, setPublishAt] = useState('');
  const [madeForKids, setMadeForKids] = useState(false);
  const [thumbnailUrl, setThumbnailUrl] = useState(defaultThumbnailUrl ?? '');
  const [playlistId, setPlaylistId] = useState('');

  // ─── Submission + polling state ───────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [publishRow, setPublishRow] = useState<PublishedVideoRow | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Reset every form field to its `default…` prop whenever the modal
  // opens. Without this, the modal that was opened for project A
  // retains A's title/description/tags when reopened for project B
  // (audit M4). The reset also clears any submission state from a
  // previous use so opening a fresh modal doesn't show the old status
  // panel.
  useEffect(() => {
    if (!open) return;
    setChannelDbId(defaultChannelId ?? '');
    setSourceVideoUrl(defaultSourceVideoUrl ?? '');
    setTitle(defaultTitle ?? '');
    setDescription(defaultDescription ?? '');
    setTagsText((defaultTags ?? []).join(', '));
    setCategoryId('22');
    setPrivacyStatus('private');
    setPublishAt('');
    setMadeForKids(false);
    setThumbnailUrl(defaultThumbnailUrl ?? '');
    setPlaylistId('');
    setPublishRow(null);
    setSubmitting(false);
  }, [open, defaultChannelId, defaultSourceVideoUrl, defaultTitle, defaultDescription, defaultTags, defaultThumbnailUrl]);

  // Escape-to-close + initial focus on the title input. Both standard
  // dialog-accessibility patterns. Focus shifts to the title because
  // it's the first user-editable field; the channel picker is below
  // the source-URL paste, which usually arrives pre-filled.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // requestAnimationFrame so the input exists in the DOM before
    // we try to focus it (the modal renders synchronously when `open`
    // flips true but focus has to wait for the paint).
    const raf = requestAnimationFrame(() => titleInputRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
    };
  }, [open, onClose]);

  // Load OAuth-connected channels once when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/channels')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const all: ChannelLite[] = data.channels ?? [];
        const connected = all.filter((c) => c.oauth_connected);
        setChannels(connected);
        // Auto-pick if there's exactly one connected channel and the
        // caller didn't pre-fill one.
        if (!channelDbId && connected.length === 1) setChannelDbId(connected[0].id);
      })
      .catch(() => {
        if (!cancelled) toast.error('Could not load channels');
      })
      .finally(() => {
        if (!cancelled) setLoadingChannels(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Poll the publish row while it's not in a terminal state.
  useEffect(() => {
    if (!publishRow || publishRow.status === 'live' || publishRow.status === 'failed') {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
      return;
    }
    let cancelled = false;
    function tick() {
      // POST to the explicit /poll endpoint — hits YouTube once and
      // returns the refreshed row. The plain GET is DB-only now (M9).
      fetch(`/api/publishing/${publishRow!.id}/poll`, { method: 'POST' })
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          if (data.publish) setPublishRow(data.publish as PublishedVideoRow);
        })
        .catch(() => { /* swallow — next tick will retry */ })
        .finally(() => {
          if (cancelled) return;
          pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        });
    }
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [publishRow]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  const tags = useMemo(
    () => tagsText.split(',').map((t) => t.trim()).filter(Boolean),
    [tagsText],
  );

  async function submit() {
    if (!channelDbId) { toast.error('Pick a channel'); return; }
    if (!sourceVideoUrl.trim()) { toast.error('Source video URL is required'); return; }
    if (!title.trim()) { toast.error('Title is required'); return; }
    if (publishAt && privacyStatus !== 'private') {
      toast.error('Scheduled publish only works with privacy = private'); return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/publishing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelDbId,
          projectId: defaultProjectId,
          scheduleItemId: defaultScheduleItemId,
          sourceVideoUrl: sourceVideoUrl.trim(),
          title: title.trim(),
          description,
          tags,
          categoryId,
          privacyStatus,
          publishAt: publishAt ? new Date(publishAt).toISOString() : null,
          madeForKids,
          thumbnailUrl: thumbnailUrl.trim() || null,
          playlistId: playlistId.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Publish failed');
      // Fetch the full row so the status panel has all fields.
      const rowRes = await fetch(`/api/publishing/${json.id}`);
      const rowJson = await rowRes.json();
      const row = (rowJson.publish ?? null) as PublishedVideoRow | null;
      if (row) {
        setPublishRow(row);
        onPublishStarted?.(row.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setPublishRow(null);
    setSubmitting(false);
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => {
        // Backdrop click closes; clicks inside the dialog don't bubble
        // here because the inner div stops them via onClick stopPropagation.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-modal-title"
        className="glass rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-4">
          <h2 id="publish-modal-title" className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            📺 Publish to YouTube
          </h2>
          <button
            onClick={onClose}
            aria-label="Close publish dialog"
            className="text-sm hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            Close
          </button>
        </div>

        {publishRow ? (
          <PublishStatusPanel row={publishRow} onPublishAnother={reset} />
        ) : (
          <div className="space-y-4">
            {/* Channel */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                Channel <span style={{ color: '#ef4444' }}>*</span>
              </label>
              {loadingChannels ? (
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading channels…</p>
              ) : channels.length === 0 ? (
                <p className="text-xs" style={{ color: '#ef4444' }}>
                  No OAuth-connected channels. Connect one in Settings → API → Google.
                </p>
              ) : (
                <select
                  value={channelDbId}
                  onChange={(e) => setChannelDbId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="">— pick a channel —</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Source video URL */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                Source video URL <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                type="url"
                value={sourceVideoUrl}
                onChange={(e) => setSourceVideoUrl(e.target.value)}
                placeholder="https://blob.vercel-storage.com/…/video.mp4"
                className="w-full px-3 py-2 rounded-lg text-sm font-mono"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                Vercel Blob URL (from /api/render/*) or any public https URL serving the MP4.
              </p>
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                Title <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                ref={titleInputRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <p className="text-[11px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>{title.length}/100</p>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={5000}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <p className="text-[11px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>{description.length}/5000</p>
            </div>

            {/* Tags */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Tags (comma-separated)</label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="react, next.js, web dev"
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {tags.length} tag{tags.length === 1 ? '' : 's'} · combined length {tags.reduce((n, t) => n + t.length, 0)}/500
              </p>
            </div>

            {/* Category + Privacy on one row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Category</label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {COMMON_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Privacy</label>
                <select
                  value={privacyStatus}
                  onChange={(e) => setPrivacyStatus(e.target.value as typeof privacyStatus)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </div>
            </div>

            {/* Scheduled publish — only shown for private */}
            {privacyStatus === 'private' && (
              <div>
                <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                  Scheduled publish (optional — flips to public at this time)
                </label>
                <input
                  type="datetime-local"
                  value={publishAt}
                  onChange={(e) => setPublishAt(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                />
              </div>
            )}

            {/* Made for kids */}
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={madeForKids}
                onChange={(e) => setMadeForKids(e.target.checked)}
              />
              Made for kids (COPPA compliance)
            </label>

            {/* Thumbnail */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                Thumbnail URL (optional — overrides YouTube auto-pick)
              </label>
              <input
                type="url"
                value={thumbnailUrl}
                onChange={(e) => setThumbnailUrl(e.target.value)}
                placeholder="https://blob.vercel-storage.com/…/thumb.jpg"
                className="w-full px-3 py-2 rounded-lg text-sm font-mono"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>

            {/* Playlist */}
            <div>
              <label className="block text-xs mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>
                Playlist ID (optional — adds the video to this playlist)
              </label>
              <input
                type="text"
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                placeholder="PLxxxxxxxxxxxxxxxx"
                className="w-full px-3 py-2 rounded-lg text-sm font-mono"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting || !channelDbId || !sourceVideoUrl || !title}
                className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#ef4444', color: 'white' }}
              >
                {submitting ? 'Starting upload…' : 'Publish to YouTube'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PublishStatusPanel({
  row,
  onPublishAnother,
}: {
  row: PublishedVideoRow;
  onPublishAnother: () => void;
}) {
  const meta = STATUS_META[row.status];
  return (
    <div className="space-y-4">
      <div
        className="rounded-lg p-4 flex items-center gap-3"
        style={{ background: meta.bg, border: `1px solid ${meta.border}` }}
      >
        <div className="text-2xl">{meta.icon}</div>
        <div className="flex-1">
          <p className="text-sm font-semibold" style={{ color: meta.color }}>{meta.label}</p>
          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{meta.subtitle}</p>
        </div>
      </div>

      {row.youtube_url && (
        <a
          href={row.youtube_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm hover:underline"
          style={{ color: 'var(--accent-cyan-bright)' }}
        >
          {row.youtube_url} ↗
        </a>
      )}

      {row.error_message && (
        <div className="rounded-lg p-3 text-xs" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
          {row.error_message}
        </div>
      )}

      <div className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
        <p><strong>Title:</strong> {row.title}</p>
        <p><strong>Privacy:</strong> {row.privacy_status_actual ?? row.privacy_status}</p>
        {row.publish_at && <p><strong>Scheduled:</strong> {new Date(row.publish_at).toLocaleString()}</p>}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          onClick={onPublishAnother}
          className="px-4 py-2 rounded-lg text-sm"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
        >
          Publish another
        </button>
      </div>
    </div>
  );
}

const STATUS_META: Record<PublishStatus, {
  icon: string;
  label: string;
  subtitle: string;
  bg: string;
  border: string;
  color: string;
}> = {
  queued: {
    icon: '⏱️',
    label: 'Queued',
    subtitle: 'Waiting to start the upload.',
    bg: 'rgba(124,58,237,0.1)',
    border: 'rgba(124,58,237,0.3)',
    color: '#a78bfa',
  },
  uploading: {
    icon: '⬆️',
    label: 'Uploading to YouTube',
    subtitle: 'Sending the video bytes — this can take a few minutes for large files.',
    bg: 'rgba(6,182,212,0.1)',
    border: 'rgba(6,182,212,0.3)',
    color: '#06b6d4',
  },
  processing: {
    icon: '🎬',
    label: 'YouTube is processing',
    subtitle: 'Upload finished. YouTube is transcoding — usually live within minutes.',
    bg: 'rgba(245,158,11,0.1)',
    border: 'rgba(245,158,11,0.3)',
    color: '#f59e0b',
  },
  live: {
    icon: '✅',
    label: 'Live on YouTube',
    subtitle: 'Done — your video is published.',
    bg: 'rgba(16,185,129,0.1)',
    border: 'rgba(16,185,129,0.3)',
    color: '#10b981',
  },
  failed: {
    icon: '❌',
    label: 'Publish failed',
    subtitle: 'See the error below. The row is preserved so you can retry.',
    bg: 'rgba(239,68,68,0.1)',
    border: 'rgba(239,68,68,0.3)',
    color: '#ef4444',
  },
};
