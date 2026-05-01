'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  system_role: 'admin' | 'user';
  status: 'active' | 'suspended' | 'invited';
  role: string;
  has_password: boolean;
  workspace_count: number;
  workspace_names: string[] | null;
  last_login_at: string | null;
  created_at: string;
}

const WORKSPACE_ROLES = ['owner', 'member', 'editor', 'narrator', 'reviewer', 'client'] as const;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users');
      if (!res.ok) throw new Error('Failed to fetch users');
      const data = await res.json();
      setUsers(data.users || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          Users
        </h1>
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          + Create user
        </button>
      </div>

      {showCreate && (
        <CreateUserPanel
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {loading && <p style={{ color: 'var(--text-muted)' }}>Loading users…</p>}
      {error && (
        <div
          className="text-sm px-4 py-3 rounded-lg"
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && users.length > 0 && (
        <div
          className="rounded-lg overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>System role</Th>
                <Th>Status</Th>
                <Th>Workspaces</Th>
                <Th>Auth</Th>
                <Th>Last login</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr
                  key={u.id}
                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                >
                  <Td>{u.name}</Td>
                  <Td style={{ color: 'var(--text-secondary)' }}>{u.email ?? '—'}</Td>
                  <Td>
                    {u.system_role === 'admin' ? (
                      <span style={badgeStyle('#0ea5e9')}>admin</span>
                    ) : (
                      <span style={badgeStyle('#64748b')}>user</span>
                    )}
                  </Td>
                  <Td>
                    {u.status === 'active' && <span style={badgeStyle('#10b981')}>active</span>}
                    {u.status === 'invited' && <span style={badgeStyle('#f59e0b')}>invited</span>}
                    {u.status === 'suspended' && (
                      <span style={badgeStyle('#ef4444')}>suspended</span>
                    )}
                  </Td>
                  <Td style={{ color: 'var(--text-muted)' }}>
                    {u.workspace_count > 0
                      ? `${u.workspace_count} (${(u.workspace_names ?? []).join(', ')})`
                      : '—'}
                  </Td>
                  <Td style={{ color: 'var(--text-muted)' }}>
                    {u.has_password ? 'password' : 'token only'}
                  </Td>
                  <Td style={{ color: 'var(--text-muted)' }}>
                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/users/${u.id}`}
                      className="text-xs hover:underline"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      Manage →
                    </Link>
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

function CreateUserPanel({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [systemRole, setSystemRole] = useState<'user' | 'admin'>('user');
  const [workspaceRole, setWorkspaceRole] = useState<(typeof WORKSPACE_ROLES)[number]>('editor');
  const [authMode, setAuthMode] = useState<'invite' | 'password' | 'token'>('invite');
  const [initialPassword, setInitialPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name,
        email,
        system_role: systemRole,
        workspace_role: workspaceRole,
      };
      if (authMode === 'invite') body.send_invite = true;
      if (authMode === 'password') body.initial_password = initialPassword;
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create user');
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 20,
        marginBottom: 20,
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          Create user
        </h2>
        <button onClick={onClose} className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Cancel
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <input
              className="input-field"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className="input-field"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="System role">
            <select
              className="input-field"
              value={systemRole}
              onChange={e => setSystemRole(e.target.value as 'admin' | 'user')}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </Field>
          <Field label="Workspace role">
            <select
              className="input-field"
              value={workspaceRole}
              onChange={e => setWorkspaceRole(e.target.value as (typeof WORKSPACE_ROLES)[number])}
            >
              {WORKSPACE_ROLES.map(r => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Authentication">
          <div className="flex gap-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMode === 'invite'}
                onChange={() => setAuthMode('invite')}
              />{' '}
              Email invite link
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMode === 'password'}
                onChange={() => setAuthMode('password')}
              />{' '}
              Set password now
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={authMode === 'token'}
                onChange={() => setAuthMode('token')}
              />{' '}
              Token portal only (no login)
            </label>
          </div>
        </Field>
        {authMode === 'password' && (
          <Field label="Password (12+ characters)">
            <input
              type="password"
              className="input-field"
              value={initialPassword}
              onChange={e => setInitialPassword(e.target.value)}
              minLength={12}
              required
            />
          </Field>
        )}
        {error && (
          <div
            className="text-sm px-4 py-3 rounded-lg"
            style={{
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444',
            }}
          >
            {error}
          </div>
        )}
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </form>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '10px 14px',
        fontWeight: 500,
        fontSize: 12,
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        letterSpacing: 0.5,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: '10px 14px', ...(style ?? {}) }}>{children}</td>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="block text-sm font-medium mb-1"
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    background: `${color}22`,
    border: `1px solid ${color}66`,
    color,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  };
}
