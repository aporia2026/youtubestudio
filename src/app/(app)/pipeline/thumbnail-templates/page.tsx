'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Template {
  id: string;
  name: string;
  image_references: string[];
  context_description: string | null;
  include_text: boolean;
  text_overlay_config: { text?: string; position?: string; color?: string } | null;
  updated_at: string;
}

const POSITIONS = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'];

export default function ThumbnailTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/thumbnail-templates', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTemplates((data.templates as Template[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function deleteTemplate(id: string) {
    if (!confirm('Delete this thumbnail template? Any preset that references it will fall back to defaults.')) return;
    try {
      const res = await fetch(`/api/thumbnail-templates/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <Link href="/pipeline" className="text-sm text-zinc-500 hover:underline">
            ← Pipeline
          </Link>
          <h1 className="text-2xl font-semibold mt-2">Thumbnail templates</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Reusable thumbnail configurations. Link a template to a pipeline preset and every batch uses it for the
            thumbnail generation step.
          </p>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium"
        >
          New template
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {editing && (
        <TemplateForm
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
          onError={setError}
        />
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading…</div>
      ) : templates.length === 0 ? (
        <div className="border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center text-sm text-zinc-500">
          No thumbnail templates yet. Click <strong>New template</strong> to create one.
        </div>
      ) : (
        <ul className="space-y-3">
          {templates.map((t) => (
            <li
              key={t.id}
              className="border border-zinc-200 dark:border-zinc-800 rounded-md p-4 flex items-start justify-between"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-zinc-500 mt-1 space-x-3">
                  <span>{t.include_text ? 'With text overlay' : 'Image only'}</span>
                  <span>{t.image_references.length} reference image{t.image_references.length === 1 ? '' : 's'}</span>
                  <span>Updated {new Date(t.updated_at).toLocaleDateString()}</span>
                </div>
                {t.context_description && (
                  <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-2 line-clamp-2">
                    {t.context_description}
                  </div>
                )}
              </div>
              <div className="ml-4 flex gap-2 shrink-0">
                <button
                  onClick={() => setEditing(t)}
                  className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline"
                >
                  Edit
                </button>
                <button
                  onClick={() => void deleteTemplate(t.id)}
                  className="text-xs text-red-600 dark:text-red-400 hover:underline"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateForm({
  template,
  onClose,
  onSaved,
  onError,
}: {
  template: Template | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [contextDescription, setContextDescription] = useState(template?.context_description ?? '');
  const [includeText, setIncludeText] = useState(template?.include_text ?? false);
  const [overlayText, setOverlayText] = useState(template?.text_overlay_config?.text ?? '');
  const [overlayPosition, setOverlayPosition] = useState(template?.text_overlay_config?.position ?? 'center');
  const [refsText, setRefsText] = useState((template?.image_references ?? []).join('\n'));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const image_references = refsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const text_overlay_config: Record<string, unknown> | null = includeText
        ? {
            ...(overlayText.trim() ? { text: overlayText.trim() } : {}),
            position: overlayPosition,
          }
        : null;

      const body = {
        name: name.trim(),
        image_references,
        context_description: contextDescription.trim() || null,
        include_text: includeText,
        text_overlay_config,
      };

      const res = template
        ? await fetch(`/api/thumbnail-templates/${template.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/thumbnail-templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 mb-5 bg-zinc-50/50 dark:bg-zinc-900/30">
      <h2 className="font-medium mb-4">{template ? 'Edit template' : 'New template'}</h2>

      <div className="space-y-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 'Cinematic dark-tone'"
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          />
        </Field>

        <Field
          label="Style description"
          hint="What this thumbnail should look like — passed as the leading instruction to the image model."
        >
          <textarea
            value={contextDescription}
            onChange={(e) => setContextDescription(e.target.value)}
            rows={4}
            placeholder="e.g. 'Cinematic dark-tone composition. Warm key light from screen-left, shallow depth of field, centered human subject reacting to a hidden object.'"
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          />
        </Field>

        <Field
          label="Reference image URLs (one per line, optional)"
          hint="Inspiration cues only — Kie text-to-image models don't accept reference images. The pipeline describes them in the prompt."
        >
          <textarea
            value={refsText}
            onChange={(e) => setRefsText(e.target.value)}
            rows={3}
            placeholder="https://example.com/inspo-1.jpg&#10;https://example.com/inspo-2.jpg"
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono"
          />
        </Field>

        <Field label="Text overlay?">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeText}
              onChange={(e) => setIncludeText(e.target.checked)}
            />
            <span>Include large text overlay on the thumbnail</span>
          </label>
          {includeText && (
            <div className="mt-2 space-y-2 pl-6">
              <input
                type="text"
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
                placeholder="Override text (default: video title)"
                className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
              />
              <select
                value={overlayPosition}
                onChange={(e) => setOverlayPosition(e.target.value)}
                className="w-48 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
              >
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={saving}
          className="px-4 py-2 rounded-md text-sm border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !name.trim()}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : template ? 'Save changes' : 'Create template'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {hint && <div className="text-xs text-zinc-500 mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}
