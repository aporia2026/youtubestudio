'use client';

/**
 * Style Manager — list / create / edit / delete the workspace-saved
 * production-doc styles. Built-ins are read-only and shown at the top
 * of the list with a lock pill so the user knows why they can't edit.
 *
 * Talks to:
 *   GET    /api/production-doc/styles          — list all (built-in + saved)
 *   POST   /api/production-doc/styles          — create
 *   PATCH  /api/production-doc/styles/[id]     — update saved
 *   DELETE /api/production-doc/styles/[id]     — delete saved
 *
 * On any successful mutation the dialog calls `onChanged()` so the
 * parent page can refresh its picker from the same /styles endpoint.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

export interface StyleSummary {
  id: string;
  label: string;
  description?: string;
  ai_image_suffix: string;
  mixing_rules?: string;
  allow_overlay_stock: boolean;
  origin: 'built-in' | 'saved';
}

interface DraftStyle {
  name: string;
  description: string;
  ai_image_suffix: string;
  mixing_rules: string;
  allow_overlay_stock: boolean;
  based_on_built_in: string | null;
}

const EMPTY_DRAFT: DraftStyle = {
  name: '',
  description: '',
  ai_image_suffix: '',
  mixing_rules: '',
  allow_overlay_stock: false,
  based_on_built_in: null,
};

interface Props {
  styles: StyleSummary[];
  /** Called after every mutation so the parent reloads the picker. */
  onChanged: () => void;
  onClose: () => void;
}

export function StyleManagerDialog({ styles, onChanged, onClose }: Props) {
  /** id of the saved style being edited, "new" for the create form, or null for browse mode. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<DraftStyle>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  // Whenever the picker swaps between rows or built-ins, re-seed the draft
  // from the chosen style so edits start from a sensible baseline.
  useEffect(() => {
    if (editing === null) return;
    if (editing === 'new') {
      setDraft(EMPTY_DRAFT);
      return;
    }
    const target = styles.find((s) => s.id === editing);
    if (!target) return;
    setDraft({
      name: target.label,
      description: target.description ?? '',
      ai_image_suffix: target.ai_image_suffix,
      mixing_rules: target.mixing_rules ?? '',
      allow_overlay_stock: target.allow_overlay_stock,
      based_on_built_in: target.origin === 'built-in' ? target.id : null,
    });
  }, [editing, styles]);

  function startCreateFrom(builtIn: StyleSummary) {
    setDraft({
      name: `${builtIn.label} (copy)`,
      description: builtIn.description ?? '',
      ai_image_suffix: builtIn.ai_image_suffix,
      mixing_rules: builtIn.mixing_rules ?? '',
      allow_overlay_stock: builtIn.allow_overlay_stock,
      based_on_built_in: builtIn.id,
    });
    setEditing('new');
  }

  async function handleSave() {
    if (!draft.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!draft.ai_image_suffix.trim()) {
      toast.error('AI image suffix is required');
      return;
    }
    setBusy(true);
    try {
      const isNew = editing === 'new';
      const url = isNew
        ? '/api/production-doc/styles'
        : `/api/production-doc/styles/${editing}`;
      const method = isNew ? 'POST' : 'PATCH';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          ai_image_suffix: draft.ai_image_suffix.trim(),
          mixing_rules: draft.mixing_rules.trim() || null,
          allow_overlay_stock: draft.allow_overlay_stock,
          based_on_built_in: draft.based_on_built_in,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || `Failed to ${isNew ? 'create' : 'update'} style`);
        return;
      }
      toast.success(isNew ? 'Style created' : 'Style updated');
      // After a create, switch to editing the freshly-created row so the user
      // sees the row appear in the sidebar and can keep tweaking. After an
      // update, stay on the same row.
      if (isNew && typeof data?.style?.id === 'string') {
        setEditing(data.style.id);
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string, label: string) {
    if (!confirm(`Delete the style "${label}"? Production docs already generated with it are unaffected.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/production-doc/styles/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Failed to delete style');
        return;
      }
      toast.success('Style deleted');
      if (editing === id) setEditing(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const builtIns = styles.filter((s) => s.origin === 'built-in');
  const saved = styles.filter((s) => s.origin === 'saved');

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-40 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-4xl rounded-xl max-h-[88vh] flex flex-col"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Visual styles
              </h2>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Built-in styles are read-only. Save your own to reuse them across production docs.
              </div>
            </div>
            <button onClick={onClose} style={{ color: 'var(--text-muted)' }} title="Close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            {/* Sidebar: list */}
            <div className="md:w-64 md:flex-shrink-0 overflow-y-auto md:border-r" style={{ borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>
              <div className="p-3">
                <button
                  onClick={() => setEditing('new')}
                  className="w-full text-xs px-3 py-2 rounded-lg font-semibold"
                  style={{
                    background: editing === 'new' ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.12)',
                    color: 'var(--accent-purple-bright)',
                    border: '1px dashed rgba(124,58,237,0.4)',
                  }}
                >
                  + Create new style
                </button>
              </div>

              <SectionLabel>Built-in</SectionLabel>
              {builtIns.map((s) => (
                <SidebarRow
                  key={s.id}
                  label={s.label}
                  description={s.description}
                  active={editing === s.id}
                  pill="locked"
                  onClick={() => setEditing(s.id)}
                />
              ))}

              <SectionLabel>Your styles ({saved.length})</SectionLabel>
              {saved.length === 0 ? (
                <div className="px-3 py-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                  No saved styles yet. Pick a built-in and use “Save as new” to get started.
                </div>
              ) : (
                saved.map((s) => (
                  <SidebarRow
                    key={s.id}
                    label={s.label}
                    description={s.description}
                    active={editing === s.id}
                    onClick={() => setEditing(s.id)}
                  />
                ))
              )}
            </div>

            {/* Right pane: detail / editor */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {editing === null ? (
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  Pick a style from the sidebar to view or edit it, or create a new one.
                </div>
              ) : (() => {
                const target = editing === 'new' ? null : styles.find((s) => s.id === editing);
                const isBuiltIn = target?.origin === 'built-in';
                const isNew = editing === 'new';
                const readOnly = isBuiltIn;

                return (
                  <>
                    {isBuiltIn && (
                      <div
                        className="text-xs p-3 rounded-lg flex items-start gap-2"
                        style={{ background: 'rgba(245,158,11,0.08)', color: 'var(--text-secondary)', border: '1px solid rgba(245,158,11,0.3)' }}
                      >
                        <span style={{ color: '#fbbf24', flexShrink: 0 }}>🔒</span>
                        <span>
                          This is a built-in style — it cannot be edited directly. Use the
                          <strong> Save as new </strong> button below to create a customisable copy.
                        </span>
                      </div>
                    )}

                    {/* Name */}
                    <Field label="Name" hint="Shown in the picker. Keep it short.">
                      <input
                        type="text"
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-sm"
                        placeholder="e.g. Doodle Explainer (my version)"
                        maxLength={80}
                      />
                    </Field>

                    {/* Description */}
                    <Field label="Description (optional)" hint="One-liner shown under the label.">
                      <input
                        type="text"
                        value={draft.description}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-sm"
                        placeholder="e.g. Stick figures with real logos overlaid where useful"
                        maxLength={240}
                      />
                    </Field>

                    {/* AI image suffix */}
                    <Field
                      label="AI image suffix"
                      hint="Appended verbatim to every AI image prompt. Controls the visual aesthetic."
                    >
                      <textarea
                        value={draft.ai_image_suffix}
                        onChange={(e) => setDraft((d) => ({ ...d, ai_image_suffix: e.target.value }))}
                        readOnly={readOnly}
                        className="input-field w-full text-xs"
                        style={{ minHeight: 80, resize: 'vertical', fontFamily: 'monospace' }}
                        placeholder="e.g. minimalist hand-drawn stick figure doodle, thick uneven black outlines, …"
                        maxLength={1200}
                      />
                    </Field>

                    {/* Allow overlay */}
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.allow_overlay_stock}
                        onChange={(e) => setDraft((d) => ({ ...d, allow_overlay_stock: e.target.checked }))}
                        disabled={readOnly}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                          Allow real-image overlays
                        </div>
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          Lets the model populate <code style={{ fontFamily: 'monospace' }}>overlay_stock_terms</code> on rows where a real
                          logo / screenshot / photo should be composited on top of the AI-generated visual in post.
                        </div>
                      </div>
                    </label>

                    {/* Mixing rules — visible when overlays are allowed */}
                    {draft.allow_overlay_stock && (
                      <Field
                        label="Mixing rules"
                        hint="Free-form instructions injected into the system prompt. Tell the model WHEN to populate overlay_stock_terms vs. leave it empty."
                      >
                        <textarea
                          value={draft.mixing_rules}
                          onChange={(e) => setDraft((d) => ({ ...d, mixing_rules: e.target.value }))}
                          readOnly={readOnly}
                          className="input-field w-full text-xs"
                          style={{ minHeight: 180, resize: 'vertical' }}
                          placeholder={'e.g.\n• When the script names a real company — overlay_stock_terms: "<brand> logo official PNG"\n• When the script names real software — overlay_stock_terms: "<thing> screenshot"\n• Otherwise leave empty and keep the row pure doodle.'}
                          maxLength={8000}
                        />
                      </Field>
                    )}

                    {/* Action row */}
                    <div className="flex items-center justify-between pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                      <div>
                        {target && target.origin === 'saved' && (
                          <button
                            onClick={() => handleDelete(target.id, target.label)}
                            disabled={busy}
                            className="text-xs px-3 py-1.5 rounded-lg"
                            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {isBuiltIn && target && (
                          <button
                            onClick={() => startCreateFrom(target)}
                            className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                            style={{ background: 'rgba(124,58,237,0.12)', color: 'var(--accent-purple-bright)', border: '1px solid rgba(124,58,237,0.3)' }}
                          >
                            Save as new
                          </button>
                        )}
                        {!readOnly && (
                          <button
                            onClick={handleSave}
                            disabled={busy || !draft.name.trim() || !draft.ai_image_suffix.trim()}
                            className="text-xs px-4 py-1.5 rounded-lg font-semibold"
                            style={{
                              background: 'var(--accent-purple-bright)',
                              color: 'white',
                              opacity: busy || !draft.name.trim() || !draft.ai_image_suffix.trim() ? 0.5 : 1,
                            }}
                          >
                            {busy ? 'Saving…' : isNew ? 'Create style' : 'Save changes'}
                          </button>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
      {children}
    </div>
  );
}

function SidebarRow({
  label,
  description,
  active,
  pill,
  onClick,
}: {
  label: string;
  description?: string;
  active: boolean;
  pill?: 'locked';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 transition-colors"
      style={{
        background: active ? 'rgba(124,58,237,0.18)' : 'transparent',
        borderLeft: active ? '2px solid var(--accent-purple-bright)' : '2px solid transparent',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium truncate" style={{ color: active ? 'var(--accent-purple-bright)' : 'var(--text-primary)' }}>
          {label}
        </span>
        {pill === 'locked' && (
          <span
            className="text-[9px] px-1 rounded"
            style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
            title="Built-in — read only"
          >
            🔒
          </span>
        )}
      </div>
      {description && (
        <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {description}
        </div>
      )}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}
