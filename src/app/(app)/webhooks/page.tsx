'use client';

import { useEffect, useState } from 'react';
import {
  WEBHOOK_EVENT_TYPES,
  type WebhookDeliveryRow,
  type WebhookKind,
  type WebhookSubscriptionRow,
} from '@/lib/webhooks-types';

export default function WebhooksPage() {
  const [subs, setSubs] = useState<WebhookSubscriptionRow[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create-form state
  const [kind, setKind] = useState<WebhookKind>('slack');
  const [label, setLabel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [filters, setFilters] = useState<string[]>([]);
  const [testToast, setTestToast] = useState<string | null>(null);

  async function refresh() {
    try {
      const [subsRes, deliveriesRes] = await Promise.all([
        fetch('/api/webhooks/subscriptions', { cache: 'no-store' }),
        fetch('/api/webhooks/deliveries?limit=30', { cache: 'no-store' }),
      ]);
      if (subsRes.ok) setSubs(((await subsRes.json()).subscriptions as WebhookSubscriptionRow[]) || []);
      if (deliveriesRes.ok) setDeliveries(((await deliveriesRes.json()).deliveries as WebhookDeliveryRow[]) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createSub() {
    if (!webhookUrl.trim()) {
      setError('Webhook URL is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/webhooks/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, label, webhookUrl, eventFilters: filters }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      setLabel('');
      setWebhookUrl('');
      setFilters([]);
      setShowCreate(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(sub: WebhookSubscriptionRow) {
    try {
      await fetch(`/api/webhooks/subscriptions/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function updateFilters(sub: WebhookSubscriptionRow, next: string[]) {
    try {
      await fetch(`/api/webhooks/subscriptions/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventFilters: next }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function deleteSub(id: string) {
    if (!confirm('Delete this webhook subscription?')) return;
    try {
      await fetch(`/api/webhooks/subscriptions/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function sendTest(id: string) {
    setTestToast('Sending…');
    try {
      const res = await fetch(`/api/webhooks/subscriptions/${id}/test`, { method: 'POST' });
      const data = await res.json();
      setTestToast(data.message || (data.ok ? 'Sent.' : 'Failed.'));
      await refresh();
    } catch (e) {
      setTestToast(e instanceof Error ? e.message : 'Test failed');
    }
    setTimeout(() => setTestToast(null), 4000);
  }

  function toggleFilter(value: string) {
    setFilters((curr) => (curr.includes(value) ? curr.filter((f) => f !== value) : [...curr, value]));
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">Webhooks</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Push studio events (A/B winners, cannibalization alerts, panel completions) into Slack or Discord.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="btn-primary text-sm"
        >
          {showCreate ? 'Cancel' : '＋ New webhook'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}
      {testToast && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(96,165,250,0.10)', color: '#60a5fa' }}>
          {testToast}
        </div>
      )}

      {showCreate && (
        <div className="glass rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold mb-4">New webhook subscription</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Kind">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as WebhookKind)}
                className="input-field"
              >
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="generic">Generic (raw JSON POST)</option>
              </select>
            </Field>
            <Field label="Label">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="input-field"
                placeholder="e.g. #studio-alerts"
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Webhook URL" hint={kind === 'slack' ? 'Slack incoming webhook (https://hooks.slack.com/...)' : kind === 'discord' ? 'Discord channel webhook (https://discord.com/api/webhooks/...)' : 'Any HTTPS endpoint that accepts POST JSON.'}>
              <input
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="https://..."
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Events" hint="Leave all unchecked = subscribe to everything.">
              <div className="space-y-2 mt-1">
                {WEBHOOK_EVENT_TYPES.filter((e) => e.type !== 'test').map((e) => (
                  <label key={e.type} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.includes(e.type)}
                      onChange={() => toggleFilter(e.type)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{e.label}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{e.description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={createSub}
              disabled={busy || !webhookUrl.trim()}
              className="btn-primary text-sm"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
        Subscriptions ({subs.length})
      </h2>
      {subs.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No webhooks yet. Create one above.
        </div>
      ) : (
        <div className="space-y-3 mb-8">
          {subs.map((sub) => (
            <SubscriptionCard
              key={sub.id}
              sub={sub}
              onToggle={() => toggleEnabled(sub)}
              onUpdateFilters={(next) => updateFilters(sub, next)}
              onTest={() => sendTest(sub.id)}
              onDelete={() => deleteSub(sub.id)}
            />
          ))}
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
        Recent deliveries
      </h2>
      {deliveries.length === 0 ? (
        <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No deliveries yet.
        </div>
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <Th>When</Th>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>Duration</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <Td>{new Date(d.sent_at).toLocaleString()}</Td>
                  <Td>{d.event_type}</Td>
                  <Td>
                    <span style={{ color: d.succeeded ? '#4ade80' : '#f87171' }}>
                      {d.http_status ?? 'err'}
                    </span>
                  </Td>
                  <Td>{d.duration_ms !== null ? `${d.duration_ms}ms` : '—'}</Td>
                  <Td style={{ color: 'var(--text-muted)' }} title={d.error_message || d.response_body || ''}>
                    {(d.error_message || d.response_body || '').slice(0, 60)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

function SubscriptionCard({
  sub,
  onToggle,
  onUpdateFilters,
  onTest,
  onDelete,
}: {
  sub: WebhookSubscriptionRow;
  onToggle: () => void;
  onUpdateFilters: (next: string[]) => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const filters = sub.event_filters;
  function toggleFilter(value: string) {
    onUpdateFilters(filters.includes(value) ? filters.filter((f) => f !== value) : [...filters, value]);
  }
  return (
    <div
      className="glass rounded-xl p-4"
      style={{ opacity: sub.enabled ? 1 : 0.55 }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
          style={{
            background: sub.kind === 'slack' ? 'rgba(74,222,128,0.15)' : sub.kind === 'discord' ? 'rgba(168,85,247,0.15)' : 'rgba(120,120,120,0.15)',
            color: sub.kind === 'slack' ? '#4ade80' : sub.kind === 'discord' ? '#c084fc' : 'var(--text-muted)',
          }}
        >
          {sub.kind}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{sub.label}</div>
          <div className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>{sub.url_preview}</div>
        </div>
        <button type="button" onClick={onToggle} className="text-xs px-2 py-1 rounded" style={{ background: sub.enabled ? 'rgba(74,222,128,0.10)' : 'rgba(120,120,120,0.10)', color: sub.enabled ? '#4ade80' : 'var(--text-muted)' }}>
          {sub.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <button type="button" onClick={onTest} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>
          Test
        </button>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs px-2 py-1 rounded" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
          {open ? 'Hide' : 'Events'}
        </button>
        <button type="button" onClick={onDelete} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          ✕
        </button>
      </div>
      <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {filters.length === 0 ? 'Subscribed to ALL events' : `Subscribed to ${filters.length} event${filters.length === 1 ? '' : 's'}`}
        {sub.last_delivery_at && ` · last sent ${new Date(sub.last_delivery_at).toLocaleString()}`}
      </div>
      {open && (
        <div className="mt-3 pl-3 border-l space-y-2" style={{ borderColor: 'var(--border)' }}>
          {WEBHOOK_EVENT_TYPES.filter((e) => e.type !== 'test').map((e) => (
            <label key={e.type} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={filters.includes(e.type)}
                onChange={() => toggleFilter(e.type)}
                className="mt-0.5"
              />
              <div>
                <div className="text-xs" style={{ color: 'var(--text-primary)' }}>{e.label}</div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{e.description}</div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
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

function Td({ children, style, title }: { children: React.ReactNode; style?: React.CSSProperties; title?: string }) {
  return (
    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary)', ...style }} title={title}>
      {children}
    </td>
  );
}
