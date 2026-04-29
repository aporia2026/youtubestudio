'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  role: string;
  color: string;
  specialties: string[];
  notes: string | null;
  created_at: string;
  // From overview endpoint
  review_link_count?: number;
  assignment_count?: number;
  last_activity?: string | null;
}

interface ReviewLink {
  id: string;
  project_id: string;
  project_title: string;
  token: string;
  permission: string;
  label: string | null;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  created_at: string;
}

interface Assignment {
  id: string;
  project_title: string;
  status: string;
  share_token: string;
  total_sections: number;
  approved_sections: number;
  last_accessed_at: string | null;
  access_count: number;
  deadline: string | null;
}

interface CollaboratorDetail extends Collaborator {
  reviewLinks: ReviewLink[];
  assignments: Assignment[];
}

const ROLES = ['all', 'editor', 'narrator', 'reviewer', 'client'] as const;
const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  editor: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  narrator: { bg: 'rgba(124,58,237,0.15)', text: '#7c3aed' },
  reviewer: { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4' },
  client: { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
};

const PERM_COLORS: Record<string, { bg: string; text: string }> = {
  'view-only': { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' },
  'can-comment': { bg: 'rgba(6,182,212,0.15)', text: '#06b6d4' },
  'can-annotate': { bg: 'rgba(124,58,237,0.15)', text: '#7c3aed' },
};

const STATUS_COLORS: Record<string, string> = {
  assigned: '#eab308', received: '#06b6d4', recording: '#7c3aed',
  submitted: '#3b82f6', revisions: '#f97316', approved: '#22c55e', completed: '#22c55e',
};

const PALETTE = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

function timeAgo(dateStr: string | null) {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function TeamPage() {
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedData, setExpandedData] = useState<CollaboratorDetail | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('reviewer');
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => { loadOverview(); }, []);

  async function loadOverview() {
    try {
      const res = await fetch('/api/team/overview');
      if (res.ok) setCollaborators(await res.json());
    } catch {} finally { setLoading(false); }
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    try {
      const res = await fetch('/api/team/collaborators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim() || undefined, role: newRole, color: PALETTE[collaborators.length % PALETTE.length] }),
      });
      if (res.ok) {
        toast.success('Collaborator added');
        setShowAdd(false);
        setNewName('');
        setNewEmail('');
        setNewRole('reviewer');
        loadOverview();
      }
    } catch { toast.error('Failed to add'); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this collaborator and all their assigned access?')) return;
    await fetch(`/api/team/collaborators/${id}`, { method: 'DELETE' });
    setCollaborators(prev => prev.filter(c => c.id !== id));
    if (expandedId === id) { setExpandedId(null); setExpandedData(null); }
    toast.success('Collaborator removed');
  }

  async function handleRevokeAll(id: string) {
    if (!confirm('Revoke ALL access for this person? This will delete all their review links and deactivate narrator assignments.')) return;
    setRevoking(id);
    try {
      const res = await fetch(`/api/team/collaborators/${id}/revoke-all`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Revoked: ${data.linksDeleted} link(s), ${data.assignmentsDeactivated} assignment(s)`);
        loadOverview();
        if (expandedId === id) loadDetail(id);
      }
    } catch { toast.error('Failed to revoke'); }
    finally { setRevoking(null); }
  }

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/team/collaborators/${id}`);
      if (res.ok) setExpandedData(await res.json());
    } catch {}
  }, []);

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedData(null);
    } else {
      setExpandedId(id);
      setExpandedData(null);
      loadDetail(id);
    }
  }

  function copyLink(type: 'review' | 'narrate', token: string) {
    const prefix = type === 'review' ? '/review/' : '/narrate/';
    navigator.clipboard.writeText(`${window.location.origin}${prefix}${token}`);
    toast.success('Link copied');
  }

  async function handleDeleteLink(linkId: string, projectId: string) {
    try {
      await fetch(`/api/review/projects/${projectId}/share`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      if (expandedId) loadDetail(expandedId);
      loadOverview();
      toast.success('Link revoked');
    } catch { toast.error('Failed'); }
  }

  const filtered = roleFilter === 'all' ? collaborators : collaborators.filter(c => c.role === roleFilter);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Team & Access</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>Manage collaborators and control who has access to your projects</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
          + Add Person
        </button>
      </div>

      {/* Role filter */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg w-fit" style={{ background: 'var(--bg-secondary)' }}>
        {ROLES.map(role => (
          <button
            key={role}
            onClick={() => setRoleFilter(role)}
            className="px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors"
            style={{
              background: roleFilter === role ? 'rgba(124,58,237,0.2)' : 'transparent',
              color: roleFilter === role ? '#a78bfa' : 'var(--text-muted)',
            }}
          >
            {role === 'all' ? `All (${collaborators.length})` : `${role}s (${collaborators.filter(c => c.role === role).length})`}
          </button>
        ))}
      </div>

      {/* Add form */}
      <AnimatePresence>
        {showAdd && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-6 overflow-hidden">
            <div className="p-5 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Add Collaborator</h3>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <input autoFocus placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
                  className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <input placeholder="Email (optional)" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                <select value={newRole} onChange={e => setNewRole(e.target.value)}
                  className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  <option value="editor">Editor</option>
                  <option value="narrator">Narrator</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="client">Client</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowAdd(false); setNewName(''); setNewEmail(''); }} className="px-3 py-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>Cancel</button>
                <button onClick={handleAdd} disabled={!newName.trim()} className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ background: '#7c3aed' }}>Add</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collaborators list */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 rounded-xl" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            {roleFilter === 'all' ? 'No collaborators yet — add someone to get started' : `No ${roleFilter}s yet`}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(collab => {
            const rc = ROLE_COLORS[collab.role] || ROLE_COLORS.reviewer;
            const isExpanded = expandedId === collab.id;
            const totalAccess = (collab.review_link_count || 0) + (collab.assignment_count || 0);

            return (
              <div key={collab.id} className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                {/* Collaborator row */}
                <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => toggleExpand(collab.id)}>
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0" style={{ background: collab.color }}>
                    {(collab.name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{collab.name}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium capitalize" style={{ background: rc.bg, color: rc.text }}>{collab.role}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      {collab.email && <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>{collab.email}</span>}
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{totalAccess} active link{totalAccess !== 1 ? 's' : ''}</span>
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Last active: {timeAgo(collab.last_activity ?? null)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={e => { e.stopPropagation(); handleRevokeAll(collab.id); }}
                      disabled={revoking === collab.id || totalAccess === 0}
                      className="px-2 py-1 rounded text-[10px] font-medium transition-colors disabled:opacity-30"
                      style={{ color: '#ef4444', background: 'rgba(239,68,68,0.1)' }}
                    >
                      {revoking === collab.id ? 'Revoking...' : 'Revoke All'}
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(collab.id); }}
                      className="p-1.5 rounded hover:bg-red-500/10 transition-colors"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    </button>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)', transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>

                {/* Expanded detail */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="px-4 pb-4 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
                        {!expandedData ? (
                          <div className="py-4 text-center">
                            <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
                          </div>
                        ) : (
                          <>
                            {/* Review links */}
                            {expandedData.reviewLinks.length > 0 && (
                              <div className="pt-3">
                                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Review Links</p>
                                <div className="space-y-1.5">
                                  {expandedData.reviewLinks.map(link => {
                                    const pc = PERM_COLORS[link.permission] || PERM_COLORS['view-only'];
                                    return (
                                      <div key={link.id} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                                        <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{link.project_title}</span>
                                        {link.label && <span className="text-[10px] italic truncate" style={{ color: 'var(--text-muted)' }}>{link.label}</span>}
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: pc.bg, color: pc.text }}>{link.permission}</span>
                                        <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
                                          {link.access_count > 0 ? `${link.access_count} views — ${timeAgo(link.last_accessed_at)}` : 'Never accessed'}
                                        </span>
                                        <button onClick={() => copyLink('review', link.token)} className="p-1 rounded hover:bg-white/5" title="Copy link">
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                        </button>
                                        <button onClick={() => handleDeleteLink(link.id, link.project_id)} className="p-1 rounded hover:bg-red-500/10" title="Revoke this link">
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><path d="M18 6L6 18M6 6l12 12" /></svg>
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {/* Narrator assignments */}
                            {expandedData.assignments.length > 0 && (
                              <div className="pt-2">
                                <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Narrator Assignments</p>
                                <div className="space-y-1.5">
                                  {expandedData.assignments.map(a => {
                                    const progress = a.total_sections > 0 ? Math.round((a.approved_sections / a.total_sections) * 100) : 0;
                                    return (
                                      <div key={a.id} className="p-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                                        <div className="flex items-center gap-2 mb-1">
                                          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{a.project_title}</span>
                                          <span className="text-[10px] px-1.5 py-0.5 rounded-full capitalize shrink-0" style={{ background: `${STATUS_COLORS[a.status] || '#666'}22`, color: STATUS_COLORS[a.status] || '#666' }}>{a.status}</span>
                                          <span className="text-[10px] ml-auto shrink-0" style={{ color: 'var(--text-muted)' }}>
                                            {a.approved_sections}/{a.total_sections} sections — {a.access_count > 0 ? timeAgo(a.last_accessed_at) : 'Never accessed'}
                                          </span>
                                          <button onClick={() => copyLink('narrate', a.share_token)} className="p-1 rounded hover:bg-white/5" title="Copy link">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                          </button>
                                        </div>
                                        <div className="h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                          <div className="h-full rounded-full" style={{ width: `${progress}%`, background: '#22c55e' }} />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {expandedData.reviewLinks.length === 0 && expandedData.assignments.length === 0 && (
                              <p className="text-xs text-center py-4" style={{ color: 'var(--text-muted)' }}>No active access — assign a review or narration project</p>
                            )}
                          </>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
