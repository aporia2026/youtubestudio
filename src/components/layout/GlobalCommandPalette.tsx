'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRouter } from 'next/navigation';

interface PageEntry {
  label: string;
  href: string;
  group: string;
  hint?: string;
  keywords?: string[];
}

const PAGES: PageEntry[] = [
  // Plan
  { label: 'Dashboard', href: '/dashboard', group: 'Plan', hint: 'Overview' },
  { label: 'Projects', href: '/projects', group: 'Plan' },
  { label: 'Schedule', href: '/schedule', group: 'Plan', hint: 'List · Calendar · Spreadsheet · Kanban' },
  { label: 'New Project', href: '/projects/new', group: 'Plan', hint: 'Create' },

  // Create
  { label: 'Auto-pipeline', href: '/pipeline', group: 'Create', hint: 'Idea → script → QA → narration → docs', keywords: ['batch', 'auto', 'pipeline', 'one click', 'automation'] },
  { label: 'Pipeline presets', href: '/pipeline/presets', group: 'Create', hint: 'Manage auto-pipeline templates', keywords: ['preset', 'template', 'rules'] },
  { label: 'Thumbnail templates', href: '/pipeline/thumbnail-templates', group: 'Create', hint: 'Reusable thumbnail configs', keywords: ['thumbnail', 'template'] },
  { label: 'Idea Generator', href: '/ideas', group: 'Create', keywords: ['brainstorm'] },
  { label: 'Script Generator', href: '/generator', group: 'Create', keywords: ['write'] },
  { label: 'QA Engine', href: '/qa', group: 'Create', hint: 'Quality check' },
  { label: 'Production Doc', href: '/production-doc', group: 'Create', hint: 'Shot breakdown' },
  { label: 'Voiceover', href: '/voiceover', group: 'Create', keywords: ['tts', 'audio', 'elevenlabs'] },
  { label: 'Video Studio', href: '/video-studio', group: 'Create', keywords: ['render', 'remotion'] },
  { label: 'Thumbnails', href: '/thumbnails', group: 'Create' },

  // Collaborate
  { label: 'Reviews', href: '/reviews', group: 'Collaborate', hint: 'Video review with comments' },
  { label: 'Team', href: '/team', group: 'Collaborate', hint: 'All collaborators' },
  { label: 'Editors', href: '/team?role=editor', group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Narrators', href: '/team?role=narrator', group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Reviewers', href: '/team?role=reviewer', group: 'Collaborate', hint: 'Filter by role' },
  { label: 'Clients', href: '/team?role=client', group: 'Collaborate', hint: 'Filter by role' },

  // Grow
  { label: 'SEO Optimizer', href: '/seo', group: 'Grow', keywords: ['title', 'description', 'tags'] },
  { label: 'Channel', href: '/channel', group: 'Grow', keywords: ['youtube'] },
  { label: 'Channel Naming', href: '/channel-naming', group: 'Grow', hint: 'Brand name generator' },
  { label: 'Competitors', href: '/competitors', group: 'Grow', keywords: ['research'] },

  // Settings
  { label: 'Settings', href: '/settings', group: 'Settings', keywords: ['api keys', 'config', 'preferences'] },
];

export function GlobalCommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Open via Cmd/Ctrl+K, custom event, or Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
      if (isCmdK) {
        e.preventDefault();
        setOpen(o => !o);
      }
    }
    function onOpen() { setOpen(true); }
    window.addEventListener('keydown', onKey);
    window.addEventListener('open-command-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('open-command-palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => { setIdx(0); }, [q]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return PAGES.slice(0, 24);
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
  }, [q]);

  function go(entry: PageEntry) {
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
              <button
                key={p.href}
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
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 text-[10px] flex items-center justify-between"
            style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
            <span>↑↓ Navigate · ↵ Open</span>
            <span>⌘K to toggle</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
