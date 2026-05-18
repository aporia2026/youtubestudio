'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Workspace admin detail page. Today it surfaces exactly one knob —
 * the per-workspace deep-analyzer daily cap override — because that's
 * the only workspace-level setting an admin needs to touch from a UI
 * (Phase 4 step 2 of `_plans/2026-05-18-youtube-deep-analyzer.md`).
 * Layout is intentionally a single Section so adding future
 * workspace-level settings is a copy-paste away.
 *
 * Auth: gated by `src/app/admin/layout.tsx` (server component) which
 * redirects non-admin sessions before this page renders. The
 * underlying API route at `/api/admin/workspaces/[id]/analyzer-cap`
 * does its own admin check, so this page is defence-in-depth, not the
 * primary gate.
 */
interface CapState {
  override: number | null;
  defaultCap: number;
}

export default function WorkspaceAdminDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [data, setData] = useState<CapState | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function refresh() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/workspaces/${id}/analyzer-cap`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed to fetch (${res.status})`);
      }
      const next = (await res.json()) as CapState;
      setData(next);
      setDraft(next.override === null ? '' : String(next.override));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      // Empty string = clear the override (fall back to defaultCap).
      // Anything else must parse to a non-negative integer.
      let next: number | null;
      const trimmed = draft.trim();
      if (trimmed === '') {
        next = null;
      } else {
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error('Override must be empty (use default) or a non-negative integer');
        }
        next = parsed;
      }
      const res = await fetch(`/api/admin/workspaces/${id}/analyzer-cap`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ override: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      const fresh = (await res.json()) as CapState;
      setData(fresh);
      setDraft(fresh.override === null ? '' : String(fresh.override));
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  }

  const effectiveCap = data ? (data.override ?? data.defaultCap) : null;
  const isDirty = data ? draft.trim() !== (data.override === null ? '' : String(data.override)) : false;

  return (
    <div>
      <header style={{ marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
            marginBottom: 8,
          }}
        >
          ← Back
        </button>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
          Workspace admin
        </h1>
        <p style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono, monospace)' }}>
          {id}
        </p>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: '8px 12px',
            borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.10)',
            border: '1px solid rgba(239, 68, 68, 0.30)',
            color: '#fca5a5',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <section
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-bright)',
          borderRadius: 10,
          padding: 18,
        }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: 0, marginBottom: 4 }}>
          Deep video analyzer · daily cap per user
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, marginTop: 0, marginBottom: 14 }}>
          Hard limit on how many <code>/analyze</code> runs each user in this workspace can start per 24-hour
          window. Defaults to{' '}
          <strong style={{ color: 'var(--text-secondary)' }}>{data?.defaultCap ?? '—'}</strong>. Leave the
          field blank to fall back to the default. Setting <code>0</code> disables the analyzer for this
          workspace entirely.
        </p>

        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          Override (blank = use default)
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            disabled={busy || !data}
            placeholder={data ? String(data.defaultCap) : ''}
            style={{
              width: 160,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid var(--border-bright)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !data || !isDirty}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              background: busy || !data || !isDirty ? 'var(--bg-input)' : '#7c3aed',
              color: busy || !data || !isDirty ? 'var(--text-muted)' : '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: busy || !data || !isDirty ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span style={{ color: '#86efac', fontSize: 12 }}>Saved.</span>
          )}
        </div>

        {data && (
          <p style={{ marginTop: 14, color: 'var(--text-muted)', fontSize: 12 }}>
            Effective cap right now:{' '}
            <strong style={{ color: 'var(--text-secondary)' }}>
              {effectiveCap === 0 ? 'disabled (0)' : `${effectiveCap} / user / day`}
            </strong>
            {data.override === null && ' — using default (no override set)'}
          </p>
        )}
      </section>

      <p style={{ marginTop: 18, color: 'var(--text-muted)', fontSize: 11 }}>
        Changes are append-only audited via{' '}
        <a href="/admin/audit" style={{ color: 'var(--text-secondary)' }}>
          /admin/audit
        </a>{' '}
        — search for <code>workspace.update</code> with{' '}
        <code>field: analyses_per_user_per_day_override</code>.
      </p>
    </div>
  );
}
