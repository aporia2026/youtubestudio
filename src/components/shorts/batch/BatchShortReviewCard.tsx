'use client';

/**
 * BatchShortReviewCard — one card in the step-4 review queue. Shows
 * a video preview + editable YouTube metadata fields. Saves on blur
 * via PATCH /api/shorts/[id]/youtube-metadata; the parent re-fetches
 * the batch after a save to keep totals fresh.
 *
 * Every field defaults to the SEO-generated seed; the user only
 * touches what they want to change.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  YOUTUBE_TITLE_MAX,
  YOUTUBE_DESCRIPTION_MAX,
} from '@/lib/youtube-upload';
import { YOUTUBE_CATEGORIES } from '@/lib/youtube-categories';
import { TagTokenInput } from './TagTokenInput';
import { PlaylistMultiSelect } from './PlaylistMultiSelect';
import { TimezoneSelect } from './TimezoneSelect';
import {
  localInputValueToUtcIso,
  utcIsoToLocalInputValue,
} from '@/lib/timezone-conversion';
import type { ShortRow } from '@/lib/shorts-types';
import type { YoutubeUploadMetadata } from '@/lib/shorts-batches-types';

export function BatchShortReviewCard({
  short,
  channelId,
  batchTimezone,
  onSaved,
}: {
  short: ShortRow;
  channelId: string;
  batchTimezone: string;
  onSaved: () => void;
}) {
  const [metadata, setMetadata] = useState<YoutubeUploadMetadata>(short.youtube_metadata);
  const [publishAt, setPublishAt] = useState<string | null>(short.youtube_publish_at);
  const [tz, setTz] = useState(batchTimezone);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<YoutubeUploadMetadata>) => {
    setMetadata((prev) => ({ ...prev, ...p }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/shorts/${short.id}/youtube-metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata, publishAt }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const titleCharsLeft = YOUTUBE_TITLE_MAX - (metadata.title ?? '').length;
  const descCharsLeft = YOUTUBE_DESCRIPTION_MAX - (metadata.description ?? '').length;

  return (
    <article className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-card)] shadow-sm">
      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[200px_1fr]">
        <div className="flex flex-col items-center gap-2">
          {short.rendered_video_url ? (
            <video
              src={short.rendered_video_url}
              controls
              playsInline
              className="aspect-[9/16] w-[180px] rounded-md bg-black"
            />
          ) : (
            <div className="flex aspect-[9/16] w-[180px] items-center justify-center rounded-md bg-white/[0.05] text-xs text-[var(--text-muted)]">
              No render yet
            </div>
          )}
          {short.youtube_status === 'uploaded' && short.youtube_video_id && (
            <a
              href={`https://studio.youtube.com/video/${short.youtube_video_id}/edit`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-[var(--accent-green)] underline hover:text-[var(--accent-green)]/80"
            >
              Open in YouTube Studio →
            </a>
          )}
          {short.youtube_status === 'failed' && short.youtube_upload_error && (
            <p className="max-w-[180px] text-xs text-red-400" title={short.youtube_upload_error}>
              Upload failed: {short.youtube_upload_error.slice(0, 80)}
              {short.youtube_upload_error.length > 80 ? '…' : ''}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)]">Title</label>
            <input
              type="text"
              value={metadata.title ?? ''}
              onChange={(e) => patch({ title: e.target.value })}
              onBlur={save}
              maxLength={YOUTUBE_TITLE_MAX}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
            />
            <span
              className={[
                'mt-0.5 block text-xs',
                titleCharsLeft < 10 ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-muted)]',
              ].join(' ')}
            >
              {titleCharsLeft} chars left
            </span>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
          >
            {expanded ? 'Hide details' : 'Edit description, tags, schedule…'}
          </button>

          {expanded && (
            <div className="space-y-3 border-t border-[var(--border)] pt-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)]">Description</label>
                <textarea
                  value={metadata.description ?? ''}
                  onChange={(e) => patch({ description: e.target.value })}
                  onBlur={save}
                  rows={5}
                  className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
                />
                <span
                  className={[
                    'mt-0.5 block text-xs',
                    descCharsLeft < 100 ? 'text-[var(--accent-yellow)]' : 'text-[var(--text-muted)]',
                  ].join(' ')}
                >
                  {descCharsLeft} chars left
                </span>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)]">Tags</label>
                <TagTokenInput
                  tags={metadata.tags ?? []}
                  onChange={(tags) => {
                    patch({ tags });
                    void save();
                  }}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">Category</label>
                  <select
                    value={metadata.categoryId ?? ''}
                    onChange={(e) => {
                      patch({ categoryId: e.target.value || undefined });
                      void save();
                    }}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
                  >
                    <option value="">—</option>
                    {YOUTUBE_CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">Privacy at publish</label>
                  <select
                    value={metadata.privacy ?? 'public'}
                    onChange={(e) => {
                      patch({ privacy: e.target.value as 'public' | 'private' | 'unlisted' });
                      void save();
                    }}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
                  >
                    <option value="public">Public</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="private">Private</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">Language</label>
                  <input
                    type="text"
                    value={metadata.defaultLanguage ?? ''}
                    onChange={(e) => patch({ defaultLanguage: e.target.value || undefined })}
                    onBlur={save}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-secondary)]">Playlists</label>
                <PlaylistMultiSelect
                  channelId={channelId}
                  value={metadata.playlistIds ?? []}
                  onChange={(playlistIds) => {
                    patch({ playlistIds });
                    void save();
                  }}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">Schedule</label>
                  <input
                    type="datetime-local"
                    value={publishAt ? utcIsoToLocalInputValue(publishAt, tz) : ''}
                    onChange={(e) => {
                      const utc = e.target.value ? localInputValueToUtcIso(e.target.value, tz) : null;
                      setPublishAt(utc);
                    }}
                    onBlur={save}
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setPublishAt(null);
                      void save();
                    }}
                    className="mt-1 text-xs text-[var(--text-muted)] underline hover:text-[var(--text-primary)]"
                  >
                    Clear (publish immediately)
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)]">Timezone</label>
                  <TimezoneSelect value={tz} onChange={setTz} />
                </div>
              </div>

              <fieldset className="rounded-md border border-[var(--border)] p-3">
                <legend className="text-xs font-medium text-[var(--text-secondary)]">Disclosures</legend>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <Toggle
                    label="Made for kids"
                    value={metadata.madeForKids ?? false}
                    onChange={(v) => {
                      patch({ madeForKids: v });
                      void save();
                    }}
                  />
                  <Toggle
                    label="Age restricted (18+)"
                    value={metadata.ageRestricted ?? false}
                    onChange={(v) => {
                      patch({ ageRestricted: v });
                      void save();
                    }}
                  />
                  <Toggle
                    label="Paid promotion"
                    value={metadata.paidPromotion ?? false}
                    onChange={(v) => {
                      patch({ paidPromotion: v });
                      void save();
                    }}
                  />
                  <Toggle
                    label="AI content disclosure"
                    value={metadata.aiContentDisclosure ?? true}
                    onChange={(v) => {
                      patch({ aiContentDisclosure: v });
                      void save();
                    }}
                  />
                </div>
                {(metadata.ageRestricted || metadata.paidPromotion) && (
                  <p className="mt-2 text-xs italic text-[var(--accent-yellow)]">
                    Age-restricted and paid-promotion can't be set via the YouTube API — finish in Studio after upload.
                  </p>
                )}
              </fieldset>
            </div>
          )}

          {saving && <span className="text-xs italic text-[var(--text-muted)]">Saving…</span>}
        </div>
      </div>
    </article>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[var(--accent-purple)]"
      />
      {label}
    </label>
  );
}

