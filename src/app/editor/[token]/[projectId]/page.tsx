'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface ProjectData {
  editor: { id: string; name: string; color: string };
  project: { id: string; title: string; niche: string; topic: string | null; status: string };
  assignment: { id: string; status: string; editor_notes: string | null; deadline: string | null; review_project_id: string | null };
  script: { id: string; version: number; content: string; word_count: number; estimated_duration_seconds: number | null } | null;
  imageRefs: Array<{ id: string; name: string; url: string; notes: string | null }>;
  thumbnails: Array<{ id: string; name: string; url: string; notes: string | null }>;
  voiceovers: Array<{ id: string; name: string; url: string; duration_seconds: number | null }>;
  videos: Array<{ id: string; name: string; url: string }>;
  ytRefs: Array<{ id: string; youtube_url: string; title: string | null; channel: string | null; thumbnail_url: string | null; notes: string | null }>;
  reviewProjectId: string | null;
  reviewVersions: Array<{ id: string; version_number: number; thumbnail_url: string | null; duration_ms: number | null; created_at: string; comment_count: number }>;
}

function formatDuration(s: number | null): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function EditorProjectPage({ params }: { params: Promise<{ token: string; projectId: string }> }) {
  const { token, projectId } = use(params);
  const [data, setData] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadNote, setUploadNote] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/editor/${token}/projects/${projectId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || 'Failed to load');
        return;
      }
      setData(await res.json());
    } catch {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  }, [token, projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleUpload(file: File) {
    if (!file.type.startsWith('video/')) { alert('Please choose a video file'); return; }
    setUploading(true);
    setUploadProgress(0);

    try {
      // Probe video metadata
      let duration_ms: number | undefined;
      let width: number | undefined;
      let height: number | undefined;
      let thumbnail_url: string | undefined;
      try {
        const videoEl = document.createElement('video');
        videoEl.preload = 'metadata';
        videoEl.muted = true;
        const objectUrl = URL.createObjectURL(file);
        videoEl.src = objectUrl;
        await new Promise<void>(resolve => {
          videoEl.onloadedmetadata = () => { videoEl.currentTime = 1; };
          videoEl.onseeked = () => resolve();
          videoEl.onerror = () => resolve();
        });
        duration_ms = isFinite(videoEl.duration) ? Math.round(videoEl.duration * 1000) : undefined;
        width = videoEl.videoWidth || undefined;
        height = videoEl.videoHeight || undefined;
        // Capture a JPEG thumbnail
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(width || 640, 640);
          canvas.height = Math.round(canvas.width * ((height || 360) / (width || 640)));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.8));
            if (blob) {
              const fd = new FormData();
              fd.append('file', blob, 'thumbnail.jpg');
              fd.append('type', 'image');
              const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
              if (upRes.ok) thumbnail_url = (await upRes.json()).url;
            }
          }
        } catch {}
        URL.revokeObjectURL(objectUrl);
      } catch {}

      // 1. Reserve the version + get presigned URL
      const reserveRes = await fetch(`/api/editor/${token}/projects/${projectId}/upload-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size, note: uploadNote || undefined }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl, versionId } = await reserveRes.json();

      // 2. PUT to R2
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', evt => { if (evt.lengthComputable) setUploadProgress(Math.round((evt.loaded / evt.total) * 100)); });
        xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 rejected upload (HTTP ${xhr.status}). Check bucket CORS.`)));
        xhr.addEventListener('error', () => reject(new Error('Network error uploading to R2 — check bucket CORS')));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });

      // 3. PATCH metadata
      await fetch(`/api/editor/${token}/projects/${projectId}/upload-video`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId, thumbnail_url, duration_ms, width, height }),
      }).catch(() => {});

      setUploadNote('');
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      alert(`Upload failed: ${msg}`);
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} /></div>;
  if (error || !data) return <div className="flex items-center justify-center min-h-screen text-center"><div><h1 className="text-xl font-bold mb-2">{error || 'Not found'}</h1><Link href={`/editor/${token}`} className="text-sm" style={{ color: '#a78bfa' }}>← Back to dashboard</Link></div></div>;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <header className="mb-6">
        <Link href={`/editor/${token}`} className="text-xs mb-2 inline-flex items-center gap-1 transition-colors hover:text-purple-400" style={{ color: 'var(--text-muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          All projects
        </Link>
        <h1 className="text-2xl font-bold mt-2" style={{ color: 'var(--text-primary)' }}>{data.project.title}</h1>
        {data.project.topic && <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{data.project.topic}</p>}
      </header>

      {data.assignment.editor_notes && (
        <div className="mb-6 p-4 rounded-xl" style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.2)' }}>
          <p className="text-xs font-medium mb-1" style={{ color: '#06b6d4' }}>Editor notes from the owner</p>
          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{data.assignment.editor_notes}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Script */}
        <Section title="Script" subtitle={data.script ? `v${data.script.version} · ${data.script.word_count} words${data.script.estimated_duration_seconds ? ' · ~' + formatDuration(data.script.estimated_duration_seconds) : ''}` : 'No script yet'}>
          {data.script ? (
            <div className="rounded-lg p-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed" style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>
              {data.script.content}
            </div>
          ) : (
            <p className="text-xs text-center py-8" style={{ color: 'var(--text-muted)' }}>The owner hasn&apos;t added a script yet</p>
          )}
        </Section>

        {/* Voiceover */}
        <Section title="Voiceover" subtitle={data.voiceovers.length > 0 ? `${data.voiceovers.length} file${data.voiceovers.length === 1 ? '' : 's'}` : 'None'}>
          {data.voiceovers.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No voiceover uploaded yet</p>
          ) : (
            <div className="space-y-2">
              {data.voiceovers.map(v => (
                <div key={v.id} className="p-2 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
                  <p className="text-xs mb-1 truncate" style={{ color: 'var(--text-primary)' }}>{v.name}</p>
                  <audio src={v.url} controls className="w-full" style={{ height: 32 }} />
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Image references */}
        <Section title="Image references" subtitle={`${data.imageRefs.length} image${data.imageRefs.length === 1 ? '' : 's'}`}>
          {data.imageRefs.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No image references</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {data.imageRefs.map(img => (
                <a key={img.id} href={img.url} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden hover:opacity-80 transition-opacity" title={img.notes || img.name}>
                  <img src={img.url} alt={img.name} className="w-full h-20 object-cover" />
                </a>
              ))}
            </div>
          )}
        </Section>

        {/* Thumbnails */}
        <Section title="Thumbnails" subtitle={`${data.thumbnails.length} thumbnail${data.thumbnails.length === 1 ? '' : 's'}`}>
          {data.thumbnails.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>No thumbnails uploaded</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {data.thumbnails.map(t => (
                <a key={t.id} href={t.url} target="_blank" rel="noreferrer" className="block rounded-lg overflow-hidden hover:opacity-80 transition-opacity" title={t.notes || t.name}>
                  <img src={t.url} alt={t.name} className="w-full aspect-video object-cover" />
                </a>
              ))}
            </div>
          )}
        </Section>

        {/* YouTube references */}
        {data.ytRefs.length > 0 && (
          <Section title="Reference videos" subtitle={`${data.ytRefs.length} link${data.ytRefs.length === 1 ? '' : 's'}`}>
            <div className="space-y-2">
              {data.ytRefs.map(yt => (
                <a key={yt.id} href={yt.youtube_url} target="_blank" rel="noreferrer" className="flex gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors" style={{ background: 'var(--bg-primary)' }}>
                  {yt.thumbnail_url && <img src={yt.thumbnail_url} alt="" className="w-20 h-12 object-cover rounded shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{yt.title || yt.youtube_url}</p>
                    {yt.channel && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{yt.channel}</p>}
                    {yt.notes && <p className="text-[11px] mt-1" style={{ color: '#06b6d4' }}>{yt.notes}</p>}
                  </div>
                </a>
              ))}
            </div>
          </Section>
        )}

        {/* Uploaded video versions */}
        {data.reviewVersions.length > 0 && (
          <Section title="Uploaded for review" subtitle={`${data.reviewVersions.length} version${data.reviewVersions.length === 1 ? '' : 's'}`}>
            <div className="space-y-2">
              {data.reviewVersions.map(v => (
                <div key={v.id} className="p-2 rounded-lg flex items-center gap-3" style={{ background: 'var(--bg-primary)' }}>
                  {v.thumbnail_url ? (
                    <img src={v.thumbnail_url} alt="" className="w-16 h-9 object-cover rounded" />
                  ) : (
                    <div className="w-16 h-9 rounded flex items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>v{v.version_number}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{new Date(v.created_at).toLocaleDateString()}</p>
                  </div>
                  {v.comment_count > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
                      💬 {v.comment_count} unresolved
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Upload finished video */}
      <div className="mt-6 rounded-xl p-5" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
        <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>📤 Upload finished video for review</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
          The owner will review your video and leave timestamped comments. Upload a new version anytime to incorporate feedback.
        </p>

        <textarea
          value={uploadNote}
          onChange={e => setUploadNote(e.target.value)}
          placeholder="Optional note (e.g. 'Cut down the intro by 10s, swapped Track B-roll')"
          className="w-full px-3 py-2 rounded-lg text-sm mb-3 resize-none"
          rows={2}
          disabled={uploading}
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />

        {uploading ? (
          <div>
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
              <div className="h-full transition-all" style={{ width: `${uploadProgress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
            </div>
            <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>Uploading… {uploadProgress}%</p>
          </div>
        ) : (
          <label className="flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors hover:border-purple-500/50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
            <input type="file" accept="video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            <span className="text-sm">Click to choose a video</span>
          </label>
        )}
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        {subtitle && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}
