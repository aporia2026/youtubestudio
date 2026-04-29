'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ScheduleItem } from '@/lib/schedule';

type Edge = {
  id: string;
  kind: string;
  note: string | null;
  other_id: string;
  other_title: string;
  other_status: string;
};

const KINDS = [
  { key: 'sequel_of', label: 'Sequel of' },
  { key: 'companion_of', label: 'Companion of' },
  { key: 'uses_broll_from', label: 'Uses B-roll from' },
  { key: 'relates_to', label: 'Relates to' },
];

type Props = {
  itemId: string;
  allItems: ScheduleItem[];
  onSelectItem: (id: string) => void;
};

export function DependenciesSection({ itemId, allItems, onSelectItem }: Props) {
  const [outgoing, setOutgoing] = useState<Edge[]>([]);
  const [incoming, setIncoming] = useState<Edge[]>([]);
  const [pickingTarget, setPickingTarget] = useState<string>('');
  const [pickingKind, setPickingKind] = useState<string>(KINDS[0].key);

  async function load() {
    const res = await fetch(`/api/schedule/${itemId}/dependencies`);
    const data = await res.json();
    setOutgoing(data.outgoing || []);
    setIncoming(data.incoming || []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [itemId]);

  async function add() {
    if (!pickingTarget) return;
    const res = await fetch(`/api/schedule/${itemId}/dependencies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_id: pickingTarget, kind: pickingKind }),
    });
    if (!res.ok) { toast.error('Could not add link'); return; }
    setPickingTarget('');
    load();
  }
  async function remove(edgeId: string) {
    const res = await fetch(`/api/schedule/${itemId}/dependencies?edge_id=${edgeId}`, { method: 'DELETE' });
    if (!res.ok) { toast.error('Could not remove'); return; }
    load();
  }

  const others = allItems.filter(i => i.id !== itemId);

  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
        Related videos
      </div>

      {outgoing.length > 0 && (
        <div className="space-y-1 mb-2">
          {outgoing.map(e => (
            <div key={e.id} className="flex items-center gap-2 px-2 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
                {KINDS.find(k => k.key === e.kind)?.label ?? e.kind}
              </span>
              <button onClick={() => onSelectItem(e.other_id)}
                className="flex-1 text-left truncate" style={{ color: 'var(--text-primary)' }}>
                {e.other_title}
              </button>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{e.other_status}</span>
              <button onClick={() => remove(e.id)} style={{ color: 'var(--text-muted)' }} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}

      {incoming.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>Referenced by</div>
          <div className="space-y-1 mb-2">
            {incoming.map(e => (
              <button key={e.id} onClick={() => onSelectItem(e.other_id)}
                className="w-full text-left px-2 py-1.5 rounded text-xs truncate"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                ← {e.other_title} ({KINDS.find(k => k.key === e.kind)?.label ?? e.kind})
              </button>
            ))}
          </div>
        </>
      )}

      {/* Add form */}
      <div className="flex gap-2">
        <select value={pickingKind} onChange={e => setPickingKind(e.currentTarget.value)}
          className="px-2 py-1.5 rounded text-xs"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
        </select>
        <select value={pickingTarget} onChange={e => setPickingTarget(e.currentTarget.value)}
          className="flex-1 px-2 py-1.5 rounded text-xs"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
          <option value="">Pick a video…</option>
          {others.map(it => <option key={it.id} value={it.id}>{it.title || 'Untitled'}</option>)}
        </select>
        <button onClick={add} disabled={!pickingTarget}
          className="text-xs px-3 py-1.5 rounded font-medium"
          style={{
            background: pickingTarget ? 'var(--accent-purple-bright)' : 'var(--bg-tertiary)',
            color: pickingTarget ? 'white' : 'var(--text-muted)',
          }}>
          Link
        </button>
      </div>
    </div>
  );
}
