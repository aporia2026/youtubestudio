'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';

import {
  TOP_NAV,
  HUBS,
  BOTTOM_NAV,
  type NavItem,
} from './nav-catalog';
import { readRecentPages } from './use-recent-pages';

interface PageEntry {
  label: string;
  href: string;
  group: string;
  hint?: string;
  keywords?: string[];
}

// Palette-only deep links — sub-pages and pre-filtered views that aren't
// worth a sidebar slot but should be reachable via Cmd+K.
const PALETTE_EXTRAS: PageEntry[] = [
  { label: 'New Project',         href: '/projects/new',                 group: 'Workspace', hint: 'Create' },
  { label: 'Pipeline presets',    href: '/pipeline/presets',             group: 'Create',    hint: 'Manage auto-pipeline templates', keywords: ['preset', 'template', 'rules'] },
  { label: 'Thumbnail templates', href: '/pipeline/thumbnail-templates', group: 'Create',    hint: 'Reusable thumbnail configs',     keywords: ['thumbnail', 'template'] },
  { label: 'Channel Naming',      href: '/channel-naming',               group: 'Grow',      hint: 'Brand name generator' },
  { label: 'Editors',             href: '/team?role=editor',             group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Narrators',           href: '/team?role=narrator',           group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Reviewers',           href: '/team?role=reviewer',           group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Clients',             href: '/team?role=client',             group: 'Collaborate', hint: 'Filter by role' },
];

function toPageEntry(item: NavItem, group: string): PageEntry {
  return {
    label: item.label,
    href: item.href,
    group,
    hint: item.hint,
    keywords: item.keywords,
  };
}

// Single source of truth: derive the palette index from the same catalog
// the sidebar renders. Adding a tool to the catalog automatically makes
// it findable in ⌘K — no second list to maintain.
const PAGES: PageEntry[] = [
  ...TOP_NAV.map(i => toPageEntry(i, 'Workspace')),
  // Hub landing pages — searchable so ⌘K + "create" jumps to the hub.
  ...HUBS.map(hub => ({
    label: `${hub.label} hub`,
    href: hub.href,
    group: 'Hubs',
    hint: hub.description,
    keywords: ['hub', hub.label.toLowerCase()],
  })),
  ...HUBS.flatMap(hub => hub.items.map(i => toPageEntry(i, hub.label))),
  ...BOTTOM_NAV.map(i => toPageEntry(i, 'Settings')),
  ...PALETTE_EXTRAS,
];

const PAGES_BY_HREF: Map<string, PageEntry> = new Map(PAGES.map(p => [p.href, p]));

// Don't trigger the `/` shortcut when the user is typing — they almost
// certainly want a literal slash in their field, not a palette toggle.
function isTypingInElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function GlobalCommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [recent, setRecent] = useState<PageEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open via Cmd/Ctrl+K, `/`, custom event. Escape to close handled below.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      if (isCmdK) {
        e.preventDefault();
        setOpen(o => {
          const next = !o;
          if (next) console.info('[palette]', 'open', { source: 'cmdk' });
          return next;
        });
        return;
      }

      // `/` opens — but only when the user isn't typing somewhere, so it
      // never hijacks a search box, comment field, or contenteditable.
      // No toggle: pressing `/` again with palette already open should
      // type into the search input, not close.
      if (e.key === '/' && !isTypingInElement(e.target)) {
        e.preventDefault();
        setOpen(o => {
          if (!o) console.info('[palette]', 'open', { source: 'slash' });
          return true;
        });
        return;
      }
    }
    function onOpen() {
      console.info('[palette]', 'open', { source: 'click' });
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-command-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('open-command-palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    // Re-read recent on every open so it reflects whatever the user has
    // visited since the last time the palette was open.
    const items: PageEntry[] = [];
    for (const entry of readRecentPages()) {
      const page = PAGES_BY_HREF.get(entry.href);
      if (page) items.push(page);
    }
    setRecent(items);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => { setIdx(0); }, [q]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) {
      // Empty query: show recent first (deduplicated against the rest)
      // followed by the catalog, capped at a sane height.
      const recentHrefs = new Set(recent.map(p => p.href));
      const rest = PAGES.filter(p => !recentHrefs.has(p.href));
      return [...recent, ...rest].slice(0, 24);
    }
    const tokens = needle.split(/\s+/);
    const scored = PAGES
      .map(p => {
        const hay = `${p.label} ${p.hint ?? ''} ${p.group} ${p.keywords?.join(' ') ?? ''}`.toLowerCase();
        const allMatch = tokens.every(t => hay.includes(t));
        if (!allMatch) return null;
        // Boost label-prefix matches
        const labelLow = p.label.toLowerCase();
        const score = tokens.reduce((s, t) => s + (labelLow.startsWith(t) ? 100 : labelLow.includes(t) ? 10 : 1), 0);
        return { p, score };
      })
      .filter((x): x is { p: PageEntry; score: number } => !!x)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map(x => x.p);
    return scored;
  }, [q, recent]);

  // Recent count drives the visual divider between "Recent" and
  // "All pages" sections. Set to 0 when the user has typed something —
  // search results aren't grouped.
  const recentCount = q.trim() ? 0 : Math.min(recent.length, filtered.length);

  // No-match diagnostic — fires once the user has actually typed something.
  // Helps surface searches that didn't land so we can backfill keywords.
  useEffect(() => {
    const needle = q.trim();
    if (needle && filtered.length === 0) {
      console.info('[palette]', 'no-match', { q: needle });
    }
  }, [q, filtered.length]);

  function go(entry: PageEntry) {
    const rank = filtered.indexOf(entry);
    console.info('[palette]', 'select', { q: q.trim(), href: entry.href, rank, group: entry.group });
    router.push(entry.href);
    setOpen(false);
  }

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4"
        style={{ background: 'rgba(0,0,0,0.6)' }}
      >
        <motion.div
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); const c = filtered[idx]; if (c) go(c); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          className="w-full max-w-xl rounded-xl overflow-hidden"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 30px 80px rgba(0,0,0,0.6)' }}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.currentTarget.value)}
              placeholder="Jump to a page…"
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--text-primary)' }}
            />
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              ESC
            </span>
          </div>

          {/* Results */}
          <div className="max-h-[50vh] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                No matches for &ldquo;{q}&rdquo;
              </div>
            )}
            {filtered.map((p, i) => (
              <div key={p.href}>
                {recentCount > 0 && i === 0 && <SectionLabel>Recent</SectionLabel>}
                {recentCount > 0 && i === recentCount && <SectionLabel>All pages</SectionLabel>}
                <button
                  onClick={() => go(p)}
                  onMouseEnter={() => setIdx(i)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    background: i === idx ? 'rgba(124,58,237,0.15)' : 'transparent',
                    color: 'var(--text-primary)',
                  }}
                >
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                    {p.group}
                  </span>
                  <span className="flex-1 truncate font-medium">{p.label}</span>
                  {p.hint && <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{p.hint}</span>}
                  {i === idx && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#a78bfa' }}>
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  )}
                </button>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 text-[10px] flex items-center justify-between"
            style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <span>↑↓ Navigate · ↵ Open</span>
            <span>⌘K or / to toggle</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest font-bold"
      style={{ color: 'var(--text-muted)' }}
    >
      {children}
    </div>
  );
}
