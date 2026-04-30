'use client';

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';

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
  created_at: string;
  updated_at: string;
}

const FIELD_META: Array<{ id: FieldType; label: string; example: string; color: string }> = [
  { id: 'script',              label: 'Script Generator',       example: 'e.g. "Fast & engaging — cut to the chase, no rambling, max 8 min"', color: '#a78bfa' },
  { id: 'youtube_description', label: 'YouTube Description',    example: 'e.g. "First-person voice, 3 hashtags, link to Discord at the bottom"', color: '#06b6d4' },
  { id: 'title',               label: 'Title',                  example: 'e.g. "Always include a number and a year"',                            color: '#f59e0b' },
  { id: 'thumbnail',           label: 'Thumbnail',              example: 'e.g. "Bold red text overlay, shocked-face style"',                      color: '#ef4444' },
  { id: 'idea',                label: 'Idea Generator',         example: 'e.g. "Focus on contrarian takes, niche-specific angles"',               color: '#22c55e' },
  { id: 'qa',                  label: 'QA Engine',              example: 'e.g. "Be brutally direct, flag every passive sentence"',                 color: '#ec4899' },
  { id: 'production_doc',      label: 'Production Doc',         example: 'e.g. "Documentary style — slow, archival B-roll, sparse music"',        color: '#14b8a6' },
  { id: 'other',               label: 'Other',                  example: 'Any other reusable preset',                                              color: 'var(--text-muted)' },
];

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeField, setActiveField] = useState<FieldType>('script');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftDefault, setDraftDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/templates');
      if (res.ok) {
        const data = await res.json();
        setTemplates(data.templates || []);
      }
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function startCreate() {
    setEditingId(null);
    setDraftName('');
    setDraftContent('');
    setDraftDefault(false);
    setCreating(true);
  }

  function startEdit(t: Template) {
    setEditingId(t.id);
    setDraftName(t.name);
    setDraftContent(t.content);
    setDraftDefault(t.is_default);
    setCreating(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setCreating(false);
    setDraftName('');
    setDraftContent('');
    setDraftDefault(false);
  }

  async function save() {
    if (!draftName.trim() || !draftContent.trim()) {
      toast.error('Name and content are required');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const res = await fetch(`/api/templates/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: draftName, content: draftContent, is_default: draftDefault }),
        });
        if (!res.ok) throw new Error('save failed');
        toast.success('Template updated');
      } else {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field_type: activeField, name: draftName, content: draftContent, is_default: draftDefault }),
        });
        if (!res.ok) throw new Error('create failed');
        toast.success('Template created');
      }
      cancelEdit();
      await load();
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this template?')) return;
    try {
      await fetch(`/api/templates/${id}`, { method: 'DELETE' });
      toast.success('Template deleted');
      await load();
    } catch { toast.error('Failed to delete'); }
  }

  const fieldTemplates = templates.filter(t => t.field_type === activeField);
  const meta = FIELD_META.find(f => f.id === activeField)!;

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Prompt Templates</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Save reusable creative directions you can pick from when generating with AI. Each template is paired with a per-call &ldquo;extra context&rdquo; box, so you set up the recurring part once and just tweak what&apos;s different per video.
        </p>

        {/* Field-type tabs */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {FIELD_META.map(f => {
            const count = templates.filter(t => t.field_type === f.id).length;
            const active = activeField === f.id;
            return (
              <button
                key={f.id}
                onClick={() => { setActiveField(f.id); cancelEdit(); }}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  background: active ? `${f.color}22` : 'var(--bg-secondary)',
                  color: active ? f.color : 'var(--text-secondary)',
                  border: `1px solid ${active ? f.color : 'transparent'}`,
                }}
              >
                {f.label}{count > 0 && <span className="ml-1.5 opacity-60">({count})</span>}
              </button>
            );
          })}
        </div>

        <div className="rounded-lg p-3 mb-3" style={{ background: 'var(--bg-secondary)' }}>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: meta.color, fontWeight: 600 }}>Tip:</span> {meta.example}
          </p>
        </div>

        {/* List */}
        {loading ? (
          <div className="py-8 text-center"><div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>
        ) : fieldTemplates.length === 0 && !creating ? (
          <div className="text-center py-8 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
            <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>No {meta.label} templates yet</p>
            <button onClick={startCreate} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: meta.color }}>+ New template</button>
          </div>
        ) : (
          <div className="space-y-2">
            {fieldTemplates.map(t => (
              <div key={t.id}>
                {editingId === t.id ? (
                  <TemplateEditor
                    name={draftName}
                    content={draftContent}
                    isDefault={draftDefault}
                    onName={setDraftName}
                    onContent={setDraftContent}
                    onDefault={setDraftDefault}
                    onSave={save}
                    onCancel={cancelEdit}
                    saving={saving}
                    color={meta.color}
                  />
                ) : (
                  <div className="rounded-lg p-3 flex items-start gap-3" style={{ background: 'var(--bg-secondary)', border: t.is_default ? `1px solid ${meta.color}` : '1px solid transparent' }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t.name}</span>
                        {t.is_default && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: `${meta.color}22`, color: meta.color }}>default</span>}
                      </div>
                      <p className="text-xs whitespace-pre-wrap line-clamp-3" style={{ color: 'var(--text-muted)' }}>{t.content}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => startEdit(t)} className="text-[11px] px-2 py-1 rounded transition-colors" style={{ color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.05)' }}>Edit</button>
                      <button onClick={() => remove(t.id)} className="text-[11px] px-2 py-1 rounded transition-colors" style={{ color: '#ef4444', background: 'rgba(239,68,68,0.1)' }}>Delete</button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {creating && (
              <TemplateEditor
                name={draftName}
                content={draftContent}
                isDefault={draftDefault}
                onName={setDraftName}
                onContent={setDraftContent}
                onDefault={setDraftDefault}
                onSave={save}
                onCancel={cancelEdit}
                saving={saving}
                color={meta.color}
              />
            )}

            {!creating && !editingId && (
              <button onClick={startCreate} className="w-full text-center py-2 rounded-lg text-xs font-medium transition-colors" style={{ background: 'rgba(124,58,237,0.1)', color: '#a78bfa', border: '1px dashed rgba(124,58,237,0.3)' }}>
                + New {meta.label} template
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface EditorProps {
  name: string;
  content: string;
  isDefault: boolean;
  onName: (v: string) => void;
  onContent: (v: string) => void;
  onDefault: (v: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  color: string;
}
function TemplateEditor({ name, content, isDefault, onName, onContent, onDefault, onSave, onCancel, saving, color }: EditorProps) {
  return (
    <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--bg-secondary)', border: `1px solid ${color}` }}>
      <input
        autoFocus
        value={name}
        onChange={e => onName(e.target.value)}
        placeholder="Template name (e.g. 'Fast & Engaging — no fluff')"
        className="w-full px-3 py-2 rounded-lg text-sm"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      />
      <textarea
        value={content}
        onChange={e => onContent(e.target.value)}
        placeholder="The reusable instruction. Will be prepended to AI calls every time you pick this template. Be specific — voice, tone, structure, hard rules."
        rows={6}
        className="w-full px-3 py-2 rounded-lg text-sm resize-y font-mono"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <input type="checkbox" checked={isDefault} onChange={e => onDefault(e.target.checked)} />
          Auto-select this template by default
        </label>
        <div className="flex gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>Cancel</button>
          <button onClick={onSave} disabled={saving || !name.trim() || !content.trim()} className="text-xs px-3 py-1.5 rounded-lg text-white disabled:opacity-50" style={{ background: color }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
