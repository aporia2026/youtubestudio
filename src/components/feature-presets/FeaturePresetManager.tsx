'use client';

/**
 * Generic admin page for a feature-preset table. Renders:
 *   - Left rail: list of presets for this feature (clickable, "+ New").
 *   - Right panel: form for the selected preset (auto-generated from
 *     the config's `fields`).
 *
 * Powers all four /pipeline/presets/{feature} pages — script, qa,
 * narration, idea. Each page imports this component and passes the
 * corresponding config from `src/lib/auto-pipeline/feature-preset-crud`.
 *
 * Why generic: the four features share the same lifecycle (list +
 * edit + create + delete) and only differ in field shape, which the
 * config already describes. Writing four near-identical admin pages
 * was a perfect use case for a parameterized component.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { FeaturePresetField } from '@/lib/auto-pipeline/feature-preset-crud';

interface PresetRow {
  id: string;
  name: string;
  description?: string | null;
  updated_at: string;
  [key: string]: unknown;
}

interface Props {
  /** API base path — e.g. `/api/auto-pipeline/script-presets`. */
  apiBase: string;
  /** Human-readable feature name for headings/buttons — e.g. "Script presets". */
  title: string;
  /** One-line subtitle for the page header. */
  subtitle: string;
  /** Field config — same shape as the server-side validator uses. */
  fields: readonly FeaturePresetField[];
}

export function FeaturePresetManager({ apiBase, title, subtitle, fields }: Props) {
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiBase, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPresets((data.presets as PresetRow[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // When the selected preset changes, hydrate the form from its values.
  // For a fresh "+ New" click, the form is reset to defaults.
  useEffect(() => {
    if (selectedId === null) {
      setForm({});
      return;
    }
    if (selectedId === '__new__') {
      const blank: Record<string, unknown> = {};
      for (const f of fields) {
        blank[f.column] = f.type === 'int' || f.type === 'numeric' ? '' : '';
      }
      setForm(blank);
      return;
    }
    const row = presets.find(p => p.id === selectedId);
    if (!row) return;
    const next: Record<string, unknown> = {};
    for (const f of fields) {
      const v = row[f.column];
      if (v === null || v === undefined) {
        next[f.column] = f.type === 'int' || f.type === 'numeric' ? '' : '';
      } else if (f.type === 'jsonb' && typeof v === 'object') {
        next[f.column] = JSON.stringify(v, null, 2);
      } else {
        next[f.column] = v;
      }
    }
    setForm(next);
  }, [selectedId, presets, fields]);

  function setField(column: string, value: unknown) {
    setForm(prev => ({ ...prev, [column]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);

    // Build the body — coerce empty strings to null for nullable fields,
    // numbers from strings for numeric inputs.
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = form[f.column];
      if (raw === '' || raw === undefined) {
        // Don't send empty fields on create — let server defaults apply.
        // On update, sending `null` clears the column.
        if (selectedId === '__new__') continue;
        body[f.column] = null;
        continue;
      }
      if (f.type === 'int' || f.type === 'numeric') {
        const n = typeof raw === 'string' ? Number(raw) : (raw as number);
        if (!Number.isFinite(n)) {
          setError(`${f.label ?? f.column} must be a number`);
          setSaving(false);
          return;
        }
        body[f.column] = n;
        continue;
      }
      if (f.type === 'jsonb' && typeof raw === 'string') {
        try {
          body[f.column] = raw.trim() ? JSON.parse(raw) : null;
        } catch {
          setError(`${f.label ?? f.column} must be valid JSON`);
          setSaving(false);
          return;
        }
        continue;
      }
      body[f.column] = raw;
    }

    try {
      const isNew = selectedId === '__new__';
      const res = await fetch(isNew ? apiBase : `${apiBase}/${selectedId}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const d = await res.json();
      await refresh();
      // After create, jump to the new row's edit view.
      if (isNew && d.preset?.id) setSelectedId(d.preset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selectedId || selectedId === '__new__') return;
    const row = presets.find(p => p.id === selectedId);
    if (!confirm(`Delete preset "${row?.name ?? selectedId}"? This cannot be undone.`)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/${selectedId}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setSelectedId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  const isNew = selectedId === '__new__';
  const isEditing = selectedId !== null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/pipeline/presets"
          className="text-sm hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          ← Pipeline presets
        </Link>
        <h1 className="text-2xl font-bold gradient-text mt-2">{title}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {subtitle}
        </p>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-5">
        {/* List rail */}
        <aside
          className="rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          <div
            className="px-3 py-2 text-xs uppercase tracking-wider font-semibold flex items-center justify-between"
            style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
          >
            <span>{presets.length} presets</span>
            <button
              type="button"
              onClick={() => setSelectedId('__new__')}
              className="text-xs hover:underline"
              style={{ color: 'var(--accent-purple-bright)' }}
            >
              + New
            </button>
          </div>
          {loading && presets.length === 0 ? (
            <div className="px-3 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              Loading…
            </div>
          ) : presets.length === 0 ? (
            <div className="px-3 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
              No presets yet. Click <strong>+ New</strong> to create one.
            </div>
          ) : (
            <ul>
              {presets.map((p, idx) => {
                const active = p.id === selectedId;
                return (
                  <li
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className="px-3 py-2 cursor-pointer text-sm transition-colors"
                    style={{
                      background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {p.name}
                    </div>
                    {p.description && (
                      <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                        {p.description}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Form panel */}
        <section
          className="rounded-lg p-5"
          style={{ border: '1px solid var(--border)', background: 'var(--bg-secondary)' }}
        >
          {!isEditing ? (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Pick a preset from the list or click <strong>+ New</strong> to create one.
            </p>
          ) : (
            <>
              <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                {isNew ? 'New preset' : `Edit: ${presets.find(p => p.id === selectedId)?.name ?? ''}`}
              </h2>
              <div className="space-y-4">
                {fields.map(f => (
                  <FieldRenderer
                    key={f.column}
                    field={f}
                    value={form[f.column]}
                    onChange={(v) => setField(f.column, v)}
                  />
                ))}
              </div>
              <div className="mt-5 flex items-center gap-2 justify-end">
                {!isNew && (
                  <button
                    type="button"
                    onClick={() => void remove()}
                    disabled={saving || deleting}
                    className="text-xs px-3 py-1.5 rounded hover:underline disabled:opacity-50"
                    style={{ color: '#f87171' }}
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  disabled={saving || deleting}
                  className="text-sm px-3 py-1.5 rounded disabled:opacity-50"
                  style={{ background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || deleting}
                  className="btn-primary text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving…' : isNew ? 'Create' : 'Save changes'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Renders the right input for one field. Inferred from `field.type` and
 * `field.widget` (text + maxLength > 500 implies textarea unless told
 * otherwise).
 */
function FieldRenderer({
  field,
  value,
  onChange,
}: {
  field: FeaturePresetField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `f-${field.column}`;
  const widget = field.widget ?? inferWidget(field);
  const labelText = field.label ?? field.column;
  const stringValue = typeof value === 'string' ? value : (value as string | number | undefined) ?? '';

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {labelText}
        {field.required && <span style={{ color: '#f87171' }}> *</span>}
      </label>
      {field.type === 'enum' ? (
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value || null)}
          className="input-field"
        >
          <option value="">— Not set —</option>
          {field.enumValues?.map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : widget === 'textarea' ? (
        <textarea
          id={id}
          value={String(stringValue)}
          onChange={e => onChange(e.target.value)}
          rows={field.rows ?? 4}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          className="input-field"
        />
      ) : (
        <input
          id={id}
          type={field.type === 'int' || field.type === 'numeric' ? 'number' : 'text'}
          value={String(stringValue)}
          onChange={e => onChange(e.target.value)}
          maxLength={field.maxLength}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
          className="input-field"
        />
      )}
      {field.hint && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {field.hint}
        </p>
      )}
    </div>
  );
}

function inferWidget(field: FeaturePresetField): 'input' | 'textarea' {
  if (field.type === 'text' && field.maxLength && field.maxLength > 500) return 'textarea';
  return 'input';
}
