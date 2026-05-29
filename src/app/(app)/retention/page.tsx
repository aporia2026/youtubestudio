'use client';

import { useEffect, useState } from 'react';
import type {
  RetentionPoint,
  RetentionPrediction,
  RetentionPredictionRow,
  SegmentExplanation,
} from '@/lib/retention-predictor-types';

interface ChannelListItem {
  id: string;
  name: string;
  channel_id: string;
}

interface ProjectListItem {
  id: string;
  title: string;
  niche: string | null;
}

interface CreateResponse {
  id: string;
  prediction: RetentionPrediction;
}

export default function RetentionPage() {
  const [channels, setChannels] = useState<ChannelListItem[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [history, setHistory] = useState<RetentionPredictionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [channelDbId, setChannelDbId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [niche, setNiche] = useState('');
  const [script, setScript] = useState('');
  const [predicting, setPredicting] = useState(false);

  const [latestId, setLatestId] = useState<string | null>(null);
  const [latest, setLatest] = useState<RetentionPrediction | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [chRes, pRes, listRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads channels
          fetch('/api/channels'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads projects
          fetch('/api/projects?limit=100'),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads retention predictions
          fetch('/api/retention/predictions?limit=20'),
        ]);
        if (cancelled) return;
        if (chRes.ok) setChannels(((await chRes.json()).channels as ChannelListItem[]) || []);
        if (pRes.ok) setProjects(((await pRes.json()).projects as ProjectListItem[]) || []);
        if (listRes.ok)
          setHistory(((await listRes.json()).predictions as RetentionPredictionRow[]) || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-fill niche when a project is picked.
  useEffect(() => {
    if (!projectId) return;
    const p = projects.find((x) => x.id === projectId);
    if (p?.niche) setNiche((curr) => curr || p.niche!);
  }, [projectId, projects]);

  async function predict() {
    if (script.trim().length < 400) {
      setError('Script must be at least 400 characters for a meaningful prediction.');
      return;
    }
    setError(null);
    setPredicting(true);
    setLatest(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- retention-predict POST: awaits and uses response
      const res = await fetch('/api/retention/predictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script,
          niche: niche || undefined,
          channelDbId: channelDbId || null,
          projectId: projectId || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as CreateResponse;
      setLatest(data.prediction);
      setLatestId(data.id);
      // Refresh history.
      // eslint-disable-next-line no-restricted-syntax -- GET .then, refresh predictions
      fetch('/api/retention/predictions?limit=20', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.predictions && setHistory(d.predictions))
        .catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prediction failed');
    } finally {
      setPredicting(false);
    }
  }

  async function loadHistorical(id: string) {
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads prediction detail
      const res = await fetch(`/api/retention/predictions/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const row = data.prediction as RetentionPredictionRow;
      setLatestId(row.id);
      setLatest({
        curve: row.predicted_curve,
        predicted_avd_percentage: row.predicted_avd_percentage ?? 0,
        predicted_avd_seconds: row.predicted_avd_seconds ?? 0,
        segment_explanations: row.segment_explanations,
        biggest_drop: row.biggest_drop,
        suggested_fixes: row.suggested_fixes,
        few_shot_video_ids: row.few_shot_video_ids,
        few_shot_count: row.few_shot_count,
      });
      setScript(row.script_text);
      setNiche(row.niche ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load prediction');
    }
  }

  async function deletePrediction(id: string) {
    if (!confirm('Delete this prediction?')) return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE for prediction - RPC
      await fetch(`/api/retention/predictions/${id}`, { method: 'DELETE' });
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
        <h1 className="text-2xl font-bold mb-1">Retention predictor</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Forecast the audience-retention curve for a script before publishing. RAG over your channel&apos;s past videos: more analytics → better predictions.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      <div className="glass rounded-xl p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Field label="Channel" hint="Predictions get sharper when scoped to one channel's history.">
            <select
              value={channelDbId}
              onChange={(e) => setChannelDbId(e.target.value)}
              className="input-field"
              disabled={predicting}
            >
              <option value="">— any channel —</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Project (optional)">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="input-field"
              disabled={predicting}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Niche">
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              className="input-field"
              placeholder="e.g. AI tools, finance"
              disabled={predicting}
            />
          </Field>
        </div>
        <Field label="Script">
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            className="input-field font-mono text-sm"
            rows={9}
            placeholder="Paste the full script. Min 400 characters."
            disabled={predicting}
          />
          <div className="text-[10px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
            {script.length} chars
          </div>
        </Field>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={predict}
            disabled={predicting || script.trim().length < 400}
            className="btn-primary text-sm"
          >
            {predicting ? 'Predicting…' : '▶ Predict retention'}
          </button>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Few-shot scope: {channelDbId ? 'this channel' : 'whole workspace'}
          </span>
        </div>
      </div>

      {latest && <PredictionView prediction={latest} />}

      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-3">History</h2>
        {history.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No predictions yet.
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
                    {row.niche ?? '(no niche)'} · {row.word_count ?? 0} words · {row.estimated_duration_seconds ?? 0}s
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(row.created_at).toLocaleString()} · {row.few_shot_count} examples
                  </div>
                </button>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {row.predicted_avd_percentage !== null ? `${row.predicted_avd_percentage.toFixed(1)}% AVP` : '—'}
                </div>
                <button
                  type="button"
                  onClick={() => deletePrediction(row.id)}
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

function PredictionView({ prediction }: { prediction: RetentionPrediction }) {
  return (
    <div className="space-y-5">
      {/* Headline metrics */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-baseline gap-6 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Predicted AVP
            </div>
            <div className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {prediction.predicted_avd_percentage.toFixed(1)}%
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              ≈ {Math.floor(prediction.predicted_avd_seconds / 60)}:
              {String(prediction.predicted_avd_seconds % 60).padStart(2, '0')} of viewing time
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
              Few-shot examples
            </div>
            <div className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              {prediction.few_shot_count}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {prediction.few_shot_count === 0 ? '(cold start — niche conventions only)' : 'past videos used as RAG'}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <PredictedCurve points={prediction.curve} />
        </div>
      </div>

      {/* Biggest drop callout */}
      {prediction.biggest_drop && (
        <div className="glass rounded-xl p-5" style={{ borderLeft: '3px solid #f87171' }}>
          <div className="text-xs uppercase tracking-wider mb-1" style={{ color: '#f87171' }}>
            Biggest predicted drop
          </div>
          <div className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            {fmtTime(prediction.biggest_drop.start_seconds)} – {fmtTime(prediction.biggest_drop.end_seconds)} ·{' '}
            <span style={{ color: '#f87171' }}>−{prediction.biggest_drop.predicted_drop_pct.toFixed(0)} pts</span>
          </div>
          <div className="text-xs italic mb-2" style={{ color: 'var(--text-muted)' }}>
            &ldquo;{prediction.biggest_drop.excerpt}&rdquo;
          </div>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <strong>Why:</strong> {prediction.biggest_drop.reason}
            {prediction.biggest_drop.fix && (
              <>
                <br />
                <strong style={{ color: '#4ade80' }}>Fix:</strong> {prediction.biggest_drop.fix}
              </>
            )}
          </div>
        </div>
      )}

      {/* Per-segment table */}
      {prediction.segment_explanations.length > 0 && (
        <div className="glass rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3">Segment forecast</h3>
          <div className="space-y-2">
            {prediction.segment_explanations.map((seg, idx) => (
              <SegmentRow key={idx} seg={seg} />
            ))}
          </div>
        </div>
      )}

      {/* Suggested fixes */}
      {prediction.suggested_fixes.length > 0 && (
        <div className="glass rounded-xl p-5">
          <h3 className="text-sm font-semibold mb-3" style={{ color: '#4ade80' }}>
            Top-impact fixes
          </h3>
          <ol className="space-y-2 list-decimal list-inside text-sm" style={{ color: 'var(--text-secondary)' }}>
            {prediction.suggested_fixes.map((fix, idx) => (
              <li key={idx}>{fix}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function SegmentRow({ seg }: { seg: SegmentExplanation }) {
  const dropColor =
    seg.predicted_drop_pct >= 15 ? '#f87171' : seg.predicted_drop_pct >= 7 ? '#fbbf24' : '#4ade80';
  return (
    <div
      className="rounded p-3"
      style={{ borderLeft: `3px solid ${dropColor}`, background: 'rgba(255,255,255,0.02)' }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          {fmtTime(seg.start_seconds)} – {fmtTime(seg.end_seconds)}
        </span>
        <span className="text-sm font-semibold" style={{ color: dropColor }}>
          −{seg.predicted_drop_pct.toFixed(0)} pts · {seg.reason}
        </span>
      </div>
      {seg.excerpt && (
        <p className="text-xs italic mb-1" style={{ color: 'var(--text-muted)' }}>
          &ldquo;{seg.excerpt}&rdquo;
        </p>
      )}
      {seg.fix && (
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: '#4ade80' }}>Fix:</strong> {seg.fix}
        </p>
      )}
    </div>
  );
}

/** SVG sparkline of the predicted curve. */
function PredictedCurve({ points }: { points: RetentionPoint[] }) {
  if (points.length < 2) return null;
  const W = 720;
  const H = 160;
  const xs = points.map((p) => Math.max(0, Math.min(1, p.position)));
  const ys = points.map((p) => Math.max(0, Math.min(1, p.retention)));
  const path = points
    .map((_p, i) => {
      const x = xs[i]! * W;
      const y = H - ys[i]! * H;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  // Area fill to make small drops visually present.
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;
  const finalRetention = ys[ys.length - 1]!;
  const stroke = finalRetention > 0.4 ? '#4ade80' : finalRetention > 0.2 ? '#fbbf24' : '#f87171';
  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Predicted retention curve"
      style={{ display: 'block' }}
    >
      {/* gridlines */}
      {[0.25, 0.5, 0.75].map((y) => (
        <line
          key={y}
          x1="0"
          y1={H - y * H}
          x2={W}
          y2={H - y * H}
          stroke="rgba(255,255,255,0.06)"
          strokeDasharray="3 5"
        />
      ))}
      <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(255,255,255,0.15)" />
      <path d={areaPath} fill={stroke} fillOpacity="0.10" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="2.5" />
    </svg>
  );
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
