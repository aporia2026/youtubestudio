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

const POSITIONS = [
  'top-left',
  'top-center',
  'top-right',
  'center',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export default function ThumbnailTemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
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
    if (
      !confirm(
        "Delete this thumbnail template? Any preset that references it will fall back to defaults.",
      )
    )
      return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
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
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <Link
            href="/pipeline"
            className="text-sm hover:underline"
            style={{ color: 'var(--text-muted)' }}
          >
            ← Pipeline
          </Link>
          <h1 className="text-2xl font-bold gradient-text mt-2">Thumbnail templates</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Reusable thumbnail configurations. Link a template to a pipeline preset and every batch uses it
            for the thumbnail generation step.
          </p>
        </div>
        <button onClick={() => setEditing('new')} className="btn-primary text-sm">
          ＋ New template
        </button>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
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
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading…</div>
      ) : templates.length === 0 ? (
        <div className="glass rounded-xl p-10 text-center" style={{ borderStyle: 'dashed' }}>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            No thumbnail templates yet. Click <strong>New template</strong> to create one.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {templates.map((t) => (
            <li key={t.id} className="glass rounded-xl p-4 flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t.name}</div>
                <div className="text-xs mt-1 flex gap-3 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                  <span>{t.include_text ? 'With text overlay' : 'Image only'}</span>
                  <span>
                    {t.image_references.length} reference image{t.image_references.length === 1 ? '' : 's'}
                  </span>
                  <span>Updated {new Date(t.updated_at).toLocaleDateString()}</span>
                </div>
                {t.context_description && (
                  <div
                    className="text-sm mt-2 line-clamp-2"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t.context_description}
                  </div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setEditing(t)}
                  className="btn-secondary text-xs"
                  style={{ padding: '6px 12px' }}
                >
                  Edit
                </button>
                <button
                  onClick={() => void deleteTemplate(t.id)}
                  className="btn-danger text-xs"
                  style={{ padding: '6px 12px' }}
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
  const [overlayPosition, setOverlayPosition] = useState(
    template?.text_overlay_config?.position ?? 'center',
  );
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
        // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
        ? await fetch(`/api/thumbnail-templates/${template.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
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
    <div className="glass-bright rounded-xl p-6 mb-6">
      <h2 className="text-sm font-semibold mb-5" style={{ color: 'var(--text-primary)' }}>
        {template ? 'Edit template' : 'New template'}
      </h2>

      <div className="space-y-4">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 'Cinematic dark-tone'"
            className="input-field"
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
            className="input-field"
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
            className="input-field"
            style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 12 }}
          />
        </Field>

        <Field label="Text overlay?">
          <label
            className="flex items-center gap-2 text-sm cursor-pointer"
            style={{ color: 'var(--text-primary)' }}
          >
            <input
              type="checkbox"
              checked={includeText}
              onChange={(e) => setIncludeText(e.target.checked)}
              style={{ accentColor: 'var(--accent-purple)' }}
            />
            <span>Include large text overlay on the thumbnail</span>
          </label>
          {includeText && (
            <div className="mt-3 space-y-2 pl-6">
              <input
                type="text"
                value={overlayText}
                onChange={(e) => setOverlayText(e.target.value)}
                placeholder="Override text (default: video title)"
                className="input-field"
              />
              <select
                value={overlayPosition}
                onChange={(e) => setOverlayPosition(e.target.value)}
                className="input-field"
                style={{ maxWidth: 240 }}
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

      <div className="mt-6 flex justify-end gap-2">
        <button onClick={onClose} disabled={saving} className="btn-secondary text-sm">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !name.trim()}
          className="btn-primary text-sm"
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
      <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
