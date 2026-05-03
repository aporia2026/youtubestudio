'use client';

import { useEffect, useState } from 'react';
import type {
  CannibalizationAlertRow,
  CannibalizationScanResult,
  CannibalRiskLevel,
  CannibalSide,
} from '@/lib/cannibalization-types';

export default function CannibalizationPage() {
  const [alerts, setAlerts] = useState<CannibalizationAlertRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<CannibalizationScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'dismissed'>('active');

  async function refreshList(status: 'active' | 'dismissed' = filter) {
    try {
      const res = await fetch(`/api/cannibalization/alerts?status=${status}&limit=200`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAlerts(((await res.json()).alerts as CannibalizationAlertRow[]) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    void refreshList(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function runScan() {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/cannibalization/scans', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      const result = (await res.json()) as CannibalizationScanResult;
      setLastScan(result);
      await refreshList('active');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function dismiss(id: string) {
    try {
      // Check res.ok — fetch() doesn't throw on 4xx/5xx, so without
      // this the local state drifts away from the server when the
      // API rejects (audit M3).
      const res = await fetch(`/api/cannibalization/alerts/${id}/dismiss`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setAlerts((curr) => curr.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dismiss failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">Cannibalization detector</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Cross-channel overlap warnings: when two of your channels are about to publish (or recently published) videos that compete for the same audience.
          </p>
        </div>
        <button
          type="button"
          onClick={runScan}
          disabled={scanning}
          className="btn-primary text-sm"
        >
          {scanning ? 'Scanning…' : '↻ Run scan'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      {lastScan && (
        <div className="glass rounded-xl p-4 mb-6 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Last scan: looked at <strong>{lastScan.candidates_considered}</strong> uploads,
          {' '}evaluated <strong>{lastScan.pairs_evaluated}</strong> cross-channel pairs in a
          {' '}±{lastScan.scanned_window_days}-day window,
          {' '}<strong>{lastScan.pairs_above_threshold}</strong> above similarity threshold,
          {' '}created <strong>{lastScan.alerts_created.length}</strong> new alerts (the rest were duplicates).
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <FilterPill label="Active" active={filter === 'active'} onClick={() => setFilter('active')} />
        <FilterPill label="Dismissed" active={filter === 'dismissed'} onClick={() => setFilter('dismissed')} />
        <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
          {alerts.length} {filter} alert{alerts.length === 1 ? '' : 's'}
        </span>
      </div>

      {alerts.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          {filter === 'active'
            ? 'No active cannibalization alerts. Run a scan to check.'
            : 'No dismissed alerts yet.'}
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((a) => (
            <AlertCard key={a.id} alert={a} onDismiss={filter === 'active' ? () => dismiss(a.id) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-3 py-1 rounded-full"
      style={{
        background: active ? 'rgba(168,85,247,0.18)' : 'var(--bg-card)',
        color: active ? '#c084fc' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'rgba(168,85,247,0.4)' : 'var(--border)'}`,
      }}
    >
      {label}
    </button>
  );
}

function AlertCard({
  alert,
  onDismiss,
}: {
  alert: CannibalizationAlertRow;
  onDismiss?: () => void;
}) {
  const riskColor = riskColorFor(alert.risk_level);
  return (
    <div
      className="glass rounded-xl p-5"
      style={{ borderLeft: `3px solid ${riskColor}` }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className="text-xs uppercase tracking-wider px-2 py-0.5 rounded"
            style={{ background: `${riskColor}22`, color: riskColor }}
          >
            {alert.risk_level} risk
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            similarity {(alert.similarity_score * 100).toFixed(0)}%
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            · detected {new Date(alert.detected_at).toLocaleString()}
          </span>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs px-2 py-1 rounded"
            style={{ background: 'rgba(120,120,120,0.10)', color: 'var(--text-muted)' }}
          >
            Dismiss
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-3">
        <SidePanel label="A" side={alert.pair_a} />
        <SidePanel label="B" side={alert.pair_b} />
      </div>
      {alert.why && (
        <div className="mb-2">
          <div className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>Why</div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{alert.why}</p>
        </div>
      )}
      {alert.recommended_fix && (
        <div>
          <div className="text-xs font-semibold mb-0.5" style={{ color: '#4ade80' }}>Fix</div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{alert.recommended_fix}</p>
        </div>
      )}
    </div>
  );
}

function SidePanel({ label, side }: { label: string; side: CannibalSide }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)' }}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-bold" style={{ color: 'var(--text-secondary)' }}>
          Variant {label}
        </span>
        <span className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {side.kind === 'video' ? 'published' : 'scheduled'}
        </span>
      </div>
      <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
        {side.title}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {side.channel_name ?? '(no channel)'}
        {side.publish_at && ` · ${new Date(side.publish_at).toLocaleDateString()}`}
      </div>
    </div>
  );
}

function riskColorFor(risk: CannibalRiskLevel): string {
  if (risk === 'high') return '#f87171';
  if (risk === 'medium') return '#fbbf24';
  return '#94a3b8';
}
