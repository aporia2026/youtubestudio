'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { TemplateContextPicker } from './TemplateContextPicker';
import { AI_MODELS, getDefaultModel } from '@/lib/ai-models';

interface Props {
  projectId: string;
  title: string;
  niche: string;
  topic?: string;
  /** The active script content. Without this we can't generate. */
  scriptContent: string;
  /** Existing saved description (preloaded from project row). */
  initialDescription?: string | null;
}

const STORAGE_KEY = 'yt_description_model';

export function YouTubeDescriptionPanel({ projectId, title, niche, topic, scriptContent, initialDescription }: Props) {
  const [description, setDescription] = useState<string>(initialDescription || '');
  const [draft, setDraft] = useState<string>(initialDescription || '');
  const [editing, setEditing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [modelId, setModelId] = useState<string>(() => {
    if (typeof window === 'undefined') return getDefaultModel().id;
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved || getDefaultModel().id;
  });

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, modelId);
  }, [modelId]);

  // Sync local state when the prop changes (parent re-fetched after save).
  useEffect(() => {
    setDescription(initialDescription || '');
    if (!editing) setDraft(initialDescription || '');
  }, [initialDescription, editing]);

  async function generate() {
    if (!scriptContent || scriptContent.trim().length < 100) {
      toast.error('Approve a script first — need at least 100 characters');
      return;
    }
    setGenerating(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/generate/youtube-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          title,
          niche,
          topic,
          script: scriptContent,
          templateId: templateId || undefined,
          context: context || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      setDraft(data.description || '');
      setEditing(true);
      toast.success('Description generated, review and save');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
      const res = await fetch(`/api/projects/${projectId}/description`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: draft }),
      });
      if (!res.ok) throw new Error('save failed');
      setDescription(draft);
      setEditing(false);
      toast.success('Description saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  function copy() {
    navigator.clipboard.writeText(description || draft);
    toast.success('Copied to clipboard');
  }

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            🎬 YouTube Description
          </span>
          {description && !editing && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
              {description.split(/\s+/).filter(Boolean).length} words
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {description && !editing && (
            <>
              <button onClick={copy} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                Copy
              </button>
              <button onClick={() => { setDraft(description); setEditing(true); }} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                ✏️ Edit
              </button>
            </>
          )}
          {editing && (
            <>
              <button onClick={() => { setEditing(false); setDraft(description); }} className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="p-6 space-y-4">
        {!description && !editing ? (
          <>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Generate a YouTube-SEO-optimized description from your script. Picks a hook for the first 150 chars, weaves in keywords naturally, ends with hashtags. Tuned to read like a human wrote it (no em-dashes, no &ldquo;in this video&rdquo; openers).
            </p>
            <TemplateContextPicker
              fieldType="youtube_description"
              templateId={templateId}
              onTemplateChange={setTemplateId}
              context={context}
              onContextChange={setContext}
              label="Description style"
              compact
            />
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold mb-1.5 block" style={{ color: 'var(--text-muted)' }}>Model</label>
              <select
                value={modelId}
                onChange={e => setModelId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              >
                {AI_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
            <button
              onClick={generate}
              disabled={generating || !scriptContent}
              className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
            >
              {generating ? 'Generating…' : '✨ Generate Description'}
            </button>
            {!scriptContent && (
              <p className="text-[11px] text-center" style={{ color: '#ef4444' }}>Approve a script first to enable generation</p>
            )}
          </>
        ) : editing ? (
          <>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={16}
              className="w-full px-3 py-2 rounded-lg text-sm resize-y"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontFamily: 'var(--font-geist-mono)', lineHeight: 1.6 }}
            />
            <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>{draft.split(/\s+/).filter(Boolean).length} words · {draft.length} chars (first 150 visible in search)</span>
              <button onClick={generate} disabled={generating} className="text-[11px] hover:underline disabled:opacity-50" style={{ color: '#a78bfa' }}>
                {generating ? 'Regenerating…' : '🔄 Regenerate'}
              </button>
            </div>
          </>
        ) : (
          <>
            <pre className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text-secondary)', maxHeight: 500, overflow: 'auto' }}>
              {description}
            </pre>
            <details className="text-xs" style={{ color: 'var(--text-muted)' }}>
              <summary className="cursor-pointer hover:text-purple-400">Regenerate with different style or context…</summary>
              <div className="mt-3 space-y-3 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                <TemplateContextPicker
                  fieldType="youtube_description"
                  templateId={templateId}
                  onTemplateChange={setTemplateId}
                  context={context}
                  onContextChange={setContext}
                  label="Description style"
                  compact
                />
                <button
                  onClick={generate}
                  disabled={generating}
                  className="w-full px-3 py-2 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                >
                  {generating ? 'Regenerating…' : '🔄 Regenerate Description'}
                </button>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
