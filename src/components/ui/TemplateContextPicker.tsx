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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/templates?field_type=${fieldType}`);
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          const list: Template[] = data.templates || [];
          setTemplates(list);
          // Auto-select the user's default template the first time we see it.
          if (autoSelectDefault && templateId === null) {
            const def = list.find(t => t.is_default);
            if (def) onTemplateChange(def.id);
          }
        }
      } catch {} finally { if (!cancelled) setLoading(false); }
    }
    load();
    function onVisible() { if (!document.hidden) load(); }
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldType]);

  const selected = templates.find(t => t.id === templateId) || null;

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
          {templates.map(t => (
            <option key={t.id} value={t.id}>
              {t.name}{t.is_default ? '  ★' : ''}
            </option>
          ))}
        </select>
        {selected && (
          <p className="text-[11px] mt-1.5 px-2 py-1.5 rounded whitespace-pre-wrap" style={{ background: 'rgba(124,58,237,0.06)', color: 'var(--text-muted)', borderLeft: '2px solid rgba(124,58,237,0.4)' }}>
            {selected.content.length > 240 ? selected.content.slice(0, 240) + '…' : selected.content}
          </p>
        )}
      </div>

      <div>
        <label className="text-[11px] uppercase tracking-wider font-semibold mb-1.5 block" style={{ color: 'var(--text-muted)' }}>
          Extra context for this generation
        </label>
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
