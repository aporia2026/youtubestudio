'use client';

/**
 * TagTokenInput — tag chips with a length guard against YouTube's
 * 500-char combined-with-commas cap. Comma or Enter adds a tag,
 * Backspace on an empty input removes the last one.
 *
 * Pure client component. The 500-char accounting matches what
 * `combinedTagsLength` in `youtube-upload.ts` enforces server-side
 * (defense in depth — the server is the source of truth).
 */

import { useState } from 'react';
import { combinedTagsLength, YOUTUBE_TAGS_COMBINED_MAX } from '@/lib/youtube-upload';

export function TagTokenInput({
  tags,
  onChange,
  placeholder = 'Add a tag…',
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const usedChars = combinedTagsLength(tags);
  const remaining = YOUTUBE_TAGS_COMBINED_MAX - usedChars;

  const tryAdd = (raw: string) => {
    const cleaned = raw.trim().replace(/^#/, '');
    if (!cleaned) return;
    if (tags.includes(cleaned)) return;
    // Reject if adding would breach the cap. Account for the comma
    // separator that would be added between existing tags + new one.
    const projected = combinedTagsLength([...tags, cleaned]);
    if (projected > YOUTUBE_TAGS_COMBINED_MAX) return;
    onChange([...tags, cleaned]);
    setDraft('');
  };

  const remove = (idx: number) => {
    onChange(tags.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-300 bg-white p-2 dark:border-zinc-600 dark:bg-zinc-900">
        {tags.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200"
          >
            {tag}
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              tryAdd(draft);
            } else if (e.key === 'Backspace' && draft.length === 0 && tags.length > 0) {
              e.preventDefault();
              remove(tags.length - 1);
            }
          }}
          onBlur={() => tryAdd(draft)}
          placeholder={placeholder}
          className="min-w-[120px] flex-1 border-0 bg-transparent text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none dark:text-zinc-100"
        />
      </div>
      <p
        className={[
          'text-xs',
          remaining < 50 ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400',
        ].join(' ')}
      >
        {remaining} characters remaining (YouTube caps combined tag length at {YOUTUBE_TAGS_COMBINED_MAX})
      </p>
    </div>
  );
}
