'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import type { ScriptSection } from '@/lib/narrator-utils';

interface NarratorProfile {
  id: string;
  name: string;
  color: string;
}

interface AssignDialogProps {
  projectId: string;
  scriptId: string;
  scriptText: string;
  scriptVersion: number;
  onClose: () => void;
  onAssigned: (token: string) => void;
}

export function AssignDialog({ projectId, scriptId, scriptText, scriptVersion, onClose, onAssigned }: AssignDialogProps) {
  const [narrators, setNarrators] = useState<NarratorProfile[]>([]);
  const [selectedNarratorId, setSelectedNarratorId] = useState('');
  const [sections, setSections] = useState<ScriptSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [splitting, setSplitting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [wpm, setWpm] = useState(150);
  const [directorNotes, setDirectorNotes] = useState('');
  const [deadline, setDeadline] = useState('');
  const [newNarratorName, setNewNarratorName] = useState('');

  useEffect(() => {
    Promise.all([
      fetch('/api/narrator/profiles').then(r => r.json()),
      splitSections(),
    ]).then(([profiles]) => {
      setNarrators(profiles);
      if (profiles.length > 0) setSelectedNarratorId(profiles[0].id);
      setLoading(false);
    });
  }, []);

  async function splitSections() {
    setSplitting(true);
    try {
      const res = await fetch('/api/narrator/split-sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_text: scriptText, wpm, autoLabel: true }),
      });
      if (res.ok) setSections(await res.json());
    } catch {}
    finally { setSplitting(false); }
  }

  async function handleCreateNarrator() {
    if (!newNarratorName.trim()) return;
    try {
      const res = await fetch('/api/narrator/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newNarratorName.trim() }),
      });
      if (res.ok) {
        const profile = await res.json();
        setNarrators(prev => [...prev, profile]);
        setSelectedNarratorId(profile.id);
        setNewNarratorName('');
      }
    } catch {}
  }

  async function handleAssign() {
    if (!selectedNarratorId || sections.length === 0) return;
    setCreating(true);
    try {
      const res = await fetch('/api/narrator/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          script_id: scriptId,
          narrator_id: selectedNarratorId,
          script_text: scriptText,
          director_notes: directorNotes || undefined,
          wpm,
          script_version: scriptVersion,
          deadline: deadline || undefined,
          sections,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success('Script assigned to narrator');
        onAssigned(data.assignment.share_token);
      } else {
        toast.error('Failed to create assignment');
      }
    } catch {
      toast.error('Failed to create assignment');
    } finally {
      setCreating(false);
    }
  }

  const totalDuration = sections.reduce((acc, s) => acc + (s.estimated_duration_seconds || 0), 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-[600px] max-h-[85vh] overflow-y-auto rounded-xl p-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>Assign to Narrator</h2>
          <button onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        {loading ? (
          <div className="py-10 text-center">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Narrator selection */}
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Narrator</label>
              {narrators.length > 0 ? (
                <select value={selectedNarratorId} onChange={e => setSelectedNarratorId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  {narrators.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                </select>
              ) : (
                <div className="flex gap-2">
                  <input placeholder="Enter narrator name" value={newNarratorName} onChange={e => setNewNarratorName(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg text-sm"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <button onClick={handleCreateNarrator} disabled={!newNarratorName.trim()} className="px-3 py-2 rounded-lg text-sm text-white disabled:opacity-50" style={{ background: '#7c3aed' }}>Add</button>
                </div>
              )}
            </div>

            {/* Settings row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Speaking pace (WPM)</label>
                <input type="number" value={wpm} onChange={e => setWpm(Number(e.target.value))} min={80} max={250}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Deadline (optional)</label>
                <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
              </div>
            </div>

            {/* Director notes */}
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Director's notes (optional)</label>
              <textarea value={directorNotes} onChange={e => setDirectorNotes(e.target.value)} rows={2} placeholder="General direction for the narrator — tone, energy, style..."
                className="w-full px-3 py-2 rounded-lg text-sm resize-none"
                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </div>

            {/* Sections preview */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Sections ({sections.length}) — ~{Math.round(totalDuration / 60)}:{(totalDuration % 60).toString().padStart(2, '0')} total
                </label>
                <button onClick={splitSections} disabled={splitting} className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.1)', color: '#7c3aed' }}>
                  {splitting ? 'Splitting...' : 'Re-split'}
                </button>
              </div>
              <div className="max-h-48 overflow-y-auto space-y-1.5 rounded-lg p-2" style={{ background: 'var(--bg-primary)' }}>
                {sections.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ background: 'var(--bg-secondary)' }}>
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0" style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>{i + 1}</span>
                    <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{s.label || `Section ${i + 1}`}</span>
                    <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>~{s.estimated_duration_seconds}s</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm" style={{ color: 'var(--text-muted)' }}>Cancel</button>
              <button onClick={handleAssign} disabled={creating || !selectedNarratorId || sections.length === 0}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                {creating ? 'Assigning...' : 'Assign & Generate Link'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
