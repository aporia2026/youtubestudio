'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import type { RosterEntry } from '@/lib/team-hub-types';

/**
 * Settings tab — folds the legacy /team CRUD into the team hub for the
 * selected person. Two distinct shapes:
 *
 *   - Collaborator (narrator/editor/reviewer/client): name, email, color,
 *     roles, notes — plus revoke-all-access (a hard reset that drops
 *     review share links and marks narrator assignments completed).
 *
 *   - Channel editor: simpler — name, email, notes — plus remove-from-
 *     channel (DELETE channel_editor; FK ON DELETE SET NULL on
 *     schedule_items keeps historical rows but unlinks the editor).
 *
 * Writes go through the existing legacy endpoints (PATCH
 * /api/team/collaborators/[id] and PATCH /api/channel-editors/[id]).
 * Both predate the Phase 1 auth gate sweep; replacing them with authed
 * wrappers is tracked separately and out of scope for this commit.
 */

const ROLE_OPTIONS = ['narrator', 'editor', 'reviewer', 'client'] as const;
type Role = (typeof ROLE_OPTIONS)[number];

const ROLE_CHIP_COLORS: Record<Role, { bg: string; text: string }> = {
  narrator: { bg: 'rgba(124,58,237,0.15)', text: '#a78bfa' },
  editor:   { bg: 'rgba(59,130,246,0.15)', text: '#60a5fa' },
  reviewer: { bg: 'rgba(6,182,212,0.15)',  text: '#67e8f9' },
  client:   { bg: 'rgba(234,179,8,0.15)',  text: '#facc15' },
};

const COLOR_PALETTE = ['#7c3aed', '#06b6d4', '#f59e0b', '#ef4444', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

interface SettingsTabProps {
  entry: RosterEntry;
  /** Called when the entry has been mutated in a way that affects the
   *  rail (renamed, role changed, deleted) so the page can refetch the
   *  roster. */
  onChanged: () => void;
}

export function SettingsTab({ entry, onChanged }: SettingsTabProps) {
  if (entry.kind === 'channel_editor') {
    return <ChannelEditorSettings entry={entry} onChanged={onChanged} />;
  }
  return <CollaboratorSettings entry={entry} onChanged={onChanged} />;
}

// ── Collaborator settings ───────────────────────────────────────────

function CollaboratorSettings({ entry, onChanged }: SettingsTabProps) {
  const [name, setName] = useState(entry.name);
  const [email, setEmail] = useState(entry.email ?? '');
  const [color, setColor] = useState(entry.color);
  const [roles, setRoles] = useState<Role[]>(
    entry.roles.filter((r): r is Role => (ROLE_OPTIONS as readonly string[]).includes(r)),
  );
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  // Hydrate notes (the roster doesn't include notes — fetch the full
  // collaborator detail on mount).
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/team/collaborators/${entry.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.notes === 'string') setNotes(data.notes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const dirty =
    name !== entry.name ||
    (email || '') !== (entry.email ?? '') ||
    color !== entry.color ||
    JSON.stringify([...roles].sort()) !== JSON.stringify([...entry.roles].sort());

  const handleSave = useCallback(async () => {
    if (!name.trim() || roles.length === 0) {
      toast.error('Name and at least one role are required');
      return;
    }
    setSaving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      const res = await fetch(`/api/team/collaborators/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
          color,
          roles,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      toast.success('Saved');
      onChanged();
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [entry.id, name, email, color, roles, notes, onChanged]);

  const handleRevoke = useCallback(async () => {
    setRevoking(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(`/api/team/collaborators/${entry.id}/revoke-all`, { method: 'POST' });
      if (!res.ok) throw new Error('revoke failed');
      toast.success('Access revoked');
      setShowRevokeConfirm(false);
      onChanged();
    } catch {
      toast.error('Failed to revoke');
    } finally {
      setRevoking(false);
    }
  }, [entry.id, onChanged]);

  const portalUrl =
    entry.personal_token && entry.roles.includes('narrator')
      ? `/narrator/${entry.personal_token}`
      : entry.personal_token && entry.roles.includes('editor')
        ? `/editor/${entry.personal_token}`
        : null;

  return (
    <div className="px-6 py-5 space-y-4 max-w-2xl">
      {/* Personal portal URL */}
      {portalUrl && (
        <Section title="Personal portal">
          <div
            className="flex items-center gap-2 rounded-lg p-3"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
          >
            <code className="text-[11px] truncate flex-1" style={{ color: 'var(--text-muted)' }}>
              {portalUrl}
            </code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${window.location.origin}${portalUrl}`);
                  toast.success('Copied');
                } catch {
                  toast.error('Could not copy');
                }
              }}
              className="text-[11px] px-2 py-1 rounded-md font-medium"
              style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
            >
              Copy
            </button>
          </div>
        </Section>
      )}

      {/* Identity */}
      <Section title="Identity">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </Field>
        </div>
      </Section>

      {/* Avatar colour */}
      <Section title="Avatar colour">
        <div className="flex items-center gap-2 flex-wrap">
          {COLOR_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-8 h-8 rounded-full transition-transform"
              style={{
                background: c,
                outline: color === c ? '2px solid #fff' : 'none',
                outlineOffset: 2,
              }}
              aria-label={`Pick ${c}`}
            />
          ))}
        </div>
      </Section>

      {/* Roles */}
      <Section title="Roles">
        <div className="flex items-center gap-2 flex-wrap">
          {ROLE_OPTIONS.map((r) => {
            const checked = roles.includes(r);
            const c = ROLE_CHIP_COLORS[r];
            return (
              <button
                key={r}
                type="button"
                onClick={() =>
                  setRoles((prev) => (checked ? prev.filter((x) => x !== r) : [...prev, r]))
                }
                className="px-3 py-1 rounded-full text-xs font-medium capitalize transition-colors"
                style={{
                  background: checked ? c.bg : 'transparent',
                  color: checked ? c.text : 'var(--text-muted)',
                  border: `1px solid ${checked ? c.text : 'var(--border)'}`,
                }}
              >
                {r}
              </button>
            );
          })}
        </div>
      </Section>

      {/* Notes */}
      <Section title="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Pronunciation notes, preferred turnaround, anything else."
          className="w-full px-3 py-2 rounded-md text-sm outline-none resize-y"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
      </Section>

      {/* Save / Cancel */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="text-xs px-3 py-1.5 rounded-md font-medium text-white transition-opacity disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {/* Revoke all */}
      <Section title="Danger zone">
        <div
          className="rounded-lg p-3 flex items-center justify-between gap-3"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: '#fda4af' }}>
              Revoke all access
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Deletes review share links and marks narrator assignments as completed. The collaborator row stays.
            </p>
          </div>
          {showRevokeConfirm ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={handleRevoke}
                disabled={revoking}
                className="text-xs px-3 py-1.5 rounded-md font-medium text-white"
                style={{ background: '#ef4444' }}
              >
                {revoking ? 'Revoking…' : 'Confirm revoke'}
              </button>
              <button
                onClick={() => setShowRevokeConfirm(false)}
                className="text-xs px-2 py-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowRevokeConfirm(true)}
              className="text-xs px-3 py-1.5 rounded-md font-medium shrink-0"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#fda4af', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              Revoke all access
            </button>
          )}
        </div>
      </Section>
    </div>
  );
}

// ── Channel editor settings ─────────────────────────────────────────

function ChannelEditorSettings({ entry, onChanged }: SettingsTabProps) {
  // entry.id was composed as '<channel_editor.id>@<channel.id>'.
  const [editorId] = entry.id.split('@');

  const [name, setName] = useState(entry.name);
  const [email, setEmail] = useState(entry.email ?? '');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);

  const dirty = name !== entry.name || (email || '') !== (entry.email ?? '');

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      const res = await fetch(`/api/channel-editors/${editorId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || null, notes: notes.trim() || null }),
      });
      if (!res.ok) throw new Error('save failed');
      toast.success('Saved');
      onChanged();
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [editorId, name, email, notes, onChanged]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      const res = await fetch(`/api/channel-editors/${editorId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      toast.success('Removed');
      setShowRemoveConfirm(false);
      onChanged();
    } catch {
      toast.error('Failed to remove');
    } finally {
      setRemoving(false);
    }
  }, [editorId, onChanged]);

  return (
    <div className="px-6 py-5 space-y-4 max-w-2xl">
      <Section title={`Editor of ${entry.channel_name ?? 'channel'}`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md text-sm outline-none"
              style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </Field>
        </div>
      </Section>

      <Section title="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Anything specific to this channel-editor relationship."
          className="w-full px-3 py-2 rounded-md text-sm outline-none resize-y"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
        />
      </Section>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="text-xs px-3 py-1.5 rounded-md font-medium text-white transition-opacity disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      <Section title="Danger zone">
        <div
          className="rounded-lg p-3 flex items-center justify-between gap-3"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <div>
            <p className="text-xs font-semibold" style={{ color: '#fda4af' }}>
              Remove from channel
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Deletes the channel-editor row. Past schedule items stay but lose the editor link.
            </p>
          </div>
          {showRemoveConfirm ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={handleRemove}
                disabled={removing}
                className="text-xs px-3 py-1.5 rounded-md font-medium text-white"
                style={{ background: '#ef4444' }}
              >
                {removing ? 'Removing…' : 'Confirm remove'}
              </button>
              <button
                onClick={() => setShowRemoveConfirm(false)}
                className="text-xs px-2 py-1.5"
                style={{ color: 'var(--text-muted)' }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowRemoveConfirm(true)}
              className="text-xs px-3 py-1.5 rounded-md font-medium shrink-0"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#fda4af', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              Remove
            </button>
          )}
        </div>
      </Section>
    </div>
  );
}

// ── Layout helpers ─────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }}>
      <h4 className="text-[10px] uppercase tracking-wider font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
        {title}
      </h4>
      {children}
    </motion.section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-medium mb-1" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}
