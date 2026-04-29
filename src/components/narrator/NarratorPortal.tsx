'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmphasisBadge } from './EmphasisBadge';
import { AudioPlayer } from './AudioPlayer';
import { TeleprompterMode } from './TeleprompterMode';

interface Assignment {
  id: string;
  project_title: string;
  narrator_name: string;
  narrator_color: string;
  status: string;
  director_notes: string | null;
  wpm: number;
  deadline: string | null;
  share_token: string;
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
  created_at: string;
}

interface Section {
  id: string;
  section_number: number;
  label: string | null;
  script_text: string;
  director_notes: string | null;
  pronunciation_notes: Array<{ word: string; phonetic: string; audio_url?: string }>;
  emphasis_markers: Array<{ tag: string; position: number; category: string }>;
  estimated_duration_seconds: number | null;
  status: string;
  reference_audio_url: string | null;
  takes: Take[] | null;
}

interface Comment {
  id: string;
  section_id: string | null;
  text: string;
  author_name: string;
  author_role: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  assigned: { label: 'Assigned', color: '#eab308' },
  received: { label: 'Received', color: '#06b6d4' },
  recording: { label: 'Recording', color: '#7c3aed' },
  submitted: { label: 'Submitted', color: '#3b82f6' },
  revisions: { label: 'Revisions', color: '#f97316' },
  approved: { label: 'Approved', color: '#22c55e' },
  completed: { label: 'Completed', color: '#22c55e' },
};

const SECTION_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--text-muted)' },
  recording: { label: 'Recording', color: '#7c3aed' },
  submitted: { label: 'Uploaded', color: '#3b82f6' },
  approved: { label: 'Approved', color: '#22c55e' },
  retake: { label: 'Retake Requested', color: '#ef4444' },
};

export function NarratorPortal({ token }: { token: string }) {
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [showTeleprompter, setShowTeleprompter] = useState(false);
  const [commentText, setCommentText] = useState('');

  useEffect(() => { loadData(); }, [token]);

  async function loadData() {
    try {
      const res = await fetch(`/api/narrate/${token}`);
      if (!res.ok) { setError(true); return; }
      const data = await res.json();
      setAssignment(data.assignment);
      setSections(data.sections || []);
      setComments(data.comments || []);
    } catch { setError(true); }
    finally { setLoading(false); }
  }

  const handleReceive = useCallback(async () => {
    await fetch(`/api/narrate/${token}/receive`, { method: 'POST' });
    setAssignment(prev => prev ? { ...prev, status: 'received' } : prev);
  }, [token]);

  const handleUpload = useCallback(async (sectionId: string, file: File) => {
    if (!file.type.startsWith('audio/')) return;
    setUploading(sectionId);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/narrate/${token}/sections/${sectionId}/upload`, { method: 'POST', body: formData });
      if (res.ok) {
        const take = await res.json();
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, takes: [take, ...(s.takes || [])], status: 'submitted' } : s));
        setAssignment(prev => prev ? { ...prev, status: prev.status === 'received' || prev.status === 'assigned' ? 'recording' : prev.status } : prev);
      }
    } catch {}
    finally { setUploading(null); }
  }, [token]);

  const handleComment = useCallback(async (sectionId: string) => {
    if (!commentText.trim() || !assignment) return;
    try {
      const res = await fetch(`/api/narrate/${token}/sections/${sectionId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: commentText.trim(), author_name: assignment.narrator_name }),
      });
      if (res.ok) {
        const comment = await res.json();
        setComments(prev => [...prev, comment]);
        setCommentText('');
      }
    } catch {}
  }, [token, commentText, assignment]);

  const handleSubmit = useCallback(async () => {
    await fetch(`/api/narrate/${token}/submit`, { method: 'POST' });
    setAssignment(prev => prev ? { ...prev, status: 'submitted' } : prev);
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (error || !assignment) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Link Invalid</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner for a valid link.</p>
        </div>
      </div>
    );
  }

  const approvedCount = sections.filter(s => s.status === 'approved').length;
  const uploadedCount = sections.filter(s => s.takes && s.takes.length > 0).length;
  const progress = sections.length > 0 ? Math.round((uploadedCount / sections.length) * 100) : 0;
  const assignmentStatus = STATUS_LABELS[assignment.status] || STATUS_LABELS.assigned;
  const totalDuration = sections.reduce((acc, s) => acc + (s.estimated_duration_seconds || 0), 0);

  return (
    <>
      {showTeleprompter && (
        <TeleprompterMode
          sections={sections}
          wpm={assignment.wpm}
          onClose={() => setShowTeleprompter(false)}
        />
      )}

      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>{assignment.project_title}</h1>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: assignment.narrator_color }}>
                    {(assignment.narrator_name || '?')[0].toUpperCase()}
                  </div>
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{assignment.narrator_name}</span>
                </div>
                <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: `${assignmentStatus.color}22`, color: assignmentStatus.color }}>{assignmentStatus.label}</span>
                {assignment.deadline && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Due: {new Date(assignment.deadline).toLocaleDateString()}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {assignment.status === 'assigned' && (
                <button onClick={handleReceive} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: '#06b6d4' }}>Mark as Received</button>
              )}
              <button onClick={() => setShowTeleprompter(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
                Teleprompter
              </button>
              {uploadedCount === sections.length && assignment.status !== 'submitted' && assignment.status !== 'approved' && (
                <button onClick={handleSubmit} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: '#22c55e' }}>Submit All</button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
              <span>{uploadedCount}/{sections.length} sections uploaded</span>
              <span>~{Math.round(totalDuration / 60)}:{(totalDuration % 60).toString().padStart(2, '0')} total</span>
            </div>
            <div className="h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
            </div>
          </div>

          {/* Director's general notes */}
          {assignment.director_notes && (
            <div className="mt-4 p-3 rounded-lg" style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)' }}>
              <p className="text-xs font-medium mb-1" style={{ color: '#06b6d4' }}>Director's Notes</p>
              <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{assignment.director_notes}</p>
            </div>
          )}
        </header>

        {/* Sections */}
        <div className="space-y-4">
          {sections.map(section => {
            const sectionStatus = SECTION_STATUS[section.status] || SECTION_STATUS.pending;
            const isExpanded = expandedSection === section.id;
            const sectionComments = comments.filter(c => c.section_id === section.id);

            return (
              <div key={section.id} className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                {/* Section header */}
                <button
                  onClick={() => { setExpandedSection(isExpanded ? null : section.id); setCommentText(''); }}
                  className="w-full flex items-center gap-3 p-4 text-left"
                >
                  <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
                    {section.section_number}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label || `Section ${section.section_number}`}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      ~{section.estimated_duration_seconds ? `${Math.round(section.estimated_duration_seconds)}s` : '?'}
                      {section.takes && section.takes.length > 0 && ` — ${section.takes.length} take${section.takes.length > 1 ? 's' : ''}`}
                    </p>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: `${sectionStatus.color}22`, color: sectionStatus.color }}>
                    {sectionStatus.label}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)', transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3">
                    {/* Script text with emphasis badges */}
                    <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                      {/* Legend */}
                      <div className="flex items-center gap-4 px-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                        <span className="flex items-center gap-1 text-[10px]"><span className="w-2 h-2 rounded-full" style={{ background: '#f1f5f9' }} /> Say this</span>
                        <span className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}><span className="w-2 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.15)' }} /> Visual direction</span>
                        <span className="flex items-center gap-1 text-[10px]" style={{ color: '#a78bfa' }}><span className="w-2 h-2 rounded-full" style={{ background: '#7c3aed' }} /> Tone/emotion</span>
                        <span className="flex items-center gap-1 text-[10px]" style={{ color: '#eab308' }}><span className="w-2 h-2 rounded-full" style={{ background: '#eab308' }} /> Pacing</span>
                      </div>
                      <div className="p-3 text-sm leading-relaxed">
                        {renderScriptWithBadges(section.script_text, section.emphasis_markers)}
                      </div>
                    </div>

                    {/* Director's section notes */}
                    {section.director_notes && (
                      <div className="p-2 rounded-lg" style={{ background: 'rgba(6,182,212,0.08)' }}>
                        <p className="text-xs" style={{ color: '#06b6d4' }}>{section.director_notes}</p>
                      </div>
                    )}

                    {/* Pronunciation notes */}
                    {section.pronunciation_notes.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {section.pronunciation_notes.map((pn, i) => (
                          <span key={i} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(6,182,212,0.1)', color: '#06b6d4' }}>
                            {pn.word} → <span className="font-mono">{pn.phonetic}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Reference audio */}
                    {section.reference_audio_url && (
                      <div>
                        <p className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>AI Reference</p>
                        <AudioPlayer src={section.reference_audio_url} label="Reference" compact />
                      </div>
                    )}

                    {/* Takes list */}
                    {section.takes && section.takes.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>Your Takes</p>
                        {section.takes.map(take => (
                          <div key={take.id} className="p-2 rounded-lg" style={{ background: 'var(--bg-primary)', border: take.is_selected ? '1px solid #22c55e' : '1px solid transparent' }}>
                            <AudioPlayer src={take.audio_url} label={`Take ${take.take_number}`} />
                            {take.owner_notes && (
                              <p className="text-xs mt-1 px-2" style={{ color: '#f97316' }}>Feedback: {take.owner_notes}</p>
                            )}
                            {take.rating && (
                              <p className="text-[10px] mt-1 px-2" style={{ color: '#eab308' }}>{'★'.repeat(take.rating)}{'☆'.repeat(5 - take.rating)}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Upload area */}
                    {section.status !== 'approved' && (
                      <label className="flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors hover:border-purple-500/50"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
                        <input type="file" accept="audio/*" className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(section.id, f); }}
                          disabled={uploading === section.id}
                        />
                        {uploading === section.id ? (
                          <span className="text-xs">Uploading...</span>
                        ) : (
                          <>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                            <span className="text-xs">Upload audio take</span>
                          </>
                        )}
                      </label>
                    )}

                    {/* Comments */}
                    {sectionComments.length > 0 && (
                      <div className="space-y-1.5 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
                        {sectionComments.map(c => (
                          <div key={c.id} className="flex gap-2 text-xs">
                            <span className="font-medium shrink-0" style={{ color: c.author_role === 'owner' ? '#06b6d4' : '#7c3aed' }}>{c.author_name}:</span>
                            <span style={{ color: 'var(--text-secondary)' }}>{c.text}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add comment */}
                    <div className="flex gap-2">
                      <input
                        placeholder="Add a comment..."
                        value={expandedSection === section.id ? commentText : ''}
                        onChange={e => setCommentText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleComment(section.id); }}
                        className="flex-1 px-3 py-1.5 rounded-lg text-xs"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                      <button onClick={() => handleComment(section.id)} disabled={!commentText.trim()} className="px-3 py-1.5 rounded-lg text-xs text-white disabled:opacity-30" style={{ background: '#7c3aed' }}>Send</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/**
 * Render script text with:
 * - Narration text highlighted in white (what to actually say)
 * - Visual cues / stage directions dimmed (e.g. [VISUAL CUE: ...], [B-ROLL: ...], [CUT TO: ...])
 * - Emphasis badges inline ([PAUSE], [WHISPER], etc.)
 */
function renderScriptWithBadges(text: string, markers: Array<{ tag: string; position: number; category: string }>) {
  // Regex for visual/stage direction cues — these are NOT to be read aloud
  const VISUAL_CUE_REGEX = /\[(VISUAL CUE|VISUAL|B-ROLL|CUT TO|CUT|SCREEN|GRAPHIC|TITLE CARD|LOWER THIRD|TRANSITION|SFX|MUSIC|FOOTAGE|OVERLAY|ANIMATION|INSERT|MONTAGE|SPLIT SCREEN)[^\]]*\]/gi;

  // First pass: split by visual cues
  const segments: Array<{ text: string; type: 'narration' | 'visual-cue' }> = [];
  let lastIdx = 0;
  let cueMatch;
  const cueRegex = new RegExp(VISUAL_CUE_REGEX.source, 'gi');

  while ((cueMatch = cueRegex.exec(text)) !== null) {
    if (cueMatch.index > lastIdx) {
      segments.push({ text: text.slice(lastIdx, cueMatch.index), type: 'narration' });
    }
    segments.push({ text: cueMatch[0], type: 'visual-cue' });
    lastIdx = cueMatch.index + cueMatch[0].length;
  }
  if (lastIdx < text.length) segments.push({ text: text.slice(lastIdx), type: 'narration' });

  // Second pass: within narration segments, render emphasis badges
  return segments.map((seg, segIdx) => {
    if (seg.type === 'visual-cue') {
      return (
        <span
          key={`vc-${segIdx}`}
          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono mx-0.5 align-middle"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', opacity: 0.5 }}
          title="Visual direction — not narrated"
        >
          {seg.text}
        </span>
      );
    }

    // Narration text — parse emphasis tags
    const TAG_REGEX = /\[([^\]]+)\]/g;
    const parts: Array<string | { tag: string; category: string }> = [];
    let partLastIdx = 0;
    let tagMatch;
    const tagRegex = new RegExp(TAG_REGEX.source, 'g');

    while ((tagMatch = tagRegex.exec(seg.text)) !== null) {
      if (tagMatch.index > partLastIdx) parts.push(seg.text.slice(partLastIdx, tagMatch.index));
      // Check if this is an emphasis marker
      const globalPos = text.indexOf(tagMatch[0], partLastIdx);
      const marker = markers?.find(m => m.tag.toLowerCase() === tagMatch![1].toLowerCase());
      if (marker) {
        parts.push({ tag: tagMatch[1], category: marker.category });
      } else {
        // Unknown tag — show as dimmed direction
        parts.push({ tag: tagMatch[1], category: 'direction' });
      }
      partLastIdx = tagMatch.index + tagMatch[0].length;
    }
    if (partLastIdx < seg.text.length) parts.push(seg.text.slice(partLastIdx));

    return (
      <span key={`narr-${segIdx}`} style={{ color: '#f1f5f9' }}>
        {parts.map((part, i) => {
          if (typeof part === 'string') return <span key={i}>{part}</span>;
          if (part.category === 'direction') {
            return (
              <span key={i} className="inline-block px-1 py-0.5 rounded text-[10px] font-mono mx-0.5 align-middle"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)', opacity: 0.5 }}>
                [{part.tag}]
              </span>
            );
          }
          return <EmphasisBadge key={i} tag={part.tag} category={part.category as 'emotion' | 'nonverbal' | 'pacing'} />;
        })}
      </span>
    );
  });
}
