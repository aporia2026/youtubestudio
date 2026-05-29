'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type FieldType =
  | 'script'
  | 'youtube_description'
  | 'title'
  | 'thumbnail'
  | 'idea'
  | 'qa'
  | 'production_doc'
  // SEO Optimizer covers titles + description + tags + chapters in one
  // pass, so we expose a single umbrella `seo` template type rather than
  // forcing the user to juggle separate title / description templates.
  | 'seo'
  | 'other';

interface Template {
  id: string;
  field_type: FieldType;
  name: string;
  content: string;
  is_default: boolean;
}

interface Props {
  fieldType: FieldType;
  /**
   * Optional additional template categories to surface in the dropdown
   * alongside `fieldType`. Useful when a feature can reasonably consume
   * templates authored for a related generator — e.g. the SEO Optimizer
   * also accepts YouTube Description templates so users don't have to
   * duplicate their description style under a second category.
   *
   * `fieldType` remains the canonical save target: the "Save as template"
   * button and `autoSelectDefault` both prefer the primary type. Extras
   * are read-only borrowed content.
   */
  extraFieldTypes?: FieldType[];
  /**
   * Short note shown under the dropdown when the selected template
   * comes from one of `extraFieldTypes` (not the primary `fieldType`).
   * Use this to tell the user where the borrowed template will apply —
   * e.g. "Scoped to the description only — titles & tags follow the
   * built-in SEO rules." Skipped when the selected template matches
   * the primary type or when no note is provided.
   */
  borrowedScopeNote?: string;
  /** The currently-selected template id (or null for "no template"). */
  templateId: string | null;
  onTemplateChange: (id: string | null) => void;
  /** Per-call extra context the user types alongside the chosen template. */
  context: string;
  onContextChange: (v: string) => void;
  /** Compact label for the section heading, e.g. "Script style" or "Description style". */
  label?: string;
  /** Smaller layout for tight panels. */
  compact?: boolean;
  /** Auto-select the user's default template for this field on first mount. */
  autoSelectDefault?: boolean;
}

/**
 * Reusable picker for any AI-generation feature: a templates dropdown
 * (filtered by field_type) + an "extra context" textarea. The chosen
 * template's content + this context are typically sent to the server
 * generation route, which prepends them to the user message.
 *
 * The component fetches templates on mount and reactively re-fetches when
 * the page tab becomes visible again — picks up newly-saved templates
 * without a page refresh.
 */
export function TemplateContextPicker({
  fieldType,
  extraFieldTypes,
  borrowedScopeNote,
  templateId,
  onTemplateChange,
  context,
  onContextChange,
  label = 'Style template',
  compact = false,
  autoSelectDefault = true,
}: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  // Save-as-template UI state. Inline name input + button instead of a
  // modal so the user can save without leaving their flow.
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Comma-joined list of every category we read from. Memoised into a
  // string so the effect's dependency array stays stable across renders
  // when the caller passes a fresh array literal each time.
  const allFieldTypes: FieldType[] = [fieldType, ...(extraFieldTypes || [])];
  const fieldTypesKey = allFieldTypes.join(',');

  async function reload(): Promise<Template[]> {
    setLoading(true);
    try {
      // Fetch each category in parallel. Done client-side to avoid an
      // API surface change; the templates endpoint accepts one type
      // per request.
      const results = await Promise.all(
        allFieldTypes.map(async (ft) => {
          try {
            // eslint-disable-next-line no-restricted-syntax -- GET, read
            const res = await fetch(`/api/templates?field_type=${ft}`);
            if (!res.ok) return [] as Template[];
            const data = await res.json();
            return (data.templates || []) as Template[];
          } catch {
            return [] as Template[];
          }
        }),
      );
      // Dedup by id (a template only belongs to one field_type today, but
      // belt-and-braces in case the same id surfaces twice).
      const byId = new Map<string, Template>();
      for (const list of results) {
        for (const t of list) if (!byId.has(t.id)) byId.set(t.id, t);
      }
      const merged = Array.from(byId.values());
      setTemplates(merged);
      return merged;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const list = await reload();
      if (cancelled) return;
      // Auto-select the user's default template the first time we see it.
      // Prefer the primary field's default over an extra-category default
      // so the save target and the chosen template agree by default.
      if (autoSelectDefault && templateId === null) {
        const primaryDefault = list.find((t) => t.is_default && t.field_type === fieldType);
        const anyDefault = primaryDefault || list.find((t) => t.is_default);
        if (anyDefault) onTemplateChange(anyDefault.id);
      }
    }
    load();
    function onVisible() {
      if (!document.hidden) load();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypesKey]);

  async function handleSaveAsTemplate() {
    const name = saveName.trim();
    const content = context.trim();
    if (!name) {
      setSaveError('Give the template a name first');
      return;
    }
    if (!content) {
      setSaveError('Type some context above before saving');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field_type: fieldType, name, content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSaveError((data as { error?: string }).error || `Save failed (${res.status})`);
        return;
      }
      const data: { template: Template } = await res.json();
      // Refresh the list so the new template appears in the dropdown,
      // and auto-select it so the user can see it landed.
      await reload();
      onTemplateChange(data.template.id);
      // Clearing `context` after save would surprise the user mid-task —
      // keep their text, just close the save panel.
      setShowSavePanel(false);
      setSaveName('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const selected = templates.find(t => t.id === templateId) || null;

  // Order: primary-type templates first (defaults at the top), then each
  // extra category in the order the caller passed them. Inside a category
  // we keep the API's existing ordering (defaults first, then name asc).
  const orderedTemplates = allFieldTypes.flatMap((ft) =>
    templates.filter(t => t.field_type === ft),
  );
  const hasMultipleCategories = allFieldTypes.length > 1;

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>{label}</label>
          <Link
            href="/settings?section=templates"
            className="text-[10px] hover:underline"
            style={{ color: '#a78bfa' }}
            target="_blank"
            title="Manage templates in Settings"
          >
            Manage →
          </Link>
        </div>
        <select
          value={templateId ?? ''}
          onChange={e => onTemplateChange(e.target.value || null)}
          className="w-full px-3 py-2 rounded-lg text-sm"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          disabled={loading}
        >
          <option value="">{loading ? 'Loading templates…' : 'No template (default behavior)'}</option>
          {orderedTemplates.map(t => {
            // When the picker pulls in extra categories, suffix the
            // template name with its category so the user can tell a
            // borrowed "YouTube Description" template apart from a
            // dedicated "SEO" one.
            const categoryLabel = hasMultipleCategories && t.field_type !== fieldType
              ? `  ·  ${t.field_type.replace(/_/g, ' ')}`
              : '';
            return (
              <option key={t.id} value={t.id}>
                {t.name}{t.is_default ? '  ★' : ''}{categoryLabel}
              </option>
            );
          })}
        </select>
        {selected && borrowedScopeNote && selected.field_type !== fieldType && (
          // Borrowed-category template — communicate the routing scope
          // so the user knows the rules won't apply uniformly. Styled
          // distinctly from the content preview below so it reads as
          // meta-info, not as template content.
          <p
            className="text-[11px] mt-1.5 px-2 py-1.5 rounded flex items-start gap-1.5"
            style={{
              background: 'rgba(59,130,246,0.08)',
              color: '#93c5fd',
              borderLeft: '2px solid #3b82f6',
            }}
          >
            <span aria-hidden style={{ flexShrink: 0 }}>ℹ</span>
            <span>{borrowedScopeNote}</span>
          </p>
        )}
        {selected && (
          <p className="text-[11px] mt-1.5 px-2 py-1.5 rounded whitespace-pre-wrap" style={{ background: 'rgba(124,58,237,0.06)', color: 'var(--text-muted)', borderLeft: '2px solid rgba(124,58,237,0.4)' }}>
            {selected.content.length > 240 ? selected.content.slice(0, 240) + '…' : selected.content}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
            Extra context for this generation
          </label>
          {context.trim().length > 0 && !showSavePanel && (
            <button
              type="button"
              onClick={() => { setShowSavePanel(true); setSaveError(null); }}
              className="text-[10px] hover:underline"
              style={{ color: '#a78bfa' }}
              title="Save this context as a reusable template"
            >
              💾 Save as template
            </button>
          )}
        </div>
        <textarea
          value={context}
          onChange={e => onContextChange(e.target.value)}
          placeholder={selected
            ? `Add anything specific to this video that the &ldquo;${selected.name}&rdquo; template doesn't cover…`
            : 'Anything the AI should know about this specific video…'}
          rows={compact ? 3 : 4}
          className="w-full px-3 py-2 rounded-lg text-sm resize-y"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
        {showSavePanel && (
          <div
            className="mt-2 p-2.5 rounded-lg space-y-2"
            style={{ background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.3)' }}
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Template name (e.g. &quot;Cold open · 6 sections&quot;)"
                className="flex-1 px-2.5 py-1.5 rounded-md text-sm outline-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSaveAsTemplate(); }
                  if (e.key === 'Escape') { setShowSavePanel(false); setSaveName(''); setSaveError(null); }
                }}
              />
              <button
                type="button"
                onClick={handleSaveAsTemplate}
                disabled={saving}
                className="text-xs font-medium px-3 py-1.5 rounded-md disabled:opacity-50"
                style={{ background: '#7c3aed', color: 'white' }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => { setShowSavePanel(false); setSaveName(''); setSaveError(null); }}
                disabled={saving}
                className="text-xs px-2 py-1.5 rounded-md"
                style={{ color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
            </div>
            {saveError && (
              <p className="text-[11px]" style={{ color: '#ef4444' }}>{saveError}</p>
            )}
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Saves the text above as a reusable template. Available next time from the dropdown.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Pure helper: combine a template's content (if any) with per-call extra
 * context into a single string suitable for prepending to a prompt's user
 * message. Keeps the formatting consistent across features.
 */
export function buildCombinedContext(templateContent: string | null | undefined, extraContext: string | null | undefined): string {
  const parts: string[] = [];
  if (templateContent && templateContent.trim()) {
    parts.push(`STYLE / DIRECTION (from saved template):\n${templateContent.trim()}`);
  }
  if (extraContext && extraContext.trim()) {
    parts.push(`ADDITIONAL CONTEXT FOR THIS VIDEO:\n${extraContext.trim()}`);
  }
  return parts.join('\n\n');
}
