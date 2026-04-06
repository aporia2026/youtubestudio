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
            return (
              <motion.div
                key={project.id}
                variants={{ hidden: { opacity: 0, y: 15 }, show: { opacity: 1, y: 0 } }}
                whileHover={{ y: -4 }}
              >
                <Link href={`/projects/${project.id}`}>
                  <div className="glass rounded-xl p-5 cursor-pointer transition-all h-full"
                    style={{ border: '1px solid var(--border)' }}
                    onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-bright)'}
                    onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)'}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <span className="badge text-xs" style={{ background: statusStyle.bg, color: statusStyle.color, border: 'none' }}>
                        {statusStyle.label}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(project.updated_at)}</span>
                    </div>
                    <h3 className="font-semibold mb-1 line-clamp-2" style={{ color: 'var(--text-primary)' }}>
                      {project.title}
                    </h3>
                    {project.niche && (
                      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>{project.niche}</p>
                    )}
                    <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      <span>📝 {project.script_count || 0} scripts</span>
                      <span>🎬 {project.media_count || 0} media</span>
                    </div>
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </div>
  );
}
