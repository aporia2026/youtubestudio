'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface ReviewProject {
  id: string;
  title: string;
  description: string | null;
  status: 'in-review' | 'needs-changes' | 'approved';
  version_count: number;
  link_count: number;
  created_at: string;
  updated_at: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  'in-review': { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4', label: 'In Review' },
  'needs-changes': { bg: 'rgba(234,179,8,0.15)', text: '#eab308', label: 'Needs Changes' },
  'approved': { bg: 'rgba(34,197,94,0.15)', text: '#22c55e', label: 'Approved' },
};

export default function ReviewsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ReviewProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadProjects(); }, []);

  async function loadProjects() {
    try {
      const res = await fetch('/api/review/projects');
      if (res.ok) setProjects(await res.json());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/review/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), description: newDesc.trim() || undefined }),
      });
      if (!res.ok) throw new Error('Failed to create');
      const { project } = await res.json();
      toast.success('Review project created');
      setShowCreate(false);
      setNewTitle('');
      setNewDesc('');
      router.push(`/reviews/${project.id}`);
    } catch {
      toast.error('Failed to create project');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Video Reviews
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Share videos with editors and narrators for timestamped feedback
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
          style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
        >
          + New Review
        </button>
      </div>

      {/* Create dialog */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-6 overflow-hidden"
          >
            <div className="p-5 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>New Review Project</h3>
              <input
                autoFocus
                placeholder="Project title (e.g. Episode 12 — Final Cut)"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full px-3 py-2 rounded-lg text-sm mb-3"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <textarea
                placeholder="Description (optional)"
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-lg text-sm mb-3 resize-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowCreate(false); setNewTitle(''); setNewDesc(''); }}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !newTitle.trim()}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ background: '#7c3aed' }}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Projects list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-20 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="text-4xl mb-4 opacity-30">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto" style={{ color: 'var(--text-muted)' }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No review projects yet</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}
          >
            Create your first review
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {projects.map(project => {
            const statusStyle = STATUS_COLORS[project.status] || STATUS_COLORS['in-review'];
            return (
              <motion.div
                key={project.id}
                whileHover={{ x: 4 }}
                onClick={() => router.push(`/reviews/${project.id}`)}
                className="p-5 rounded-xl cursor-pointer transition-colors"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {project.title}
                      </h3>
                      <span
                        className="px-2 py-0.5 rounded-full text-xs font-medium shrink-0"
                        style={{ background: statusStyle.bg, color: statusStyle.text }}
                      >
                        {statusStyle.label}
                      </span>
                    </div>
                    {project.description && (
                      <p className="text-xs truncate mb-2" style={{ color: 'var(--text-muted)' }}>{project.description}</p>
                    )}
                    <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <span>{project.version_count} version{project.version_count !== 1 ? 's' : ''}</span>
                      <span>{project.link_count} share link{project.link_count !== 1 ? 's' : ''}</span>
                      <span>{new Date(project.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }} className="shrink-0 mt-1">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
