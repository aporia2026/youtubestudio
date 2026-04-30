'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Props {
  token: string;
  role: 'narrator' | 'editor';
}

/** Event keys the user can opt out of. The labels are tuned per role so a
 *  narrator sees narrator-relevant events first. */
const EVENT_META: Record<string, { label: string; description: string; roles: Array<'narrator' | 'editor'> }> = {
  retake_requested: { label: 'Retake requested',  description: 'When the owner asks for a re-record on a section', roles: ['narrator'] },
  narrator_assigned:{ label: 'New narration job', description: 'When a project is assigned to you',                  roles: ['narrator'] },
  editor_assigned:  { label: 'New editing job',   description: 'When a project is assigned to you',                  roles: ['editor'] },
  review_comment:   { label: 'New comments',      description: 'When the owner or another reviewer leaves feedback', roles: ['narrator', 'editor'] },
  comment_resolved: { label: 'Comments resolved', description: 'When your comments are marked resolved',             roles: ['narrator', 'editor'] },
  version_uploaded: { label: 'New video version', description: 'When a new edit is posted on a project you share',    roles: ['narrator', 'editor'] },
  status_changed:   { label: 'Project status',    description: 'When a project moves between stages',                roles: ['narrator', 'editor'] },
  deadline_reminder:{ label: 'Deadline reminders',description: 'Heads-up the day before something is due',           roles: ['narrator', 'editor'] },
};

export function NotificationPrefsPanel({ token, role }: Props) {
  const [enabled, setEnabled] = useState<boolean>(true);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/collaborator-prefs/${token}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setEnabled(!!d.notifications_enabled);
        setPrefs(d.notification_prefs || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [token]);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/collaborator-prefs/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      setEnabled(!!data.notifications_enabled);
      setPrefs(data.notification_prefs || {});
    } catch { toast.error('Failed to save'); }
    finally { setSaving(false); }
  }

  // The pref blob uses `false` to mean "muted". A missing key = receive.
  function isMuted(key: string): boolean { return prefs[key] === false; }
  function setKey(key: string, on: boolean) {
    // We store explicit booleans for clarity; even a 'true' is harmless.
    patch({ notification_prefs: { [key]: on } });
  }

  if (loading) {
    return <div className="h-[88px] rounded-xl animate-pulse" style={{ background: 'var(--bg-secondary)' }} />;
  }

  const events = Object.entries(EVENT_META).filter(([, m]) => m.roles.includes(role));

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Notifications</p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Pick what you want emails for. The bell shows everything regardless.</p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer shrink-0">
          <span className="text-[11px]" style={{ color: enabled ? '#22c55e' : 'var(--text-muted)' }}>
            {enabled ? 'Email on' : 'Email off'}
          </span>
          <button
            type="button"
            onClick={() => patch({ notifications_enabled: !enabled })}
            disabled={saving}
            className="relative w-9 h-5 rounded-full transition-colors"
            style={{ background: enabled ? '#22c55e' : 'rgba(255,255,255,0.15)' }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
            />
          </button>
        </label>
      </div>

      <div className="space-y-1.5" style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        {events.map(([key, m]) => {
          const muted = isMuted(key);
          return (
            <label key={key} className="flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-colors hover:bg-white/[0.03]">
              <input
                type="checkbox"
                checked={!muted}
                onChange={e => setKey(key, e.target.checked)}
                disabled={saving}
                className="mt-0.5 accent-purple-500"
              />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{m.label}</p>
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{m.description}</p>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
