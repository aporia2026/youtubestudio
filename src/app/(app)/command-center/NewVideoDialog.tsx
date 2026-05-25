'use client';

/**
 * New video dialog — Command Center's "+ New video" button opens this.
 *
 * Captures the minimum to start a video: title (required) + optional
 * channel + optional publish date. Calls POST /api/videos and, on
 * success, navigates to the generator with the new videoId so the
 * VideoContextStrip is already loaded and the user can start writing.
 *
 * Simple inline modal — fixed overlay + centered card, matches the
 * codebase's existing dialog style (no Radix dependency).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface ChannelOption {
  id: string;
  name: string;
  account_color: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  channels: ChannelOption[];
  /** Called after the new video is created so the caller can refresh
   *  the kanban snapshot before the redirect. */
  onCreated?: (videoId: string) => void;
}

export function NewVideoDialog({ open, onClose, channels, onCreated }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [channelId, setChannelId] = useState<string>(channels[0]?.id ?? '');
  const [scheduledFor, setScheduledFor] = useState<string>(defaultScheduledFor());
  const [submitting, setSubmitting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Reset + focus when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setChannelId(channels[0]?.id ?? '');
    setScheduledFor(defaultScheduledFor());
    // Focus next tick so the input exists in the DOM.
    setTimeout(() => titleInputRef.current?.focus(), 0);
  }, [open, channels]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  async function submit() {
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    setSubmitting(true);
    console.info('[command-center new-video] submit', {
      has_channel: !!channelId,
      has_schedule: !!scheduledFor,
    });
    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          channelId: channelId || null,
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? 'Failed to create video');
        return;
      }
      const newVideoId = (json as { videoId: string }).videoId;
      toast.success('Video created');
      onCreated?.(newVideoId);
      // Land on the script generator with the new video selected — the
      // Wave 1 strip is then visible at the top.
      router.push(`/generator?videoId=${encodeURIComponent(newVideoId)}`);
      onClose();
    } catch (err) {
      console.error('[command-center new-video] error', err);
      toast.error('Failed to create video');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onMouseDown={e => {
        // Click outside the card to close (only when not submitting).
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Create a new video"
    >
      <div
        className="w-full max-w-md rounded-lg p-5"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
      >
        <header className="mb-4">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>New video</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Start a video. You can pick a channel and a publish date now, or come back to it later from the kanban.
          </p>
        </header>

        <form
          onSubmit={e => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-3"
        >
          <label className="block">
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Title</span>
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={300}
              placeholder="What is this video about?"
              required
              className="mt-1 w-full px-3 py-2 rounded text-sm"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </label>

          {channels.length > 0 && (
            <label className="block">
              <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Channel</span>
              <select
                value={channelId}
                onChange={e => setChannelId(e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded text-sm"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                <option value="">No channel — assign later</option>
                {channels.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Publish date (optional)</span>
            <input
              type="date"
              value={scheduledFor}
              onChange={e => setScheduledFor(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded text-sm"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
            <span className="text-[11px] mt-1 inline-block" style={{ color: 'var(--text-muted)' }}>
              Sets the schedule slot. You can move or remove it from the Schedule later.
            </span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="text-sm px-3 py-1.5 rounded font-medium disabled:opacity-60"
              style={{ background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="text-sm px-3 py-1.5 rounded font-medium disabled:opacity-60"
              style={{ background: 'var(--accent-purple)', color: 'white' }}
            >
              {submitting ? 'Creating…' : 'Create + open script'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Default to one week from today, formatted YYYY-MM-DD for the date input. */
function defaultScheduledFor(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
