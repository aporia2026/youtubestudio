'use client';

import { useState } from 'react';
import { toast } from 'sonner';

interface SaveAsProjectProps {
  script?: string;
  niche: string;
  topic: string;
  modelId?: string;
  onSaved?: (projectId: string) => void;
  className?: string;
  variant?: 'primary' | 'secondary';
  label?: string;
}

export function SaveAsProject({ script, niche, topic, modelId, onSaved, className = '', variant = 'primary', label }: SaveAsProjectProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(topic || '');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!title.trim()) { toast.error('Enter a project title'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          niche: niche || 'General',
          topic: topic || title.trim(),
          script: script || undefined,
          modelId,
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      const data = await res.json();
      toast.success('Project saved!');
      setOpen(false);
      onSaved?.(data.project?.id);
    } catch {
      toast.error('Failed to save project');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => { setTitle(topic || ''); setOpen(true); }}
        className={`${variant === 'primary' ? 'btn-primary' : 'btn-secondary'} text-sm ${className}`}
      >
        💾 {label || 'Save as Project'}
      </button>
    );
  }

  return (
    <div className={`p-4 rounded-lg ${className}`} style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(124,58,237,0.3)' }}>
      <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Save as Project</h4>
      <div className="flex gap-2">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Project title..."
          className="input-field flex-1"
          style={{ fontSize: 13, padding: '6px 10px' }}
          onKeyDown={e => e.key === 'Enter' && save()}
          autoFocus
        />
        <button onClick={save} disabled={saving || !title.trim()} className="btn-primary text-xs px-3">
          {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Save'}
        </button>
        <button onClick={() => setOpen(false)} className="text-xs" style={{ color: 'var(--text-muted)' }}>Cancel</button>
      </div>
    </div>
  );
}
