'use client';

/**
 * Phase 9.6 — inline opt-in toggle for the weekly digest.
 *
 * Rendered on the permalink page so users can enable / disable +
 * override the email recipients without leaving for /settings. Uses
 * the existing /api/insights/preferences GET+POST pair. Optimistic
 * UI on toggle (rolls back on a non-OK response).
 */
import { useEffect, useState } from 'react';

interface Prefs {
  enabled: boolean;
  email_recipients: string | null;
}

export function DigestPreferencesPanel() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/insights/preferences', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as Prefs;
        if (cancelled) return;
        setPrefs(data);
        setEmailDraft(data.email_recipients ?? '');
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!prefs) return null;

  async function persist(next: Partial<Prefs>): Promise<boolean> {
    setSaving(true);
    setSavedNotice(null);
    try {
      const res = await fetch('/api/insights/preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setSavedNotice(j.error ?? 'Could not save.');
        return false;
      }
      return true;
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      style={{
        marginTop: 32,
        padding: 16,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
      }}
    >
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 12,
        }}
      >
        Digest preferences
      </h2>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={prefs.enabled}
          disabled={saving}
          onChange={async (e) => {
            const wanted = e.target.checked;
            // Optimistic
            setPrefs({ ...prefs, enabled: wanted });
            const ok = await persist({ enabled: wanted });
            if (!ok) setPrefs((p) => (p ? { ...p, enabled: !wanted } : p));
            else setSavedNotice('Saved.');
          }}
        />
        <span style={{ color: 'var(--text-primary)' }}>
          Send the weekly digest for this workspace
        </span>
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        <label
          htmlFor="digest-emails"
          style={{ color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontSize: 10 }}
        >
          Email recipients (comma-separated; blank = workspace owner)
        </label>
        <input
          id="digest-emails"
          type="text"
          value={emailDraft}
          onChange={(e) => setEmailDraft(e.target.value)}
          placeholder="you@example.com, teammate@example.com"
          style={{
            width: '100%',
            padding: '6px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={async () => {
            const ok = await persist({ email_recipients: emailDraft.trim() || null });
            if (ok) {
              setPrefs((p) =>
                p ? { ...p, email_recipients: emailDraft.trim() || null } : p,
              );
              setSavedNotice('Saved.');
            }
          }}
          disabled={saving || emailDraft === (prefs.email_recipients ?? '')}
          className="btn-secondary"
          style={{ alignSelf: 'flex-start', fontSize: 11, marginTop: 4 }}
        >
          {saving ? 'Saving…' : 'Save email list'}
        </button>
      </div>

      {savedNotice && (
        <p style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>{savedNotice}</p>
      )}
    </section>
  );
}
