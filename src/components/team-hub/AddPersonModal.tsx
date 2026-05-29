'use client';

import { useEffect, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';

/**
 * Add Person modal — "+ Add" button on the LeftRail opens this. Per the
 * plan's Option 3c hybrid, every role is addable from the hub:
 *
 *   - Collaborator roles (narrator/editor/reviewer/client) → POST
 *     /api/team/collaborators with the picked role(s).
 *   - Channel editor → first picks a channel, then POSTs to
 *     /api/channels/[id]/editors with the editor name + email. Same
 *     backend code path the /schedule + brand-kit pages already use.
 *
 * The picked-role flow drives the second step's shape:
 *   - 'collaborator' step: name + email + role chip (multi-role
 *     management lives in the Settings tab once added)
 *   - 'channel-editor-pick' step: channel select + name + email
 *
 * On success, fires onCreated(id) so the parent can refresh the rail
 * and select the new entry.
 */

const COLLAB_ROLES = ['narrator', 'editor', 'reviewer', 'client'] as const;
type CollabRole = (typeof COLLAB_ROLES)[number];

const ROLE_BLURB: Record<CollabRole | 'channel_editor', string> = {
  narrator: 'Records voiceovers from your scripts.',
  editor: 'Edits the video and uploads versions for review.',
  reviewer: 'Watches review versions and posts timestamped feedback.',
  client: 'External stakeholder with read or comment access.',
  channel_editor: 'Manages a single channel\'s schedule.',
};

const ROLE_CHIP_COLORS: Record<CollabRole | 'channel_editor', { bg: string; text: string }> = {
  narrator:       { bg: 'rgba(124,58,237,0.18)', text: '#a78bfa' },
  editor:         { bg: 'rgba(59,130,246,0.18)', text: '#60a5fa' },
  reviewer:       { bg: 'rgba(6,182,212,0.18)',  text: '#67e8f9' },
  client:         { bg: 'rgba(234,179,8,0.18)',  text: '#facc15' },
  channel_editor: { bg: 'rgba(245,158,11,0.18)', text: '#fbbf24' },
};

interface ChannelOption {
  id: string;
  name: string;
}

interface AddPersonModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (newEntryId: string) => void;
}

type Step = 'pick-role' | 'collaborator' | 'channel-editor';

export function AddPersonModal({ open, onClose, onCreated }: AddPersonModalProps) {
  const [step, setStep] = useState<Step>('pick-role');
  const [pickedRole, setPickedRole] = useState<CollabRole | 'channel_editor' | null>(null);

  // Collaborator form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  // Channel-editor form
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [pickedChannelId, setPickedChannelId] = useState('');

  const [submitting, setSubmitting] = useState(false);

  // Reset on open/close so a stale form doesn't leak between sessions.
  useEffect(() => {
    if (!open) {
      setStep('pick-role');
      setPickedRole(null);
      setName('');
      setEmail('');
      setPickedChannelId('');
    }
  }, [open]);

  // Lazy-load channels when the user picks the channel-editor flow.
  useEffect(() => {
    if (step !== 'channel-editor') return;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/channels', { cache: 'no-store' })
      .then(async (r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list: ChannelOption[] = Array.isArray(data) ? data : Array.isArray(data?.channels) ? data.channels : [];
        setChannels(list);
        if (list.length > 0 && !pickedChannelId) setPickedChannelId(list[0].id);
      })
      .catch(() => setChannels([]));
  }, [step, pickedChannelId]);

  const handlePickRole = useCallback((role: CollabRole | 'channel_editor') => {
    setPickedRole(role);
    setStep(role === 'channel_editor' ? 'channel-editor' : 'collaborator');
  }, []);

  const handleCreateCollaborator = useCallback(async () => {
    if (!pickedRole || pickedRole === 'channel_editor') return;
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSubmitting(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/team/collaborators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || undefined,
          roles: [pickedRole],
        }),
      });
      if (!res.ok) throw new Error('create failed');
      const data = await res.json();
      toast.success('Added');
      onCreated(data.id);
      onClose();
    } catch {
      toast.error('Failed to add');
    } finally {
      setSubmitting(false);
    }
  }, [pickedRole, name, email, onCreated, onClose]);

  const handleCreateChannelEditor = useCallback(async () => {
    if (!pickedChannelId) {
      toast.error('Pick a channel');
      return;
    }
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSubmitting(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(`/api/channels/${pickedChannelId}/editors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim() || undefined }),
      });
      if (!res.ok) throw new Error('create failed');
      const data = await res.json();
      const newId = data?.editor?.id ? `${data.editor.id}@${pickedChannelId}` : '';
      toast.success(data?.existed ? 'Already on this channel — selected.' : 'Added');
      if (newId) onCreated(newId);
      onClose();
    } catch {
      toast.error('Failed to add');
    } finally {
      setSubmitting(false);
    }
  }, [pickedChannelId, name, email, onCreated, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.55)' }}
          />
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className="rounded-2xl shadow-2xl w-full max-w-lg pointer-events-auto"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <header
                className="flex items-center justify-between px-5 py-3 border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <div>
                  <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Add a team member
                  </h2>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {step === 'pick-role'
                      ? 'Pick the role they\'ll play.'
                      : step === 'collaborator'
                        ? `New ${pickedRole}`
                        : 'New channel editor'}
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="p-1 rounded-md hover:bg-white/5"
                  aria-label="Close"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </header>

              <div className="p-5">
                {step === 'pick-role' && (
                  <div className="space-y-2">
                    {(['narrator', 'editor', 'reviewer', 'client', 'channel_editor'] as const).map((role) => {
                      const c = ROLE_CHIP_COLORS[role];
                      return (
                        <button
                          key={role}
                          onClick={() => handlePickRole(role)}
                          className="w-full text-left rounded-lg p-3 flex items-start gap-3 transition-colors hover:bg-white/5"
                          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)' }}
                        >
                          <span
                            className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded shrink-0"
                            style={{ background: c.bg, color: c.text }}
                          >
                            {role === 'channel_editor' ? 'Channel editor' : role}
                          </span>
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {ROLE_BLURB[role]}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {step === 'collaborator' && (
                  <div className="space-y-3">
                    <Field label="Name">
                      <input
                        autoFocus
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateCollaborator()}
                        className="w-full px-3 py-2 rounded-md text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </Field>
                    <Field label="Email (optional)">
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full px-3 py-2 rounded-md text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </Field>
                  </div>
                )}

                {step === 'channel-editor' && (
                  <div className="space-y-3">
                    <Field label="Channel">
                      <select
                        value={pickedChannelId}
                        onChange={(e) => setPickedChannelId(e.target.value)}
                        className="w-full px-3 py-2 rounded-md text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      >
                        {channels.length === 0 ? (
                          <option value="">No channels yet</option>
                        ) : (
                          channels.map((ch) => (
                            <option key={ch.id} value={ch.id}>
                              {ch.name}
                            </option>
                          ))
                        )}
                      </select>
                    </Field>
                    <Field label="Name">
                      <input
                        autoFocus
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleCreateChannelEditor()}
                        className="w-full px-3 py-2 rounded-md text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </Field>
                    <Field label="Email (optional)">
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full px-3 py-2 rounded-md text-sm outline-none"
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                    </Field>
                  </div>
                )}
              </div>

              <footer
                className="flex items-center justify-between px-5 py-3 border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                {step !== 'pick-role' ? (
                  <button
                    onClick={() => setStep('pick-role')}
                    className="text-xs px-2 py-1"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    ← Back
                  </button>
                ) : (
                  <span />
                )}
                {step === 'collaborator' && (
                  <button
                    onClick={handleCreateCollaborator}
                    disabled={submitting || !name.trim()}
                    className="text-xs px-3 py-1.5 rounded-md font-medium text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                  >
                    {submitting ? 'Adding…' : `Add ${pickedRole}`}
                  </button>
                )}
                {step === 'channel-editor' && (
                  <button
                    onClick={handleCreateChannelEditor}
                    disabled={submitting || !name.trim() || !pickedChannelId}
                    className="text-xs px-3 py-1.5 rounded-md font-medium text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
                  >
                    {submitting ? 'Adding…' : 'Add channel editor'}
                  </button>
                )}
              </footer>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
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
