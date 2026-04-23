'use client';

import { useState } from 'react';
import type { ChecklistItem } from '@/lib/schedule';

type Props = {
  items: ChecklistItem[];
  onChange: (next: ChecklistItem[]) => void;
};

export function ChecklistSection({ items, onChange }: Props) {
  const [draft, setDraft] = useState('');

  function toggle(id: string) {
    onChange(items.map(it => it.id === id ? { ...it, done: !it.done } : it));
  }
  function remove(id: string) {
    onChange(items.filter(it => it.id !== id));
  }
  function add() {
    const text = draft.trim();
    if (!text) return;
    const next: ChecklistItem = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      done: false,
    };
    onChange([...items, next]);
    setDraft('');
  }

  const done = items.filter(it => it.done).length;
  const total = items.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Checklist {total > 0 && <span style={{ color: done === total ? '#10b981' : 'var(--text-muted)' }}>· {done}/{total}</span>}
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="h-1 rounded-full overflow-hidden mb-2"
          style={{ background: 'var(--bg-tertiary)' }}>
          <div className="h-full"
            style={{
              width: `${(done / total) * 100}%`,
              background: done === total ? '#10b981' : 'linear-gradient(90deg, #7c3aed, #06b6d4)',
              transition: 'width 220ms',
            }} />
        </div>
      )}

      <div className="space-y-1">
        {items.map(it => (
          <div key={it.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5">
            <input type="checkbox" checked={it.done} onChange={() => toggle(it.id)} className="shrink-0" />
            <span className="flex-1 text-sm"
              style={{
                color: it.done ? 'var(--text-muted)' : 'var(--text-primary)',
                textDecoration: it.done ? 'line-through' : 'none',
              }}>
              {it.text}
              {it.stage && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                  {it.stage}
                </span>
              )}
            </span>
            <button onClick={() => remove(it.id)}
              className="opacity-0 hover:opacity-100 group-hover:opacity-100 transition-opacity text-xs"
              style={{ color: 'var(--text-muted)' }}
              title="Remove">✕</button>
          </div>
        ))}
      </div>

      {/* Add */}
      <div className="flex gap-2 mt-2">
        <input
          value={draft}
          onChange={e => setDraft(e.currentTarget.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="Add item — press Enter"
          className="flex-1 px-3 py-1.5 rounded text-sm"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
        />
        <button onClick={add}
          disabled={!draft.trim()}
          className="px-3 py-1.5 rounded text-xs font-medium"
          style={{
            background: draft.trim() ? 'var(--accent-purple-bright)' : 'var(--bg-tertiary)',
            color: draft.trim() ? 'white' : 'var(--text-muted)',
          }}>
          Add
        </button>
      </div>
    </div>
  );
}
