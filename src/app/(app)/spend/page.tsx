'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  SpendByDayRow,
  SpendByFeatureRow,
  SpendByModelRow,
  SpendByProjectRow,
  SpendRecentExpensiveRow,
  SpendSummary,
} from '@/lib/ai-spend';

const WINDOWS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export default function SpendPage() {
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/spend/summary?windowDays=${windowDays}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data.summary as SpendSummary);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays]);

  const dailyMax = useMemo(
    () => (summary ? Math.max(0.01, ...summary.by_day.map((d) => d.total_usd)) : 0.01),
    [summary],
  );

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">AI spend</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Per-call cost log across every Anthropic / OpenAI / Google call.
            Wired through generateText — features that opt in (currently retention-predictor, fix-the-dip, comment-triage) appear here automatically.
          </p>
        </div>
        <div className="flex gap-1 items-center">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              onClick={() => setWindowDays(w.days)}
              className="text-xs px-3 py-1 rounded-full"
              style={{
                background: windowDays === w.days ? 'rgba(168,85,247,0.18)' : 'var(--bg-card)',
                color: windowDays === w.days ? '#c084fc' : 'var(--text-secondary)',
                border: `1px solid ${windowDays === w.days ? 'rgba(168,85,247,0.4)' : 'var(--border)'}`,
              }}
            >
              {w.label}
            </button>
          ))}
          <button type="button" onClick={refresh} disabled={loading} className="text-xs px-3 py-1.5 rounded ml-2" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      {summary && (
        <>
          {/* Headline KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Kpi label={`Total — last ${summary.totals.window_days}d`} value={`$${summary.totals.workspace_total_usd.toFixed(2)}`} accent="#c084fc" />
            <Kpi label="Calls" value={summary.totals.total_calls.toLocaleString()} />
            <Kpi label="Input tokens" value={fmtTokens(summary.totals.total_input_tokens)} />
            <Kpi label="Output tokens" value={fmtTokens(summary.totals.total_output_tokens)} />
          </div>

          {/* Daily sparkline */}
          {summary.by_day.length > 0 && (
            <div className="glass rounded-xl p-5 mb-6">
              <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                Spend per day
              </h2>
              <DailyChart days={summary.by_day} max={dailyMax} />
            </div>
          )}

          {/* By feature + by model */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <BreakdownPanel
              title="By feature"
              empty="No spend in this window. Wire generateText callers with a `spend` context to populate."
              rows={summary.by_feature}
              renderRow={(r: SpendByFeatureRow) => (
                <BreakdownRow
                  key={r.feature_area}
                  label={r.feature_area}
                  total={r.total_usd}
                  count={r.calls}
                  share={r.share_of_total}
                />
              )}
            />
            <BreakdownPanel
              title="By model"
              empty="No spend in this window."
              rows={summary.by_model}
              renderRow={(r: SpendByModelRow) => (
                <BreakdownRow
                  key={`${r.model_id}-${r.provider}`}
                  label={r.model_id}
                  sublabel={r.provider}
                  total={r.total_usd}
                  count={r.calls}
                />
              )}
            />
          </div>

          {/* By project */}
          {summary.by_project.length > 0 && (
            <div className="glass rounded-xl p-5 mb-6">
              <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                By project
              </h2>
              <div className="space-y-1.5">
                {summary.by_project.map((r: SpendByProjectRow) => (
                  <BreakdownRow
                    key={r.project_id ?? 'no-project'}
                    label={r.project_title ?? '(unattributed)'}
                    sublabel={r.project_id ? r.project_id.slice(0, 8) : 'no project'}
                    total={r.total_usd}
                    count={r.calls}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Top 10 expensive calls */}
          {summary.recent_expensive.length > 0 && (
            <div className="glass rounded-xl p-5">
              <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                Most expensive calls (window's top 10)
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    <tr>
                      <Th>When</Th>
                      <Th>Feature</Th>
                      <Th>Model</Th>
                      <Th>Input tok</Th>
                      <Th>Output tok</Th>
                      <Th>Cost</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recent_expensive.map((r: SpendRecentExpensiveRow) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <Td>{new Date(r.occurred_at).toLocaleString()}</Td>
                        <Td>{r.feature_area}</Td>
                        <Td>{r.model_id}</Td>
                        <Td>{fmtTokens(r.input_tokens)}</Td>
                        <Td>{fmtTokens(r.output_tokens)}</Td>
                        <Td><span style={{ color: '#c084fc', fontWeight: 600 }}>${r.cost_usd_total.toFixed(4)}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color: accent ?? 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

function BreakdownPanel<T>({
  title,
  empty,
  rows,
  renderRow,
}: {
  title: string;
  empty: string;
  rows: T[];
  renderRow: (r: T) => React.ReactNode;
}) {
  return (
    <div className="glass rounded-xl p-5">
      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </h2>
      {rows.length === 0 ? (
        <div className="text-xs text-center py-6" style={{ color: 'var(--text-muted)' }}>
          {empty}
        </div>
      ) : (
        <div className="space-y-1.5">{rows.map(renderRow)}</div>
      )}
    </div>
  );
}

function BreakdownRow({
  label,
  sublabel,
  total,
  count,
  share,
}: {
  label: string;
  sublabel?: string;
  total: number;
  count: number;
  share?: number;
}) {
  return (
    <div className="rounded p-2" style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="flex items-baseline justify-between gap-3 mb-0.5">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{label}</div>
          {sublabel && (
            <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{sublabel}</div>
          )}
        </div>
        <div className="text-sm font-semibold tabular-nums shrink-0" style={{ color: '#c084fc' }}>
          ${total.toFixed(2)}
        </div>
      </div>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {count} call{count === 1 ? '' : 's'}
        {share !== undefined && ` · ${(share * 100).toFixed(0)}% of total`}
      </div>
      {share !== undefined && (
        <div className="mt-1 h-1 rounded overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <div style={{ width: `${Math.min(100, share * 100)}%`, background: '#c084fc', height: '100%' }} />
        </div>
      )}
    </div>
  );
}

function DailyChart({ days, max }: { days: SpendByDayRow[]; max: number }) {
  const W = 720;
  const H = 100;
  const barWidth = Math.max(2, W / days.length - 2);
  return (
    <div className="overflow-x-auto">
      <svg width="100%" viewBox={`0 0 ${W} ${H + 20}`} preserveAspectRatio="none" style={{ display: 'block' }}>
        {days.map((d, i) => {
          const x = (i * W) / days.length;
          const h = max > 0 ? (d.total_usd / max) * H : 0;
          const y = H - h;
          return (
            <g key={d.day}>
              <rect x={x} y={y} width={barWidth} height={h} fill="#c084fc" fillOpacity={0.7} />
              {(i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) && (
                <text x={x + barWidth / 2} y={H + 12} fontSize="9" fill="var(--text-muted)" textAnchor="middle">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '8px 12px',
        textAlign: 'left',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        fontSize: '0.7rem',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{children}</td>
  );
}
