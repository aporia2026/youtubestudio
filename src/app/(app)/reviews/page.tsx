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

interface NarrationAssignment {
  id: string;
  project_id: string;
  project_title: string;
  narrator_name: string | null;
  narrator_color: string | null;
  status: string;
  total_sections: number;
  approved_sections: number;
  deadline: string | null;
  updated_at: string;
}

const VIDEO_STATUS: Record<string, { bg: string; text: string; label: string }> = {
  'in-review': { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4', label: 'In Review' },
  'needs-changes': { bg: 'rgba(234,179,8,0.15)', text: '#eab308', label: 'Needs Changes' },
  'approved': { bg: 'rgba(34,197,94,0.15)', text: '#22c55e', label: 'Approved' },
};

const NARRATION_STATUS: Record<string, { bg: string; text: string; label: string }> = {
  assigned:  { bg: 'rgba(234,179,8,0.15)',  text: '#eab308', label: 'Assigned' },
  received:  { bg: 'rgba(6,182,212,0.15)',  text: '#06b6d4', label: 'Received' },
  recording: { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa', label: 'Recording' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6', label: 'Submitted' },
  revisions: { bg: 'rgba(249,115,22,0.15)', text: '#f97316', label: 'Revisions' },
  approved:  { bg: 'rgba(34,197,94,0.15)',  text: '#22c55e', label: 'Approved' },
  completed: { bg: 'rgba(34,197,94,0.15)',  text: '#22c55e', label: 'Completed' },
};

type Tab = 'video' | 'narration';

export default function ReviewsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('video');
  const [projects, setProjects] = useState<ReviewProject[]>([]);
  const [narrations, setNarrations] = useState<NarrationAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    try {
      const [vrRes, narRes] = await Promise.all([
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        fetch('/api/review/projects'),
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        fetch('/api/narrator/assignments'),
      ]);
      if (vrRes.ok) setProjects(await vrRes.json());
      if (narRes.ok) setNarrations(await narRes.json());
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
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
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

  const activeNarration = narrations.filter(n => n.status !== 'completed' && n.status !== 'approved');
  const completedNarration = narrations.filter(n => n.status === 'completed' || n.status === 'approved');

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Reviews</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Video reviews with timestamped feedback, and narration takes from your narrators.
          </p>
        </div>
        {tab === 'video' && (
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors cursor-pointer"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
          >
            + New Video Review
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg w-fit" style={{ background: 'var(--bg-secondary)' }}>
        <TabButton active={tab === 'video'} onClick={() => setTab('video')}>
          🎞️ Video <span className="opacity-60 ml-1">({projects.length})</span>
        </TabButton>
        <TabButton active={tab === 'narration'} onClick={() => setTab('narration')}>
          🎤 Narration <span className="opacity-60 ml-1">({narrations.length})</span>
        </TabButton>
      </div>

      {/* Video review create dialog */}
      <AnimatePresence>
        {showCreate && tab === 'video' && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="p-5 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>New Video Review</h3>
              <input
                autoFocus placeholder="Project title (e.g. Episode 12 — Final Cut)"
                value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full px-3 py-2 rounded-lg text-sm mb-3"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <textarea
                placeholder="Description (optional)" value={newDesc} onChange={e => setNewDesc(e.target.value)} rows={2}
                className="w-full px-3 py-2 rounded-lg text-sm mb-3 resize-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowCreate(false); setNewTitle(''); setNewDesc(''); }} className="px-3 py-1.5 rounded-lg text-sm cursor-pointer" style={{ color: 'var(--text-muted)' }}>Cancel</button>
                <button onClick={handleCreate} disabled={creating || !newTitle.trim()} className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 cursor-pointer" style={{ background: '#7c3aed' }}>
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
        </div>
      ) : tab === 'video' ? (
        // ── Video reviews ───────────────────────────────────────────────────
        projects.length === 0 ? (
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto" style={{ color: 'var(--text-muted)' }}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            }
            text="No video reviews yet"
            cta={<button onClick={() => setShowCreate(true)} className="mt-4 px-4 py-2 rounded-lg text-sm font-medium cursor-pointer" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>Create your first review</button>}
          />
        ) : (
          <div className="grid gap-4">
            {projects.map(project => {
              const s = VIDEO_STATUS[project.status] || VIDEO_STATUS['in-review'];
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
                        <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{project.title}</h3>
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium shrink-0" style={{ background: s.bg, color: s.text }}>{s.label}</span>
                      </div>
                      {project.description && <p className="text-xs truncate mb-2" style={{ color: 'var(--text-muted)' }}>{project.description}</p>}
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
        )
      ) : (
        // ── Narration reviews ───────────────────────────────────────────────
        narrations.length === 0 ? (
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto" style={{ color: 'var(--text-muted)' }}>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            }
            text="No narration assignments yet"
            cta={<p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>Assign a script to a narrator from a project&apos;s Narration tab — the assignment will show up here for review.</p>}
          />
        ) : (
          <div className="space-y-6">
            {activeNarration.length > 0 && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
                  Active ({activeNarration.length})
                </h2>
                <div className="grid gap-3">
                  {activeNarration.map(n => <NarrationCard key={n.id} n={n} onClick={() => router.push(`/projects/${n.project_id}?tab=narration`)} />)}
                </div>
              </section>
            )}
            {completedNarration.length > 0 && (
              <section>
                <h2 className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: 'var(--text-secondary)' }}>
                  Completed ({completedNarration.length})
                </h2>
                <div className="grid gap-3">
                  {completedNarration.map(n => <NarrationCard key={n.id} n={n} compact onClick={() => router.push(`/projects/${n.project_id}?tab=narration`)} />)}
                </div>
              </section>
            )}
          </div>
        )
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors cursor-pointer"
      style={{
        background: active ? 'rgba(124,58,237,0.2)' : 'transparent',
        color: active ? '#a78bfa' : 'var(--text-muted)',
      }}
    >
      {children}
    </button>
  );
}

function EmptyState({ icon, text, cta }: { icon: React.ReactNode; text: string; cta?: React.ReactNode }) {
  return (
    <div className="text-center py-20 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="text-4xl mb-4 opacity-30">{icon}</div>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{text}</p>
      {cta}
    </div>
  );
}

function NarrationCard({ n, onClick, compact }: { n: NarrationAssignment; onClick: () => void; compact?: boolean }) {
  const s = NARRATION_STATUS[n.status] || NARRATION_STATUS.assigned;
  const progress = n.total_sections > 0 ? Math.round((n.approved_sections / n.total_sections) * 100) : 0;
  return (
    <motion.div
      whileHover={{ x: 4 }}
      onClick={onClick}
      className="p-5 rounded-xl cursor-pointer transition-colors"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', opacity: compact ? 0.7 : 1 }}
    >
      <div className="flex items-start gap-3">
        {n.narrator_color && n.narrator_name && (
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ background: n.narrator_color }}>
            {n.narrator_name[0].toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{n.project_title}</h3>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium shrink-0" style={{ background: s.bg, color: s.text }}>{s.label}</span>
          </div>
          <div className="flex gap-4 text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            {n.narrator_name && <span>🎤 {n.narrator_name}</span>}
            <span>{n.approved_sections}/{n.total_sections} sections approved</span>
            {n.deadline && <span>Due {new Date(n.deadline).toLocaleDateString()}</span>}
          </div>
          {!compact && (
            <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #22c55e)' }} />
            </div>
          )}
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }} className="shrink-0 mt-1">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </div>
    </motion.div>
  );
}
