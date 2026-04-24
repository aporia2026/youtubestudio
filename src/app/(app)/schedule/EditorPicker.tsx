'use client';

// Editor assignment for a schedule item. Lists the combined rosters of every
// channel the item is linked to, and supports inline add / rename / delete so
// the user can manage the roster without leaving the detail drawer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ChannelEditor } from '@/lib/schedule';
import type { Channel } from './types';

type Props = {
  linkedChannels: Channel[];
  selectedEditorId: string | null;
  onChange: (editorId: string | null) => void;
};

type EditorWithChannel = ChannelEditor & { channelName?: string; channelColor?: string | null };

export function EditorPicker({ linkedChannels, selectedEditorId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [editors, setEditors] = useState<EditorWithChannel[]>([]);
  const [newName, setNewName] = useState('');
  const [targetChannelId, setTargetChannelId] = useState<string | null>(linkedChannels[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Default add-target follows the linked channels: when the item's linked set
  // changes (or first loads), point at the first linked channel.
  useEffect(() => {
    setTargetChannelId(prev => prev && linkedChannels.some(c => c.id === prev) ? prev : (linkedChannels[0]?.id ?? null));
  }, [linkedChannels]);

  const fetchRoster = useCallback(async () => {
    if (linkedChannels.length === 0) { setEditors([]); return; }
    setLoading(true);
    try {
      const results = await Promise.all(linkedChannels.map(async c => {
        const res = await fetch(`/api/channels/${c.id}/editors`);
        const data = await res.json();
        return (data.editors as ChannelEditor[]).map(e => ({ ...e, channelName: c.name, channelColor: c.account_color }));
      }));
      setEditors(results.flat());
    } finally {
      setLoading(false);
    }
  }, [linkedChannels]);

  useEffect(() => { fetchRoster(); }, [fetchRoster]);

  // Click-away dismisses the popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selected = useMemo(() => editors.find(e => e.id === selectedEditorId) ?? null, [editors, selectedEditorId]);

  async function createEditor() {
    const name = newName.trim();
    if (!name) return;
    if (!targetChannelId) { toast.error('Link a channel first, then add editors'); return; }
    const res = await fetch(`/api/channels/${targetChannelId}/editors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error || 'Could not add editor'); return; }
    setNewName('');
    // Assign on create — matches user intent ("add + pick") in a single keystroke.
    onChange(data.editor.id);
    await fetchRoster();
    toast.success(`${name} added to ${linkedChannels.find(c => c.id === targetChannelId)?.name ?? 'channel'}`);
  }

  async function renameEditor(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await fetch(`/api/channel-editors/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (!res.ok) { toast.error('Rename failed'); return; }
    await fetchRoster();
  }

  async function removeEditor(id: string) {
    if (!confirm('Remove this editor from the roster? Videos they were assigned to will be unlinked but remain in the schedule.')) return;
    const res = await fetch(`/api/channel-editors/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Remove failed'); return; }
    if (selectedEditorId === id) onChange(null);
    await fetchRoster();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
      >
        {selected ? (
          <>
            <EditorAvatar name={selected.name} color={selected.channelColor ?? null} />
            <span className="truncate">{selected.name}</span>
            {selected.channelName && (
              <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                {selected.channelName}
              </span>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No editor assigned — click to pick or add</span>
        )}
        <svg className="ml-auto shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg overflow-hidden"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}
        >
          {/* Current roster */}
          <div className="max-h-56 overflow-y-auto">
            {loading && <div className="px-3 py-2 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>}
            {!loading && editors.length === 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                No editors saved for {linkedChannels.length === 1 ? linkedChannels[0].name : 'these channels'} yet — add one below.
              </div>
            )}
            {selectedEditorId && (
              <button
                onClick={() => { onChange(null); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-xs"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
              >
                Clear assignment
              </button>
            )}
            {editors.map(ed => (
              <div key={ed.id} className="group flex items-center gap-2 px-2 py-1.5 text-sm"
                style={{ background: selectedEditorId === ed.id ? 'rgba(124,58,237,0.12)' : 'transparent' }}>
                <button onClick={() => { onChange(ed.id); setOpen(false); }} className="flex-1 flex items-center gap-2 text-left">
                  <EditorAvatar name={ed.name} color={ed.channelColor ?? null} />
                  <span className="truncate" style={{ color: 'var(--text-primary)' }}>{ed.name}</span>
                  {ed.channelName && (
                    <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                      {ed.channelName}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => {
                    const next = prompt('Rename editor', ed.name);
                    if (next && next.trim() && next.trim() !== ed.name) renameEditor(ed.id, next);
                  }}
                  title="Rename"
                  className="opacity-0 group-hover:opacity-100 p-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                  </svg>
                </button>
                <button
                  onClick={() => removeEditor(ed.id)}
                  title="Remove"
                  className="opacity-0 group-hover:opacity-100 p-1"
                  style={{ color: '#ef4444' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Add new */}
          <div className="p-2 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
            <input
              value={newName}
              onChange={e => setNewName(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter') createEditor(); }}
              placeholder="New editor name"
              className="flex-1 px-2 py-1 rounded text-sm"
              style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
            {linkedChannels.length > 1 && (
              <select
                value={targetChannelId ?? ''}
                onChange={e => setTargetChannelId(e.currentTarget.value || null)}
                className="px-2 py-1 rounded text-xs"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                title="Which channel's roster to add to"
              >
                {linkedChannels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <button
              onClick={createEditor}
              disabled={!newName.trim() || !targetChannelId}
              className="text-xs px-2 py-1 rounded"
              style={{
                background: newName.trim() && targetChannelId ? 'var(--accent-purple-bright)' : 'var(--bg-secondary)',
                color: newName.trim() && targetChannelId ? 'white' : 'var(--text-muted)',
                opacity: newName.trim() && targetChannelId ? 1 : 0.6,
              }}
            >
              Add
            </button>
          </div>
          {linkedChannels.length === 0 && (
            <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              Link this video to at least one channel before adding editors.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EditorAvatar({ name, color, size = 20 }: { name: string; color: string | null; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
  const bg = color || '#7c3aed';
  return (
    <span
      className="shrink-0 rounded-full flex items-center justify-center font-semibold"
      title={name}
      style={{ width: size, height: size, background: bg, color: 'white', fontSize: size * 0.45 }}
    >
      {initials}
    </span>
  );
}
