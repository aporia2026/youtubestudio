'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ReviewPlayer } from './ReviewPlayer';
import { ReviewTimeline } from './ReviewTimeline';
import { CommentPanel } from './CommentPanel';
import { AuthorSetup } from './AuthorSetup';
import { VersionSelector } from './VersionSelector';
import { StatusBadge } from './StatusBadge';
import { ComparisonView } from './ComparisonView';

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
  text: string;
  author_name: string;
  author_color: string;
  drawing_data: unknown | null;
  drawing_thumbnail_url: string | null;
  resolved: boolean;
  resolved_by: string | null;
  parent_id: string | null;
  created_at: string;
}

export interface ReviewData {
  project: { id: string; title: string; description: string | null; status: string };
  permission: 'view-only' | 'can-comment' | 'can-annotate';
  versions: ReviewVersion[];
  comments: ReviewComment[];
}

interface Author {
  name: string;
  color: string;
}

const AUTHOR_COLORS = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

export function ReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState<Author | null>(null);
  const [showAuthorSetup, setShowAuthorSetup] = useState(false);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [showAllVersionComments, setShowAllVersionComments] = useState(false);
  const [compareMode, setCompareMode] = useState<'off' | 'side-by-side' | 'onion-skin' | 'swipe'>('off');
  const [compareVersionId, setCompareVersionId] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Drawing state
  const [isDrawing, setIsDrawing] = useState(false);
  const [pendingDrawing, setPendingDrawing] = useState<{ data: unknown; thumbnail: string } | null>(null);

  // Load author from localStorage
  useEffect(() => {
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
  }, []);

  // Load review data
  useEffect(() => {
    loadData();
  }, [token]);

  async function loadData() {
    try {
      const res = await fetch(`/api/review/${token}`);
      if (!res.ok) {
        setError(res.status === 404 ? 'expired' : 'error');
        return;
      }
      const reviewData: ReviewData = await res.json();
      setData(reviewData);
      if (!activeVersionId && reviewData.versions.length > 0) {
        setActiveVersionId(reviewData.versions[reviewData.versions.length - 1].id);
      }
    } catch {
      setError('error');
    } finally {
      setLoading(false);
    }
  }

  // Poll for new comments every 30s
  useEffect(() => {
    if (!activeVersionId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/review/${token}/comments?versionId=${activeVersionId}`);
        if (res.ok) {
          const freshComments = await res.json();
          setData(prev => prev ? { ...prev, comments: freshComments } : prev);
        }
      } catch {}
    }, 30000);
    return () => clearInterval(interval);
  }, [token, activeVersionId]);

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
  const versionComments = showAllVersionComments
    ? data.comments
    : data.comments.filter(c => c.version_id === activeVersionId);

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
          <div className="flex-1 flex flex-col min-w-0">
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
                  isDrawing={isDrawing}
                  onDrawingToggle={setIsDrawing}
                  onDrawingComplete={(drawingData, thumbnail) => {
                    setPendingDrawing({ data: drawingData, thumbnail });
                    setIsDrawing(false);
                  }}
                  canAnnotate={data.permission === 'can-annotate'}
                />
                <ReviewTimeline
                  currentTimeMs={currentTimeMs}
                  durationMs={activeVersion.duration_ms || 0}
                  comments={versionComments}
                  onSeek={handleSeek}
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
            token={token}
            comments={versionComments}
            activeVersionId={activeVersionId || ''}
            permission={data.permission}
            author={author}
            currentTimeMs={currentTimeMs}
            onSeek={handleSeek}
            onCommentAdded={handleCommentAdded}
            onCommentResolved={handleCommentResolved}
            showAllVersions={showAllVersionComments}
            onToggleAllVersions={() => setShowAllVersionComments(v => !v)}
            pendingDrawing={pendingDrawing}
            onClearDrawing={() => setPendingDrawing(null)}
          />
        </div>
      </div>
    </>
  );
}
