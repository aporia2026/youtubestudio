'use client';

/**
 * Gemini-TTS style controls.
 *
 * Renders only when the selected voice uses a Gemini-TTS model
 * (Gemini 2.5 or Gemini 3.1). Two surfaces:
 *
 *   1. "Style instructions" textarea  → sent as `input.prompt` to the
 *      Cloud TTS API alongside the script text. Natural-language
 *      direction like "Read this conspiratorially, building to an
 *      excited reveal at the end."
 *
 *   2. "Insert audio tag" button → opens a searchable modal listing
 *      every documented + commonly-cited tag. Click a tag and it's
 *      spliced into the script at the current cursor position. Tags
 *      drop into the script text inline, e.g. "[whispering] I have a
 *      secret. [pause] You won't believe it."
 *
 * The script wording stays untouched — instructions ride alongside.
 * Both are optional: a Gemini voiceover generates without either, just
 * without the expressive control.
 */

import { useMemo, useState } from 'react';
import {
  GEMINI_TAGS,
  TAG_CATEGORY_LABELS,
  searchTags,
  type GeminiTag,
} from '@/lib/tts/gemini-tags';

interface GeminiStylePanelProps {
  stylePrompt: string;
  onStylePromptChange: (next: string) => void;
  /** Callback to insert a tag into the script at the cursor. The page
   *  owns the script textarea ref and the script text state. */
  onInsertTag: (insert: string) => void;
  /** Which Gemini model is active — drives the warning bar copy. */
  geminiVariant: '2.5' | '3.1';
}

const MAX_PROMPT_CHARS = 4000;

export function GeminiStylePanel({
  stylePrompt,
  onStylePromptChange,
  onInsertTag,
  geminiVariant,
}: GeminiStylePanelProps) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);

  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Style instructions {geminiVariant === '3.1' && (
              <span
                className="ml-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide"
                style={{
                  background: 'rgba(124,58,237,0.15)',
                  color: 'var(--accent-purple-bright)',
                }}
              >
                preview
              </span>
            )}
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Tell Gemini how to deliver the script. Optional. Audio tags go in the script itself.
          </p>
        </div>
        <button
          onClick={() => setTagPickerOpen(true)}
          className="px-2.5 py-1 rounded text-xs font-medium transition-all"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}
        >
          + Insert audio tag
        </button>
      </div>

      <textarea
        value={stylePrompt}
        onChange={(e) => onStylePromptChange(e.target.value.slice(0, MAX_PROMPT_CHARS))}
        placeholder={
          geminiVariant === '3.1'
            ? 'e.g. Read this in a conspiratorial whisper, building to an excited reveal at the end.'
            : 'e.g. Warm narrator tone, deliberate pace, slight smile in the voice.'
        }
        className="input-field"
        style={{ minHeight: 80, fontSize: 13 }}
      />
      <div className="flex items-center justify-between mt-1">
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Counts toward Gemini&apos;s 8 KB combined cap (prompt + script per request).
        </p>
        <span
          className="text-[11px]"
          style={{
            color:
              stylePrompt.length > MAX_PROMPT_CHARS * 0.9
                ? '#ef4444'
                : 'var(--text-muted)',
          }}
        >
          {stylePrompt.length.toLocaleString()} / {MAX_PROMPT_CHARS.toLocaleString()}
        </span>
      </div>

      {tagPickerOpen && (
        <TagPickerModal
          onClose={() => setTagPickerOpen(false)}
          onPick={(tag) => {
            onInsertTag(tag.insert);
            setTagPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Tag picker modal ────────────────────────────────────────────────────────

interface TagPickerModalProps {
  onClose: () => void;
  onPick: (tag: GeminiTag) => void;
}

function TagPickerModal({ onClose, onPick }: TagPickerModalProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => searchTags(query), [query]);

  // Group filtered results by category for the rendered sections.
  const byCategory = useMemo(() => {
    const out = new Map<GeminiTag['category'], GeminiTag[]>();
    for (const tag of filtered) {
      const list = out.get(tag.category) ?? [];
      list.push(tag);
      out.set(tag.category, list);
    }
    return out;
  }, [filtered]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.6)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass rounded-xl p-5 w-full max-w-2xl"
        style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Insert audio tag
          </h3>
          <button
            onClick={onClose}
            className="text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Close
          </button>
        </div>

        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags... e.g. whisper, pause, excited"
          className="input-field mb-3"
          style={{ padding: '8px 12px', fontSize: 13 }}
        />

        <div className="overflow-y-auto flex-1 space-y-3">
          {filtered.length === 0 ? (
            <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>
              No tags match &quot;{query}&quot;.
            </p>
          ) : (
            Array.from(byCategory.entries()).map(([category, tags]) => (
              <div key={category}>
                <h4
                  className="text-[11px] uppercase tracking-wide mb-1.5"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {TAG_CATEGORY_LABELS[category]}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <button
                      key={tag.insert}
                      onClick={() => onPick(tag)}
                      title={
                        tag.source === 'experimental'
                          ? `${tag.insert} — experimental (not in Google's official spec, may not behave consistently)`
                          : `${tag.insert} — documented`
                      }
                      className="px-2 py-1 rounded text-xs transition-all"
                      style={{
                        background:
                          tag.source === 'documented'
                            ? 'rgba(124,58,237,0.12)'
                            : 'var(--bg-secondary)',
                        color:
                          tag.source === 'documented'
                            ? 'var(--accent-purple-bright)'
                            : 'var(--text-secondary)',
                        border: `1px solid ${tag.source === 'documented' ? 'rgba(124,58,237,0.25)' : 'transparent'}`,
                      }}
                    >
                      {tag.label}
                      {tag.source === 'experimental' && (
                        <span className="ml-1 opacity-50">·exp</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <p
          className="text-[11px] mt-3 pt-3"
          style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}
        >
          <span style={{ color: 'var(--accent-purple-bright)' }}>Highlighted</span> tags are in
          Google&apos;s official spec. <span style={{ opacity: 0.5 }}>·exp</span> tags are
          commonly used but unguaranteed — test before relying on them in production.
        </p>
      </div>
    </div>
  );
}
