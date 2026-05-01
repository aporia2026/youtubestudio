'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';

interface AdminUserDetail {
  user: {
    id: string;
    name: string;
    email: string | null;
    system_role: 'admin' | 'user';
    status: 'active' | 'suspended' | 'invited';
    role: string;
    has_password: boolean;
    has_google: boolean;
    last_login_at: string | null;
    personal_token: string | null;
    unsubscribe_token: string | null;
  };
  memberships: Array<{ workspace_id: string; workspace_name: string; role: string }>;
}

export default function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`);
      if (!res.ok) throw new Error('Failed to fetch user');
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }
  useEffect(() => {
    void refresh();
  }, [id]);

  async function call(path: string, body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Operation failed');
      }
      return await res.json().catch(() => ({}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <p style={{ color: 'var(--text-muted)' }}>{error ?? 'Loading…'}</p>;
  }

  const u = data.user;

  async function setPassword() {
    const password = prompt('New password (12+ characters):');
    if (!password) return;
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    await call(`/api/admin/users/${id}/set-password`, { password });
    await refresh();
  }

  async function reissueInvite() {
    if (!confirm(`Re-issue invite link to ${u.email}?`)) return;
    await call(`/api/admin/users/${id}/issue-invite`, {});
    await refresh();
  }

  async function toggleSuspend() {
    const suspended = u.status !== 'suspended';
    if (!confirm(suspended ? `Suspend ${u.name}?` : `Re-activate ${u.name}?`)) return;
    await call(`/api/admin/users/${id}/suspend`, { suspended });
    await refresh();
  }

  async function patchUser(updates: Record<string, unknown>) {
    await call(`/api/admin/users/${id}`, updates, 'PATCH');
    await refresh();
  }

  async function deleteUser() {
    const typed = prompt(`Type the email "${u.email}" to confirm permanent deletion:`);
    if (typed !== u.email) {
      setError('Email did not match. Deletion cancelled.');
      return;
    }
    await call(`/api/admin/users/${id}`, undefined, 'DELETE');
    router.push('/admin');
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={() => router.push('/admin')}
          className="text-sm hover:underline mb-2"
          style={{ color: 'var(--text-muted)' }}
        >
          ← All users
        </button>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
          {u.name}
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{u.email ?? '— no email'}</p>
      </div>

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

      <Section title="Profile">
        <Row k="ID" v={u.id} />
        <Row k="Status" v={u.status} />
        <Row k="System role" v={u.system_role} />
        <Row k="Legacy role" v={u.role} />
        <Row k="Last login" v={u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'} />
        <div className="flex flex-wrap gap-2 mt-4">
          <button
            disabled={busy}
            onClick={() => {
              const newName = prompt('New name', u.name);
              if (newName && newName.trim() && newName !== u.name) {
                void patchUser({ name: newName.trim() });
              }
            }}
            className="btn-secondary"
          >
            Edit name
          </button>
          <button
            disabled={busy}
            onClick={() => {
              const newEmail = prompt('New email', u.email ?? '');
              if (newEmail !== null) void patchUser({ email: newEmail });
            }}
            className="btn-secondary"
          >
            Edit email
          </button>
          <button
            disabled={busy}
            onClick={() =>
              patchUser({ system_role: u.system_role === 'admin' ? 'user' : 'admin' })
            }
            className="btn-secondary"
          >
            {u.system_role === 'admin' ? 'Demote to user' : 'Promote to admin'}
          </button>
        </div>
      </Section>

      <Section title="Authentication">
        <Row k="Password set" v={u.has_password ? 'yes' : 'no'} />
        <Row k="Google linked" v={u.has_google ? 'yes' : 'no'} />
        <div className="flex flex-wrap gap-2 mt-4">
          <button disabled={busy} onClick={setPassword} className="btn-secondary">
            Set password
          </button>
          <button disabled={busy || !u.email} onClick={reissueInvite} className="btn-secondary">
            Send invite link
          </button>
          <button
            disabled={busy}
            onClick={toggleSuspend}
            className="btn-secondary"
            style={{
              color: u.status === 'suspended' ? '#10b981' : '#f59e0b',
            }}
          >
            {u.status === 'suspended' ? 'Re-activate account' : 'Suspend account'}
          </button>
        </div>
      </Section>

      <Section title="Workspace memberships">
        {data.memberships.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>No memberships</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.memberships.map(m => (
              <li
                key={`${m.workspace_id}-${m.role}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  fontSize: 14,
                }}
              >
                <span>{m.workspace_name}</span>
                <span style={{ color: 'var(--text-muted)' }}>{m.role}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Token portal URLs">
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 8 }}>
          These long-lived tokens grant access to the editor / narrator / reviewer portals
          without a login.
        </p>
        <Row k="Personal token" v={u.personal_token ?? '—'} mono />
        <Row k="Unsubscribe token" v={u.unsubscribe_token ?? '—'} mono />
      </Section>

      <Section title="Danger zone">
        <button
          disabled={busy}
          onClick={deleteUser}
          className="btn-secondary"
          style={{ color: '#ef4444', borderColor: '#ef444466' }}
        >
          Permanently delete user
        </button>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 20,
      }}
    >
      <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        padding: '4px 0',
        fontSize: 14,
      }}
    >
      <span style={{ color: 'var(--text-muted)', minWidth: 140 }}>{k}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : undefined,
          wordBreak: mono ? 'break-all' : undefined,
        }}
      >
        {v}
      </span>
    </div>
  );
}
