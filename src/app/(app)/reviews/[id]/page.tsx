'use client';

import { useState, useEffect, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

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
  expires_at: string | null;
  created_at: string;
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
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [newPerm, setNewPerm] = useState('can-comment');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { loadData(); }, [id]);

  async function loadData() {
    try {
      const [projRes, linksRes] = await Promise.all([
        fetch(`/api/review/projects/${id}`),
        fetch(`/api/review/projects/${id}/share`),
      ]);
      if (projRes.ok) {
        const data = await projRes.json();
        setProject(data.project);
        setVersions(data.versions);
      }
      if (linksRes.ok) setShareLinks(await linksRes.json());
    } catch (err) {
      console.error(err);
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('video/')) {
      toast.error('Please select a video file');
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // 1. Get presigned URL
      const presignRes = await fetch(`/api/review/projects/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, versionId } = await presignRes.json();

      // 2. Upload directly to R2 with progress
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', (evt) => {
          if (evt.lengthComputable) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.status}`));
        });
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
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
      toast.error('Upload failed');
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

  async function handleCreateLink() {
    try {
      const res = await fetch(`/api/review/projects/${id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission: newPerm }),
      });
      if (res.ok) {
        const link = await res.json();
        setShareLinks(prev => [link, ...prev]);
        setShowShareDialog(false);
        toast.success('Share link created');
      }
    } catch {
      toast.error('Failed to create link');
    }
  }

  async function handleDeleteLink(linkId: string) {
    try {
      await fetch(`/api/review/projects/${id}/share`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId }),
      });
      setShareLinks(prev => prev.filter(l => l.id !== linkId));
      toast.success('Link deleted');
    } catch {
      toast.error('Failed to delete link');
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
              {uploading ? 'Uploading...' : '+ Upload Video'}
            </button>
          </div>

          {/* Upload progress */}
          <AnimatePresence>
            {uploading && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4"
              >
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: 'linear-gradient(90deg, #7c3aed, #06b6d4)', width: `${uploadProgress}%` }}
                    initial={{ width: 0 }}
                    animate={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>{uploadProgress}%</p>
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
                <div key={v.id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  {v.thumbnail_url ? (
                    <img src={v.thumbnail_url} alt="" className="w-20 h-12 object-cover rounded" />
                  ) : (
                    <div className="w-20 h-12 rounded flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>v{v.version_number}</p>
                    <div className="flex gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {v.duration_ms && <span>{formatDuration(v.duration_ms)}</span>}
                      {v.file_size && <span>{formatBytes(v.file_size)}</span>}
                      <span>{new Date(v.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Share links section */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Share Links</h2>
            <button
              onClick={() => setShowShareDialog(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium"
              style={{ background: 'rgba(124,58,237,0.15)', color: '#7c3aed' }}
            >
              + New Link
            </button>
          </div>

          {/* Create link dialog */}
          <AnimatePresence>
            {showShareDialog && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 overflow-hidden"
              >
                <div className="p-3 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>Permission Level</label>
                  <select
                    value={newPerm}
                    onChange={e => setNewPerm(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg text-sm mb-3"
                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  >
                    <option value="view-only">View Only</option>
                    <option value="can-comment">Can Comment</option>
                    <option value="can-annotate">Can Annotate (draw on frames)</option>
                  </select>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowShareDialog(false)} className="px-3 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>Cancel</button>
                    <button onClick={handleCreateLink} className="px-3 py-1 rounded-lg text-xs font-medium text-white" style={{ background: '#7c3aed' }}>Create</button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {shareLinks.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No share links yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {shareLinks.map(link => (
                <div key={link.id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full"
                        style={{
                          background: link.permission === 'can-annotate' ? 'rgba(124,58,237,0.15)' :
                                     link.permission === 'can-comment' ? 'rgba(6,182,212,0.15)' : 'rgba(255,255,255,0.05)',
                          color: link.permission === 'can-annotate' ? '#7c3aed' :
                                 link.permission === 'can-comment' ? '#06b6d4' : 'var(--text-muted)',
                        }}
                      >
                        {PERM_LABELS[link.permission]}
                      </span>
                    </div>
                    <p className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                      /review/{link.token.slice(0, 8)}...
                    </p>
                  </div>
                  <button onClick={() => copyLink(link.token)} className="p-1.5 rounded-lg transition-colors hover:bg-white/5" title="Copy link">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  <button onClick={() => handleDeleteLink(link.id)} className="p-1.5 rounded-lg transition-colors hover:bg-red-500/10" title="Delete link">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
