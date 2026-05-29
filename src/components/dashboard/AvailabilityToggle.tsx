'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

type Availability = 'available' | 'recording' | 'editing' | 'busy' | 'out' | null;

interface Props {
  token: string;
  /** Optional initial value to avoid the picker flickering empty on first render. */
  initial?: { availability: Availability; status_note: string | null };
  /** Show the editing-specific options. Narrators see 'recording', editors see 'editing'. */
  role: 'narrator' | 'editor';
}

const META: Record<Exclude<Availability, null>, { label: string; emoji: string; color: string }> = {
  available: { label: 'Available',  emoji: '🟢', color: '#22c55e' },
  recording: { label: 'Recording',  emoji: '🎙️', color: '#7c3aed' },
  editing:   { label: 'Editing',    emoji: '✂️', color: '#06b6d4' },
  busy:      { label: 'Busy',       emoji: '🔴', color: '#f97316' },
  out:       { label: 'Out',        emoji: '🌴', color: 'var(--text-muted)' },
};

/**
 * Self-reported availability + one-line status note. Surfaced to the
 * project owner on the team page so they know whether to ping someone
 * for a same-day deliverable. The collaborator picks an option and
 * optionally types a note ("Recording sessions till 6pm" / "Out till
 * Friday"). Persists to /api/collaborator-prefs.
 */
export function AvailabilityToggle({ token, initial, role }: Props) {
  const [availability, setAvailability] = useState<Availability>(initial?.availability ?? null);
  const [note, setNote] = useState(initial?.status_note ?? '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initial !== undefined) return;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch(`/api/collaborator-prefs/${token}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setAvailability(d.availability ?? null);
        setNote(d.status_note ?? '');
      })
      .catch(() => {});
  }, [token, initial]);

  // Narrators see 'recording', editors see 'editing'. Both see the rest.
  const opts: Array<Exclude<Availability, null>> = role === 'narrator'
    ? ['available', 'recording', 'busy', 'out']
    : ['available', 'editing', 'busy', 'out'];

  async function save(next: { availability?: Availability; status_note?: string }) {
    setSaving(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      const res = await fetch(`/api/collaborator-prefs/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          availability: next.availability !== undefined ? next.availability : availability,
          status_note: next.status_note !== undefined ? next.status_note : note,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setAvailability(data.availability);
      setNote(data.status_note || '');
      toast.success('Status updated');
    } catch {
      toast.error('Failed to save');
    } finally { setSaving(false); }
  }

  const current = availability ? META[availability] : null;

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'var(--text-muted)' }}>
          Your status
        </p>
        {!editing ? (
          <button onClick={() => setEditing(true)} className="text-[11px]" style={{ color: '#a78bfa' }}>
            Edit
          </button>
        ) : (
          <button onClick={() => setEditing(false)} className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Done
          </button>
        )}
      </div>

      {!editing ? (
        <div className="flex items-center gap-2">
          {current ? (
            <>
              <span className="text-base">{current.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold" style={{ color: current.color }}>{current.label}</p>
                {note && <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>{note}</p>}
              </div>
            </>
          ) : (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Set your status so the team knows when you&apos;re available.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {opts.map(o => {
              const m = META[o];
              const active = availability === o;
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => save({ availability: o })}
                  disabled={saving}
                  className="px-2 py-1 rounded-full text-[11px] font-medium transition-all flex items-center gap-1"
                  style={{
                    background: active ? `${m.color}22` : 'transparent',
                    color: active ? m.color : 'var(--text-muted)',
                    border: `1px solid ${active ? m.color : 'var(--border)'}`,
                  }}
                >
                  <span>{m.emoji}</span>
                  <span>{m.label}</span>
                </button>
              );
            })}
            {availability && (
              <button
                type="button"
                onClick={() => save({ availability: null, status_note: '' })}
                className="px-2 py-1 rounded-full text-[11px] transition-colors"
                style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
              >
                Clear
              </button>
            )}
          </div>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            onBlur={() => save({ status_note: note })}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="Add a note (optional) — e.g. 'Recording till 6pm', 'Out till Friday'"
            className="w-full px-2.5 py-1.5 rounded-lg text-xs"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
          />
        </div>
      )}
    </div>
  );
}
