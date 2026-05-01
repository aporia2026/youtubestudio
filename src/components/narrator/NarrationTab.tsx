'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { AssignDialog } from './AssignDialog';
import { AudioPlayer } from './AudioPlayer';
import { TakeReview } from './TakeReview';

interface Assignment {
  id: string;
  project_id?: string;
  narrator_name: string;
  narrator_color: string;
  status: string;
  share_token: string;
  deadline: string | null;
  created_at: string;
  /** Set when the narrator uploaded one audio file covering the whole
   *  script — owner reviews it via TakeReview. */
  full_audio_take_id?: string | null;
  full_audio_url?: string | null;
  full_audio_duration_seconds?: number | null;
  full_audio_comment_count?: number;
  full_audio_unresolved_count?: number;
  full_audio_has_unresolved_owner_feedback?: boolean;
}

interface Take {
  id: string;
  take_number: number;
  audio_url: string;
  duration_seconds: number | null;
  narrator_notes: string | null;
  owner_notes: string | null;
  rating: number | null;
  is_selected: boolean;
  /** Per-take comment counts embedded by the GET route. */
  comment_count?: number;
  unresolved_count?: number;
  has_owner_feedback?: boolean;
  has_unresolved_owner_feedback?: boolean;
}

interface Section {
  id: string;
  section_number: number;
  label: string | null;
  script_text: string;
  estimated_duration_seconds: number | null;
  status: string;
  approved_take_id: string | null;
  takes: Take[] | null;
}

interface NarrationTabProps {
  projectId: string;
  scriptId: string;
  scriptText: string;
  scriptVersion: number;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: 'rgba(255,255,255,0.05)', text: 'var(--text-muted)' },
  recording: { bg: 'rgba(124,58,237,0.15)', text: '#7c3aed' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  approved: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  retake: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444' },
};

export function NarrationTab({ projectId, scriptId, scriptText, scriptVersion }: NarrationTabProps) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAssign, setShowAssign] = useState(false);
  const [activeAssignment, setActiveAssignment] = useState<Assignment | null>(null);
  const [stitching, setStitching] = useState(false);
  // Which take is currently expanded into the Frame.io-style review panel.
  // One at a time so the page stays manageable on long scripts.
  const [reviewingTakeId, setReviewingTakeId] = useState<string | null>(null);

  useEffect(() => { loadAssignments(); }, [projectId]);

  // Auto-open the assign dialog when arriving via ?assign=1 (e.g. from the
  // Script Generator's "Send to Narrator" button) — but only after data has
  // loaded so we don't pop a dialog over a loading skeleton, and only when
  // there's no existing assignment (otherwise we'd offer to create a duplicate).
  useEffect(() => {
    if (typeof window === 'undefined' || loading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('assign') !== '1') return;
    if (!activeAssignment && scriptText) {
      setShowAssign(true);
    }
    // Clean the param so refresh doesn't reopen
    params.delete('assign');
    const newSearch = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${newSearch ? '?' + newSearch : ''}`);
  }, [loading, activeAssignment, scriptText]);

  async function loadAssignments() {
    try {
      const res = await fetch(`/api/narrator/assignments`);
      if (res.ok) {
        const all: Array<Assignment & { project_id?: string }> = await res.json();
        setAssignments(all);

        // Find assignment for this project and load its details
        const match = all.find(a => a.project_id === projectId);
        if (match) {
          const detailRes = await fetch(`/api/narrator/assignments/${match.id}`);
          if (detailRes.ok) {
            const data = await detailRes.json();
            setActiveAssignment(data.assignment);
            setSections(data.sections || []);
          }
        }
      }
    } catch {}
    finally { setLoading(false); }
  }

  function handleAssigned(token: string) {
    setShowAssign(false);
    navigator.clipboard.writeText(`${window.location.origin}/narrate/${token}`);
    toast.success('Assignment created — link copied to clipboard');
    loadAssignments();
  }

  async function handleApproveSection(sectionId: string, takeId: string) {
    if (!activeAssignment) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved', approved_take_id: takeId }),
      });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, status: 'approved', approved_take_id: takeId } : s));
      toast.success('Section approved');
    } catch { toast.error('Failed to approve'); }
  }

  async function handleRetakeSection(sectionId: string) {
    if (!activeAssignment) return;
    const notes = prompt('What needs to be re-recorded?');
    if (!notes) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'retake', retake_notes: notes }),
      });
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, status: 'retake' } : s));
      toast.success('Retake requested');
    } catch { toast.error('Failed'); }
  }

  async function handleStitch() {
    if (!activeAssignment) return;
    setStitching(true);
    try {
      const res = await fetch(`/api/narrator/assignments/${activeAssignment.id}/stitch`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Final voiceover created (${data.sections} sections stitched)`);
        setActiveAssignment(prev => prev ? { ...prev, status: 'completed' } : prev);
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to stitch');
      }
    } catch { toast.error('Failed to stitch'); }
    finally { setStitching(false); }
  }

  async function handleRateTake(takeId: string, rating: number, sectionId: string) {
    if (!activeAssignment) return;
    try {
      await fetch(`/api/narrator/assignments/${activeAssignment.id}/sections/${sectionId}/takes/${takeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      setSections(prev => prev.map(s => {
        if (s.id !== sectionId || !s.takes) return s;
        return { ...s, takes: s.takes.map(t => t.id === takeId ? { ...t, rating } : t) };
      }));
    } catch {}
  }

  if (loading) {
    return <div className="py-10 text-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>;
  }

  if (!activeAssignment) {
    return (
      <div className="text-center py-16 glass rounded-xl">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-3" style={{ color: 'var(--text-muted)' }}>
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        </svg>
        <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>No narrator assigned yet</p>
        <button onClick={() => setShowAssign(true)} disabled={!scriptText} className="btn-primary text-sm disabled:opacity-50">
          Assign to Narrator
        </button>
        {showAssign && scriptText && (
          <AssignDialog
            projectId={projectId}
            scriptId={scriptId}
            scriptText={scriptText}
            scriptVersion={scriptVersion}
            onClose={() => setShowAssign(false)}
            onAssigned={handleAssigned}
          />
        )}
      </div>
    );
  }

  // Section 0 is the synthetic "full narration" container — surfaced as its
  // own card, not in the per-section grid.
  const realSections = sections.filter(s => s.section_number !== 0);
  const approvedCount = realSections.filter(s => s.status === 'approved').length;
  const allApproved = approvedCount === realSections.length && realSections.length > 0;
  const progress = realSections.length > 0 ? Math.round((approvedCount / realSections.length) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Assignment header */}
      <div className="glass rounded-xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white" style={{ background: activeAssignment.narrator_color }}>
            {(activeAssignment.narrator_name || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{activeAssignment.narrator_name}</p>
            <p className="text-xs capitalize" style={{ color: 'var(--text-muted)' }}>{activeAssignment.status} — {approvedCount}/{realSections.length} approved</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/narrate/${activeAssignment.share_token}`); toast.success('Link copied'); }}
            className="text-xs px-3 py-1.5 rounded-lg" style={{ background: 'rgba(124,58,237,0.1)', color: '#7c3aed' }}>
            Copy Link
          </button>
          {allApproved && activeAssignment.status !== 'completed' && (
            <button onClick={handleStitch} disabled={stitching} className="text-xs px-3 py-1.5 rounded-lg font-medium text-white disabled:opacity-50" style={{ background: '#22c55e' }}>
              {stitching ? 'Stitching...' : 'Stitch Final Voiceover'}
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      <div className="h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #22c55e)' }} />
      </div>

      {/* Full-narration card — surfaces when the narrator chose to upload a
          single audio file covering the whole script. Owner reviews it via
          the same TakeReview component used per-take. */}
      {activeAssignment.full_audio_take_id && activeAssignment.full_audio_url && (
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Full narration</span>
              {activeAssignment.full_audio_duration_seconds && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  ~{Math.floor(activeAssignment.full_audio_duration_seconds / 60)}:{(Math.round(activeAssignment.full_audio_duration_seconds) % 60).toString().padStart(2, '0')}
                </span>
              )}
            </div>
            <button
              onClick={() => setReviewingTakeId(reviewingTakeId === activeAssignment.full_audio_take_id ? null : (activeAssignment.full_audio_take_id || null))}
              className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer flex items-center gap-1.5"
              style={{
                background: reviewingTakeId === activeAssignment.full_audio_take_id ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)',
                color: '#a78bfa',
                border: '1px solid rgba(124,58,237,0.3)',
              }}
            >
              {reviewingTakeId === activeAssignment.full_audio_take_id ? '▾ Hide review' : '▸ Review & comment'}
              {reviewingTakeId !== activeAssignment.full_audio_take_id && (activeAssignment.full_audio_unresolved_count ?? 0) > 0 && (
                <span
                  className="text-[9px] px-1 py-0.5 rounded-full font-bold"
                  style={{ background: 'rgba(167,139,250,0.5)', color: '#fff', minWidth: 14, textAlign: 'center' }}
                >
                  {activeAssignment.full_audio_unresolved_count}
                </span>
              )}
            </button>
          </div>
          {reviewingTakeId === activeAssignment.full_audio_take_id ? (
            <div className="pt-2">
              <TakeReview
                takeId={activeAssignment.full_audio_take_id}
                audioUrl={`/api/narrator/takes/${activeAssignment.full_audio_take_id}/audio`}
                scriptText={realSections.map(s => s.script_text).filter(Boolean).join('\n\n')}
                initialDurationMs={activeAssignment.full_audio_duration_seconds ? activeAssignment.full_audio_duration_seconds * 1000 : null}
                listUrl={`/api/narrator/takes/${activeAssignment.full_audio_take_id}/comments`}
                itemUrl={(id) => `/api/narrator/take-comments/${id}`}
                author={{ name: 'Owner', color: '#06b6d4', role: 'owner' }}
                canDeleteAny
              />
            </div>
          ) : (
            <AudioPlayer src={activeAssignment.full_audio_url} compact />
          )}
        </div>
      )}

      {/* Sections grid */}
      <div className="space-y-3">
        {realSections.map(section => {
          const sc = STATUS_COLORS[section.status] || STATUS_COLORS.pending;
          const takes = section.takes || [];
          return (
            <div key={section.id} className="glass rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>{section.section_number}</span>
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label || `Section ${section.section_number}`}</span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>~{section.estimated_duration_seconds}s</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full capitalize" style={{ background: sc.bg, color: sc.text }}>{section.status}</span>
              </div>

              {/* Script preview */}
              <p className="text-xs mb-3 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{section.script_text.length > 150 ? section.script_text.slice(0, 150) + '...' : section.script_text}</p>

              {/* Takes */}
              {takes.length > 0 ? (
                <div className="space-y-2">
                  {takes.map((take: Take) => {
                    const reviewing = reviewingTakeId === take.id;
                    return (
                      <div key={take.id} className="rounded-lg" style={{ background: 'var(--bg-primary)', border: take.id === section.approved_take_id ? '1px solid #22c55e' : '1px solid transparent' }}>
                        <div className="flex items-center gap-2 p-2">
                          <AudioPlayer src={take.audio_url} label={`Take ${take.take_number}`} compact />
                          <div className="flex items-center gap-1">
                            {[1, 2, 3, 4, 5].map(star => (
                              <button key={star} onClick={() => handleRateTake(take.id, star, section.id)} className="text-xs cursor-pointer" style={{ color: take.rating && take.rating >= star ? '#eab308' : 'var(--text-muted)' }}>
                                {take.rating && take.rating >= star ? '★' : '☆'}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => setReviewingTakeId(reviewing ? null : take.id)}
                            className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer flex items-center gap-1.5"
                            style={{
                              background: reviewing ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)',
                              color: '#a78bfa',
                              border: '1px solid rgba(124,58,237,0.3)',
                            }}
                            title={reviewing ? 'Close review panel' : `Open the timestamped review${(take.unresolved_count ?? 0) > 0 ? ` — ${take.unresolved_count} unresolved` : ''}`}
                          >
                            {reviewing ? '▾ Hide review' : '▸ Review & comment'}
                            {!reviewing && (take.unresolved_count ?? 0) > 0 && (
                              <span
                                className="text-[9px] px-1 py-0.5 rounded-full font-bold"
                                style={{
                                  background: 'rgba(167,139,250,0.5)',
                                  color: '#fff',
                                  minWidth: 14,
                                  textAlign: 'center',
                                }}
                              >
                                {take.unresolved_count}
                              </span>
                            )}
                          </button>
                          {section.status !== 'approved' && (
                            <button onClick={() => handleApproveSection(section.id, take.id)} className="text-[10px] px-2 py-0.5 rounded text-white cursor-pointer" style={{ background: '#22c55e' }}>Approve</button>
                          )}
                        </div>

                        {reviewing && (
                          <div className="px-3 pb-3" style={{ borderTop: '1px solid var(--border)' }}>
                            <div className="pt-3">
                              <TakeReview
                                takeId={take.id}
                                // Use the same-origin audio proxy so
                                // wavesurfer's fetch doesn't need R2 CORS
                                // configured, and so the URL doesn't carry
                                // a presign expiry mid-review-session.
                                audioUrl={`/api/narrator/takes/${take.id}/audio`}
                                scriptText={section.script_text}
                                initialDurationMs={take.duration_seconds ? take.duration_seconds * 1000 : null}
                                listUrl={`/api/narrator/takes/${take.id}/comments`}
                                itemUrl={(id) => `/api/narrator/take-comments/${id}`}
                                author={{ name: 'Owner', color: '#06b6d4', role: 'owner' }}
                                canDeleteAny
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {section.status !== 'approved' && (
                    <button onClick={() => handleRetakeSection(section.id)} className="text-[10px] flex items-center gap-1 cursor-pointer" style={{ color: '#ef4444' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                      Request retake
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>Waiting for narrator to upload...</p>
              )}
            </div>
          );
        })}
      </div>

      {showAssign && (
        <AssignDialog
          projectId={projectId}
          scriptId={scriptId}
          scriptText={scriptText}
          scriptVersion={scriptVersion}
          onClose={() => setShowAssign(false)}
          onAssigned={handleAssigned}
        />
      )}
    </div>
  );
}
