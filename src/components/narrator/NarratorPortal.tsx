'use client';

import { useState, useEffect, useCallback } from 'react';
import { EmphasisBadge } from './EmphasisBadge';
import { AudioPlayer } from './AudioPlayer';
import { TeleprompterMode } from './TeleprompterMode';
import { TakeReview } from './TakeReview';
import { HeroAction } from '@/components/dashboard/HeroAction';

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
  /** The narrator's personal_token, if available, so we can render a
   *  "Back to dashboard" link from any single-assignment view. */
  narrator_personal_token?: string | null;
  /** When the narrator uploads a single file covering the whole script,
   *  the take id + url + duration are cached here. Owner can leave
   *  timestamped feedback on it via the standard TakeReview surface. */
  full_audio_take_id?: string | null;
  full_audio_url?: string | null;
  full_audio_duration_seconds?: number | null;
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

type ViewMode = 'sections' | 'recording' | 'plain';

interface BulkMapping {
  file: File;
  sectionId: string | null;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
}

/**
 * Try to match an audio filename to a section by:
 *  1. Leading number → section_number  (e.g. "01-intro.mp3" → section 1)
 *  2. Word-level keyword match against section label
 *     (e.g. "phishing-social.mp3" → "Phishing & Social Engineering")
 *
 * Word-level matching is intentionally strict: substring matching on cleaned
 * strings was too permissive and could mis-map files (e.g. "intro.mp3" hitting
 * any section whose label happened to share 4 chars). Now we only count word
 * tokens of length ≥3 that actually appear in both filename and label.
 *
 * Returns null if there's no confident match — caller picks via dropdown.
 */
function autoMatchFileToSection(
  fileName: string,
  sections: Array<{ id: string; section_number: number; label: string | null }>,
): string | null {
  const base = fileName.toLowerCase().replace(/\.[^.]+$/, '');

  // Strategy 1: leading number — most reliable, return immediately.
  const num = base.match(/^\s*(\d{1,3})\b/);
  if (num) {
    const n = parseInt(num[1], 10);
    const m = sections.find(s => s.section_number === n);
    if (m) return m.id;
  }

  // Strategy 2: word-token overlap. Score = sum of matched word lengths.
  // Require minimum score of 4 (e.g. one 4-letter word, or two 3-letter words
  // share-prefixed) to count as a match. Tie-broken by highest score.
  const fileWords = new Set(base.split(/[^a-z0-9]+/).filter(w => w.length >= 3));
  if (fileWords.size === 0) return null;

  let best: { id: string; score: number } | null = null;
  for (const s of sections) {
    if (!s.label) continue;
    const labelWords = s.label.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (labelWords.length === 0) continue;
    let score = 0;
    for (const lw of labelWords) {
      if (fileWords.has(lw)) score += lw.length;
    }
    if (score >= 4 && (!best || score > best.score)) best = { id: s.id, score };
  }
  return best?.id || null;
}

/**
 * Strip production cues like [VISUAL CUE: ...], [SFX: ...], [B-ROLL ...]
 * from a narration line so the plain reading view shows only what the
 * narrator actually says. Mirrors the teleprompter's plain-mode logic.
 */
function stripCues(text: string): string {
  return text.replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '-').slice(0, 60).toLowerCase() || 'narration';
}

function downloadBlob(content: string | Blob, filename: string, mimeType: string) {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface PortalSectionLite {
  section_number: number;
  label: string | null;
  script_text: string;
  estimated_duration_seconds: number | null;
}

function exportTxt(title: string, sections: PortalSectionLite[], withLabels: boolean) {
  const lines: string[] = [title, '='.repeat(Math.max(title.length, 8)), ''];
  const visible = sections.filter(s => stripCues(s.script_text).length > 0);
  if (withLabels) {
    for (const s of visible) {
      const label = s.label || `Section ${s.section_number}`;
      const dur = s.estimated_duration_seconds ? ` (~${Math.round(s.estimated_duration_seconds)}s)` : '';
      lines.push(`-- ${label}${dur} --`);
      lines.push('');
      lines.push(stripCues(s.script_text));
      lines.push('');
      lines.push('');
    }
  } else {
    lines.push(visible.map(s => stripCues(s.script_text)).join('\n\n'));
  }
  downloadBlob(lines.join('\n'), `${sanitizeFilename(title)}-narration.txt`, 'text/plain');
}

function exportDoc(title: string, sections: PortalSectionLite[], withLabels: boolean) {
  // Word will open .doc files that are valid HTML with the right MIME type.
  // Avoids pulling in a docx dep just for a save-as option.
  const visible = sections.filter(s => stripCues(s.script_text).length > 0);
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = withLabels
    ? visible.map(s => {
        const label = escape(s.label || `Section ${s.section_number}`);
        const dur = s.estimated_duration_seconds ? ` <span style="color:#777">(~${Math.round(s.estimated_duration_seconds)}s)</span>` : '';
        return `<h2 style="color:#7c3aed;margin-top:18pt;">${label}${dur}</h2><p>${escape(stripCues(s.script_text))}</p>`;
      }).join('\n')
    : `<p>${escape(visible.map(s => stripCues(s.script_text)).join('\n\n'))}</p>`;
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body style="font-family:Georgia,serif;font-size:13pt;line-height:1.6;"><h1>${escape(title)}</h1>${body}</body></html>`;
  downloadBlob(html, `${sanitizeFilename(title)}-narration.doc`, 'application/msword');
}

async function exportPdf(title: string, sections: PortalSectionLite[], withLabels: boolean) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  const titleLines = doc.splitTextToSize(title, contentWidth);
  for (const tl of titleLines) {
    doc.text(tl, margin, y);
    y += 8;
  }
  y += 4;

  const visible = sections.filter(s => stripCues(s.script_text).length > 0);
  doc.setFont('times', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(15, 15, 15);
  const lineHeight = 6;

  function writeParagraph(text: string) {
    const lines = doc.splitTextToSize(text, contentWidth);
    for (const line of lines) {
      if (y + lineHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
    y += 3;
  }

  if (withLabels) {
    for (const s of visible) {
      if (y > pageHeight - 40) { doc.addPage(); y = margin; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(124, 58, 237);
      const label = s.label || `Section ${s.section_number}`;
      const dur = s.estimated_duration_seconds ? ` · ~${Math.round(s.estimated_duration_seconds)}s` : '';
      doc.text(`${label}${dur}`.toUpperCase(), margin, y);
      y += 7;
      doc.setFont('times', 'normal');
      doc.setFontSize(13);
      doc.setTextColor(15, 15, 15);
      writeParagraph(stripCues(s.script_text));
      y += 2;
    }
  } else {
    writeParagraph(visible.map(s => stripCues(s.script_text)).join('\n\n'));
  }

  doc.save(`${sanitizeFilename(title)}-narration.pdf`);
}

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
  const [viewMode, setViewMode] = useState<ViewMode>('sections');
  const [showLabels, setShowLabels] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Per-take Frame.io review panel — narrator can expand to see/respond to
  // owner comments and post their own.
  const [reviewingTakeId, setReviewingTakeId] = useState<string | null>(null);
  // Full-script single-file upload (drops one audio for the whole assignment).
  const [fullUploading, setFullUploading] = useState(false);

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

  const handleUpload = useCallback(async (sectionId: string, file: File, opts?: { silent?: boolean }) => {
    // `silent: true` propagates the error back to the caller (used by BulkUploadZone
    // so each row can show its own error state). Default behaviour shows an alert
    // for one-off per-section uploads since this component lives outside the app shell.
    if (!file.type.startsWith('audio/')) {
      if (opts?.silent) throw new Error('Not an audio file');
      return;
    }
    setUploading(sectionId);
    try {
      // Probe duration locally before reserving the take row
      let durationSeconds: number | undefined;
      try {
        const audioEl = document.createElement('audio');
        audioEl.preload = 'metadata';
        const objectUrl = URL.createObjectURL(file);
        audioEl.src = objectUrl;
        await new Promise<void>(resolve => {
          audioEl.onloadedmetadata = () => resolve();
          audioEl.onerror = () => resolve();
        });
        if (isFinite(audioEl.duration)) durationSeconds = Math.round(audioEl.duration);
        URL.revokeObjectURL(objectUrl);
      } catch {}

      // 1. Reserve a take + get a presigned R2 upload URL
      const reserveRes = await fetch(`/api/narrate/${token}/sections/${sectionId}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          durationSeconds,
        }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl, takeId, takeNumber, audioUrl } = await reserveRes.json();

      // 2. Upload directly to R2
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`R2 rejected the upload (HTTP ${putRes.status}). Check bucket CORS configuration.`);
      }

      // 3. Confirm with metadata
      await fetch(`/api/narrate/${token}/sections/${sectionId}/upload`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ takeId, durationSeconds, fileSize: file.size }),
      }).catch(() => {});

      // 4. Surface the new take in the UI
      const take = {
        id: takeId,
        take_number: takeNumber,
        audio_url: audioUrl,
        duration_seconds: durationSeconds ?? null,
        narrator_notes: null,
        owner_notes: null,
        rating: null,
        is_selected: false,
        created_at: new Date().toISOString(),
      };
      setSections(prev => prev.map(s => s.id === sectionId ? { ...s, takes: [take, ...(s.takes || [])], status: 'submitted' } : s));
      setAssignment(prev => prev ? { ...prev, status: prev.status === 'received' || prev.status === 'assigned' ? 'recording' : prev.status } : prev);
    } catch (e) {
      // Surface the error so the narrator knows what to fix (CORS, R2 setup, etc.)
      const msg = e instanceof Error ? e.message : 'Upload failed';
      console.error('Take upload failed:', e);
      if (opts?.silent) throw e;
      alert(`Upload failed: ${msg}`);
    }
    finally { setUploading(null); }
  }, [token]);

  /**
   * Upload one audio file that covers the whole script — alternative to
   * recording per-section. Goes to a synthetic "section 0" backing take so
   * the existing review/comment surfaces work unchanged.
   */
  const handleFullUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith('audio/')) {
      alert('Please choose an audio file.');
      return;
    }
    setFullUploading(true);
    try {
      let durationSeconds: number | undefined;
      try {
        const audioEl = document.createElement('audio');
        audioEl.preload = 'metadata';
        const objectUrl = URL.createObjectURL(file);
        audioEl.src = objectUrl;
        await new Promise<void>(resolve => {
          audioEl.onloadedmetadata = () => resolve();
          audioEl.onerror = () => resolve();
        });
        if (isFinite(audioEl.duration)) durationSeconds = Math.round(audioEl.duration);
        URL.revokeObjectURL(objectUrl);
      } catch {}

      const reserveRes = await fetch(`/api/narrate/${token}/full-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
          durationSeconds,
        }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl, takeId, audioUrl } = await reserveRes.json();

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) {
        throw new Error(`R2 rejected the upload (HTTP ${putRes.status}). Check bucket CORS configuration.`);
      }

      await fetch(`/api/narrate/${token}/full-audio`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ takeId, durationSeconds, fileSize: file.size }),
      }).catch(() => {});

      setAssignment(prev => prev ? {
        ...prev,
        full_audio_take_id: takeId,
        full_audio_url: audioUrl,
        full_audio_duration_seconds: durationSeconds ?? prev.full_audio_duration_seconds ?? null,
        status: prev.status === 'received' || prev.status === 'assigned' ? 'recording' : prev.status,
      } : prev);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      console.error('Full-audio upload failed:', e);
      alert(`Upload failed: ${msg}`);
    } finally {
      setFullUploading(false);
    }
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

  // Section 0 is the synthetic full-script section. Hide it from the normal
  // per-section listings — it surfaces as the "Full narration" card instead.
  const realSections = sections.filter(s => s.section_number !== 0);
  const approvedCount = realSections.filter(s => s.status === 'approved').length;
  const uploadedCount = realSections.filter(s => s.takes && s.takes.length > 0).length;
  const progress = realSections.length > 0 ? Math.round((uploadedCount / realSections.length) * 100) : 0;
  const assignmentStatus = STATUS_LABELS[assignment.status] || STATUS_LABELS.assigned;
  const totalDuration = realSections.reduce((acc, s) => acc + (s.estimated_duration_seconds || 0), 0);
  // Spoken word count — sums words in every section after stripping any
  // bracketed cue ([VISUAL CUE: …], [excited], [pause], etc.). What the
  // narrator will literally read aloud, not the raw script length.
  const totalWords = realSections.reduce((acc, s) => {
    const spoken = (s.script_text || '').replace(/\[[^\]]+\]/g, '');
    return acc + spoken.split(/\s+/).filter(w => w.length > 0).length;
  }, 0);

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
        {/* Back-to-dashboard breadcrumb. Only renders when this assignment
            actually belongs to a narrator with a personal dashboard token —
            otherwise the link would 404. Visible above the project title so
            it's the first thing the eye lands on after coming in from a
            specific assignment. */}
        {assignment.narrator_personal_token && (
          <a
            href={`/narrator/${assignment.narrator_personal_token}`}
            className="inline-flex items-center gap-1.5 text-xs mb-4 transition-colors hover:text-purple-400"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            All assignments
          </a>
        )}

        {/* Header — title + narrator + status. Action toolbar lives below. */}
        <header className="mb-5">
          <h1 className="text-3xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>{assignment.project_title}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: assignment.narrator_color }}>
                {(assignment.narrator_name || '?')[0].toUpperCase()}
              </div>
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{assignment.narrator_name}</span>
            </div>
            <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: `${assignmentStatus.color}22`, color: assignmentStatus.color }}>{assignmentStatus.label}</span>
            {assignment.deadline && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>📅 Due {new Date(assignment.deadline).toLocaleDateString()}</span>
            )}
            <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
              {totalWords.toLocaleString()} words · ~{Math.round(totalDuration / 60)}:{(totalDuration % 60).toString().padStart(2, '0')} total
            </span>
          </div>
        </header>

        {/* Hero action bar — primary actions live here, large + visible. */}
        <div className="mb-5 flex items-center gap-2 flex-wrap">
          {assignment.status === 'assigned' && (
            <HeroAction
              tone="cyan"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
              label="Mark as Received"
              hint="Let the owner know you've started"
              onClick={handleReceive}
              primary
            />
          )}
          <HeroAction
            tone="purple"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>}
            label="Teleprompter"
            hint="Full-screen scrolling read-along"
            onClick={() => setShowTeleprompter(true)}
          />
          <div className="relative">
            <HeroAction
              tone="slate"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>}
              label="Export"
              hint="PDF · Word · TXT"
              onClick={() => setExportOpen(o => !o)}
            />
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div
                  className="absolute left-0 top-full mt-1 z-50 rounded-lg overflow-hidden"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', minWidth: 260, boxShadow: '0 10px 30px rgba(0,0,0,0.4)' }}
                >
                  <label className="flex items-center gap-2 px-3 py-2.5 text-[11px]" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' }}>
                    <input
                      type="checkbox"
                      checked={showLabels}
                      onChange={e => setShowLabels(e.target.checked)}
                      className="accent-purple-500"
                    />
                    Include section labels (Hook / Section N)
                  </label>
                  {([
                    { key: 'pdf', label: '📕 Download PDF', hint: 'Print-ready' },
                    { key: 'doc', label: '📄 Download .doc', hint: 'Opens in Word / Docs' },
                    { key: 'txt', label: '📝 Download .txt', hint: 'Plain text' },
                  ] as const).map(opt => (
                    <button
                      key={opt.key}
                      disabled={exporting}
                      onClick={async () => {
                        setExporting(true);
                        try {
                          const title = assignment.project_title;
                          if (opt.key === 'pdf') await exportPdf(title, sections, showLabels);
                          else if (opt.key === 'doc') exportDoc(title, sections, showLabels);
                          else exportTxt(title, sections, showLabels);
                        } catch (err) {
                          console.error('Narrator export failed:', err);
                          alert('Export failed — please try again.');
                        } finally {
                          setExporting(false);
                          setExportOpen(false);
                        }
                      }}
                      className="w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 transition-colors disabled:opacity-50"
                      style={{ color: 'var(--text-primary)' }}
                      onMouseEnter={e => { if (!exporting) e.currentTarget.style.background = 'rgba(124,58,237,0.08)'; }}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span>{opt.label}</span>
                      <span className="ml-auto text-[10px]" style={{ color: 'var(--text-muted)' }}>{opt.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {uploadedCount === realSections.length && realSections.length > 0 && assignment.status !== 'submitted' && assignment.status !== 'approved' && (
            <HeroAction
              tone="green"
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
              label="Submit All"
              hint="Send to owner for review"
              onClick={handleSubmit}
              primary
            />
          )}
        </div>

        {/* Progress bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>
            <span>
              <span style={{ color: progress >= 100 ? '#22c55e' : 'var(--text-primary)', fontWeight: 600 }}>{uploadedCount}</span>
              {' / '}{realSections.length} sections uploaded
            </span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: progress >= 100 ? '#22c55e' : 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
          </div>
        </div>

        {/* Director's general notes */}
        {assignment.director_notes && (
          <div className="mb-5 p-3 rounded-lg" style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)' }}>
            <p className="text-xs font-medium mb-1" style={{ color: '#06b6d4' }}>Director's Notes</p>
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{assignment.director_notes}</p>
          </div>
        )}

        {/* View tabs — three clearly-labelled modes for navigating the script */}
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          <ViewTab active={viewMode === 'sections'} onClick={() => setViewMode('sections')} icon="📋" label="Sections" hint="Expandable cards with full context" />
          <ViewTab active={viewMode === 'recording'} onClick={() => setViewMode('recording')} icon="🎙️" label="Recording" hint="Flat row-per-section — fastest to upload" />
          <ViewTab active={viewMode === 'plain'} onClick={() => setViewMode('plain')} icon="📖" label="Plain text" hint="Continuous read-through, no clutter" />
          {viewMode === 'plain' && (
            <button
              onClick={() => setShowLabels(s => !s)}
              className="px-2.5 py-1.5 rounded-lg text-[11px] transition-colors ml-auto"
              style={{
                background: showLabels ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.05)',
                color: showLabels ? '#a78bfa' : 'var(--text-muted)',
              }}
              title={showLabels ? 'Hide HOOK / SECTION labels' : 'Show HOOK / SECTION labels'}
            >
              {showLabels ? '🏷️ Labels: on' : '🏷️ Labels: off'}
            </button>
          )}
        </div>

        {/* Full-script upload — drop one audio file that covers the whole
            narration. Alternative to recording per-section. Owner can leave
            timestamped feedback on it via the same review surface. */}
        {viewMode !== 'plain' && (
          <FullNarrationCard
            assignment={assignment}
            uploading={fullUploading}
            onUpload={handleFullUpload}
            scriptText={realSections.map(s => stripCues(s.script_text)).filter(Boolean).join('\n\n')}
            reviewing={reviewingTakeId === assignment.full_audio_take_id}
            onToggleReview={() => setReviewingTakeId(reviewingTakeId === assignment.full_audio_take_id ? null : (assignment.full_audio_take_id || null))}
            token={token}
          />
        )}

        {/* Bulk-upload drop zone — visible in Sections + Recording modes only.
            Lets the narrator drop a folder of audio files at once and have
            them auto-mapped to sections by filename. Uses silent mode so each
            row's error state shows in the mapping panel instead of an alert. */}
        {viewMode !== 'plain' && (
          <BulkUploadZone
            sections={realSections}
            onUpload={(sectionId, file) => handleUpload(sectionId, file, { silent: true })}
          />
        )}

        {/* Plain text view — flowing narration with production cues stripped.
            "Labels: on" keeps HOOK / SECTION dividers; "Labels: off" merges
            everything into one uninterrupted read. */}
        {viewMode === 'plain' ? (
          <div className="rounded-xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
            {(() => {
              const visible = realSections.filter(s => stripCues(s.script_text).length > 0);
              if (visible.length === 0) {
                return <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>No narration text yet.</p>;
              }
              if (!showLabels) {
                return (
                  <p className="text-base leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)', fontFamily: 'Georgia, serif', lineHeight: 1.8 }}>
                    {visible.map(s => stripCues(s.script_text)).join('\n\n')}
                  </p>
                );
              }
              return (
                <div className="space-y-6">
                  {visible.map(section => (
                    <div key={section.id}>
                      <p className="text-[11px] uppercase tracking-wider mb-2" style={{ color: '#a78bfa' }}>
                        {section.label || `Section ${section.section_number}`}
                        {section.estimated_duration_seconds ? ` · ~${Math.round(section.estimated_duration_seconds)}s` : ''}
                      </p>
                      <p className="text-base leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-primary)', fontFamily: 'Georgia, serif', lineHeight: 1.8 }}>
                        {stripCues(section.script_text)}
                      </p>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : null}

        {/* Recording mode — flat row-per-section view, fastest path to upload */}
        {viewMode === 'recording' && (
          <RecordingModeView
            sections={realSections}
            comments={comments}
            uploading={uploading}
            onUpload={handleUpload}
          />
        )}

        {/* Sections */}
        <div className="space-y-4" style={{ display: viewMode === 'sections' ? undefined : 'none' }}>
          {realSections.map(section => {
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
                        {section.takes.map(take => {
                          const reviewing = reviewingTakeId === take.id;
                          return (
                            <div key={take.id} className="rounded-lg" style={{ background: 'var(--bg-primary)', border: take.is_selected ? '1px solid #22c55e' : '1px solid transparent' }}>
                              <div className="p-2">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 min-w-0">
                                    <AudioPlayer src={take.audio_url} label={`Take ${take.take_number}`} />
                                  </div>
                                  <button
                                    onClick={() => setReviewingTakeId(reviewing ? null : take.id)}
                                    className="text-[10px] px-2 py-0.5 rounded transition-colors cursor-pointer shrink-0"
                                    style={{
                                      background: reviewing ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.1)',
                                      color: '#a78bfa',
                                      border: '1px solid rgba(124,58,237,0.3)',
                                    }}
                                    title={reviewing ? 'Close review' : 'See timestamped feedback from the owner and reply'}
                                  >
                                    {reviewing ? '▾ Hide review' : '▸ Review'}
                                  </button>
                                </div>
                                {take.owner_notes && (
                                  <p className="text-xs mt-1 px-2" style={{ color: '#f97316' }}>Feedback: {take.owner_notes}</p>
                                )}
                                {take.rating && (
                                  <p className="text-[10px] mt-1 px-2" style={{ color: '#eab308' }}>{'★'.repeat(take.rating)}{'☆'.repeat(5 - take.rating)}</p>
                                )}
                              </div>
                              {reviewing && (
                                <div className="px-3 pb-3" style={{ borderTop: '1px solid var(--border)' }}>
                                  <div className="pt-3">
                                    <TakeReview
                                      takeId={take.id}
                                      audioUrl={take.audio_url}
                                      scriptText={section.script_text}
                                      initialDurationMs={take.duration_seconds ? take.duration_seconds * 1000 : null}
                                      listUrl={`/api/narrate/${token}/takes/${take.id}/comments`}
                                      itemUrl={(id) => `/api/narrate/${token}/take-comments/${id}`}
                                      author={{
                                        name: assignment.narrator_name,
                                        color: assignment.narrator_color,
                                        role: 'narrator',
                                      }}
                                      canDeleteAny={false}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
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
                        {sectionComments.map(c => {
                          // The narrator can delete their own comments — never owner's.
                          // Author identity in this portal is the narrator on the assignment.
                          const myName = assignment?.narrator_name;
                          const canDelete = c.author_role === 'narrator' && !!myName && myName === c.author_name;
                          return (
                            <div key={c.id} className="group flex gap-2 text-xs items-start">
                              <span className="font-medium shrink-0" style={{ color: c.author_role === 'owner' ? '#06b6d4' : '#7c3aed' }}>{c.author_name}:</span>
                              <span className="flex-1" style={{ color: 'var(--text-secondary)' }}>{c.text}</span>
                              {canDelete && (
                                <button
                                  onClick={async () => {
                                    if (!confirm('Delete your comment?')) return;
                                    try {
                                      const res = await fetch(`/api/narrate/${token}/comments/${c.id}?author_name=${encodeURIComponent(myName!)}`, { method: 'DELETE' });
                                      if (res.ok) setComments(prev => prev.filter(x => x.id !== c.id));
                                    } catch {}
                                  }}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer p-0.5"
                                  title="Delete comment"
                                >
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ef4444' }}><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                                </button>
                              )}
                            </div>
                          );
                        })}
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

// ─── Full-narration single-file upload card ────────────────────────────────

function FullNarrationCard({
  assignment,
  uploading,
  onUpload,
  scriptText,
  reviewing,
  onToggleReview,
  token,
}: {
  assignment: Assignment;
  uploading: boolean;
  onUpload: (file: File) => Promise<void>;
  /** Combined script across every real section. Drives the script-follow panel
   *  in the embedded TakeReview so the owner can verify every word. */
  scriptText: string;
  reviewing: boolean;
  onToggleReview: () => void;
  token: string;
}) {
  const hasUpload = !!assignment.full_audio_take_id && !!assignment.full_audio_url;

  return (
    <div className="mb-5 rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(34,197,94,0.15)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {hasUpload ? 'Full narration uploaded' : 'Full narration — one file for the whole script'}
          </p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {hasUpload
              ? 'The owner can leave timestamped feedback on this file.'
              : 'Have the whole thing in one take? Drop it here instead of uploading per-section.'}
          </p>
        </div>
        {hasUpload ? (
          <>
            <button
              onClick={onToggleReview}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
              style={{ background: reviewing ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}
            >
              {reviewing ? '▾ Hide review' : '▸ Review & comments'}
            </button>
            <label className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                disabled={uploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
              />
              {uploading ? 'Uploading…' : 'Replace'}
            </label>
          </>
        ) : (
          <label className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors" style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
            />
            {uploading ? 'Uploading…' : 'Upload one file'}
          </label>
        )}
      </div>

      {hasUpload && reviewing && assignment.full_audio_take_id && assignment.full_audio_url && (
        <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="pt-3">
            <TakeReview
              takeId={assignment.full_audio_take_id}
              audioUrl={assignment.full_audio_url}
              scriptText={scriptText}
              initialDurationMs={assignment.full_audio_duration_seconds ? assignment.full_audio_duration_seconds * 1000 : null}
              listUrl={`/api/narrate/${token}/takes/${assignment.full_audio_take_id}/comments`}
              itemUrl={(id) => `/api/narrate/${token}/take-comments/${id}`}
              author={{ name: assignment.narrator_name, color: assignment.narrator_color, role: 'narrator' }}
              canDeleteAny={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── View tab ──────────────────────────────────────────────────────────────

function ViewTab({
  active, onClick, icon, label, hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
  hint: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all"
      style={{
        background: active ? 'rgba(124,58,237,0.18)' : 'var(--bg-secondary)',
        color: active ? '#a78bfa' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'rgba(124,58,237,0.4)' : 'var(--border)'}`,
      }}
      title={hint}
    >
      <span>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ─── Bulk upload drop zone ─────────────────────────────────────────────────

interface BulkSectionRef { id: string; section_number: number; label: string | null; status: string }

function BulkUploadZone({
  sections,
  onUpload,
}: {
  sections: BulkSectionRef[];
  onUpload: (sectionId: string, file: File) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mappings, setMappings] = useState<BulkMapping[]>([]);
  const [uploadingAll, setUploadingAll] = useState(false);

  const acceptFiles = useCallback((files: FileList | File[]) => {
    const audio = Array.from(files).filter(f => f.type.startsWith('audio/'));
    if (audio.length === 0) return;
    const next: BulkMapping[] = audio.map(f => ({
      file: f,
      sectionId: autoMatchFileToSection(f.name, sections),
      status: 'pending',
    }));
    setMappings(prev => [...prev, ...next]);
    setOpen(true);
  }, [sections]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files) acceptFiles(e.dataTransfer.files);
  }, [acceptFiles]);

  const runUploads = useCallback(async () => {
    setUploadingAll(true);
    // Sequential to avoid overloading bandwidth + give clear per-row progress.
    for (let i = 0; i < mappings.length; i++) {
      const m = mappings[i];
      if (!m.sectionId || m.status === 'done') continue;
      setMappings(prev => prev.map((x, idx) => idx === i ? { ...x, status: 'uploading' } : x));
      try {
        await onUpload(m.sectionId, m.file);
        setMappings(prev => prev.map((x, idx) => idx === i ? { ...x, status: 'done' } : x));
      } catch (err) {
        setMappings(prev => prev.map((x, idx) => idx === i ? { ...x, status: 'error', error: err instanceof Error ? err.message : 'Failed' } : x));
      }
    }
    setUploadingAll(false);
  }, [mappings, onUpload]);

  const matchedCount = mappings.filter(m => m.sectionId).length;
  const doneCount = mappings.filter(m => m.status === 'done').length;
  const allDone = mappings.length > 0 && doneCount === mappings.length;

  return (
    <div
      className="mb-5 rounded-xl overflow-hidden transition-colors"
      style={{
        background: dragOver ? 'rgba(124,58,237,0.10)' : 'var(--bg-secondary)',
        border: `2px dashed ${dragOver ? 'rgba(124,58,237,0.6)' : 'var(--border)'}`,
      }}
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(124,58,237,0.15)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Bulk upload — drop a folder of audio files
          </p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Files matched to sections by leading number (<code>01-…</code>) or label keyword. You can confirm before uploading.
          </p>
        </div>
        <label className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors" style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)' }}>
          <input
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files) acceptFiles(e.target.files); e.target.value = ''; }}
          />
          Choose files
        </label>
      </div>

      {open && mappings.length > 0 && (
        <div className="px-4 pb-4 space-y-2" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between pt-3">
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {mappings.length} file{mappings.length === 1 ? '' : 's'} · {matchedCount} matched · {doneCount} uploaded
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setMappings([]); setOpen(false); }}
                className="text-[11px] px-2 py-1 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Clear
              </button>
              <button
                onClick={runUploads}
                disabled={uploadingAll || matchedCount === 0 || allDone}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 transition-all"
                style={{ background: allDone ? '#22c55e' : 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
              >
                {allDone ? '✓ All uploaded' : uploadingAll ? 'Uploading…' : `Upload ${matchedCount} file${matchedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {mappings.map((m, i) => {
              const sec = sections.find(s => s.id === m.sectionId);
              const statusBadge = (() => {
                if (m.status === 'done') return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(34,197,94,0.18)', color: '#22c55e' }}>✓ Uploaded</span>;
                if (m.status === 'uploading') return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(124,58,237,0.18)', color: '#a78bfa' }}>Uploading…</span>;
                if (m.status === 'error') return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(239,68,68,0.18)', color: '#ef4444' }} title={m.error}>✕ Error</span>;
                if (!m.sectionId) return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(234,179,8,0.18)', color: '#eab308' }}>⚠️ Pick section</span>;
                return <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>Ready</span>;
              })();
              return (
                <div key={i} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <span className="text-base shrink-0">🎵</span>
                  <span className="text-xs truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }} title={m.file.name}>{m.file.name}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                    <path d="M5 12h14M13 5l7 7-7 7"/>
                  </svg>
                  <select
                    value={m.sectionId || ''}
                    onChange={e => setMappings(prev => prev.map((x, idx) => idx === i ? { ...x, sectionId: e.target.value || null } : x))}
                    disabled={m.status === 'uploading' || m.status === 'done'}
                    className="text-xs px-2 py-1 rounded shrink-0 max-w-[200px]"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="">— Pick section —</option>
                    {sections.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.section_number}. {s.label || `Section ${s.section_number}`}
                      </option>
                    ))}
                  </select>
                  {statusBadge}
                  {m.status !== 'uploading' && m.status !== 'done' && (
                    <button
                      onClick={() => setMappings(prev => prev.filter((_, idx) => idx !== i))}
                      className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                      title="Remove"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                  {sec && m.status !== 'done' && (
                    <span className="hidden lg:block text-[10px] truncate max-w-[120px]" style={{ color: 'var(--text-muted)' }}>
                      → {sec.label || `Section ${sec.section_number}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Recording mode — flat row-per-section view ────────────────────────────

interface RecordingModeSection {
  id: string;
  section_number: number;
  label: string | null;
  script_text: string;
  estimated_duration_seconds: number | null;
  status: string;
  takes: Array<{ id: string; take_number: number; audio_url: string; is_selected: boolean; owner_notes: string | null }> | null;
}

function RecordingModeView({
  sections,
  comments,
  uploading,
  onUpload,
}: {
  sections: RecordingModeSection[];
  comments: Array<{ section_id: string | null }>;
  uploading: string | null;
  onUpload: (sectionId: string, file: File) => Promise<void>;
}) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
              <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-left" style={{ color: 'var(--text-muted)', width: 50 }}>#</th>
              <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-left" style={{ color: 'var(--text-muted)' }}>Section</th>
              <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-left" style={{ color: 'var(--text-muted)', width: 100 }}>Status</th>
              <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-left" style={{ color: 'var(--text-muted)' }}>Latest take</th>
              <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-right" style={{ color: 'var(--text-muted)', width: 180 }}>Upload</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(s => {
              const sectionStatus = SECTION_STATUS[s.status] || SECTION_STATUS.pending;
              const latestTake = s.takes && s.takes.length > 0 ? s.takes[0] : null;
              const isUploading = uploading === s.id;
              const commentCount = comments.filter(c => c.section_id === s.id).length;
              const wordCount = (s.script_text || '').replace(/\[[^\]]+\]/g, '').split(/\s+/).filter(w => w.length > 0).length;

              const approved = s.status === 'approved';
              return (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--border)', opacity: approved ? 0.55 : 1 }}>
                  <td className="px-3 py-3 align-top">
                    <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: approved ? 'rgba(34,197,94,0.15)' : 'rgba(124,58,237,0.15)', color: approved ? '#22c55e' : '#7c3aed' }}>
                      {s.section_number}
                    </span>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{s.label || `Section ${s.section_number}`}</p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {wordCount} words · ~{s.estimated_duration_seconds ? `${Math.round(s.estimated_duration_seconds)}s` : '?'}
                      {s.takes && s.takes.length > 0 && ` · ${s.takes.length} take${s.takes.length === 1 ? '' : 's'}`}
                      {commentCount > 0 && ` · 💬 ${commentCount}`}
                    </p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: `${sectionStatus.color}22`, color: sectionStatus.color }}>
                      {sectionStatus.label}
                    </span>
                  </td>
                  <td className="px-3 py-3 align-top">
                    {latestTake ? (
                      <div className="flex items-center gap-2 max-w-md">
                        <AudioPlayer src={latestTake.audio_url} label={`Take ${latestTake.take_number}`} compact />
                      </div>
                    ) : (
                      <span className="text-[11px]" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>— no take yet —</span>
                    )}
                    {latestTake?.owner_notes && (
                      <p className="text-[11px] mt-1.5 italic" style={{ color: '#f97316' }}>
                        Owner: {latestTake.owner_notes}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 align-top text-right">
                    {s.status !== 'approved' ? (
                      <label
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors"
                        style={{
                          background: isUploading ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.18)',
                          color: '#a78bfa',
                          border: '1px solid rgba(124,58,237,0.3)',
                          opacity: isUploading ? 0.6 : 1,
                        }}
                      >
                        <input
                          type="file"
                          accept="audio/*"
                          className="hidden"
                          disabled={isUploading}
                          onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(s.id, f); e.target.value = ''; }}
                        />
                        {isUploading ? (
                          <>
                            <span className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
                            Uploading…
                          </>
                        ) : (
                          <>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            {latestTake ? 'New take' : 'Upload'}
                          </>
                        )}
                      </label>
                    ) : (
                      <span className="text-[11px]" style={{ color: '#22c55e' }}>✓ Approved</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
