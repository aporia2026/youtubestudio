'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { compressVideo, isCompressionSupported } from '@/lib/compress-video';
import { HeroAction } from '@/components/dashboard/HeroAction';

interface ProjectData {
  editor: { id: string; name: string; color: string };
  project: { id: string; title: string; niche: string; topic: string | null; status: string };
  assignment: { id: string; status: string; editor_notes: string | null; deadline: string | null; review_project_id: string | null };
  script: { id: string; version: number; content: string; word_count: number; estimated_duration_seconds: number | null } | null;
  imageRefs: Array<{ id: string; name: string; url: string; notes: string | null }>;
  thumbnails: Array<{ id: string; name: string; url: string; notes: string | null }>;
  voiceovers: Array<{ id: string; name: string; url: string; duration_seconds: number | null }>;
  videos: Array<{ id: string; name: string; url: string }>;
  productionDocs: Array<{
    id: string;
    name: string;
    url: string;
    source: string | null;
    size_bytes: number | null;
    metadata: Record<string, unknown> | null;
  }>;
  ytRefs: Array<{ id: string; youtube_url: string; title: string | null; channel: string | null; thumbnail_url: string | null; notes: string | null }>;
  reviewProjectId: string | null;
  reviewVersions: Array<{ id: string; version_number: number; thumbnail_url: string | null; duration_ms: number | null; created_at: string; comment_count: number }>;
  /** Auto-created share-link token for this editor's collaborator id, so the
   *  editor can open the full review UI (player + comments + resolve). */
  reviewShareToken: string | null;
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
  const [compressing, setCompressing] = useState(false);
  const [compressProgress, setCompressProgress] = useState(0);
  const [compressionSavedPct, setCompressionSavedPct] = useState<number | null>(null);
  const [skipCompression, setSkipCompression] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage?.getItem('skipVideoCompression') === '1';
  });
  const [uploadNote, setUploadNote] = useState('');

  // Fix-notes modal state — opens after a successful upload when there are
  // unresolved comments on the previous version. The editor writes a short
  // "what I fixed" message per comment; submitting them creates fix-note
  // comments on the new version and (optionally) marks the originals
  // resolved. Owner sees the fix notes on the new version's timeline.
  type PrevComment = { id: string; timestamp_ms: number; end_timestamp_ms: number | null; text: string; author_name: string; author_color: string; drawing_thumbnail_url: string | null };
  const [fixNotesVersionId, setFixNotesVersionId] = useState<string | null>(null);
  const [fixNotesPrevious, setFixNotesPrevious] = useState<{ versionNumber: number; comments: PrevComment[] } | null>(null);
  const [fixNotesDrafts, setFixNotesDrafts] = useState<Record<string, { text: string; resolveOriginal: boolean }>>({});
  const [fixNotesSaving, setFixNotesSaving] = useState(false);

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

  async function handleUpload(originalFile: File) {
    if (!originalFile.type.startsWith('video/')) { alert('Please choose a video file'); return; }
    setUploading(true);
    setUploadProgress(0);
    setCompressionSavedPct(null);

    let file: File = originalFile;

    // Browser-side compression — same flow as the owner-side review upload.
    // Cuts file size, fixes faststart, falls back to original on any failure.
    if (!skipCompression && originalFile.size >= 5 * 1024 * 1024) {
      try {
        const supported = await isCompressionSupported();
        if (supported) {
          setCompressing(true);
          setCompressProgress(0);
          const result = await compressVideo(originalFile, p => setCompressProgress(p.fraction));
          if (result.compressedSize < result.originalSize) {
            file = result.file;
            setCompressionSavedPct(Math.round((1 - result.compressedSize / result.originalSize) * 100));
          }
        }
      } catch (err) {
        console.warn('Compression failed, uploading original:', err);
      } finally {
        setCompressing(false);
      }
    }

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

      // After the upload + thumbnail PATCH land, fetch unresolved comments
      // from the previous version. If any exist, open the fix-notes modal
      // so the editor can describe what they changed for each.
      try {
        const r = await fetch(`/api/editor/${token}/projects/${projectId}/previous-comments?versionId=${versionId}`);
        if (r.ok) {
          const body = await r.json();
          if (body.previousVersion && Array.isArray(body.comments) && body.comments.length > 0) {
            setFixNotesVersionId(versionId);
            setFixNotesPrevious({ versionNumber: body.previousVersion.version_number, comments: body.comments });
            const initial: Record<string, { text: string; resolveOriginal: boolean }> = {};
            for (const c of body.comments) initial[c.id] = { text: '', resolveOriginal: true };
            setFixNotesDrafts(initial);
          }
        }
      } catch {}
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

  // Status pill mapping for the editor's view of their assignment
  const STATUS_LABELS: Record<string, { label: string; color: string }> = {
    assigned:  { label: 'New',         color: '#eab308' },
    editing:   { label: 'Editing',     color: '#a78bfa' },
    submitted: { label: 'In review',   color: '#3b82f6' },
    approved:  { label: 'Approved',    color: '#22c55e' },
    completed: { label: 'Completed',   color: '#22c55e' },
  };
  const aStatus = STATUS_LABELS[data.assignment.status] || STATUS_LABELS.assigned;
  const dl = (() => {
    if (!data.assignment.deadline) return null;
    const d = new Date(data.assignment.deadline);
    const ms = d.getTime() - Date.now();
    const days = Math.round(ms / (1000 * 60 * 60 * 24));
    if (ms < 0) return { text: `Overdue · ${d.toLocaleDateString()}`, urgent: true };
    if (days <= 1) return { text: days === 0 ? 'Due today' : 'Due tomorrow', urgent: true };
    if (days <= 3) return { text: `Due in ${days} days`, soon: true };
    return { text: `Due ${d.toLocaleDateString()}` };
  })();
  const unresolvedComments = data.reviewVersions.reduce((sum, v) => sum + v.comment_count, 0);

  function scrollToUpload() {
    document.getElementById('editor-upload-zone')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <header className="mb-5">
        <Link href={`/editor/${token}`} className="text-xs mb-2 inline-flex items-center gap-1 transition-colors hover:text-purple-400" style={{ color: 'var(--text-muted)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
          All projects
        </Link>
        <h1 className="text-3xl font-bold mt-2" style={{ color: 'var(--text-primary)' }}>{data.project.title}</h1>
        <div className="flex items-center gap-3 flex-wrap mt-1.5">
          {data.project.topic && <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{data.project.topic}</span>}
          <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: `${aStatus.color}22`, color: aStatus.color }}>{aStatus.label}</span>
          {dl && (
            <span className="text-xs" style={{ color: dl.urgent ? '#ef4444' : dl.soon ? '#f97316' : 'var(--text-muted)', fontWeight: dl.urgent ? 600 : 400 }}>
              {dl.urgent ? '⏰ ' : '📅 '}{dl.text}
            </span>
          )}
        </div>
      </header>

      {/* Hero action bar — primary CTAs above the fold */}
      <div className="mb-5 flex items-center gap-2 flex-wrap">
        {data.reviewShareToken && data.reviewVersions.length > 0 && (
          <HeroAction
            tone="purple"
            primary
            href={`/review/${data.reviewShareToken}`}
            target="_blank"
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>}
            label="Open review"
            hint={unresolvedComments > 0 ? `${unresolvedComments} unresolved comment${unresolvedComments === 1 ? '' : 's'}` : 'Player + comments'}
          />
        )}
        <HeroAction
          tone={data.reviewVersions.length === 0 ? 'cyan' : 'green'}
          primary={data.reviewVersions.length === 0}
          onClick={scrollToUpload}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>}
          label={data.reviewVersions.length === 0 ? 'Upload first version' : 'Upload new version'}
          hint={data.reviewVersions.length === 0 ? 'Send to owner for review' : `Replaces v${data.reviewVersions[0]?.version_number || 1}`}
        />
        {unresolvedComments > 0 && (
          <span className="ml-auto text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
            💬 {unresolvedComments} unresolved comment{unresolvedComments === 1 ? '' : 's'} to address
          </span>
        )}
      </div>

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

        {/* Production Doc — shot-by-shot reference attached by the owner.
            Three flavours: uploaded file (PDF/DOCX/etc.), Google Sheet link,
            or a library link reusing another project's doc. We just render
            them as openable links — the editor downloads or views in a new
            tab. */}
        {data.productionDocs && data.productionDocs.length > 0 && (
          <Section title="Production Doc" subtitle={`${data.productionDocs.length} attached`}>
            <div className="space-y-2">
              {data.productionDocs.map(d => {
                const meta = (d.metadata || {}) as { source_kind?: string; linked_from_asset_id?: string };
                const isSheet = meta.source_kind === 'google_sheet';
                const isLinked = !!meta.linked_from_asset_id;
                return (
                  <a
                    key={d.id}
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:translate-y-[-1px] transition-transform"
                    style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                  >
                    <span className="text-base">{isSheet ? '📊' : '📄'}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{d.name}</p>
                      <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {isSheet ? 'Google Sheet' : (isLinked ? 'Linked from library' : (d.source === 'upload' ? 'Uploaded file' : 'External URL'))}
                        {d.size_bytes ? ` · ${(d.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                      </p>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full shrink-0" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
                      Open ↗
                    </span>
                  </a>
                );
              })}
            </div>
          </Section>
        )}

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
            {/* Prominent CTA — opens the full review UI in a new tab so the
                editor gets the pro player, comments panel, and resolve
                buttons. Without this they had no way to play the video at
                all from this dashboard. */}
            {data.reviewShareToken && (
              <a
                href={`/review/${data.reviewShareToken}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 p-3 mb-3 rounded-lg transition-transform hover:translate-y-[-1px]"
                style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.18), rgba(6,182,212,0.18))', border: '1px solid rgba(124,58,237,0.4)' }}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Watch + address comments</p>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Full player, see all timestamped feedback, and mark items as resolved when you've fixed them.
                  </p>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            )}
            <div className="space-y-2">
              {data.reviewVersions.map(v => {
                const Tile = data.reviewShareToken ? 'a' : 'div';
                const tileProps = data.reviewShareToken
                  ? { href: `/review/${data.reviewShareToken}`, target: '_blank' as const, rel: 'noreferrer' }
                  : {};
                return (
                  <Tile
                    key={v.id}
                    {...tileProps}
                    className="p-2 rounded-lg flex items-center gap-3 transition-colors hover:bg-white/5"
                    style={{ background: 'var(--bg-primary)' }}
                  >
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
                  </Tile>
                );
              })}
            </div>
          </Section>
        )}
      </div>

      {/* Upload finished video */}
      <div id="editor-upload-zone" className="mt-6 rounded-xl p-5 scroll-mt-6" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
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
            {compressing ? (
              <>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                  <div className="h-full transition-all" style={{ width: `${Math.round(compressProgress * 100)}%`, background: 'linear-gradient(90deg, #f59e0b, #ef4444)' }} />
                </div>
                <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                  Compressing in your browser… {Math.round(compressProgress * 100)}%
                </p>
              </>
            ) : (
              <>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
                  <div className="h-full transition-all" style={{ width: `${uploadProgress}%`, background: 'linear-gradient(90deg, #7c3aed, #06b6d4)' }} />
                </div>
                <p className="text-xs mt-1 text-center" style={{ color: 'var(--text-muted)' }}>
                  Uploading… {uploadProgress}%
                  {compressionSavedPct != null && (
                    <span className="ml-2" style={{ color: '#22c55e' }}>(saved {compressionSavedPct}% via browser compression)</span>
                  )}
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <label className="flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-colors hover:border-purple-500/50"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
              <input type="file" accept="video/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
              <span className="text-sm">Click to choose a video</span>
            </label>
            <label className="flex items-center gap-2 mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
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
          </>
        )}
      </div>

      {/* Fix-notes modal — shown after a successful upload of a corrected
          version. Lists each unresolved comment from the previous version
          so the editor can describe what they changed for that piece of
          feedback. Notes get posted as comments on the new version with a
          link back to the original. */}
      {fixNotesVersionId && fixNotesPrevious && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={() => { setFixNotesVersionId(null); setFixNotesPrevious(null); }}
        >
          <div
            className="rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="p-5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
              <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>What did you fix?</h3>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Write a short note next to each comment from v{fixNotesPrevious.versionNumber}. The owner will see your notes on the timeline of this new version, alongside their original feedback.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {fixNotesPrevious.comments.map(c => {
                const draft = fixNotesDrafts[c.id] ?? { text: '', resolveOriginal: true };
                const min = Math.floor(c.timestamp_ms / 60000);
                const sec = Math.floor((c.timestamp_ms % 60000) / 1000).toString().padStart(2, '0');
                const tsLabel = `${min}:${sec}`;
                return (
                  <div key={c.id} className="rounded-lg p-3" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
                    <div className="flex items-start gap-3">
                      {c.drawing_thumbnail_url && (
                        <img src={c.drawing_thumbnail_url} alt="" className="w-16 h-9 object-cover rounded shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>{tsLabel}</span>
                          <span className="text-xs font-medium" style={{ color: c.author_color }}>{c.author_name}</span>
                        </div>
                        <p className="text-xs mb-2" style={{ color: 'var(--text-secondary)' }}>{c.text}</p>
                        <textarea
                          value={draft.text}
                          onChange={e => setFixNotesDrafts(d => ({ ...d, [c.id]: { ...draft, text: e.target.value } }))}
                          placeholder="Describe what you changed for this one… (leave empty to skip)"
                          rows={2}
                          className="w-full px-2.5 py-1.5 rounded text-xs resize-y"
                          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                        />
                        <label className="flex items-center gap-2 mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <input
                            type="checkbox"
                            checked={draft.resolveOriginal}
                            onChange={e => setFixNotesDrafts(d => ({ ...d, [c.id]: { ...draft, resolveOriginal: e.target.checked } }))}
                          />
                          Mark this comment as resolved
                        </label>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="p-5 flex justify-between items-center shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
              <button
                onClick={() => { setFixNotesVersionId(null); setFixNotesPrevious(null); }}
                className="text-xs"
                style={{ color: 'var(--text-muted)' }}
              >
                Skip — I'll explain later
              </button>
              <button
                disabled={fixNotesSaving}
                onClick={async () => {
                  const notes = Object.entries(fixNotesDrafts)
                    .filter(([, d]) => d.text.trim().length > 0)
                    .map(([commentId, d]) => ({ commentId, text: d.text.trim(), resolveOriginal: d.resolveOriginal }));
                  if (notes.length === 0) {
                    setFixNotesVersionId(null);
                    setFixNotesPrevious(null);
                    return;
                  }
                  setFixNotesSaving(true);
                  try {
                    await fetch(`/api/editor/${token}/projects/${projectId}/fix-notes`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ versionId: fixNotesVersionId, notes }),
                    });
                  } catch {}
                  setFixNotesSaving(false);
                  setFixNotesVersionId(null);
                  setFixNotesPrevious(null);
                  await load();
                }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
              >
                {fixNotesSaving ? 'Saving…' : 'Submit fix notes'}
              </button>
            </div>
          </div>
        </div>
      )}
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
