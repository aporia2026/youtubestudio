'use client';

/**
 * Result view for one deep analysis.
 *
 * Three top-level states:
 *
 *   stage = 'analyzing' — show a progress panel. Poll the GET endpoint
 *     every 5 seconds until the stage flips to done/failed. The 5s
 *     cadence is deliberately conservative: a 60-min Gemini call can
 *     take 4-5 minutes, polling faster just burns the rate-limiter
 *     and the operator's nerves. Cron-style "this is taking a while"
 *     copy reassures rather than alarms.
 *
 *   stage = 'failed' — show the failure reason, a "Retry" button
 *     that re-POSTs with `force=true`, and a link back to /analyze.
 *
 *   stage = 'done' — show the meta header + two tabs:
 *     "Style packs" (the cards the operator can save as presets)
 *     and "Strategic insights" (the human-readable breakdown).
 *
 * The tab choice is a local string state (not query string) so the
 * back button takes the operator back to /analyze, not to a sibling
 * tab on the same row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { AnalyzedVideo, AnalysisStage } from '@/lib/analyzer/types';
import { StylePackCard } from './StylePackCard';
import { StrategicReportPanel } from './StrategicReportPanel';
import { MakeVideoButton } from '@/components/video-context/MakeVideoButton';

export type { AnalysisStage };

/**
 * Shared style for the analyzer→consumer bridge buttons in the
 * "Use this analysis as input" row. Kept as a const so the buttons
 * stay visually consistent as more bridges land in Phase 3.
 */
const bridgeButtonStyle: React.CSSProperties = {
  padding: '5px 12px',
  background: 'rgba(124, 58, 237, 0.12)',
  color: '#c4b5fd',
  border: '1px solid rgba(124, 58, 237, 0.35)',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

/**
 * Sibling of `bridgeButtonStyle` for buttons that require a saved
 * preset to be useful but haven't gotten one yet. Rendered as a
 * still-clickable Link (the user can still open the bare consumer
 * page) but visually muted so the operator reads it as "this would
 * be richer if you saved a style first."
 */
const bridgeButtonStyleDisabled: React.CSSProperties = {
  ...bridgeButtonStyle,
  background: 'transparent',
  color: 'var(--text-muted)',
  border: '1px dashed var(--border-bright)',
};

export interface AnalysisSnapshot {
  id: string;
  videoId: string;
  videoUrl: string;
  videoTitle: string | null;
  channelTitle: string | null;
  modelId: string;
  stage: AnalysisStage;
  failureReason: string | null;
  result: AnalyzedVideo | null;
  stale: boolean;
  createdAt: string;
  completedAt: string | null;
}

interface Props {
  initial: AnalysisSnapshot;
}

type TabKey = 'style-packs' | 'insights';

const POLL_INTERVAL_MS = 5_000;

export function AnalyzeResultClient({ initial }: Props): React.ReactElement {
  const [snap, setSnap] = useState<AnalysisSnapshot>(initial);
  // Tracks which packs the operator has saved as presets this session.
  // Keyed by pack id → { saved preset row id, human name }. Drives the
  // bridge-row deep-links that need a preset id (production-doc / script /
  // thumbnail). Per StylePackCard's `onSaved` callback, this map grows as
  // the operator saves more packs without leaving the page.
  const [savedPresets, setSavedPresets] = useState<Record<string, { id: string; name: string }>>({});
  const [tab, setTab] = useState<TabKey>('style-packs');
  const [retrying, setRetrying] = useState(false);
  const elapsedRef = useRef<number>(Date.now() - new Date(initial.createdAt).getTime());

  // ─── Polling while in-flight ───────────────────────────────────
  useEffect(() => {
    if (snap.stage !== 'analyzing') return undefined;
    const interval = setInterval(async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        const res = await fetch(`/api/analyze/youtube-video/${snap.id}`, { method: 'GET' });
        if (!res.ok) return;
        const data = (await res.json()) as {
          stage: AnalysisStage;
          failureReason: string | null;
          result: AnalyzedVideo | null;
          videoTitle: string | null;
          channelTitle: string | null;
          completedAt: string | null;
          stale: boolean;
        };
        setSnap((prev) => ({
          ...prev,
          stage: data.stage,
          failureReason: data.failureReason,
          result: data.result,
          videoTitle: data.videoTitle ?? prev.videoTitle,
          channelTitle: data.channelTitle ?? prev.channelTitle,
          completedAt: data.completedAt,
          stale: data.stale,
        }));
      } catch {
        /* network blip — next tick retries */
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [snap.stage, snap.id]);

  // ─── Elapsed-time tick (cheap, just re-renders the "elapsed" copy)
  const [, force] = useState(0);
  useEffect(() => {
    if (snap.stage !== 'analyzing') return undefined;
    const t = setInterval(() => {
      elapsedRef.current = Date.now() - new Date(snap.createdAt).getTime();
      force((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [snap.stage, snap.createdAt]);

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/analyze/youtube-video', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: snap.videoUrl, force: true }),
      });
      const data = (await res.json()) as { analysisId?: string; error?: string };
      if (!res.ok || !data.analysisId) {
        toast.error(data.error || 'Retry failed');
        return;
      }
      // The retry deletes the old row and creates a new one. Take the
      // operator there.
      window.location.href = `/analyze/${data.analysisId}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }, [snap.videoUrl]);

  // ─── Header (always rendered) ───────────────────────────────────
  const header = (
    <header style={{ marginBottom: 20, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`https://img.youtube.com/vi/${snap.videoId}/mqdefault.jpg`}
        alt=""
        width={160}
        height={90}
        style={{ borderRadius: 8, border: '1px solid var(--border-bright)', flexShrink: 0, objectFit: 'cover' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link
          href="/analyze"
          style={{
            fontSize: 12,
            color: 'var(--text-tertiary)',
            textDecoration: 'none',
            display: 'inline-block',
            marginBottom: 4,
          }}
        >
          ← All analyses
        </Link>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '2px 0 4px',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {snap.videoTitle || snap.videoId}
        </h1>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {snap.channelTitle && <span>{snap.channelTitle} · </span>}
          <a
            href={snap.videoUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}
          >
            Open on YouTube
          </a>
          <span> · model: {snap.modelId}</span>
        </div>
        {snap.stage === 'done' && snap.videoTitle && (
          <div style={{ marginTop: 8 }}>
            <MakeVideoButton
              title={snap.videoTitle}
              from="Video Analyzer"
              label="+ Make video inspired by this"
              compact
            />
          </div>
        )}
        {snap.stale && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: '#fbbf24',
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(245,158,11,0.10)',
              border: '1px solid rgba(245,158,11,0.30)',
            }}
            title="The analyzer version or prompt has been updated since this run. Re-analyze for fresh output."
          >
            Older analyzer version
          </div>
        )}
      </div>
    </header>
  );

  // ─── Analyzing state ───────────────────────────────────────────
  if (snap.stage === 'analyzing') {
    const elapsedSec = Math.floor(elapsedRef.current / 1000);
    return (
      <main style={{ padding: '32px 24px', maxWidth: 920, margin: '0 auto' }}>
        {header}
        <section
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-bright)',
            borderRadius: 12,
            padding: 28,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            Analyzing…
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            Gemini is watching the full video. This usually takes 2-4 minutes for a typical YouTube video,
            up to 5 minutes for hour-long content.
          </div>
          <div
            style={{
              display: 'inline-block',
              padding: '6px 14px',
              borderRadius: 999,
              background: 'rgba(245,158,11,0.10)',
              border: '1px solid rgba(245,158,11,0.35)',
              color: '#fbbf24',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {formatElapsed(elapsedSec)}
          </div>
          <p style={{ marginTop: 18, fontSize: 12, color: 'var(--text-tertiary)' }}>
            It&apos;s safe to leave this page open or come back later — the analysis runs server-side and will
            finish on its own.
          </p>
        </section>
      </main>
    );
  }

  // ─── Failed state ──────────────────────────────────────────────
  if (snap.stage === 'failed') {
    return (
      <main style={{ padding: '32px 24px', maxWidth: 920, margin: '0 auto' }}>
        {header}
        <section
          style={{
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.30)',
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h2 style={{ margin: 0, color: '#fca5a5', fontSize: 18, fontWeight: 600 }}>Analysis failed</h2>
          <p style={{ marginTop: 10, color: 'var(--text-secondary)', fontSize: 14, whiteSpace: 'pre-wrap' }}>
            {snap.failureReason || 'Unknown error.'}
          </p>
          <div style={{ marginTop: 18, display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: 'none',
                background: retrying ? 'var(--bg-input)' : '#7c3aed',
                color: retrying ? 'var(--text-secondary)' : '#fff',
                fontSize: 14,
                fontWeight: 600,
                cursor: retrying ? 'not-allowed' : 'pointer',
              }}
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
            <Link
              href="/analyze"
              style={{
                padding: '8px 16px',
                borderRadius: 8,
                border: '1px solid var(--border-bright)',
                background: 'transparent',
                color: 'var(--text-secondary)',
                fontSize: 14,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Back to analyses
            </Link>
          </div>
        </section>
      </main>
    );
  }

  // ─── Done state — tabs ─────────────────────────────────────────
  const result = snap.result;
  if (!result) {
    // Defensive — stage says 'done' but no result. Treat as failure.
    return (
      <main style={{ padding: '32px 24px', maxWidth: 920, margin: '0 auto' }}>
        {header}
        <p style={{ color: '#fca5a5' }}>This analysis is marked done but has no result data. Try Re-analyze.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: '32px 24px', maxWidth: 1080, margin: '0 auto' }}>
      {header}

      {(() => {
        const firstSavedPresetId = Object.values(savedPresets)[0]?.id;
        const channelHint = snap.channelTitle ?? null;
        return (
          <nav
            aria-label="Use this analysis as input"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 20,
              padding: '10px 14px',
              background: 'rgba(124, 58, 237, 0.05)',
              border: '1px solid rgba(124, 58, 237, 0.20)',
              borderRadius: 8,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginRight: 4 }}>
              Use this analysis as input:
            </span>
            <Link
              href={`/ideas?from=analyzer&analysisId=${encodeURIComponent(snap.id)}`}
              prefetch={false}
              style={bridgeButtonStyle}
              title="Open the idea generator with this analysis's strategic report + chapter outline as referenceContext"
            >
              Generate ideas
            </Link>
            <Link
              href={`/seo?from=analyzer&analysisId=${encodeURIComponent(snap.id)}`}
              prefetch={false}
              style={bridgeButtonStyle}
              title="Open the SEO optimizer with this analysis's hook + transcript as additionalContext"
            >
              SEO-optimize
            </Link>
            <Link
              href={firstSavedPresetId
                ? `/production-doc?stylePreset=${encodeURIComponent(firstSavedPresetId)}`
                : '/production-doc'}
              prefetch={false}
              style={firstSavedPresetId ? bridgeButtonStyle : bridgeButtonStyleDisabled}
              title={firstSavedPresetId
                ? `Open the production doc generator with the saved style "${Object.values(savedPresets)[0]?.name}" preselected`
                : 'Save a style pack as a preset first (button on each pack card) — then this opens production doc with that preset preselected'}
            >
              Use style in production doc
            </Link>
            <Link
              href={firstSavedPresetId
                ? `/generator?stylePreset=${encodeURIComponent(firstSavedPresetId)}`
                : '/generator'}
              prefetch={false}
              style={firstSavedPresetId ? bridgeButtonStyle : bridgeButtonStyleDisabled}
              title={firstSavedPresetId
                ? `Open the script generator with the saved style "${Object.values(savedPresets)[0]?.name}" preselected`
                : 'Save a style pack as a preset first — then this opens the script generator with that preset preselected'}
            >
              Write script in this style
            </Link>
            <Link
              href={channelHint
                ? `/competitors?channelHint=${encodeURIComponent(channelHint)}`
                : '/competitors'}
              prefetch={false}
              style={bridgeButtonStyle}
              title={channelHint
                ? `Open the competitor tracker with "${channelHint}" prefilled as a search hint`
                : 'Open the competitor tracker'}
            >
              Track channel
            </Link>
            <Link
              href={channelHint
                ? `/insights/niches?channelHint=${encodeURIComponent(channelHint)}`
                : '/insights/niches'}
              prefetch={false}
              style={bridgeButtonStyle}
              title={channelHint
                ? `Open the niche finder with "${channelHint}" prefilled as a channel hint`
                : 'Open the niche finder'}
            >
              Find niches
            </Link>
          </nav>
        );
      })()}

      {result.warnings && result.warnings.length > 0 && (
        <div
          role="status"
          style={{
            marginBottom: 20,
            padding: '10px 14px',
            borderRadius: 6,
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.30)',
            color: '#fde68a',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ fontWeight: 600 }}>
            Analyzer flagged {result.warnings.length === 1 ? '1 inconsistency' : `${result.warnings.length} inconsistencies`} in Gemini&apos;s output.
          </strong>{' '}
          The style packs and strategic report are still usable — these warnings are about
          scene-boundary / pack-arithmetic consistency, not content quality. Re-analyze if you want a fresh run.
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
              Show details ({result.warnings.length})
            </summary>
            <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 22, fontSize: 12, color: 'var(--text-primary)' }}>
              {result.warnings.map((w, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <code style={{ background: 'rgba(0,0,0,0.30)', padding: '1px 6px', borderRadius: 4 }}>{w}</code>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <nav
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border-bright)',
          marginBottom: 20,
        }}
      >
        <TabButton active={tab === 'style-packs'} onClick={() => setTab('style-packs')}>
          Style packs <span style={{ opacity: 0.6 }}>· {result.style_packs.length}</span>
        </TabButton>
        <TabButton active={tab === 'insights'} onClick={() => setTab('insights')}>
          Strategic insights
        </TabButton>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid var(--border-bright)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 12,
            cursor: retrying ? 'not-allowed' : 'pointer',
          }}
        >
          {retrying ? 'Re-analyzing…' : 'Re-analyze'}
        </button>
      </nav>

      {tab === 'style-packs' ? (
        <div style={{ display: 'grid', gap: 16 }}>
          {result.style_packs.map((pack) => (
            <StylePackCard
              key={pack.id}
              pack={pack}
              sourceVideo={{ videoId: snap.videoId, title: snap.videoTitle, channel: snap.channelTitle }}
              onSaved={(presetId, presetName) => {
                setSavedPresets((prev) => ({ ...prev, [pack.id]: { id: presetId, name: presetName } }));
              }}
            />
          ))}
          {result.scenes.length > 0 && (
            <section
              style={{
                marginTop: 8,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-bright)',
                borderRadius: 12,
                padding: 20,
              }}
            >
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text-primary)' }}>
                Scenes by style ({result.scenes.length})
              </h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                {result.scenes.map((s, idx) => (
                  <li
                    key={`${s.start}-${idx}`}
                    style={{
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.5,
                      padding: '8px 12px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: 'rgba(124,58,237,0.15)',
                        color: '#c4b5fd',
                        fontSize: 11,
                        marginRight: 8,
                        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                      }}
                    >
                      {formatTimeRange(s.start, s.end)} · {s.style_pack_id}
                    </span>
                    {s.summary}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <StrategicReportPanel report={result.strategic_report} chapters={result.transcript.chapters} />
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: '10px 14px',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #7c3aed' : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 14,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s elapsed`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s elapsed`;
}

function formatTimeRange(start: number, end: number): string {
  return `${formatTime(start)}-${formatTime(end)}`;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
