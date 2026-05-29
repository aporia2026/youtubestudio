'use client';

import { useEffect, useState } from 'react';
import type {
  DipAnalysis,
  DipAnalysisRow,
  DipPattern,
  RetentionDip,
} from '@/lib/fix-the-dip-types';
import type { RetentionPoint } from '@/lib/retention-predictor-types';

interface VideoOption {
  youtube_video_id: string;
  title: string | null;
  duration_seconds: number | null;
  average_view_percentage: number | null;
}

interface CreateResponse {
  id: string;
  analysis: DipAnalysis;
}

export default function FixTheDipPage() {
  const [videos, setVideos] = useState<VideoOption[]>([]);
  const [history, setHistory] = useState<DipAnalysisRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [youtubeVideoId, setYoutubeVideoId] = useState('');
  const [script, setScript] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  const [latestId, setLatestId] = useState<string | null>(null);
  const [latest, setLatest] = useState<{
    analysis: DipAnalysis;
    curve: RetentionPoint[];
    videoTitle: string | null;
    videoDuration: number | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [vidRes, listRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads video-analytics
          fetch('/api/video-analytics?limit=50'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads dip-analyses
          fetch('/api/retention/dip-analyses?limit=20'),
        ]);
        if (cancelled) return;
        if (vidRes.ok) {
          const data = await vidRes.json();
          // /api/video-analytics may not exist — fall back to using just the
          // input field. Either way, populate what we can.
          const list = (data?.rows ?? data?.analytics ?? []) as VideoOption[];
          setVideos(list);
        }
        if (listRes.ok) {
          setHistory(((await listRes.json()).analyses as DipAnalysisRow[]) || []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function analyze() {
    if (!youtubeVideoId.trim()) {
      setError('YouTube video id is required.');
      return;
    }
    if (script.trim().length < 200) {
      setError('Script must be at least 200 characters to align dips.');
      return;
    }
    setError(null);
    setAnalyzing(true);
    setLatest(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- dip-analyses POST: awaits and uses response
      const res = await fetch('/api/retention/dip-analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          youtubeVideoId: youtubeVideoId.trim(),
          script,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as CreateResponse;
      setLatestId(data.id);
      // Fetch the full row so we get curve + title + duration for the chart.
      // eslint-disable-next-line no-restricted-syntax -- GET, loads dip-analysis detail
      const detailRes = await fetch(`/api/retention/dip-analyses/${data.id}`, { cache: 'no-store' });
      if (detailRes.ok) {
        const row = ((await detailRes.json()).analysis as DipAnalysisRow);
        setLatest({
          analysis: data.analysis,
          curve: row.retention_curve_snapshot,
          videoTitle: row.video_title,
          videoDuration: row.video_duration_seconds,
        });
      } else {
        setLatest({
          analysis: data.analysis,
          curve: [],
          videoTitle: null,
          videoDuration: null,
        });
      }
      // Refresh history.
      // eslint-disable-next-line no-restricted-syntax -- GET .then, refresh dip-analyses list
      fetch('/api/retention/dip-analyses?limit=20', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.analyses && setHistory(d.analyses))
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  }

  async function loadHistorical(id: string) {
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads dip-analysis detail
      const res = await fetch(`/api/retention/dip-analyses/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const row = ((await res.json()).analysis as DipAnalysisRow);
      setLatestId(row.id);
      setLatest({
        analysis: {
          detected_dips: row.detected_dips,
          top_fixes: row.top_fixes,
          patterns: row.patterns,
          observed_avp_percentage: row.average_view_percentage,
        },
        curve: row.retention_curve_snapshot,
        videoTitle: row.video_title,
        videoDuration: row.video_duration_seconds,
      });
      setYoutubeVideoId(row.youtube_video_id);
      setScript(row.script_text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analysis');
    }
  }

  async function deleteAnalysis(id: string) {
    if (!confirm('Delete this analysis?')) return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for dip-analysis - RPC
      await fetch(`/api/retention/dip-analyses/${id}`, { method: 'DELETE' });
      setHistory((h) => h.filter((r) => r.id !== id));
      if (latestId === id) {
        setLatest(null);
        setLatestId(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Fix the dip</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Post-publish retention analysis. Pick a published video, paste the script that produced it, and we&apos;ll align every drop in the real curve to a script section + propose a concrete fix.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      <div className="glass rounded-xl p-5 mb-6">
        <Field label="YouTube video id" hint="The video must already be in your video_analytics cache. Open the schedule item and click Sync analytics if it isn't.">
          {videos.length > 0 ? (
            <div className="flex gap-2">
              <select
                value={youtubeVideoId}
                onChange={(e) => setYoutubeVideoId(e.target.value)}
                className="input-field flex-1"
                disabled={analyzing}
              >
                <option value="">— pick a published video —</option>
                {videos.map((v) => (
                  <option key={v.youtube_video_id} value={v.youtube_video_id}>
                    {v.title ?? v.youtube_video_id}
                    {v.average_view_percentage !== null
                      ? ` — ${v.average_view_percentage.toFixed(1)}% AVP`
                      : ''}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={youtubeVideoId}
                onChange={(e) => setYoutubeVideoId(e.target.value)}
                className="input-field"
                style={{ width: 180 }}
                placeholder="or paste id"
                disabled={analyzing}
              />
            </div>
          ) : (
            <input
              type="text"
              value={youtubeVideoId}
              onChange={(e) => setYoutubeVideoId(e.target.value)}
              className="input-field"
              placeholder="dQw4w9WgXcQ"
              disabled={analyzing}
            />
          )}
        </Field>
        <div className="mt-4">
          <Field label="Script">
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              className="input-field font-mono text-sm"
              rows={9}
              placeholder="Paste the script of the published video. Min 200 characters."
              disabled={analyzing}
            />
            <div className="text-[10px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
              {script.length} chars
            </div>
          </Field>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={analyze}
            disabled={analyzing || !youtubeVideoId.trim() || script.trim().length < 200}
            className="btn-primary text-sm"
          >
            {analyzing ? 'Analyzing dips…' : '▶ Find the dips'}
          </button>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Detection is deterministic (no LLM); the LLM only writes the per-dip fix.
          </span>
        </div>
      </div>

      {latest && (
        <DipAnalysisView
          analysis={latest.analysis}
          curve={latest.curve}
          videoTitle={latest.videoTitle}
          videoDuration={latest.videoDuration}
        />
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-3">History</h2>
        {history.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No analyses yet.
          </div>
        ) : (
          <div className="space-y-2">
            {history.map((row) => (
              <div key={row.id} className="glass rounded-xl px-4 py-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => loadHistorical(row.id)}
                  className="flex-1 text-left min-w-0"
                >
                  <div className="text-sm truncate">
                    {row.video_title ?? row.youtube_video_id} · {row.detected_dips.length} dips
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(row.created_at).toLocaleString()}
                    {row.average_view_percentage !== null &&
                      ` · ${row.average_view_percentage.toFixed(1)}% AVP`}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => deleteAnalysis(row.id)}
                  className="text-xs px-2 py-1 rounded"
                  style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </div>
  );
}

function DipAnalysisView({
  analysis,
  curve,
  videoTitle,
  videoDuration,
}: {
  analysis: DipAnalysis;
  curve: RetentionPoint[];
  videoTitle: string | null;
  videoDuration: number | null;
}) {
  return (
    <div className="space-y-5">
      {/* Curve with dip markers */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {videoTitle ?? '(untitled)'}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {analysis.detected_dips.length} dips detected
              {analysis.observed_avp_percentage !== null &&
                ` · observed ${analysis.observed_avp_percentage.toFixed(1)}% AVP`}
            </div>
          </div>
        </div>
        <CurveWithDipMarkers
          curve={curve}
          dips={analysis.detected_dips}
          duration={videoDuration ?? 0}
        />
      </div>

      {analysis.detected_dips.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center" style={{ color: 'var(--text-muted)' }}>
          {analysis.top_fixes[0] ?? 'No dips detected.'}
        </div>
      ) : (
        <>
          {/* Patterns first — they're more valuable than per-dip fixes */}
          {analysis.patterns.length > 0 && (
            <div className="glass rounded-xl p-5" style={{ borderLeft: '3px solid #fbbf24' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: '#fbbf24' }}>
                Cross-cutting patterns
              </h3>
              <div className="space-y-3">
                {analysis.patterns.map((p, idx) => (
                  <PatternRow key={idx} pattern={p} />
                ))}
              </div>
            </div>
          )}

          {/* Top fixes */}
          {analysis.top_fixes.length > 0 && (
            <div className="glass rounded-xl p-5" style={{ borderLeft: '3px solid #4ade80' }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: '#4ade80' }}>
                Top-impact fixes
              </h3>
              <ol className="space-y-2 list-decimal list-inside text-sm" style={{ color: 'var(--text-secondary)' }}>
                {analysis.top_fixes.map((f, idx) => (
                  <li key={idx}>{f}</li>
                ))}
              </ol>
            </div>
          )}

          {/* Per-dip table */}
          <div className="glass rounded-xl p-5">
            <h3 className="text-sm font-semibold mb-3">Each dip</h3>
            <div className="space-y-3">
              {analysis.detected_dips.map((d, idx) => (
                <DipRow key={idx} dip={d} index={idx} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PatternRow({ pattern }: { pattern: DipPattern }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {pattern.pattern}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          affects dips {pattern.affected_dip_indices.map((i) => i + 1).join(', ')}
        </span>
      </div>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{pattern.recommendation}</p>
    </div>
  );
}

function DipRow({ dip, index }: { dip: RetentionDip; index: number }) {
  const sevColor = dip.severity === 'cliff' ? '#f87171' : dip.severity === 'major' ? '#fb923c' : dip.severity === 'moderate' ? '#fbbf24' : '#a3a3a3';
  return (
    <div
      className="rounded p-3"
      style={{ borderLeft: `3px solid ${sevColor}`, background: 'rgba(255,255,255,0.02)' }}
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          #{index + 1} · {fmtTime(dip.start_seconds)} → {fmtTime(dip.end_seconds)}
        </span>
        <span className="text-sm font-semibold" style={{ color: sevColor }}>
          −{dip.drop_pct.toFixed(1)} pts ({(dip.retention_before * 100).toFixed(0)}% → {(dip.retention_after * 100).toFixed(0)}%)
        </span>
      </div>
      {dip.script_excerpt && (
        <p className="text-xs italic mb-2" style={{ color: 'var(--text-muted)' }}>
          &ldquo;{dip.script_excerpt}&rdquo;
        </p>
      )}
      <div className="text-sm space-y-1" style={{ color: 'var(--text-secondary)' }}>
        <div><strong>Why:</strong> {dip.why}</div>
        <div>
          <strong style={{ color: '#4ade80' }}>Fix:</strong> {dip.fix}
          {dip.estimated_lift_pct !== undefined && dip.estimated_lift_pct > 0 && (
            <span className="text-xs ml-2" style={{ color: 'var(--text-muted)' }}>
              (~+{dip.estimated_lift_pct.toFixed(1)} pt lift)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CurveWithDipMarkers({
  curve,
  dips,
  duration,
}: {
  curve: RetentionPoint[];
  dips: RetentionDip[];
  duration: number;
}) {
  if (curve.length < 2) {
    return (
      <div className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
        Curve unavailable.
      </div>
    );
  }
  const W = 720;
  const H = 180;
  const xs = curve.map((p) => Math.max(0, Math.min(1, p.position)));
  const ys = curve.map((p) => Math.max(0, Math.min(1, p.retention)));
  const path = curve
    .map((_p, i) => {
      const x = xs[i]! * W;
      const y = H - ys[i]! * H;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;
  const finalRetention = ys[ys.length - 1]!;
  const stroke = finalRetention > 0.4 ? '#4ade80' : finalRetention > 0.2 ? '#fbbf24' : '#f87171';

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Retention curve with dips marked"
      style={{ display: 'block' }}
    >
      {[0.25, 0.5, 0.75].map((y) => (
        <line key={y} x1="0" y1={H - y * H} x2={W} y2={H - y * H} stroke="rgba(255,255,255,0.06)" strokeDasharray="3 5" />
      ))}
      <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(255,255,255,0.15)" />
      <path d={areaPath} fill={stroke} fillOpacity="0.10" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2.5" />
      {/* Dip overlays */}
      {duration > 0 && dips.map((dip, idx) => {
        const x1 = (dip.start_seconds / duration) * W;
        const x2 = (dip.end_seconds / duration) * W;
        const fillColor = dip.severity === 'cliff' ? 'rgba(248,113,113,0.20)' : dip.severity === 'major' ? 'rgba(251,146,60,0.20)' : 'rgba(251,191,36,0.15)';
        return (
          <g key={idx}>
            <rect x={x1} y={0} width={Math.max(2, x2 - x1)} height={H} fill={fillColor} />
            <text x={(x1 + x2) / 2} y={14} fontSize="10" textAnchor="middle" fill="var(--text-secondary)">
              #{idx + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
