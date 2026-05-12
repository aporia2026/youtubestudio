'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PageSkeleton } from '@/components/ui/PageSkeleton';
import type { InboxAuthorRole, InboxFilter, InboxSource } from '@/lib/inbox-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxRow {
  source: InboxSource;
  id: string;
  text: string;
  timestamp_ms: number;
  end_timestamp_ms: number | null;
  author_name: string;
  author_color: string;
  author_role: InboxAuthorRole;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
  fix_for_comment_id: string | null;
  reply_count: number;
  project_id: string;
  project_title: string;
  take_id: string | null;
  take_number: number | null;
  assignment_id: string | null;
  version_id: string | null;
  version_number: number | null;
  deep_link: string;
}

// ---------------------------------------------------------------------------
// Role metadata — the source of truth for label, color, icon, and bucket
// order. Owners first (you), then the production funnel (narrators → editors
// → reviewers). Reordering here updates every surface that reads ROLE_META.
// ---------------------------------------------------------------------------

const ROLE_META: Record<InboxAuthorRole, { label: string; color: string; icon: React.ReactNode; order: number }> = {
  owner: {
    label: 'Owners',
    color: '#7c3aed',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
        <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zM2 20h20" />
      </svg>
    ),
    order: 0,
  },
  narrator: {
    label: 'Narrators',
    color: '#06b6d4',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
    order: 1,
  },
  editor: {
    label: 'Editors',
    color: '#22c55e',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" />
      </svg>
    ),
    order: 2,
  },
  reviewer: {
    label: 'Reviewers',
    color: '#f59e0b',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
      </svg>
    ),
    order: 3,
  },
};

const ORDERED_ROLES: InboxAuthorRole[] = (Object.keys(ROLE_META) as InboxAuthorRole[])
  .sort((a, b) => ROLE_META[a].order - ROLE_META[b].order);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Global comments inbox.
 *
 * Two-pane layout:
 *   • Left  — search, filter chips, role groups with person sub-rows.
 *   • Right — the selected person's comments, newest first, with deep-link
 *             out to the source page and a one-click resolve button.
 *
 * Polls /api/inbox every 15s + on window focus, mirroring the Messages
 * page rhythm. Optimistic resolve so the unresolved counters update before
 * the next poll lands.
 */
export default function InboxPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // URL state — kept as the source of truth so deep-links from other
  // surfaces (e.g. "open in inbox" from a notification) work cleanly. The
  // URL carries: filter, q, role, person, comment id.
  const filter = (searchParams.get('filter') as InboxFilter | null) ?? 'unresolved';
  const q = searchParams.get('q') ?? '';
  const selectedRole = (searchParams.get('role') as InboxAuthorRole | null);
  const selectedAuthor = searchParams.get('person');
  const focusCommentId = searchParams.get('comment');

  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState(q);
  const [openRoles, setOpenRoles] = useState<Record<InboxAuthorRole, boolean>>({
    owner: true,
    narrator: true,
    editor: true,
    reviewer: true,
  });

  // Push-state helper — write a single search param without losing the rest.
  const updateParam = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    router.replace(`/inbox?${next.toString()}`, { scroll: false });
  }, [router, searchParams]);

  // Debounced search — push into URL after 250ms of quiet so the URL is
  // shareable but typing isn't sluggish.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchInput === q) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      updateParam({ q: searchInput || null });
    }, 250);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchInput, q, updateParam]);

  // Data fetch — keyed by filter so swapping chips reloads immediately.
  // Search and role/person filtering are applied client-side from the same
  // base list so the left pane's role+person counts reflect the full
  // filter state (otherwise selecting one person would hide the counts
  // for everyone else).
  const loadInbox = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter });
      const res = await fetch(`/api/inbox?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(Array.isArray(data.comments) ? data.comments : []);
    } catch (err) {
      console.error('Inbox load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    loadInbox();
    const id = setInterval(loadInbox, 15_000);
    const onFocus = () => loadInbox();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [loadInbox]);

  // Client-side text search across text + author name + project title.
  // Project title is included because owners often remember "comments on
  // the holiday script" before they remember a phrase or an author.
  const searched = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r =>
      r.text.toLowerCase().includes(needle) ||
      r.author_name.toLowerCase().includes(needle) ||
      r.project_title.toLowerCase().includes(needle),
    );
  }, [rows, q]);

  // Group by role → author. Done in one pass so we can render the left
  // pane and the right pane from the same indexed structure without
  // recomputing.
  const grouped = useMemo(() => {
    const byRole = new Map<InboxAuthorRole, Map<string, InboxRow[]>>();
    for (const role of ORDERED_ROLES) byRole.set(role, new Map());
    for (const r of searched) {
      const role = (ORDERED_ROLES as string[]).includes(r.author_role)
        ? r.author_role
        : 'reviewer'; // unknown roles bucket into reviewer
      const roleMap = byRole.get(role as InboxAuthorRole)!;
      const list = roleMap.get(r.author_name);
      if (list) list.push(r); else roleMap.set(r.author_name, [r]);
    }
    return byRole;
  }, [searched]);

  const totals = useMemo(() => {
    const unresolved = rows.reduce((n, r) => n + (r.resolved ? 0 : 1), 0);
    return { total: rows.length, unresolved };
  }, [rows]);

  // Right-pane selection — the comments visible to the user.
  // Priority order: explicit ?comment=X (jump-to-comment) > ?role+person
  // > first person in the first non-empty role group.
  const visibleRows = useMemo(() => {
    if (selectedRole && selectedAuthor) {
      const roleMap = grouped.get(selectedRole);
      return roleMap?.get(selectedAuthor) ?? [];
    }
    if (focusCommentId) {
      const target = rows.find(r => r.id === focusCommentId);
      if (target) {
        const roleMap = grouped.get(target.author_role);
        return roleMap?.get(target.author_name) ?? [target];
      }
    }
    // Default: first author in the first non-empty role.
    for (const role of ORDERED_ROLES) {
      const roleMap = grouped.get(role);
      if (!roleMap || roleMap.size === 0) continue;
      const firstAuthor = roleMap.keys().next().value;
      if (firstAuthor) return roleMap.get(firstAuthor) ?? [];
    }
    return [];
  }, [grouped, selectedRole, selectedAuthor, focusCommentId, rows]);

  // Determine the active (role, author) so the left-pane row can be
  // highlighted in sync with what's on the right.
  const activeSelection = useMemo(() => {
    if (selectedRole && selectedAuthor) return { role: selectedRole, author: selectedAuthor };
    if (focusCommentId) {
      const t = rows.find(r => r.id === focusCommentId);
      if (t) return { role: t.author_role, author: t.author_name };
    }
    for (const role of ORDERED_ROLES) {
      const roleMap = grouped.get(role);
      if (!roleMap || roleMap.size === 0) continue;
      const firstAuthor = roleMap.keys().next().value;
      if (firstAuthor) return { role, author: firstAuthor };
    }
    return null;
  }, [grouped, selectedRole, selectedAuthor, focusCommentId, rows]);

  const handleSelectPerson = useCallback((role: InboxAuthorRole, author: string) => {
    updateParam({ role, person: author, comment: null });
  }, [updateParam]);

  const handleResolve = useCallback(async (row: InboxRow, resolved: boolean) => {
    // Optimistic — flip in local state, then fire the request. Rollback on
    // error and surface a toast so the user knows their click didn't take.
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, resolved } : r));
    try {
      const res = await fetch('/api/inbox/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: row.source, commentId: row.id, resolved }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, resolved: !resolved } : r));
      toast.error(err instanceof Error ? err.message : 'Failed to update comment');
    }
  }, []);

  if (loading) {
    return <PageSkeleton title="Inbox" />;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <header className="px-6 py-4 shrink-0">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Inbox</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Every comment across your projects — grouped by role and person.
          {' '}
          <span style={{ color: totals.unresolved > 0 ? '#ef4444' : 'var(--text-muted)' }}>
            {totals.unresolved} unresolved
          </span>
          {' · '}{totals.total} total
        </p>
      </header>

      <div className="flex-1 flex overflow-hidden mx-6 mb-6 rounded-xl"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>

        {/* ---- Left pane: search + filter chips + role groups ---------- */}
        <aside className="w-80 shrink-0 flex flex-col" style={{ borderRight: '1px solid var(--border)' }}>

          <div className="p-3 shrink-0 flex flex-col gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="relative">
              <input
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Search comments, names, projects…"
                className="w-full text-sm rounded-md px-3 py-2 pl-8"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  outline: 'none',
                }}
              />
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              {searchInput && (
                <button
                  onClick={() => setSearchInput('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1.5 rounded"
                  style={{ color: 'var(--text-muted)' }}
                  title="Clear"
                >×</button>
              )}
            </div>

            <div className="flex gap-1">
              {(['unresolved', 'all', 'resolved'] as InboxFilter[]).map(f => (
                <button
                  key={f}
                  onClick={() => updateParam({ filter: f === 'unresolved' ? null : f })}
                  className="flex-1 text-xs py-1.5 rounded-md font-medium transition-colors capitalize cursor-pointer"
                  style={{
                    background: filter === f ? 'rgba(124,58,237,0.18)' : 'var(--bg-card)',
                    border: `1px solid ${filter === f ? 'var(--accent-purple)' : 'var(--border)'}`,
                    color: filter === f ? 'var(--text-primary)' : 'var(--text-secondary)',
                  }}
                >{f}</button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {searched.length === 0 ? (
              <div className="px-4 py-10 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
                {rows.length === 0
                  ? (filter === 'unresolved'
                      ? 'No unresolved comments. Switch to "all" to see history.'
                      : 'No comments yet. Comments will appear here as you and your collaborators leave feedback.')
                  : 'Nothing matches your search.'}
              </div>
            ) : (
              ORDERED_ROLES.map(role => {
                const roleMap = grouped.get(role);
                if (!roleMap) return null;
                const people = Array.from(roleMap.entries());
                if (people.length === 0) return null;
                const meta = ROLE_META[role];
                const roleUnresolved = people.reduce(
                  (n, [, items]) => n + items.filter(r => !r.resolved).length, 0,
                );
                const isOpen = openRoles[role];
                return (
                  <div key={role} className="mb-1">
                    <button
                      onClick={() => setOpenRoles(prev => ({ ...prev, [role]: !prev[role] }))}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide cursor-pointer"
                      style={{ color: meta.color, letterSpacing: '0.05em' }}
                    >
                      <span style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                      <span style={{ color: meta.color, display: 'inline-flex' }}>{meta.icon}</span>
                      <span>{meta.label}</span>
                      <span className="ml-auto text-[10px] font-normal" style={{ color: 'var(--text-muted)' }}>
                        {people.length}
                        {roleUnresolved > 0 && <span style={{ color: '#ef4444' }}> · {roleUnresolved}●</span>}
                      </span>
                    </button>
                    {isOpen && people
                      .sort((a, b) => a[0].localeCompare(b[0]))
                      .map(([author, items]) => {
                        const unresolvedCount = items.filter(r => !r.resolved).length;
                        const isActive = activeSelection?.role === role && activeSelection.author === author;
                        const last = items[0];
                        return (
                          <button
                            key={author}
                            onClick={() => handleSelectPerson(role, author)}
                            className="w-full text-left px-3 py-2 flex items-center gap-2 cursor-pointer"
                            style={{
                              background: isActive ? 'rgba(124,58,237,0.10)' : 'transparent',
                              borderLeft: isActive ? `2px solid ${meta.color}` : '2px solid transparent',
                            }}
                          >
                            <span
                              className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold uppercase"
                              style={{ background: last?.author_color || meta.color, color: '#fff' }}
                            >
                              {author.slice(0, 1)}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm truncate"
                                style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                                {author}
                              </span>
                              <span className="block text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                                {items.length} comment{items.length === 1 ? '' : 's'}
                                {last && <> · {formatRelative(last.created_at)}</>}
                              </span>
                            </span>
                            {unresolvedCount > 0 && (
                              <span
                                className="text-[10px] px-1.5 rounded-full font-bold shrink-0"
                                style={{ background: '#ef4444', color: '#fff', minWidth: 18, textAlign: 'center', lineHeight: '14px' }}
                              >{unresolvedCount}</span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* ---- Right pane: the selected person's comments -------------- */}
        <section className="flex-1 overflow-y-auto">
          {visibleRows.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6"
              style={{ color: 'var(--text-muted)' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ marginBottom: 12, opacity: 0.5 }}>
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
              <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {rows.length === 0
                  ? 'No comments yet.'
                  : q
                    ? 'Nothing matches your search.'
                    : (selectedRole && selectedAuthor)
                      ? `No comments from ${selectedAuthor} match this filter.`
                      : 'Pick a person on the left to read their comments.'}
              </p>
            </div>
          ) : (
            <div className="p-6 flex flex-col gap-4 max-w-3xl mx-auto">
              {activeSelection && (
                <header className="flex items-center gap-3 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
                  <span
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold uppercase"
                    style={{ background: visibleRows[0]?.author_color || ROLE_META[activeSelection.role].color, color: '#fff' }}
                  >
                    {activeSelection.author.slice(0, 1)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                      {activeSelection.author}
                    </div>
                    <div className="text-xs flex items-center gap-1.5" style={{ color: ROLE_META[activeSelection.role].color }}>
                      {ROLE_META[activeSelection.role].icon}
                      <span>{ROLE_META[activeSelection.role].label.replace(/s$/, '')}</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        · {visibleRows.length} comment{visibleRows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                </header>
              )}

              {[...visibleRows]
                .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                .map(row => (
                  <CommentCard
                    key={row.id}
                    row={row}
                    highlight={row.id === focusCommentId}
                    onResolve={(resolved) => handleResolve(row, resolved)}
                  />
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CommentCard — single comment row in the right pane.
// ---------------------------------------------------------------------------

function CommentCard({
  row,
  highlight,
  onResolve,
}: {
  row: InboxRow;
  highlight: boolean;
  onResolve: (resolved: boolean) => void;
}) {
  const sourceLabel = row.source === 'narration'
    ? `Take ${row.take_number ?? '?'}`
    : `Version ${row.version_number ?? '?'}`;
  const timeLabel = row.end_timestamp_ms != null && row.end_timestamp_ms > row.timestamp_ms
    ? `${formatTimestamp(row.timestamp_ms)} – ${formatTimestamp(row.end_timestamp_ms)}`
    : formatTimestamp(row.timestamp_ms);

  return (
    <article
      className="rounded-xl p-4 transition-all"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${highlight ? 'var(--accent-purple)' : 'var(--border)'}`,
        boxShadow: highlight ? '0 0 0 3px rgba(124,58,237,0.18)' : 'none',
        opacity: row.resolved ? 0.7 : 1,
      }}
    >
      <div className="flex items-center gap-2 text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
        <Link
          // Narration comments live under `projects` (the script workspace);
          // review comments live under `review_projects` (a separate entity
          // with its own /reviews/<id> page). Same column name in the row
          // here, different destination — pick by source.
          href={row.source === 'review' ? `/reviews/${row.project_id}` : `/projects/${row.project_id}`}
          className="font-medium hover:underline truncate max-w-[220px]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {row.project_title}
        </Link>
        <span>·</span>
        <span>{sourceLabel}</span>
        <span>·</span>
        <span>{timeLabel}</span>
        <span className="ml-auto">{formatRelative(row.created_at)}</span>
      </div>

      <p className="text-sm whitespace-pre-wrap mb-3" style={{ color: 'var(--text-primary)' }}>
        {row.text}
      </p>

      <div className="flex items-center gap-2">
        {row.resolved ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
            ✓ Resolved
          </span>
        ) : (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
            Unresolved
          </span>
        )}
        {row.fix_for_comment_id && (
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
            style={{ background: 'rgba(6,182,212,0.12)', color: '#06b6d4' }}>
            Fix note
          </span>
        )}
        {row.reply_count > 0 && (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {row.reply_count} repl{row.reply_count === 1 ? 'y' : 'ies'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => onResolve(!row.resolved)}
            className="text-xs px-2.5 py-1 rounded-md cursor-pointer"
            style={{
              background: row.resolved ? 'transparent' : 'rgba(34,197,94,0.15)',
              border: `1px solid ${row.resolved ? 'var(--border)' : 'rgba(34,197,94,0.4)'}`,
              color: row.resolved ? 'var(--text-secondary)' : '#22c55e',
            }}
          >
            {row.resolved ? 'Reopen' : 'Resolve'}
          </button>
          {row.deep_link && row.deep_link !== '#' ? (
            <Link
              href={row.deep_link}
              className="text-xs px-2.5 py-1 rounded-md font-medium"
              style={{ background: 'var(--accent-purple)', color: '#fff' }}
            >
              Open in source ↗
            </Link>
          ) : (
            <span className="text-xs px-2.5 py-1 rounded-md cursor-not-allowed"
              title="Source take/version was removed"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
            >
              Source removed
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
