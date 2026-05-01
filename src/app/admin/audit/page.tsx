'use client';

import { useEffect, useState } from 'react';

interface AuditEntry {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  target_user_id: string | null;
  target_email: string | null;
  target_name: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export default function AdminAuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>('');

  useEffect(() => {
    setLoading(true);
    const qs = actionFilter ? `?action=${encodeURIComponent(actionFilter)}` : '';
    fetch(`/api/admin/audit-log${qs}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then(d => setEntries(d.entries || []))
      .catch(e => setError(e instanceof Error ? e.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }, [actionFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Audit log
        </h1>
        <select
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          className="input-field"
          style={{ width: 'auto' }}
        >
          <option value="">All actions</option>
          <option value="user.create">user.create</option>
          <option value="user.update">user.update</option>
          <option value="user.delete">user.delete</option>
          <option value="user.suspend">user.suspend</option>
          <option value="user.unsuspend">user.unsuspend</option>
          <option value="user.set_password">user.set_password</option>
          <option value="user.issue_invite">user.issue_invite</option>
          <option value="user.issue_password_reset">user.issue_password_reset</option>
        </select>
      </div>

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
      {error && <p style={{ color: '#ef4444' }}>{error}</p>}

      {!loading && !error && (
        <div
          className="rounded-lg overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Actor</th>
                <th style={th}>Action</th>
                <th style={th}>Target</th>
                <th style={th}>IP</th>
                <th style={th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={td}>{new Date(e.created_at).toLocaleString()}</td>
                  <td style={td}>{e.actor_email ?? e.actor_name ?? e.actor_user_id}</td>
                  <td style={td}>
                    <code style={{ fontSize: 12 }}>{e.action}</code>
                  </td>
                  <td style={td}>
                    {e.target_email ?? e.target_name ?? e.target_user_id ?? '—'}
                  </td>
                  <td style={td} title={e.ip_address ?? undefined}>
                    {e.ip_address ?? '—'}
                  </td>
                  <td style={{ ...td, fontSize: 12, color: 'var(--text-muted)' }}>
                    {Object.keys(e.metadata).length > 0
                      ? JSON.stringify(e.metadata)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontWeight: 500,
  fontSize: 11,
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  letterSpacing: 0.5,
};

const td: React.CSSProperties = { padding: '8px 14px' };
