'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { toast } from 'sonner';
import { timeAgo } from '@/lib/utils';

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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // Inline rename state. Using a single editing-id rather than a flag per
  // row keeps the UX exclusive: only one card is editable at a time, and
  // entering edit mode on a different card cancels the previous draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects();
  }, []);

  async function fetchProjects() {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects || []);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
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
            // When editing or hovering action buttons, the card itself is no
            // longer a click-through — wrapping the whole thing in <Link>
            // would steal click events from the rename input + buttons.
            const cardInner = (
              <div
                className="glass rounded-xl p-5 transition-all h-full group relative"
                style={{ border: '1px solid var(--border)', cursor: isEditing ? 'default' : 'pointer' }}
                onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-bright)'}
                onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'}
              >
                <div className="flex items-start justify-between mb-3 gap-2">
                  <span className="badge text-xs" style={{ background: statusStyle.bg, color: statusStyle.color, border: 'none' }}>
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
