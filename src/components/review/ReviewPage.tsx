'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { ReviewPlayer } from './ReviewPlayer';
import { ReviewTimeline, type PriorComment } from './ReviewTimeline';
import { CommentPanel } from './CommentPanel';
import { AuthorSetup } from './AuthorSetup';
import { VersionSelector } from './VersionSelector';
import { StatusBadge } from './StatusBadge';
import { ComparisonView } from './ComparisonView';
import { compressVideo, isCompressionSupported } from '@/lib/compress-video';
import { downloadCrossOriginFile } from '@/lib/download-file';

export interface ReviewVersion {
  id: string;
  version_number: number;
  video_url: string | null;
  thumbnail_url: string | null;
  duration_ms: number | null;
  file_size: number | null;
  created_at: string;
}

export interface ReviewComment {
  id: string;
  version_id: string;
  version_number?: number;
  timestamp_ms: number;
  /** When set, this is a RANGE comment from timestamp_ms..end_timestamp_ms.
   *  When null, the comment is point-in-time at timestamp_ms (existing behavior). */
  end_timestamp_ms: number | null;
  text: string;
  author_name: string;
  author_color: string;
  drawing_data: unknown | null;
  drawing_thumbnail_url: string | null;
  resolved: boolean;
  resolved_by: string | null;
  parent_id: string | null;
  /** When set, this comment is an editor's "what I fixed" note posted on a
   *  newer version, linking back to the original feedback comment from a
   *  previous version. */
  fix_for_comment_id: string | null;
  created_at: string;
}

export interface ReviewData {
  project: { id: string; title: string; description: string | null; status: string };
  permission: 'view-only' | 'can-comment' | 'can-annotate';
  /** Token-side only: server-decided flag indicating whether the linked
   *  collaborator may resolve comments (editors + narrators yes, anyone
   *  else no). Owner mode always treats this as true. */
  canResolve?: boolean;
  /** Token-side: collaborator's display name (used to seed the author UI). */
  collaboratorName?: string | null;
  /** Token-side: collaborator's roles. Drives whether to show the inline
   *  "Upload corrected version" button (editor) or "Go to narrator
   *  portal" link (narrator). */
  collaboratorRoles?: string[];
  versions: ReviewVersion[];
  comments: ReviewComment[];
}

interface Author {
  name: string;
  color: string;
}

const AUTHOR_COLORS = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

export interface ReviewPageProps {
  /** Token for public review (collaborator). Uses /api/review/[token]/* */
  token?: string;
  /** Project ID for owner playback. Uses /api/review/projects/[id]/* */
  ownerProjectId?: string;
  /** Optional initial version to focus when opened (e.g. ?v=<id>) */
  initialVersionId?: string;
  /** Comment id to scroll/highlight on mount (deep link from global
   *  comments inbox or notification). The matching version is expected to
   *  also be passed in `initialVersionId` so the comment is in view. */
  initialCommentId?: string;
}

export function ReviewPage({ token, ownerProjectId, initialVersionId, initialCommentId }: ReviewPageProps) {
  // Build API endpoints based on mode (token = collaborator, projectId = owner)
  const isOwner = !!ownerProjectId;
  const dataUrl = isOwner ? `/api/review/projects/${ownerProjectId}/playback` : `/api/review/${token}`;
  const commentsUrl = isOwner ? `/api/review/projects/${ownerProjectId}/comments` : `/api/review/${token}/comments`;
  const commentItemUrl = (commentId: string) =>
    isOwner ? `/api/review/projects/${ownerProjectId}/comments/${commentId}` : `/api/review/${token}/comments/${commentId}`;
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState<Author | null>(null);
  const [showAuthorSetup, setShowAuthorSetup] = useState(false);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [showAllVersionComments, setShowAllVersionComments] = useState(false);
  const [compareMode, setCompareMode] = useState<'off' | 'side-by-side' | 'onion-skin' | 'swipe'>('off');
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Marker → panel highlight pulse. Bumping `nonce` re-fires the panel's
  // scroll-into-view + transient highlight, even if the same id is clicked
  // again. Tracked here (not in CommentPanel) so the timeline can pulse it
  // when the user clicks a marker.
  const [markerPulse, setMarkerPulse] = useState<{ id: string; nonce: number } | null>(null);
  // Was the video playing when the user grabbed the scrubber? Captured at
  // mousedown and used by `handleSeekEnd` to resume play on release. Pausing
  // during drag stops decode-loop seek thrash on large mp4s.
  const wasPlayingBeforeScrubRef = useRef(false);
  const correctedFileInputRef = useRef<HTMLInputElement>(null);
  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [pendingDrawing, setPendingDrawing] = useState<{ data: unknown; thumbnail: string } | null>(null);

  // Editor inline upload-corrected-version state. Mirrors the same flow on
  // the editor's project dashboard so editors don't have to bounce tabs.
  const [uploadingCorrected, setUploadingCorrected] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [compressingCorrected, setCompressingCorrected] = useState(false);
  const [compressProgress, setCompressProgress] = useState(0);
  const [compressionSavedPct, setCompressionSavedPct] = useState<number | null>(null);

  // "Download current version" inline state. The video URL is cross-origin
  // (R2), so we route through the same `/api/download-proxy` pipe the rest
  // of the app uses — `<a download>` would be silently ignored.
  const [downloadingCurrent, setDownloadingCurrent] = useState(false);

  // Fix-notes modal — opens after a successful upload when there's a
  // previous version with unresolved comments.
  type PrevComment = { id: string; timestamp_ms: number; end_timestamp_ms: number | null; text: string; author_name: string; author_color: string; drawing_thumbnail_url: string | null };
  const [fixNotesVersionId, setFixNotesVersionId] = useState<string | null>(null);
  const [fixNotesPrevious, setFixNotesPrevious] = useState<{ versionNumber: number; comments: PrevComment[] } | null>(null);
  const [fixNotesDrafts, setFixNotesDrafts] = useState<Record<string, { text: string; resolveOriginal: boolean }>>({});
  const [fixNotesSaving, setFixNotesSaving] = useState(false);

  // Load author from localStorage. Owner mode skips the prompt.
  useEffect(() => {
    if (isOwner) {
      setAuthor({ name: 'Owner', color: '#7c3aed' });
      return;
    }
    try {
      const saved = localStorage.getItem('review_author');
      if (saved) {
        setAuthor(JSON.parse(saved));
      } else {
        setShowAuthorSetup(true);
      }
    } catch {
      setShowAuthorSetup(true);
    }
  }, [isOwner]);

  // Load review data
  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUrl]);

  async function loadData() {
    try {
      const res = await fetch(dataUrl);
      if (!res.ok) {
        setError(res.status === 404 ? 'expired' : 'error');
        return;
      }
      const reviewData: ReviewData = await res.json();
      setData(reviewData);
      if (!activeVersionId && reviewData.versions.length > 0) {
        const initial = initialVersionId && reviewData.versions.find(v => v.id === initialVersionId);
        setActiveVersionId((initial || reviewData.versions[reviewData.versions.length - 1]).id);
      }
    } catch {
      setError('error');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Editor-only inline upload of a corrected version. Same compress + R2
   * presign + thumbnail probe pipeline as the editor dashboard, but uses
   * the share-token endpoints so the personal_token never has to be
   * exposed to the client. After the upload lands, fetch unresolved
   * comments from the previous version and open the fix-notes modal.
   */
  async function handleCorrectedUpload(originalFile: File) {
    if (!token) return;
    if (!originalFile.type.startsWith('video/')) {
      toast.error('Please pick a video file');
      return;
    }
    setUploadingCorrected(true);
    setUploadProgress(0);
    setCompressionSavedPct(null);

    let file: File = originalFile;

    // Compress when supported. Fall back to original on any failure so a
    // bad codec path can never block the upload.
    if (typeof window !== 'undefined' && window.localStorage?.getItem('skipVideoCompression') !== '1' && originalFile.size >= 5 * 1024 * 1024) {
      try {
        const supported = await isCompressionSupported();
        if (supported) {
          setCompressingCorrected(true);
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
        setCompressingCorrected(false);
      }
    }

    try {
      // 1. Probe thumbnail + duration. Done before upload so the metadata
      // PATCH right after R2 PUT can fill these in.
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

      // 2. Reserve a version + presigned URL via the share-token endpoint.
      const reserveRes = await fetch(`/api/review/${token}/upload-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!reserveRes.ok) {
        const err = await reserveRes.json().catch(() => ({}));
        throw new Error(err.error || `Server returned ${reserveRes.status}`);
      }
      const { uploadUrl, versionId } = await reserveRes.json();

      // 3. PUT the bytes to R2.
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener('progress', evt => {
          if (evt.lengthComputable) setUploadProgress(Math.round((evt.loaded / evt.total) * 100));
        });
        xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 rejected upload (HTTP ${xhr.status})`)));
        xhr.addEventListener('error', () => reject(new Error('Network error uploading to R2')));
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file);
      });

      // 4. PATCH metadata.
      await fetch(`/api/review/${token}/upload-video`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId, thumbnail_url, duration_ms, width, height }),
      }).catch(() => {});

      toast.success('Corrected version uploaded');
      await loadData();
      setActiveVersionId(versionId);

      // 5. Open the fix-notes modal pre-populated with the previous
      // version's unresolved comments.
      try {
        const r = await fetch(`/api/review/${token}/previous-comments?versionId=${versionId}`);
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
      toast.error(`Upload failed: ${msg}`);
    } finally {
      setUploadingCorrected(false);
      setUploadProgress(0);
    }
  }

  async function submitFixNotes() {
    if (!token || !fixNotesVersionId) return;
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
      await fetch(`/api/review/${token}/fix-notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: fixNotesVersionId, notes }),
      });
    } catch {}
    setFixNotesSaving(false);
    setFixNotesVersionId(null);
    setFixNotesPrevious(null);
    await loadData();
  }

  // Download the currently-active version's video file. Builds a filename
  // from the project title + version number so multiple downloads from the
  // same project stay distinguishable in the user's downloads folder.
  async function handleDownloadCurrent() {
    if (!data) return;
    const v = data.versions.find(ver => ver.id === activeVersionId) || data.versions[0];
    if (!v?.video_url) return;
    const safeTitle = (data.project.title || 'video')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'video';
    const fileName = `${safeTitle} - v${v.version_number}.mp4`;
    setDownloadingCurrent(true);
    try {
      await downloadCrossOriginFile(v.video_url, fileName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Download failed';
      toast.error(msg);
    } finally {
      setDownloadingCurrent(false);
    }
  }

  // Poll for fresh comments every 30s. We deliberately hit the full
  // `dataUrl` (which returns all-versions comments) instead of the
  // active-version-only listing, so the prior-version timeline ghosts and
  // the "From previous versions" panel section don't silently disappear
  // 30 seconds after the page loads. Only `comments` is merged back —
  // versions / project metadata are preserved so we don't get unrelated
  // re-renders flickering the player.
  useEffect(() => {
    if (!activeVersionId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(dataUrl);
        if (res.ok) {
          const fresh: ReviewData = await res.json();
          setData(prev => prev ? { ...prev, comments: fresh.comments } : prev);
        }
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [dataUrl, activeVersionId]);

  const handleAuthorSave = useCallback((name: string) => {
    const color = AUTHOR_COLORS[Math.floor(Math.random() * AUTHOR_COLORS.length)];
    const newAuthor = { name, color };
    setAuthor(newAuthor);
    localStorage.setItem('review_author', JSON.stringify(newAuthor));
    setShowAuthorSetup(false);
  }, []);

  const handleSeek = useCallback((ms: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = ms / 1000;
    }
  }, []);

  // Called once when the user grabs the scrubber. Pause if currently
  // playing so we don't fight the decode loop with rapid seeks, and
  // remember the prior state so we can restore it on release.
  const handleSeekStart = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    wasPlayingBeforeScrubRef.current = !v.paused;
    if (!v.paused) v.pause();
  }, []);

  // Called once when the user releases the scrubber. Resume play if and
  // only if we paused on grab.
  const handleSeekEnd = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (wasPlayingBeforeScrubRef.current) {
      v.play().catch(() => {});
    }
    wasPlayingBeforeScrubRef.current = false;
  }, []);

  // Pulse the panel's highlight + scroll-into-view for the matching
  // comment. Used both by current-version markers (existing flow) and the
  // new prior-version ghost markers.
  const handleMarkerClick = useCallback((commentId: string) => {
    setMarkerPulse({ id: commentId, nonce: Date.now() });
  }, []);

  const handleCommentAdded = useCallback(async (comment: ReviewComment) => {
    setData(prev => {
      if (!prev) return prev;
      return { ...prev, comments: [...prev.comments, comment] };
    });
  }, []);

  const handleCommentResolved = useCallback((commentId: string, resolved: boolean, resolvedBy?: string) => {
    setData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        comments: prev.comments.map(c =>
          c.id === commentId ? { ...c, resolved, resolved_by: resolvedBy || null } : c
        ),
      };
    });
  }, []);

  const handleCommentDeleted = useCallback((commentId: string) => {
    setData(prev => {
      if (!prev) return prev;
      // Drop the comment AND any replies that pointed at it (server CASCADEs;
      // mirror that on the client so we don't show ghost rows until refresh).
      return {
        ...prev,
        comments: prev.comments.filter(c => c.id !== commentId && c.parent_id !== commentId),
      };
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Loading review...</p>
        </div>
      </div>
    );
  }

  if (error === 'expired') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Link Expired or Invalid</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Ask the project owner for a new link.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const activeVersion = data.versions.find(v => v.id === activeVersionId) || data.versions[0];
  const activeVersionNumber = activeVersion?.version_number ?? 0;
  const versionComments = showAllVersionComments
    ? data.comments
    : data.comments.filter(c => c.version_id === activeVersionId);

  // ─── Prior-version surfacing ─────────────────────────────────────────
  // For every top-level comment from an EARLIER version, decide whether
  // it's been fixed (an editor posted a fix-note on this or any later
  // version pointing at it), resolved (the original was marked resolved
  // without a fix-note), or still open. The reviewer uses this to spot v1
  // feedback they want to verify while watching v2.
  //
  // Fix-notes themselves and replies are intentionally excluded — they
  // aren't independent feedback items.
  const fixedCommentIds = new Set(
    data.comments.map(c => c.fix_for_comment_id).filter((x): x is string => !!x)
  );
  const priorVersionRows: Array<{ comment: ReviewComment; status: 'fixed' | 'resolved' | 'open' }> = data.comments
    .filter(c =>
      !c.parent_id &&
      !c.fix_for_comment_id &&
      c.version_number != null &&
      c.version_number < activeVersionNumber
    )
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
    .map(c => {
      const status: 'fixed' | 'resolved' | 'open' = fixedCommentIds.has(c.id)
        ? 'fixed'
        : c.resolved
          ? 'resolved'
          : 'open';
      return { comment: c, status };
    });

  // Timeline ghost markers — slim mapping of the rows above.
  const priorTimelineMarkers: PriorComment[] = priorVersionRows.map(({ comment, status }) => ({
    id: comment.id,
    timestamp_ms: comment.timestamp_ms,
    end_timestamp_ms: comment.end_timestamp_ms,
    color: comment.author_color,
    versionNumber: comment.version_number ?? 0,
    status,
    authorName: comment.author_name,
    text: comment.text,
    hasDrawing: !!comment.drawing_data,
  }));

  return (
    <>
      {showAuthorSetup && <AuthorSetup onSave={handleAuthorSave} />}

      <div className="flex flex-col h-screen">
        {/* Header */}
        <header className="flex items-center justify-between px-6 h-14 shrink-0" style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="white" /></svg>
            </div>
            <h1 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{data.project.title}</h1>
            <StatusBadge status={data.project.status} />
          </div>
          <div className="flex items-center gap-3">
            {data.versions.length > 1 && (
              <>
                <VersionSelector
                  versions={data.versions}
                  activeVersionId={activeVersionId || ''}
                  onSelect={setActiveVersionId}
                />
                <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-primary)' }}>
                  {(['off', 'side-by-side', 'onion-skin', 'swipe'] as const).map(mode => (
                    <button
                      key={mode}
                      onClick={() => {
                        setCompareMode(mode);
                        if (mode !== 'off' && !compareVersionId) {
                          const other = data.versions.find(v => v.id !== activeVersionId);
                          if (other) setCompareVersionId(other.id);
                        }
                      }}
                      className="px-2 py-1 rounded text-xs transition-colors"
                      style={{
                        background: compareMode === mode ? 'rgba(124,58,237,0.2)' : 'transparent',
                        color: compareMode === mode ? '#7c3aed' : 'var(--text-muted)',
                      }}
                    >
                      {mode === 'off' ? 'Single' : mode === 'side-by-side' ? 'Side by Side' : mode === 'onion-skin' ? 'Onion Skin' : 'Swipe'}
                    </button>
                  ))}
                </div>
              </>
            )}
            {/* Download the currently-active version. Routes through the
                cross-origin download proxy so the R2 presigned URL gets
                served with Content-Disposition: attachment. */}
            {activeVersion?.video_url && (
              <button
                onClick={handleDownloadCurrent}
                disabled={downloadingCurrent}
                className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
                style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
                title={`Download v${activeVersion.version_number}`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {downloadingCurrent ? 'Preparing…' : `Download v${activeVersion.version_number}`}
              </button>
            )}

            {/* Editor inline upload — pops a file picker in this same tab.
                On success we reload, jump to the new version, and open the
                fix-notes modal with the previous version's open comments. */}
            {!isOwner && data.collaboratorRoles?.includes('editor') && (
              <>
                <input
                  ref={correctedFileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleCorrectedUpload(f); }}
                />
                <button
                  onClick={() => correctedFileInputRef.current?.click()}
                  disabled={uploadingCorrected}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                  title="Upload a corrected version of this video"
                >
                  {compressingCorrected
                    ? `Compressing… ${Math.round(compressProgress * 100)}%`
                    : uploadingCorrected
                      ? `Uploading… ${uploadProgress}%`
                      : '📤 Upload corrected version'}
                </button>
              </>
            )}

            {/* Narrator portal jump — server-side redirect avoids exposing
                the personal_token to the client. */}
            {!isOwner && data.collaboratorRoles?.includes('narrator') && !data.collaboratorRoles?.includes('editor') && (
              <a
                href={`/api/review/${token}/narrator-portal`}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white flex items-center gap-1.5"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                title="Open your narrator portal — that's where you re-record sections to fix narration feedback"
              >
                🎙️ Re-record sections in narrator portal
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            )}

            {author && (
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ background: author.color }}>
                  {(author.name || '?')[0].toUpperCase()}
                </div>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{author.name}</span>
              </div>
            )}
          </div>
        </header>

        {/* Main content */}
        <div className="flex flex-1 min-h-0">
          {/* Video area */}
          {/* Video area. `min-h-0` is load-bearing here: without it the
              nested flex-col refuses to shrink below the video's content
              height, which pushes the ReviewTimeline below the viewport
              on shorter screens. */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            {compareMode !== 'off' && activeVersion && compareVersionId && data.versions.find(v => v.id === compareVersionId) ? (
              <ComparisonView
                mode={compareMode}
                version1={activeVersion}
                version2={data.versions.find(v => v.id === compareVersionId)!}
                onTimeUpdate={setCurrentTimeMs}
              />
            ) : activeVersion?.video_url ? (
              <>
                <ReviewPlayer
                  ref={videoRef}
                  src={activeVersion.video_url}
                  onTimeUpdate={setCurrentTimeMs}
                  onBufferedChange={setBufferedPct}
                  isDrawing={isDrawing}
                  onDrawingToggle={setIsDrawing}
                  onDrawingComplete={(drawingData, thumbnail) => {
                    setPendingDrawing({ data: drawingData, thumbnail });
                    setIsDrawing(false);
                  }}
                  canAnnotate={data.permission === 'can-annotate'}
                  commentTimestamps={versionComments.filter(c => !c.parent_id).map(c => c.timestamp_ms)}
                />
                <ReviewTimeline
                  currentTimeMs={currentTimeMs}
                  durationMs={activeVersion.duration_ms || 0}
                  comments={versionComments}
                  onSeek={handleSeek}
                  onSeekStart={handleSeekStart}
                  onSeekEnd={handleSeekEnd}
                  onCommentMarkerClick={handleMarkerClick}
                  onPriorMarkerClick={handleMarkerClick}
                  priorComments={priorTimelineMarkers}
                  videoUrl={activeVersion.video_url}
                  bufferedPct={bufferedPct}
                />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center" style={{ background: '#000' }}>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No video uploaded yet</p>
              </div>
            )}
          </div>

          {/* Comment panel */}
          <CommentPanel
            commentsUrl={commentsUrl}
            commentItemUrl={commentItemUrl}
            isOwner={isOwner}
            canResolve={isOwner || !!data.canResolve}
            comments={versionComments}
            activeVersionId={activeVersionId || ''}
            permission={data.permission}
            author={author}
            currentTimeMs={currentTimeMs}
            onSeek={handleSeek}
            onCommentAdded={handleCommentAdded}
            onCommentResolved={handleCommentResolved}
            onCommentDeleted={handleCommentDeleted}
            showAllVersions={showAllVersionComments}
            onToggleAllVersions={() => setShowAllVersionComments(v => !v)}
            pendingDrawing={pendingDrawing}
            onClearDrawing={() => setPendingDrawing(null)}
            initialHighlightCommentId={initialCommentId}
            priorVersionRows={priorVersionRows}
            pulseHighlightCommentId={markerPulse}
          />
        </div>
      </div>

      {/* Fix-notes modal — opens after the editor uploads a corrected
          version inline. Lists each unresolved comment from the previous
          version so the editor can describe what they changed for it. */}
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
                Skip — I&apos;ll explain later
              </button>
              <button
                disabled={fixNotesSaving}
                onClick={submitFixNotes}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
              >
                {fixNotesSaving ? 'Saving…' : 'Submit fix notes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
