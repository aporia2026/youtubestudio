'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface NarratorProfile {
  id: string;
  name: string;
  email: string | null;
  color: string;
  specialties: string[];
  notes: string | null;
  personal_token: string | null;
  created_at: string;
}

interface Assignment {
  id: string;
  project_title: string;
  narrator_name: string;
  narrator_color: string;
  narrator_personal_token?: string | null;
  status: string;
  total_sections: number;
  approved_sections: number;
  deadline: string | null;
  share_token: string;
  updated_at: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  assigned: { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
  received: { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4' },
  recording: { bg: 'rgba(124,58,237,0.15)', text: '#7c3aed' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  revisions: { bg: 'rgba(249,115,22,0.15)', text: '#f97316' },
  approved: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  completed: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
};

const COLORS = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

export default function NarratorsPage() {
  const [profiles, setProfiles] = useState<NarratorProfile[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      const [profRes, assignRes] = await Promise.all([
        fetch('/api/narrator/profiles'),
        fetch('/api/narrator/assignments'),
      ]);
      if (profRes.ok) setProfiles(await profRes.json());
      if (assignRes.ok) setAssignments(await assignRes.json());
    } catch {} finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/narrator/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          email: newEmail.trim() || undefined,
          color: COLORS[profiles.length % COLORS.length],
        }),
      });
      if (res.ok) {
        toast.success('Narrator added');
        setShowCreate(false);
        setNewName('');
        setNewEmail('');
        loadData();
      }
    } catch {
      toast.error('Failed to add narrator');
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this narrator?')) return;
    await fetch(`/api/narrator/profiles/${id}`, { method: 'DELETE' });
    setProfiles(prev => prev.filter(p => p.id !== id));
    toast.success('Narrator removed');
  }

  function copyLink(token: string) {
    navigator.clipboard.writeText(`${window.location.origin}/narrate/${token}`);
    toast.success('Link copied');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      {/* Sunset banner — points to /team-hub. Per the team-hub plan
          (2026-05-09) this page is being phased out two weeks after the
          hub ships, once we've verified the hub covers everything this
          page does. Until then, both surfaces work. */}
      <a
        href="/team-hub"
        className="block mb-6 rounded-xl px-4 py-3 transition-colors"
        style={{
          background: 'linear-gradient(90deg, rgba(124,58,237,0.12), rgba(6,182,212,0.12))',
          border: '1px solid rgba(124,58,237,0.35)',
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Manage every team member in one place at /team-hub
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              The new Team Hub covers narrators, video editors, reviewers, and channel editors with a single dashboard. This page is scheduled to be removed.
            </p>
          </div>
          <span
            className="text-xs px-3 py-1.5 rounded-md font-medium shrink-0"
            style={{ background: 'rgba(124,58,237,0.25)', color: '#fff', border: '1px solid rgba(124,58,237,0.5)' }}
          >
            Open Team Hub →
          </span>
        </div>
      </a>

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Narrators</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage your narrator roster and track assignments</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
        >
          + Add Narrator
        </button>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="p-5 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Add Narrator</h3>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <input autoFocus placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input placeholder="Email (optional)" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowCreate(false); setNewName(''); setNewEmail(''); }} className="px-3 py-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>Cancel</button>
                <button onClick={handleCreate} disabled={!newName.trim()} className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ background: '#7c3aed' }}>Add</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Narrator Roster */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Roster ({profiles.length})</h2>
          {profiles.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>No narrators yet — add one to get started</p>
          ) : (
            <div className="space-y-2">
              {profiles.map(p => (
                <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0" style={{ background: p.color }}>
                    {(p.name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{p.name}</p>
                    {p.email && <p className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{p.email}</p>}
                  </div>
                  {p.personal_token && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/narrator/${p.personal_token}`);
                        toast.success('Dashboard link copied');
                      }}
                      className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-purple-500/10 cursor-pointer"
                      style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)' }}
                      title="Copy this narrator's dashboard link — one URL with all their assignments"
                    >
                      📋 Dashboard link
                    </button>
                  )}
                  <button onClick={() => handleDelete(p.id)} className="p-1.5 rounded hover:bg-red-500/10 transition-colors cursor-pointer" style={{ color: 'var(--text-muted)' }} title="Remove narrator">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Assignments */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>Active Assignments</h2>
          {assignments.length === 0 ? (
            <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>No assignments yet — assign a script from a project page</p>
          ) : (
            <div className="space-y-2">
              {assignments.map(a => {
                const sc = STATUS_COLORS[a.status] || STATUS_COLORS.assigned;
                const progress = a.total_sections > 0 ? Math.round((a.approved_sections / a.total_sections) * 100) : 0;
                return (
                  <div key={a.id} className="p-3 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{a.project_title}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full capitalize shrink-0" style={{ background: sc.bg, color: sc.text }}>{a.status}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ background: a.narrator_color }}>{a.narrator_name?.[0]?.toUpperCase()}</div>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{a.narrator_name}</span>
                      <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>{a.approved_sections}/{a.total_sections} sections</span>
                    </div>
                    {/* Progress bar */}
                    <div className="h-1.5 rounded-full mb-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
                    </div>
                    <button onClick={() => copyLink(a.share_token)} className="text-[10px] flex items-center gap-1 transition-colors hover:text-purple-400" style={{ color: 'var(--text-muted)' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      Copy narrator link
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
