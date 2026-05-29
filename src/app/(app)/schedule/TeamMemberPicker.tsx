'use client';

// Picks a person from /team — used on schedule items to assign an editor or
// narrator from the unified collaborators table (independent of the legacy
// per-channel channel_editors roster).

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  color: string;
  role: string;
  personal_token: string | null;
}

type Props = {
  /** 'editor' or 'narrator' */
  role: 'editor' | 'narrator';
  selectedId: string | null;
  /** Optional pre-known display values so the button label renders correctly
   *  before the roster fetch returns. */
  selectedName?: string | null;
  selectedColor?: string | null;
  selectedToken?: string | null;
  onChange: (id: string | null) => void;
};

const ROLE_COPY: Record<string, { empty: string; emptyTeam: string; addLink: string }> = {
  editor: {
    empty: 'No editor assigned — pick from your Team',
    emptyTeam: 'No editors in your Team yet.',
    addLink: 'Add an editor to Team →',
  },
  narrator: {
    empty: 'No narrator assigned — pick from your Team',
    emptyTeam: 'No narrators in your Team yet.',
    addLink: 'Add a narrator to Team →',
  },
};

export function TeamMemberPicker({ role, selectedId, selectedName, selectedColor, selectedToken, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch the roster lazily — only when the popover opens for the first time.
  useEffect(() => {
    if (!open || people.length > 0) return;
    setLoading(true);
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/team/collaborators?role=${role}`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: Collaborator[]) => setPeople(rows))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, role, people.length]);

  // Click-away + Esc to close
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(p =>
      p.name.toLowerCase().includes(q) || (p.email?.toLowerCase().includes(q) ?? false)
    );
  }, [people, query]);

  // Show whatever name/color the parent provided. If we already fetched the
  // roster, prefer the live row in case it was renamed.
  const live = people.find(p => p.id === selectedId);
  const displayName = live?.name ?? selectedName ?? null;
  const displayColor = live?.color ?? selectedColor ?? '#7c3aed';
  const displayToken = live?.personal_token ?? selectedToken ?? null;
  const copy = ROLE_COPY[role];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left cursor-pointer"
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
      >
        {selectedId && displayName ? (
          <>
            <Avatar name={displayName} color={displayColor} />
            <span className="truncate">{displayName}</span>
            {displayToken && (
              <a
                href={`/${role}/${displayToken}`}
                target="_blank"
                rel="noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-[10px] ml-auto px-1.5 py-0.5 rounded shrink-0 hover:underline"
                style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}
                title="Open this person's dashboard in a new tab"
              >
                dashboard ↗
              </a>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>{copy.empty}</span>
        )}
        <svg className="ml-auto shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg overflow-hidden"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}
        >
          {/* Search */}
          <div className="p-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.currentTarget.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder={`Search ${role}s by name or email…`}
              className="w-full px-2 py-1 rounded text-sm"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            />
          </div>

          <div className="max-h-64 overflow-y-auto">
            {loading && <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>}
            {!loading && people.length === 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                {copy.emptyTeam}
                <Link href="/team" className="block mt-1.5" style={{ color: '#a78bfa' }} onClick={() => setOpen(false)}>{copy.addLink}</Link>
              </div>
            )}
            {!loading && people.length > 0 && filtered.length === 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>No matches for &ldquo;{query}&rdquo;</div>
            )}
            {selectedId && (
              <button
                onClick={() => { onChange(null); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-xs cursor-pointer hover:bg-white/5"
                style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}
              >
                Clear assignment
              </button>
            )}
            {filtered.map(p => (
              <button
                key={p.id}
                onClick={() => { onChange(p.id); setOpen(false); setQuery(''); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-white/5 cursor-pointer"
                style={{ background: selectedId === p.id ? 'rgba(124,58,237,0.12)' : 'transparent' }}
              >
                <Avatar name={p.name} color={p.color} />
                <div className="flex-1 min-w-0">
                  <p className="truncate" style={{ color: 'var(--text-primary)' }}>{p.name}</p>
                  {p.email && <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{p.email}</p>}
                </div>
                {selectedId === p.id && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))}
          </div>

          {/* Footer link to /team for adding more */}
          <div className="px-3 py-2 text-[11px]" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <Link href="/team" onClick={() => setOpen(false)} className="hover:underline" style={{ color: '#a78bfa' }}>
              Manage your Team →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name, color }: { name: string; color: string }) {
  const ch = ((name || '?')[0] || '?').toUpperCase();
  return (
    <span
      className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center font-semibold text-white"
      style={{ background: color, fontSize: 10 }}
      title={name}
    >
      {ch}
    </span>
  );
}
