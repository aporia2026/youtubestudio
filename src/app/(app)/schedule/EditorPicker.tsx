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
  /** Called after add/rename/delete so the parent can re-fetch items and
   *  flush stale denormalised editor_name values off every card. */
  onRosterChanged?: () => void;
};

type EditorWithChannel = ChannelEditor & { channelName?: string; channelColor?: string | null };

export function EditorPicker({ linkedChannels, selectedEditorId, onChange, onRosterChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [editors, setEditors] = useState<EditorWithChannel[]>([]);
  const [newName, setNewName] = useState('');
  const [targetChannelId, setTargetChannelId] = useState<string | null>(linkedChannels[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Default add-target follows the linked channels: when the item's linked set
  // changes (or first loads), point at the first linked channel.
  useEffect(() => {
    setTargetChannelId(prev => prev && linkedChannels.some(c => c.id === prev) ? prev : (linkedChannels[0]?.id ?? null));
  }, [linkedChannels]);

  // A stable dep key so the effect below doesn't refetch on every identity
  // change of the array prop (caller memoises, but belt-and-braces).
  const linkedIdsKey = useMemo(() => linkedChannels.map(c => c.id).join('|'), [linkedChannels]);

  const fetchRoster = useCallback(async () => {
    if (linkedChannels.length === 0) { setEditors([]); return; }
    setLoading(true);
    try {
      const results = await Promise.all(linkedChannels.map(async c => {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/channels/${c.id}/editors`);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.editors as ChannelEditor[]).map(e => ({ ...e, channelName: c.name, channelColor: c.account_color }));
      }));
      setEditors(results.flat());
    } finally {
      setLoading(false);
    }
    // linkedChannels identity changes don't matter — we key off linkedIdsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedIdsKey]);

  useEffect(() => { fetchRoster(); }, [fetchRoster]);

  // Click-away and Esc dismiss the popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = useMemo(() => editors.find(e => e.id === selectedEditorId) ?? null, [editors, selectedEditorId]);

  async function createEditor() {
    const name = newName.trim();
    if (!name) return;
    if (!targetChannelId) { toast.error('Link a channel first, then add editors'); return; }
    if (saving) return; // defend against double-click / Enter-spam
    setSaving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(`/api/channels/${targetChannelId}/editors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Could not add editor'); return; }
      setNewName('');
      onChange(data.editor.id);
      await fetchRoster();
      const channelName = linkedChannels.find(c => c.id === targetChannelId)?.name ?? 'channel';
      if (data.existed) {
        toast.message(`${data.editor.name} was already on ${channelName} — selected`);
      } else {
        toast.success(`${name} added to ${channelName}`);
      }
      onRosterChanged?.();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function commitRename(id: string) {
    const next = renameDraft.trim();
    if (!next) { setRenamingId(null); return; }
    const prev = editors.find(e => e.id === id)?.name;
    setRenamingId(null);
    if (next === prev) return;
    // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
    const res = await fetch(`/api/channel-editors/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: next }),
    });
    if (!res.ok) { toast.error('Rename failed'); return; }
    await fetchRoster();
    onRosterChanged?.();
  }

  async function removeEditor(id: string) {
    const ed = editors.find(e => e.id === id);
    const name = ed?.name ?? 'this editor';
    if (!confirm(`Remove ${name} from the roster? Videos they were assigned to will be unlinked but remain in the schedule.`)) return;
    // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
    const res = await fetch(`/api/channel-editors/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Remove failed'); return; }
    if (selectedEditorId === id) onChange(null);
    await fetchRoster();
    onRosterChanged?.();
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
            {!loading && editors.length === 0 && linkedChannels.length > 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                No editors saved for {linkedChannels.length === 1 ? linkedChannels[0].name : 'these channels'} yet — add one below.
              </div>
            )}
            {!loading && linkedChannels.length === 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                Link this video to at least one channel before adding editors.
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
                {renamingId === ed.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.currentTarget.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(ed.id);
                      else if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => commitRename(ed.id)}
                    className="flex-1 px-2 py-1 rounded text-sm"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                  />
                ) : (
                  <button onClick={() => { onChange(ed.id); setOpen(false); }} className="flex-1 flex items-center gap-2 text-left">
                    <EditorAvatar name={ed.name} color={ed.channelColor ?? null} />
                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{ed.name}</span>
                    {ed.channelName && (
                      <span className="text-[10px] ml-auto px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {ed.channelName}
                      </span>
                    )}
                  </button>
                )}
                {renamingId !== ed.id && (
                  <>
                    <button
                      onClick={() => { setRenamingId(ed.id); setRenameDraft(ed.name); }}
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
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Add new */}
          {linkedChannels.length > 0 && (
            <div className="p-2 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
              <input
                value={newName}
                onChange={e => setNewName(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && targetChannelId) createEditor();
                }}
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
                disabled={!newName.trim() || !targetChannelId || saving}
                className="text-xs px-2 py-1 rounded"
                style={{
                  background: newName.trim() && targetChannelId && !saving ? 'var(--accent-purple-bright)' : 'var(--bg-secondary)',
                  color: newName.trim() && targetChannelId && !saving ? 'white' : 'var(--text-muted)',
                  opacity: newName.trim() && targetChannelId && !saving ? 1 : 0.6,
                }}
              >
                {saving ? '…' : 'Add'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EditorAvatar({ name, color, size = 20 }: { name: string; color: string | null; size?: number }) {
  // Slice off combining marks / emoji variation selectors for a safer initials
  // fallback on unusual names. Anything that doesn't contribute a visible char
  // becomes "?"; avoids a blank avatar.
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map(p => {
    const ch = Array.from(p)[0] ?? '';
    return ch.toUpperCase();
  }).join('') || '?';
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
