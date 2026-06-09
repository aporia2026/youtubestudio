'use client';

import { useEffect, useState } from 'react';

/**
 * Admin spend-leaks viewer. Renders the data from
 * `/api/admin/spend-orphans` — rows in the `provider_generations`
 * ledger that represent wasted spend (charged at the provider, never
 * landed in `project_assets`, not recovered by the reconciliation
 * cron).
 *
 * Phase 5 of the persistence-rebuild follow-up. Replaces the original
 * "refund issuance" framing — this is a single-user app, so the
 * surface that actually matters is a personal spend-leak dashboard,
 * not a customer-refund queue.
 *
 * Layout: top row of summary cards (totals + by-provider + by-route),
 * then a scrollable table of individual orphan rows. Filters in the
 * header for the time window and status set.
 */

interface OrphanRow {
  id: string;
  created_at: string;
  updated_at: string;
  route: string;
  provider: string;
  provider_model: string | null;
  provider_request_id: string | null;
  status: string;
  failure_reason: string | null;
  cost_usd: number | null;
  project_id: string | null;
  row_index: number | null;
  slot: string | null;
  response_url: string | null;
  user_id: string | null;
  workspace_id: string | null;
}

interface ApiResponse {
  summary: {
    since_days: number;
    statuses: string | string[];
    total_orphans: number;
    total_cost_usd: number;
    by_provider: { provider: string; count: number; cost_usd: number }[];
    by_route: { route: string; count: number; cost_usd: number }[];
  };
  rows: OrphanRow[];
}

const STATUS_OPTIONS = [
  { value: 'refund_pending,failed', label: 'Leaks only (refund_pending + failed)' },
  { value: 'all', label: 'All rows (everything in the ledger)' },
  { value: 'delivered', label: 'Delivered but unattached (in grace window)' },
  { value: 'recovered', label: 'Recovered (cron auto-fixed)' },
];

export default function AdminSpendPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sinceDays, setSinceDays] = useState(30);
  const [statuses, setStatuses] = useState('refund_pending,failed');

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
       
      const res = await fetch(
        `/api/admin/spend-orphans?since_days=${sinceDays}&status=${encodeURIComponent(statuses)}&limit=500`,
        { cache: 'no-store' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceDays, statuses]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Spend leaks
        </h1>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            Window
            <select
              value={sinceDays}
              onChange={(e) => setSinceDays(Number(e.target.value))}
              style={selectStyle}
            >
              <option value={1}>Last 24h</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </label>
          <label className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            Status
            <select value={statuses} onChange={(e) => setStatuses(e.target.value)} style={selectStyle}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button onClick={refresh} className="btn-primary" disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(236, 72, 153, 0.12)',
            border: '1px solid rgba(236, 72, 153, 0.4)',
            color: '#f472b6',
            padding: '10px 14px',
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {data && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            <SummaryCard
              label="Total leak rows"
              value={data.summary.total_orphans.toString()}
              hint={`window: ${data.summary.since_days}d`}
            />
            <SummaryCard
              label="Total wasted spend"
              value={`$${data.summary.total_cost_usd.toFixed(2)}`}
              hint="sum of cost_usd across the rows (rows with null cost contribute $0)"
              accent="pink"
            />
            <SummaryCard
              label="By provider"
              value={`${data.summary.by_provider.length} provider${data.summary.by_provider.length === 1 ? '' : 's'}`}
              hint={data.summary.by_provider
                .slice(0, 3)
                .map((p) => `${p.provider}: $${p.cost_usd.toFixed(2)}`)
                .join(' · ') || '—'}
            />
            <SummaryCard
              label="By route"
              value={`${data.summary.by_route.length} route${data.summary.by_route.length === 1 ? '' : 's'}`}
              hint={data.summary.by_route
                .slice(0, 2)
                .map((r) => `${r.route.replace('/api/generate/production-doc/', '')}: $${r.cost_usd.toFixed(2)}`)
                .join(' · ') || '—'}
            />
          </div>

          <div style={tableWrap}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {['When', 'Status', 'Provider', 'Model', 'Route', 'Cost', 'Project', 'Slot', 'Reason'].map(
                    (h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ ...tdStyle, textAlign: 'center', padding: '32px 16px' }}>
                      No leaks in this window. The reconciliation cron is doing its job.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={tdStyle}>{new Date(r.created_at).toLocaleString()}</td>
                      <td style={tdStyle}>
                        <StatusPill status={r.status} />
                      </td>
                      <td style={tdStyle}>{r.provider}</td>
                      <td style={tdStyle}>{r.provider_model ?? '—'}</td>
                      <td style={{ ...tdStyle, fontSize: 11, color: 'var(--text-muted)' }}>
                        {r.route.replace('/api/generate/production-doc/', '/').replace('auto-pipeline:', 'ap:')}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {r.cost_usd !== null ? `$${r.cost_usd.toFixed(4)}` : '—'}
                      </td>
                      <td style={{ ...tdStyle, fontSize: 10, color: 'var(--text-muted)' }}>
                        {r.project_id ? `${r.project_id.slice(0, 8)}#${r.row_index ?? '?'}` : '—'}
                      </td>
                      <td style={tdStyle}>{r.slot ?? '—'}</td>
                      <td style={{ ...tdStyle, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.failure_reason ?? (r.status === 'delivered' ? '(unattached)' : '')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: 'pink';
}) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: `1px solid ${accent === 'pink' ? 'rgba(236, 72, 153, 0.3)' : 'var(--border)'}`,
        borderRadius: 8,
        padding: 14,
      }}
    >
      <div className="text-xs" style={{ color: 'var(--text-muted)', marginBottom: 4 }}>
        {label}
      </div>
      <div
        className="text-2xl font-semibold"
        style={{ color: accent === 'pink' ? '#f472b6' : 'var(--text-primary)' }}
      >
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-secondary)', marginTop: 6 }}>
        {hint}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    delivered: { bg: 'rgba(6, 182, 212, 0.15)', fg: '#22d3ee' },
    attached: { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10b981' },
    recovered: { bg: 'rgba(16, 185, 129, 0.15)', fg: '#10b981' },
    pending: { bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b' },
    failed: { bg: 'rgba(236, 72, 153, 0.15)', fg: '#f472b6' },
    refund_pending: { bg: 'rgba(236, 72, 153, 0.2)', fg: '#f472b6' },
    refunded: { bg: 'rgba(124, 58, 237, 0.15)', fg: '#9d5cff' },
  };
  const p = palette[status] ?? { bg: 'rgba(255,255,255,0.05)', fg: 'var(--text-secondary)' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10,
        background: p.bg,
        color: p.fg,
        fontFamily: 'monospace',
        letterSpacing: 0.3,
      }}
    >
      {status}
    </span>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  padding: '4px 8px',
  borderRadius: 4,
  fontSize: 12,
};

const tableWrap: React.CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  background: 'rgba(255,255,255,0.02)',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-secondary)',
};
