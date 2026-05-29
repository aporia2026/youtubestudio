'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import { toast } from 'sonner';
import { timeAgo } from '@/lib/utils';

interface ProjectChannel {
  id: string;
  name: string;
  account_color: string | null;
}

interface Project {
  id: string;
  title: string;
  niche: string;
  topic: string;
  status: string;
  created_at: string;
  updated_at: string;
  script_count?: number;
  media_count?: number;
  channels?: ProjectChannel[];
}

const STATUS_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  draft: { color: 'var(--text-muted)', bg: 'rgba(107,114,128,0.1)', label: 'Draft' },
  in_progress: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: 'In Progress' },
  review: { color: 'var(--accent-cyan-bright)', bg: 'rgba(6,182,212,0.1)', label: 'In Review' },
  complete: { color: 'var(--accent-green)', bg: 'rgba(16,185,129,0.1)', label: 'Complete' },
  published: { color: 'var(--accent-purple-bright)', bg: 'rgba(124,58,237,0.1)', label: 'Published' },
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [channels, setChannels] = useState<ProjectChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // Inline rename state. Using a single editing-id rather than a flag per
  // row keeps the UX exclusive: only one card is editable at a time, and
  // entering edit mode on a different card cancels the previous draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  // Bulk-assign selection — modeled on schedule's ListView.tsx. Storing the
  // selected ids as a Set keeps O(1) toggle + lookup for chip rendering.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigningChannels, setAssigningChannels] = useState(false);

  useEffect(() => {
    fetchProjects();
    fetchChannels();
  }, []);

  async function fetchProjects() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }
  async function fetchChannels() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/channels');
      const data = await res.json();
      // /api/channels returns the richer per-account shape — narrow to the
      // three fields the popover and chips actually use.
      const trimmed: ProjectChannel[] = (data.channels || []).map((c: { id: string; name: string; account_color: string | null }) => ({
        id: c.id,
        name: c.name,
        account_color: c.account_color,
      }));
      setChannels(trimmed);
    } catch {
      // Non-fatal — the page still works without the popover when channels
      // can't be fetched. The "Assign channels" button just won't render.
    }
  }

  function toggleSelected(id: string) {
    setSelected(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  async function bulkAssignChannels(channelIds: string[], mode: 'add' | 'replace') {
    if (channelIds.length === 0) return;
    const count = selected.size;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/projects/bulk-assign-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_ids: Array.from(selected), channel_ids: channelIds, mode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Bulk assign failed');
        return;
      }
    } catch {
      toast.error('Bulk assign failed');
      return;
    }
    // Pull fresh rows so chips reflect the new join — single round-trip
    // beats N optimistic patches that each have to merge into project.channels.
    await fetchProjects();
    const resolvedCount = channels.filter(c => channelIds.includes(c.id)).length;
    toast.success(
      `Assigned ${count} ${count === 1 ? 'project' : 'projects'} to ${resolvedCount} ${resolvedCount === 1 ? 'channel' : 'channels'}`,
    );
    setSelected(new Set());
    setAssigningChannels(false);
  }

  function startRename(project: Project) {
    setEditingId(project.id);
    setEditingTitle(project.title);
  }
  function cancelRename() {
    setEditingId(null);
    setEditingTitle('');
  }
  async function saveRename(project: Project) {
    const next = editingTitle.trim();
    if (!next) { toast.error('Title cannot be empty'); return; }
    if (next === project.title) { cancelRename(); return; }
    setSavingId(project.id);
    // Optimistic update — flip the card text immediately, revert on failure.
    setProjects(prev => prev.map(p => p.id === project.id ? { ...p, title: next } : p));
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error('rename failed');
      toast.success('Renamed');
      cancelRename();
    } catch {
      // Rollback by re-fetching since we don't keep the original title client-side.
      toast.error('Failed to rename');
      fetchProjects();
    } finally {
      setSavingId(null);
    }
  }

  async function deleteProject(project: Project) {
    if (!confirm(`Delete "${project.title}"? This permanently removes the project, its scripts, and all linked media. Cannot be undone.`)) return;
    setSavingId(project.id);
    // Optimistic remove from the grid; if the request fails we re-fetch.
    setProjects(prev => prev.filter(p => p.id !== project.id));
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/projects/${project.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      toast.success('Project deleted');
    } catch {
      toast.error('Failed to delete');
      fetchProjects();
    } finally {
      setSavingId(null);
    }
  }

  const filtered = projects.filter(p => {
    const matchesSearch = !search || p.title.toLowerCase().includes(search.toLowerCase()) || p.niche?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(236,72,153,0.2))', border: '1px solid rgba(245,158,11,0.3)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#f59e0b' }}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span className="badge badge-yellow">Production Workspace</span>
          </div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>Video Projects</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Manage your full video production pipeline
          </p>
        </div>
        <Link href="/projects/new">
          <button className="btn-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Project
          </button>
        </Link>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="input-field"
          style={{ maxWidth: 280 }}
        />
        <div className="flex gap-2">
          {['all', 'draft', 'in_progress', 'review', 'complete', 'published'].map(status => (
            <button key={status} onClick={() => setStatusFilter(status)}
              className="px-3 py-2 rounded-lg text-sm transition-all capitalize"
              style={{
                background: statusFilter === status ? 'rgba(124,58,237,0.2)' : 'var(--bg-card)',
                border: `1px solid ${statusFilter === status ? 'var(--accent-purple)' : 'var(--border)'}`,
                color: statusFilter === status ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}>
              {status === 'all' ? 'All' : STATUS_STYLES[status]?.label || status}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="sticky top-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg mb-4"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--accent-purple-bright)', boxShadow: '0 4px 20px rgba(124,58,237,0.2)' }}
          >
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set(filtered.map(p => p.id)))}
              className="text-xs px-2 py-1 rounded"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              Select all visible
            </button>
            {channels.length > 0 && (
              <div className="relative">
                <button onClick={() => setAssigningChannels(v => !v)}
                  className="text-xs px-3 py-1 rounded-md"
                  style={{ background: 'rgba(124,58,237,0.15)', color: 'var(--accent-purple-bright)', border: '1px solid rgba(124,58,237,0.35)' }}>
                  Assign channels ▾
                </button>
                {assigningChannels && (
                  <ChannelAssignPopover
                    channels={channels}
                    onApply={bulkAssignChannels}
                    onClose={() => setAssigningChannels(false)}
                  />
                )}
              </div>
            )}
            <button onClick={() => setSelected(new Set())}
              className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
              Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="glass rounded-xl p-6 animate-pulse" style={{ height: 160 }} />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="glass rounded-xl p-16 text-center">
          <div className="text-5xl mb-4">📁</div>
          <p className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            {projects.length === 0 ? 'No projects yet' : 'No projects match your filters'}
          </p>
          <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
            {projects.length === 0 ? 'Create your first video project to get started' : 'Try different search terms or filters'}
          </p>
          {projects.length === 0 && (
            <Link href="/projects/new">
              <button className="btn-primary">Create First Project</button>
            </Link>
          )}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          {filtered.map(project => {
            const statusStyle = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
            const isEditing = editingId === project.id;
            const isBusy = savingId === project.id;
            const isSelected = selected.has(project.id);
            // When editing or hovering action buttons, the card itself is no
            // longer a click-through — wrapping the whole thing in <Link>
            // would steal click events from the rename input + buttons.
            const cardInner = (
              <div
                className="glass rounded-xl p-5 transition-all h-full group relative"
                style={{
                  border: `1px solid ${isSelected ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
                  background: isSelected ? 'rgba(124,58,237,0.06)' : undefined,
                  cursor: isEditing ? 'default' : 'pointer',
                }}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-bright)'; }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'; }}
              >
                {/* Bulk-select checkbox — always visible so the lazy user
                    can fan-select without learning a hover affordance. The
                    click handler stops propagation so the outer <Link>
                    doesn't navigate when the checkbox is clicked. */}
                {!isEditing && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(project.id)}
                    onClick={e => e.stopPropagation()}
                    aria-label={`Select ${project.title}`}
                    className="absolute top-3 left-3 cursor-pointer z-10"
                  />
                )}
                <div className="flex items-start justify-between mb-3 gap-2">
                  <span
                    className="badge text-xs"
                    style={{
                      background: statusStyle.bg,
                      color: statusStyle.color,
                      border: 'none',
                      // Clear the absolute-positioned bulk-select checkbox.
                      // No padding mid-edit (no checkbox is rendered then).
                      marginLeft: isEditing ? 0 : 22,
                    }}
                  >
                    {statusStyle.label}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(project.updated_at)}</span>
                    {/* Action buttons. Hidden until hover so they don't clutter
                        the list, but always visible mid-edit so the user can
                        see what's happening. */}
                    {!isEditing && (
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 ml-1">
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); startRename(project); }}
                          className="p-1 rounded hover:bg-white/10"
                          title="Rename"
                          disabled={isBusy}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                            <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={e => { e.preventDefault(); e.stopPropagation(); deleteProject(project); }}
                          className="p-1 rounded hover:bg-red-500/15"
                          title="Delete"
                          disabled={isBusy}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ef4444' }}>
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <div className="mb-1" onClick={e => e.preventDefault()}>
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={e => setEditingTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); saveRename(project); }
                        if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                      }}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                      className="w-full px-2 py-1.5 rounded text-sm font-semibold"
                      style={{ background: 'var(--bg-primary)', border: '1px solid var(--accent-purple)', color: 'var(--text-primary)' }}
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <button
                        onClick={e => { e.preventDefault(); e.stopPropagation(); cancelRename(); }}
                        className="text-xs"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={e => { e.preventDefault(); e.stopPropagation(); saveRename(project); }}
                        disabled={isBusy || !editingTitle.trim()}
                        className="text-xs px-2 py-1 rounded font-medium text-white disabled:opacity-50"
                        style={{ background: 'var(--accent-purple)' }}
                      >
                        {isBusy ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <h3 className="font-semibold mb-1 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                    {project.title}
                  </h3>
                )}
                {!isEditing && project.niche && (
                  <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>{project.niche}</p>
                )}
                {!isEditing && (
                  <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>📝 {project.script_count || 0} scripts</span>
                    <span>🎬 {project.media_count || 0} media</span>
                    {/* Channel chips — show up to three, then "+N" for the rest.
                        Mirrors the schedule-row chip pattern (initials + colour
                        dot) so the visual language carries across pages. */}
                    {(project.channels?.length ?? 0) > 0 && (
                      <span className="flex -space-x-1 ml-auto">
                        {project.channels!.slice(0, 3).map(c => (
                          <span
                            key={c.id}
                            title={c.name}
                            className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold border-2"
                            style={{ background: c.account_color || '#7c3aed', color: 'white', borderColor: 'var(--bg-card)' }}
                          >
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                        ))}
                        {project.channels!.length > 3 && (
                          <span
                            className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium border-2"
                            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', borderColor: 'var(--bg-card)' }}
                            title={project.channels!.slice(3).map(c => c.name).join(', ')}
                          >
                            +{project.channels!.length - 3}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
            return (
              <motion.div
                key={project.id}
                variants={{ hidden: { opacity: 0, y: 15 }, show: { opacity: 1, y: 0 } }}
                whileHover={isEditing ? undefined : { y: -4 }}
              >
                {isEditing ? cardInner : <Link href={`/projects/${project.id}`}>{cardInner}</Link>}
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}

// Bulk "Assign channels" popover. Mirrors the schedule's affordance — same
// pick-and-mode UX so users don't relearn the pattern across pages. Lives
// in this file (rather than a shared module) until Phase 2/3 give us a
// second non-schedule caller and the duplication becomes worth abstracting.
function ChannelAssignPopover({ channels, onApply, onClose }: {
  channels: ProjectChannel[];
  onApply: (ids: string[], mode: 'add' | 'replace') => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'add' | 'replace'>('add');
  function toggle(id: string) {
    setPicked(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={e => e.stopPropagation()}
      // `right-0` keeps the popover inside the sticky toolbar on narrow
      // viewports (where an absolute-left popover would clip off-screen).
      className="absolute right-0 top-full mt-1 z-20 w-72 max-w-[calc(100vw-2rem)] p-3 rounded-lg space-y-2"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}
    >
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        Pick channels
      </div>
      <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
        {channels.map(c => (
          <label key={c.id} className="flex items-center gap-2 text-sm px-2 py-1 rounded cursor-pointer"
            style={{ background: picked.has(c.id) ? 'rgba(124,58,237,0.12)' : 'transparent', color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
            <span className="w-2 h-2 rounded-full" style={{ background: c.account_color || '#7c3aed' }} />
            {c.name}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs pt-1" style={{ borderTop: '1px solid var(--border)' }}>
        <label className="flex items-center gap-1 cursor-pointer" style={{ color: 'var(--text-primary)' }}>
          <input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} /> Add
        </label>
        <label className="flex items-center gap-1 cursor-pointer" style={{ color: 'var(--text-primary)' }}>
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button onClick={onClose} className="text-xs px-2 py-1" style={{ color: 'var(--text-muted)' }}>
          Cancel
        </button>
        <button
          onClick={() => onApply(Array.from(picked), mode)}
          disabled={picked.size === 0}
          className="text-xs px-3 py-1 rounded-md"
          style={{
            background: picked.size ? 'var(--accent-purple-bright)' : 'var(--bg-tertiary)',
            color: picked.size ? 'white' : 'var(--text-muted)',
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
