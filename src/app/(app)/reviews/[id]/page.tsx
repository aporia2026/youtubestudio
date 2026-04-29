'use client';

import { useState, useEffect, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { compressVideo, isCompressionSupported } from '@/lib/compress-video';

interface Version {
  id: string;
  version_number: number;
  r2_key: string;
  video_url: string | null;
  thumbnail_url: string | null;
  duration_ms: number | null;
  uploaded_by: string;
  file_size: number | null;
  created_at: string;
}

interface ShareLink {
  id: string;
  token: string;
  permission: string;
  label: string | null;
  collaborator_id: string | null;
  collaborator_name: string | null;
  collaborator_role: string | null;
  collaborator_color: string | null;
  last_accessed_at: string | null;
  access_count: number;
  expires_at: string | null;
  created_at: string;
}

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  role: string;
  color: string;
}

interface Project {
  id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
}

const STATUS_OPTIONS = [
  { value: 'in-review', label: 'In Review', color: '#06b6d4' },
  { value: 'needs-changes', label: 'Needs Changes', color: '#eab308' },
  { value: 'approved', label: 'Approved', color: '#22c55e' },
];

const PERM_LABELS: Record<string, string> = {
  'view-only': 'View Only',
  'can-comment': 'Can Comment',
  'can-annotate': 'Can Annotate',
};

export default function ReviewProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  // Compression state — distinct from upload progress so the UI can show
  // a two-phase progress bar (compress → upload).
  const [compressing, setCompressing] = useState(false);
  const [compressProgress, setCompressProgress] = useState(0);
  const [compressionStats, setCompressionStats] = useState<{ originalMB: number; compressedMB: number; savedPct: number } | null>(null);
  // Persisted preference — once a user opts out we don't pester them again
  // for the rest of the session.
  const [skipCompression, setSkipCompression] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage?.getItem('skipVideoCompression') === '1';
  });
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [pickedCollaboratorId, setPickedCollaboratorId] = useState('');
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('reviewer');
  const [newPerm, setNewPerm] = useState('can-comment');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadData(); }, [id]);

  async function loadData() {
    try {
      const [projRes, linksRes, collabRes] = await Promise.all([
        fetch(`/api/review/projects/${id}`),
        fetch(`/api/review/projects/${id}/share`),
        fetch(`/api/team/collaborators`),
      ]);
      if (projRes.ok) {
        const data = await projRes.json();
        setProject(data.project);
        setVersions(data.versions);
      }
      if (linksRes.ok) setShareLinks(await linksRes.json());
      if (collabRes.ok) setCollaborators(await collabRes.json());
    } catch (err) {
      console.error(err);
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const original = e.target.files?.[0];
    if (!original) return;

    if (!original.type.startsWith('video/')) {
      toast.error('Please select a video file');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setCompressionStats(null);

    let file: File = original;

    // 0. Compress in the browser before uploading. Cuts file size roughly
    // in half on most footage and produces a faststart MP4 (moov atom at
    // the front), which fixes the mid-playback stalls on R2. We skip if
    // the browser doesn't have hardware H.264, the user opted out, or the
    // file is already tiny — and silently fall back to the original on
    // any compression error so a broken codec path can never block upload.
    if (!skipCompression && original.size >= 5 * 1024 * 1024) {
      try {
        const supported = await isCompressionSupported();
        if (supported) {
          setCompressing(true);
          setCompressProgress(0);
          const result = await compressVideo(original, p => setCompressProgress(p.fraction));
          // Only keep the compressed version if it actually saved bytes —
          // some sources (e.g. already-tightly-encoded screen recordings)
          // can grow on a re-encode.
          if (result.compressedSize < result.originalSize) {
            file = result.file;
            const originalMB = result.originalSize / (1024 * 1024);
            const compressedMB = result.compressedSize / (1024 * 1024);
            const savedPct = Math.round((1 - result.compressedSize / result.originalSize) * 100);
            setCompressionStats({ originalMB, compressedMB, savedPct });
            toast.success(`Compressed ${originalMB.toFixed(1)} MB → ${compressedMB.toFixed(1)} MB (saved ${savedPct}%)`);
          }
        }
      } catch (err) {
        console.warn('Compression failed, uploading original:', err);
      } finally {
        setCompressing(false);
      }
    }

    try {
      // 1. Get presigned URL
      const presignRes = await fetch(`/api/review/projects/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const errBody = await presignRes.json().catch(() => ({}));
        throw new Error(errBody.error || `Server returned ${presignRes.status}`);
      }
      const { uploadUrl, versionId } = await presignRes.json();

      // 2. Upload directly to R2 with progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (evt) => {
          if (evt.lengthComputable) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`R2 rejected upload (HTTP ${xhr.status}). Check bucket CORS and credentials.`));
        });
        xhr.addEventListener('error', () => reject(new Error('Network error uploading to R2 — check bucket CORS configuration')));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });

      // 3. Extract thumbnail and duration from video
      try {
        const videoEl = document.createElement('video');
        videoEl.preload = 'metadata';
        videoEl.muted = true;
        const objectUrl = URL.createObjectURL(file);
        videoEl.src = objectUrl;

        await new Promise<void>((resolve) => {
          videoEl.onloadedmetadata = () => {
            videoEl.currentTime = 1; // seek to 1s for thumbnail
          };
          videoEl.onseeked = () => resolve();
          videoEl.onerror = () => resolve(); // don't block on thumbnail failure
        });

        const duration_ms = Math.round(videoEl.duration * 1000);
        const width = videoEl.videoWidth;
        const height = videoEl.videoHeight;

        // Extract thumbnail frame
        let thumbnail_url: string | undefined;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(width, 640);
          canvas.height = Math.round(canvas.width * (height / width));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.8));
            if (blob) {
              const formData = new FormData();
              formData.append('file', blob, 'thumbnail.jpg');
              formData.append('type', 'image');
              const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
              if (uploadRes.ok) {
                const data = await uploadRes.json();
                thumbnail_url = data.url;
              }
            }
          }
        } catch {}

        URL.revokeObjectURL(objectUrl);

        // 4. Update version with metadata
        await fetch(`/api/review/projects/${id}/versions`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ versionId, thumbnail_url, duration_ms, width, height }),
        });
      } catch {}

      toast.success('Video uploaded successfully');
      loadData();
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error(msg, { duration: 8000 });
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleStatusChange(status: string) {
    try {
      const res = await fetch(`/api/review/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        setProject(prev => prev ? { ...prev, status } : prev);
        toast.success('Status updated');
      }
    } catch {
      toast.error('Failed to update status');
    }
  }

  async function handleAddPerson() {
    setAdding(true);
    try {
      let collaboratorId = pickedCollaboratorId;
      let collaboratorName = '';

      // Path A: Picked an existing collaborator
      if (pickedCollaboratorId) {
        const c = collaborators.find(c => c.id === pickedCollaboratorId);
        collaboratorName = c?.name || 'Person';
      }
      // Path B: New collaborator inline
      else if (newName.trim()) {
        const palette = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];
        const cRes = await fetch('/api/team/collaborators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newName.trim(),
            email: newEmail.trim() || undefined,
            role: newRole,
            color: palette[collaborators.length % palette.length],
          }),
        });
        if (!cRes.ok) {
          const err = await cRes.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to create collaborator');
        }
        const c = await cRes.json();
        collaboratorId = c.id;
        collaboratorName = c.name;
        setCollaborators(prev => [...prev, c]);
      } else {
        toast.error('Pick a person or enter a name');
        return;
      }

      // Create the share link tied to this collaborator
      const linkRes = await fetch(`/api/review/projects/${id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permission: newPerm,
          collaboratorId,
          label: `For ${collaboratorName}`,
        }),
      });
      if (!linkRes.ok) {
        const err = await linkRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to create link');
      }
      // Reload to get joined collaborator info
      const refresh = await fetch(`/api/review/projects/${id}/share`);
      if (refresh.ok) setShareLinks(await refresh.json());

      // Auto-copy the link
      const link = await linkRes.json();
      navigator.clipboard.writeText(`${window.location.origin}/review/${link.token}`).catch(() => {});
      toast.success(`${collaboratorName} added — link copied`);

      // Reset form
      setShowAddPerson(false);
      setPickedCollaboratorId('');
      setNewName('');
      setNewEmail('');
      setNewRole('reviewer');
      setNewPerm('can-comment');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add person');
    } finally {
      setAdding(false);
    }
  }

  async function handleRevokeAccess(linkId: string, name: string) {
    if (!confirm(`Revoke ${name}'s access? Their link will stop working immediately.`)) return;
    try {
      await fetch(`/api/review/projects/${id}/share`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      setShareLinks(prev => prev.filter(l => l.id !== linkId));
      toast.success('Access revoked');
    } catch {
      toast.error('Failed to revoke');
    }
  }

  async function handleDeleteVersion(versionId: string, versionNumber: number) {
    if (!confirm(`Delete v${versionNumber}? The video will be removed permanently from R2 storage and all comments on this version will be deleted. This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/review/projects/${id}/versions/${versionId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${res.status}`);
      }
      setVersions(prev => prev.filter(v => v.id !== versionId));
      toast.success(`v${versionNumber} deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete version');
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this review project and all its versions?')) return;
    setDeleting(true);
    try {
      await fetch(`/api/review/projects/${id}`, { method: 'DELETE' });
      toast.success('Project deleted');
      router.push('/reviews');
    } catch {
      toast.error('Failed to delete');
      setDeleting(false);
    }
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}/review/${token}`;
    navigator.clipboard.writeText(url);
    toast.success('Link copied to clipboard');
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDuration(ms: number) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function timeAgo(dateStr: string) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-20 text-center">
        <p style={{ color: 'var(--text-muted)' }}>Project not found</p>
      </div>
    );
  }

  const currentStatus = STATUS_OPTIONS.find(s => s.value === project.status) || STATUS_OPTIONS[0];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <button
            onClick={() => router.push('/reviews')}
            className="text-xs mb-2 flex items-center gap-1 transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            Back to Reviews
          </button>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{project.title}</h1>
          {project.description && (
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{project.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Status selector */}
          <select
            value={project.status}
            onChange={e => handleStatusChange(e.target.value)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border-none outline-none cursor-pointer"
            style={{ background: `${currentStatus.color}22`, color: currentStatus.color }}
          >
            {STATUS_OPTIONS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-2 rounded-lg transition-colors hover:bg-red-500/10"
            style={{ color: 'var(--text-muted)' }}
            title="Delete project"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Versions section */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Versions</h2>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
              style={{ background: '#7c3aed' }}
            >
              {compressing ? 'Compressing…' : uploading ? 'Uploading…' : '+ Upload Video'}
            </button>
          </div>

          {/* Compression toggle — once a user opts out we remember it for the
              session via localStorage so they don't have to keep dismissing
              the bar on every upload. */}
          {!uploading && (
            <label className="flex items-center gap-2 mb-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <input
                type="checkbox"
                checked={!skipCompression}
                onChange={e => {
                  const enabled = e.target.checked;
                  setSkipCompression(!enabled);
                  if (typeof window !== 'undefined') {
                    if (enabled) window.localStorage.removeItem('skipVideoCompression');
                    else window.localStorage.setItem('skipVideoCompression', '1');
                  }
                }}
              />
              <span>Auto-compress before upload (faster, smaller — runs in your browser)</span>
            </label>
          )}

          {/* Upload progress — two-phase bar (compress → upload) so the user
              can see which stage they're in. Compression is the slower step
              for large files; the upload step is bandwidth-bound. */}
          <AnimatePresence>
            {uploading && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 space-y-2"
              >
                {compressing && (
                  <div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: 'linear-gradient(90deg, #f59e0b, #ef4444)', width: `${Math.round(compressProgress * 100)}%` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.round(compressProgress * 100)}%` }}
                      />
                    </div>
                    <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                      Compressing in your browser… {Math.round(compressProgress * 100)}%
                    </p>
                  </div>
                )}
                {!compressing && (
                  <div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: 'linear-gradient(90deg, #7c3aed, #06b6d4)', width: `${uploadProgress}%` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                    <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                      Uploading… {uploadProgress}%
                      {compressionStats && (
                        <span className="ml-2" style={{ color: '#22c55e' }}>
                          (saved {compressionStats.savedPct}% via browser compression)
                        </span>
                      )}
                    </p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {versions.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No versions uploaded yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {versions.map(v => (
                <div
                  key={v.id}
                  className="group flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors hover:bg-white/5"
                  style={{ background: 'var(--bg-primary)' }}
                  onClick={() => router.push(`/reviews/${id}/play?v=${v.id}`)}
                >
                  <div className="relative shrink-0">
                    {v.thumbnail_url ? (
                      <img src={v.thumbnail_url} alt="" className="w-20 h-12 object-cover rounded" />
                    ) : (
                      <div className="w-20 h-12 rounded flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      </div>
                    )}
                    {/* Play overlay on hover */}
                    <div className="absolute inset-0 flex items-center justify-center rounded transition-opacity opacity-0 group-hover:opacity-100" style={{ background: 'rgba(0,0,0,0.5)' }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>v{v.version_number}</p>
                    <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {v.duration_ms && <span>{formatDuration(v.duration_ms)}</span>}
                      {v.file_size && <span>{formatBytes(v.file_size)}</span>}
                      <span>{new Date(v.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteVersion(v.id, v.version_number); }}
                    className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10 cursor-pointer opacity-0 group-hover:opacity-100"
                    title="Delete this version"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#ef4444' }}>
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* People with access section */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>People with access</h2>
            <button
              onClick={() => setShowAddPerson(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:opacity-90"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}
            >
              + Add Person
            </button>
          </div>
          <p className="text-[11px] mb-4" style={{ color: 'var(--text-muted)' }}>
            Each person gets their own link. Revoking removes their access only — others keep working.
          </p>

          {/* Add person dialog */}
          <AnimatePresence>
            {showAddPerson && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 overflow-hidden"
              >
                <div className="p-3 rounded-lg space-y-3" style={{ background: 'var(--bg-primary)' }}>
                  {/* Pick existing collaborator */}
                  {collaborators.length > 0 && (
                    <div>
                      <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>Existing person</label>
                      <select
                        value={pickedCollaboratorId}
                        onChange={e => { setPickedCollaboratorId(e.target.value); if (e.target.value) { setNewName(''); setNewEmail(''); } }}
                        className="w-full px-3 py-1.5 rounded-lg text-sm cursor-pointer"
                        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      >
                        <option value="">— Select someone —</option>
                        {collaborators
                          .filter(c => !shareLinks.some(l => l.collaborator_id === c.id))
                          .map(c => <option key={c.id} value={c.id}>{c.name} {c.email ? `· ${c.email}` : ''} · {c.role}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Or create new */}
                  {!pickedCollaboratorId && (
                    <div className="space-y-2">
                      {collaborators.length > 0 && (
                        <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Or add someone new</div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          placeholder="Name"
                          value={newName}
                          onChange={e => setNewName(e.target.value)}
                          className="px-3 py-1.5 rounded-lg text-sm"
                          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                        />
                        <input
                          placeholder="Email (optional)"
                          value={newEmail}
                          onChange={e => setNewEmail(e.target.value)}
                          className="px-3 py-1.5 rounded-lg text-sm"
                          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                        />
                      </div>
                      <select
                        value={newRole}
                        onChange={e => setNewRole(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg text-sm cursor-pointer"
                        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      >
                        <option value="editor">Editor</option>
                        <option value="reviewer">Reviewer</option>
                        <option value="client">Client</option>
                        <option value="narrator">Narrator</option>
                      </select>
                    </div>
                  )}

                  {/* Permission */}
                  <div>
                    <label className="text-xs block mb-1" style={{ color: 'var(--text-muted)' }}>What can they do?</label>
                    <select
                      value={newPerm}
                      onChange={e => setNewPerm(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg text-sm cursor-pointer"
                      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <option value="view-only">View only</option>
                      <option value="can-comment">Can comment</option>
                      <option value="can-annotate">Can comment + draw on frames</option>
                    </select>
                  </div>

                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => { setShowAddPerson(false); setPickedCollaboratorId(''); setNewName(''); setNewEmail(''); }}
                      className="px-3 py-1.5 text-xs cursor-pointer transition-colors hover:text-white"
                      style={{ color: 'var(--text-muted)' }}
                    >Cancel</button>
                    <button
                      onClick={handleAddPerson}
                      disabled={adding || (!pickedCollaboratorId && !newName.trim())}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 cursor-pointer transition-opacity hover:opacity-90"
                      style={{ background: '#7c3aed' }}
                    >
                      {adding ? 'Adding...' : 'Add & generate link'}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {shareLinks.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No one has access yet — add someone above</p>
            </div>
          ) : (
            <div className="space-y-2">
              {shareLinks.map(link => {
                const lastSeen = link.access_count > 0 && link.last_accessed_at
                  ? `Last viewed ${timeAgo(link.last_accessed_at)} · ${link.access_count} view${link.access_count !== 1 ? 's' : ''}`
                  : 'Never accessed';
                const personName = link.collaborator_name || 'Anonymous link';
                const initial = ((link.collaborator_name || '?')[0] || '?').toUpperCase();
                const color = link.collaborator_color || '#64748b';
                return (
                  <div key={link.id} className="flex items-center gap-3 p-2.5 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0" style={{ background: color }}>
                      {initial}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{personName}</span>
                        {link.collaborator_role && (
                          <span className="text-[10px] capitalize" style={{ color: 'var(--text-muted)' }}>{link.collaborator_role}</span>
                        )}
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full ml-auto shrink-0"
                          style={{
                            background: link.permission === 'can-annotate' ? 'rgba(124,58,237,0.15)' :
                                       link.permission === 'can-comment' ? 'rgba(6,182,212,0.15)' : 'rgba(255,255,255,0.05)',
                            color: link.permission === 'can-annotate' ? '#a78bfa' :
                                   link.permission === 'can-comment' ? '#06b6d4' : 'var(--text-muted)',
                          }}>
                          {PERM_LABELS[link.permission]}
                        </span>
                      </div>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{lastSeen}</p>
                    </div>
                    <button
                      onClick={() => copyLink(link.token)}
                      className="p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-white/10"
                      title={`Copy ${personName}'s link`}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleRevokeAccess(link.id, personName)}
                      className="p-1.5 rounded-lg cursor-pointer transition-colors hover:bg-red-500/10"
                      title="Revoke access"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
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
