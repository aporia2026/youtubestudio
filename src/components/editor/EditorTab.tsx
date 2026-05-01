'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  role: string;
  color: string;
  personal_token?: string | null;
}

interface EditorAssignment {
  id: string;
  editor_id: string;
  status: string;
  editor_notes: string | null;
  deadline: string | null;
  review_project_id: string | null;
  editor_name: string;
  editor_email: string | null;
  editor_color: string;
  editor_personal_token: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

interface ImageAsset {
  id: string;
  name: string;
  url: string;
  size_bytes?: number | null;
  notes: string | null;
  created_at: string;
}

interface Props { projectId: string }

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  assigned:  { bg: 'rgba(234,179,8,0.15)', text: '#eab308' },
  editing:   { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  submitted: { bg: 'rgba(59,130,246,0.15)', text: '#3b82f6' },
  approved:  { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
  completed: { bg: 'rgba(34,197,94,0.15)', text: '#22c55e' },
};

function timeAgo(s: string | null) {
  if (!s) return 'never';
  const ms = Date.now() - new Date(s).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function EditorTab({ projectId }: Props) {
  const [editors, setEditors] = useState<Collaborator[]>([]);
  const [assignments, setAssignments] = useState<EditorAssignment[]>([]);
  const [imageRefs, setImageRefs] = useState<ImageAsset[]>([]);
  const [thumbnails, setThumbnails] = useState<ImageAsset[]>([]);
  const [loading, setLoading] = useState(true);

  // Assign UI state
  const [showAssign, setShowAssign] = useState(false);
  const [pickedEditorId, setPickedEditorId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [editorNotes, setEditorNotes] = useState('');
  const [deadline, setDeadline] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Upload state
  const [uploadingRef, setUploadingRef] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [projectId]);

  async function load() {
    setLoading(true);
    try {
      const [a, c, refs, thumbs] = await Promise.all([
        fetch(`/api/projects/${projectId}/editors`).then(r => r.ok ? r.json() : []),
        fetch(`/api/team/collaborators?role=editor`).then(r => r.ok ? r.json() : []),
        fetch(`/api/projects/${projectId}/image-refs`).then(r => r.ok ? r.json() : []),
        fetch(`/api/projects/${projectId}/thumbnails`).then(r => r.ok ? r.json() : []),
      ]);
      setAssignments(a);
      setEditors(c);
      setImageRefs(refs);
      setThumbnails(thumbs);
    } catch {} finally { setLoading(false); }
  }

  async function handleAssign() {
    setAssigning(true);
    try {
      let editorId = pickedEditorId;

      // Inline-create new editor if needed
      if (!editorId && newName.trim()) {
        const palette = ['#3b82f6', '#7c3aed', '#06b6d4', '#f59e0b', '#22c55e', '#ec4899'];
        const cRes = await fetch('/api/team/collaborators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), email: newEmail.trim() || undefined, role: 'editor', color: palette[editors.length % palette.length] }),
        });
        if (!cRes.ok) throw new Error('Failed to create editor');
        const c = await cRes.json();
        editorId = c.id;
        setEditors(prev => [...prev, c]);
      }
      if (!editorId) { toast.error('Pick an editor or enter a name'); setAssigning(false); return; }

      const res = await fetch(`/api/projects/${projectId}/editors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor_id: editorId,
          editor_notes: editorNotes.trim() || undefined,
          deadline: deadline || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed');
      }
      toast.success('Editor assigned');
      setShowAssign(false);
      setPickedEditorId('');
      setNewName('');
      setNewEmail('');
      setEditorNotes('');
      setDeadline('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally { setAssigning(false); }
  }

  async function handleRevoke(assignmentId: string, name: string) {
    if (!confirm(`Revoke ${name}'s access to this project?`)) return;
    await fetch(`/api/projects/${projectId}/editors/${assignmentId}`, { method: 'DELETE' });
    setAssignments(prev => prev.filter(a => a.id !== assignmentId));
    toast.success('Access revoked');
  }

  function copyDashboardLink(token: string | null) {
    if (!token) { toast.error('No personal token on this editor'); return; }
    navigator.clipboard.writeText(`${window.location.origin}/editor/${token}`);
    toast.success('Dashboard link copied');
  }

  // ── Upload flows ──────────────────────────────────────────────────────────
  async function uploadFile(kind: 'image-refs' | 'thumbnails', file: File) {
    if (!file.type.startsWith('image/')) { toast.error('Image files only'); return; }
    const setBusy = kind === 'image-refs' ? setUploadingRef : setUploadingThumb;
    setBusy(true);
    try {
      const reserveRes = await fetch(`/api/projects/${projectId}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl } = await reserveRes.json();
      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!putRes.ok) throw new Error(`R2 rejected upload (HTTP ${putRes.status}). Check bucket CORS.`);
      toast.success(kind === 'image-refs' ? 'Reference added' : 'Thumbnail added');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally { setBusy(false); }
  }

  async function deleteAsset(kind: 'image-refs' | 'thumbnails', assetId: string) {
    if (!confirm('Delete this image?')) return;
    await fetch(`/api/projects/${projectId}/${kind}/${assetId}`, { method: 'DELETE' });
    if (kind === 'image-refs') setImageRefs(prev => prev.filter(a => a.id !== assetId));
    else setThumbnails(prev => prev.filter(a => a.id !== assetId));
    toast.success('Deleted');
  }

  if (loading) {
    return <div className="py-10 text-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>;
  }

  // Filter out editors already assigned for the picker
  const assignedEditorIds = new Set(assignments.map(a => a.editor_id));
  const availableEditors = editors.filter(e => !assignedEditorIds.has(e.id));

  return (
    <div className="space-y-6">
      {/* Editors */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Editors</h3>
          <button
            onClick={() => setShowAssign(s => !s)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}
          >
            {showAssign ? 'Cancel' : '+ Assign Editor'}
          </button>
        </div>
        <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
          Editors get their own dashboard with the script, references, thumbnails, and an upload button.
        </p>

        {showAssign && (
          <div className="p-3 rounded-lg space-y-3 mb-4" style={{ background: 'var(--bg-primary)' }}>
            {availableEditors.length > 0 && (
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Existing editor</label>
                <select
                  value={pickedEditorId}
                  onChange={e => { setPickedEditorId(e.target.value); if (e.target.value) { setNewName(''); setNewEmail(''); } }}
                  className="w-full px-3 py-1.5 rounded-lg text-sm cursor-pointer"
                  style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  <option value="">— Select an editor —</option>
                  {availableEditors.map(e => <option key={e.id} value={e.id}>{e.name}{e.email ? ` · ${e.email}` : ''}</option>)}
                </select>
              </div>
            )}

            {!pickedEditorId && (
              <div className="space-y-2">
                {availableEditors.length > 0 && <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Or add a new editor</div>}
                <div className="grid grid-cols-2 gap-2">
                  <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <input placeholder="Email (optional)" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                    className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                </div>
              </div>
            )}

            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Notes for the editor (optional)</label>
              <textarea value={editorNotes} onChange={e => setEditorNotes(e.target.value)} rows={2}
                placeholder="Style direction, references to mimic, must-haves…"
                className="w-full px-3 py-1.5 rounded-lg text-sm resize-none"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </div>

            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Deadline (optional)</label>
              <input type="date" value={deadline} onChange={e => setDeadline(e.target.value)}
                className="px-3 py-1.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setShowAssign(false)} className="text-xs px-3 py-1.5 cursor-pointer" style={{ color: 'var(--text-muted)' }}>Cancel</button>
              <button onClick={handleAssign} disabled={assigning || (!pickedEditorId && !newName.trim())}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
                style={{ background: '#7c3aed' }}>
                {assigning ? 'Assigning...' : 'Assign & generate dashboard link'}
              </button>
            </div>
          </div>
        )}

        {assignments.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No editors assigned yet</p>
        ) : (
          <div className="space-y-2">
            {assignments.map(a => {
              const sc = STATUS_COLORS[a.status] || STATUS_COLORS.assigned;
              return (
                <div key={a.id} className="flex items-center gap-3 p-2.5 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ background: a.editor_color }}>
                    {(a.editor_name || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{a.editor_name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: sc.bg, color: sc.text }}>{a.status}</span>
                    </div>
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {a.editor_email && <span>{a.editor_email} · </span>}
                      {a.last_accessed_at ? `last viewed ${timeAgo(a.last_accessed_at)}` : 'never accessed'}
                    </p>
                  </div>
                  <a
                    href={`/messages?with=${a.editor_id}`}
                    className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-cyan-500/10 cursor-pointer flex items-center gap-1"
                    style={{ color: '#06b6d4', background: 'rgba(6,182,212,0.1)' }}
                    title={`Open chat with ${a.editor_name}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    Message
                  </a>
                  <button onClick={() => copyDashboardLink(a.editor_personal_token)} className="text-[10px] px-2 py-1 rounded transition-colors hover:bg-purple-500/10 cursor-pointer"
                    style={{ color: '#a78bfa', background: 'rgba(124,58,237,0.1)' }}>📋 Dashboard link</button>
                  <button onClick={() => handleRevoke(a.id, a.editor_name)} className="p-1.5 rounded hover:bg-red-500/10 cursor-pointer" title="Revoke access">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Image refs */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Image references</h3>
          <input
            ref={refInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile('image-refs', f); if (e.target) e.target.value = ''; }}
          />
          <button onClick={() => refInputRef.current?.click()} disabled={uploadingRef}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
            {uploadingRef ? 'Uploading…' : '+ Add reference'}
          </button>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Stored in your <code>images</code> bucket. Editors see these on their dashboard.
        </p>
        {imageRefs.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No image references yet</p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {imageRefs.map(img => (
              <div key={img.id} className="relative group rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                <img src={img.url} alt={img.name} className="w-full h-24 object-cover" />
                <button onClick={() => deleteAsset('image-refs', img.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Thumbnails */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Thumbnails</h3>
          <input
            ref={thumbInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile('thumbnails', f); if (e.target) e.target.value = ''; }}
          />
          <button onClick={() => thumbInputRef.current?.click()} disabled={uploadingThumb}
            className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer disabled:opacity-50"
            style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}>
            {uploadingThumb ? 'Uploading…' : '+ Add thumbnail'}
          </button>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Stored in your <code>images</code> bucket under <code>thumbnails/</code>.
        </p>
        {thumbnails.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No thumbnails yet</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {thumbnails.map(t => (
              <div key={t.id} className="relative group rounded-lg overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                <img src={t.url} alt={t.name} className="w-full aspect-video object-cover" />
                <button onClick={() => deleteAsset('thumbnails', t.id)} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
