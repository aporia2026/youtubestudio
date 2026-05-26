'use client';

/**
 * MakeVideoButton — reusable "Make video from here" affordance.
 *
 * Any feature page (Niche Finder, Competitors, Video Analyzer, etc.)
 * that has a "thing the user might want to turn into a video" should
 * drop this in. It calls POST /api/videos with the prefilled context
 * and routes the user to /generator?videoId=NEW_ID so the Wave 1 strip
 * greets them.
 *
 * The button is intentionally non-customising — same shape, same label
 * pattern everywhere. Differentiation is via the `from` prop which
 * shows up in telemetry and the toast.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface Props {
  /** Video title to prefill. Required — without a title there's no
   *  video. The button shows an error toast if title is empty. */
  title: string;
  /** Optional niche to prefill. Saved on the project so the script
   *  generator targets it. */
  niche?: string | null;
  /** Optional channel link. Validated server-side against the
   *  workspace. */
  channelId?: string | null;
  /** Short description of where the user came from. Used in the
   *  success toast and in console logs for telemetry. */
  from: string;
  /** Optional label override; defaults to "+ Make video". */
  label?: string;
  /** Optional CSS class to size/position the button. The button
   *  brings its own purple-pill styling so this is for layout only. */
  className?: string;
  /** Compact variant for tight surfaces (table rows, card corners). */
  compact?: boolean;
}

export function MakeVideoButton({
  title,
  niche,
  channelId,
  from,
  label = '+ Make video',
  className,
  compact = false,
}: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleClick() {
    if (!title.trim()) {
      toast.error('Cannot make a video without a title');
      return;
    }
    setSubmitting(true);
    console.info('[make-video] start', { from, title_chars: title.length, has_niche: !!niche, has_channel: !!channelId });
    try {
      const res = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          niche: niche ?? '',
          channelId: channelId ?? null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = (json as { error?: string }).error ?? 'Failed to create video';
        toast.error(message);
        return;
      }
      const videoId = (json as { videoId: string }).videoId;
      toast.success(`Video created from ${from}`);
      router.push(`/generator?videoId=${encodeURIComponent(videoId)}`);
    } catch (err) {
      console.error('[make-video] error', err);
      toast.error('Failed to create video');
    } finally {
      setSubmitting(false);
    }
  }

  const sizeClasses = compact ? 'text-xs px-2 py-0.5' : 'text-sm px-3 py-1.5';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={submitting || !title.trim()}
      className={`${sizeClasses} rounded font-medium transition-opacity disabled:opacity-60 ${className ?? ''}`}
      style={{ background: 'var(--accent-purple)', color: 'white' }}
      title={submitting ? 'Creating…' : `Create a new video using "${title}"`}
    >
      {submitting ? 'Creating…' : label}
    </button>
  );
}
