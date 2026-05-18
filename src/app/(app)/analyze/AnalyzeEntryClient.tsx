'use client';

/**
 * Entry experience for /analyze.
 *
 * Three things stacked vertically:
 *   1. A short explainer header so a first-time visitor knows what the
 *      page does and what the cost / wait looks like.
 *   2. A URL input + Analyze button. The button kicks off the POST to
 *      `/api/analyze/youtube-video` and routes to /analyze/[id] when
 *      the row is created (the result page handles the polling).
 *   3. A reverse-chrono list of the workspace's recent analyses with
 *      stage badges so the operator can pick up where they left off.
 *
 * The "Re-analyze" button on a completed item passes `force=true`
 * to the POST. The plan keeps re-analyses explicit so the daily cap
 * isn't drained by an over-eager browser cache miss.
 *
 * Deep-link contract (niche-finder integration, Phase 3):
 *   /analyze?videoId=abc123&title=...&channel=...           — prefill
 *   /analyze?videoId=abc123&title=...&channel=...&autostart=1
 *                                                  — prefill + start
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { extractYoutubeVideoId } from '@/lib/analyzer/url';

export interface RecentAnalysisItem {
  id: string;
  videoId: string;
  videoUrl: string;
  videoTitle: string | null;
  channelTitle: string | null;
  stage: 'analyzing' | 'done' | 'failed';
  failureReason: string | null;
  modelId: string;
  stylePackCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface Props {
  initialRecent: RecentAnalysisItem[];
}

const STAGE_COLOR: Record<RecentAnalysisItem['stage'], { bg: string; border: string; fg: string; label: string }> = {
  analyzing: { bg: 'rgba(245, 158, 11, 0.10)', border: 'rgba(245, 158, 11, 0.35)', fg: '#fbbf24', label: 'Analyzing…' },
  done: { bg: 'rgba(34, 197, 94, 0.10)', border: 'rgba(34, 197, 94, 0.35)', fg: '#86efac', label: 'Ready' },
  failed: { bg: 'rgba(239, 68, 68, 0.10)', border: 'rgba(239, 68, 68, 0.35)', fg: '#fca5a5', label: 'Failed' },
};

export function AnalyzeEntryClient({ initialRecent }: Props): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentAnalysisItem[]>(initialRecent);
  const autostartedRef = useRef(false);

  // Prefill from query string (?videoId=&title=&channel=). When
  // `autostart=1` is present, fire the analyze POST once on mount.
  useEffect(() => {
    const videoId = params.get('videoId');
    if (videoId && !url) {
      const canonical = `https://www.youtube.com/watch?v=${videoId}`;
      setUrl(canonical);
      if (params.get('autostart') === '1' && !autostartedRef.current) {
        autostartedRef.current = true;
        void submit(canonical);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Poll the list every 8s while any row is in `analyzing` — handles
  // the case where a tab was left open while a sibling browser kicked
  // off the analyze. Stops when nothing is in flight (we don't want
  // to burn quota on a static page).
  const hasInFlight = useMemo(() => recent.some((r) => r.stage === 'analyzing'), [recent]);
  useEffect(() => {
    if (!hasInFlight) return undefined;
    const id = setInterval(() => {
      void refreshRecent();
    }, 8000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInFlight]);

  const refreshRecent = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/analyze/youtube-video', { method: 'GET' });
      if (!res.ok) return;
      const data = (await res.json()) as { analyses: RecentAnalysisItem[] };
      setRecent(data.analyses);
    } catch {
      /* network blip — next tick retries */
    }
  }, []);

  const submit = useCallback(
    async (overrideUrl?: string, force = false): Promise<void> => {
      const youtubeUrl = (overrideUrl ?? url).trim();
      setError(null);
      if (!youtubeUrl) {
        setError('Paste a YouTube URL first.');
        return;
      }
      if (!extractYoutubeVideoId(youtubeUrl)) {
        setError("That URL doesn't look like a YouTube video link.");
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch('/api/analyze/youtube-video', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ youtubeUrl, force }),
        });
        const data = (await res.json()) as {
          analysisId?: string;
          error?: string;
          cached?: boolean;
          status?: string;
        };
        if (!res.ok) {
          setError(data.error || `Request failed (${res.status})`);
          return;
        }
        if (!data.analysisId) {
          setError('Server did not return an analysis id.');
          return;
        }
        // Route into the result page regardless of cached vs fresh —
        // the result page renders both the same way.
        router.push(`/analyze/${data.analysisId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unexpected error');
      } finally {
        setSubmitting(false);
      }
    },
    [url, router],
  );

  return (
    <main style={{ padding: '32px 24px', maxWidth: 920, margin: '0 auto' }}>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Deep video analyzer
        </h1>
        <p style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 15, lineHeight: 1.5 }}>
          Paste any YouTube URL. Gemini watches the full video and returns a per-mode style pack you can
          replicate in the gen pipeline, plus a strategic breakdown of what makes the video work. Most analyses
          finish in two to four minutes.
        </p>
      </header>

      <section
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-bright)',
          borderRadius: 12,
          padding: 20,
          marginBottom: 28,
        }}
      >
        <label style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
          YouTube URL
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !submitting) {
                e.preventDefault();
                void submit();
              }
            }}
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid var(--border-bright)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              fontSize: 15,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !url.trim()}
            style={{
              padding: '10px 18px',
              borderRadius: 8,
              border: 'none',
              background: submitting || !url.trim() ? 'var(--bg-input)' : '#7c3aed',
              color: submitting || !url.trim() ? 'var(--text-secondary)' : '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting || !url.trim() ? 'not-allowed' : 'pointer',
              minWidth: 110,
            }}
          >
            {submitting ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
        {error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 6,
              background: 'rgba(239, 68, 68, 0.10)',
              border: '1px solid rgba(239, 68, 68, 0.30)',
              color: '#fca5a5',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
          Up to 60 min videos. Each new analysis counts toward a 20-per-day soft cap. Same video re-analyzed is
          a cache hit (free, instant).
        </p>
      </section>

      <section>
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
            Recent analyses
          </h2>
          <button
            type="button"
            onClick={() => void refreshRecent()}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-bright)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </header>

        {recent.length === 0 ? (
          <div
            style={{
              padding: '24px',
              borderRadius: 10,
              border: '1px dashed var(--border-bright)',
              color: 'var(--text-tertiary)',
              fontSize: 14,
              textAlign: 'center',
            }}
          >
            Your workspace has no analyses yet. Paste a URL above to start.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            {recent.map((item) => {
              const tone = STAGE_COLOR[item.stage];
              const title = item.videoTitle || item.videoId;
              return (
                <li
                  key={item.id}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-bright)',
                    borderRadius: 10,
                    padding: '12px 16px',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <Link
                    href={`/analyze/${item.id}`}
                    style={{ textDecoration: 'none', display: 'block', color: 'var(--text-primary)' }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      {item.channelTitle ? `${item.channelTitle} · ` : ''}
                      {formatRelative(item.createdAt)}
                      {item.stylePackCount != null && item.stage === 'done'
                        ? ` · ${item.stylePackCount} style pack${item.stylePackCount === 1 ? '' : 's'}`
                        : ''}
                    </div>
                  </Link>

                  <span
                    style={{
                      padding: '3px 10px',
                      borderRadius: 999,
                      background: tone.bg,
                      border: `1px solid ${tone.border}`,
                      color: tone.fg,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                    title={item.failureReason || undefined}
                  >
                    {tone.label}
                  </span>

                  {item.stage === 'done' ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        void submit(item.videoUrl, true);
                        toast.info('Re-analyzing…', { description: 'Old result will be replaced when this finishes.' });
                      }}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--border-bright)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Re-analyze
                    </button>
                  ) : item.stage === 'failed' ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        void submit(item.videoUrl, true);
                      }}
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        border: '1px solid rgba(239,68,68,0.35)',
                        background: 'rgba(239,68,68,0.10)',
                        color: '#fca5a5',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      Retry
                    </button>
                  ) : (
                    <span style={{ width: 1 }} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 minute ago';
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}
