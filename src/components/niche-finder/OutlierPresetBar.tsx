'use client';

/**
 * Preset chip row for the outlier finder.
 *
 * Renders the 9 built-in presets first, then the user's saved
 * presets (loaded once on mount). One-click applies the filter set;
 * an `×` next to each saved preset deletes it.
 *
 * "Save current search" opens a tiny inline name prompt rather than
 * a modal — fewer clicks, less ceremony.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  BUILTIN_OUTLIER_PRESETS,
  type OutlierFilters,
  type OutlierPreset,
} from '@/lib/niche-finder/outlier-filters';
import type { SavedPresetRow } from '@/lib/niche-finder/presets-db';

interface PresetBarProps {
  /** Currently active filter set — used to drive the "Save current"
   *  button. */
  currentFilters: OutlierFilters;
  /** Currently active niche search term. Saved alongside the
   *  filters so applying a preset can also re-seed the search. */
  currentNiche: string;
  /** Called when the user clicks a built-in OR saved preset. */
  onApplyPreset: (filters: OutlierFilters, nicheHint?: string) => void;
}

export function OutlierPresetBar({
  currentFilters,
  currentNiche,
  onApplyPreset,
}: PresetBarProps): React.ReactElement {
  const [saved, setSaved] = useState<SavedPresetRow[] | null>(null);
  const [showNameInput, setShowNameInput] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/niche-finder/outliers/presets');
      if (!res.ok) {
        setSaved([]);
        return;
      }
      const body = (await res.json()) as { rows: SavedPresetRow[] };
      setSaved(body.rows);
    } catch {
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(async () => {
    const name = draftName.trim();
    if (name.length === 0) {
      setError('Give it a name first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/niche-finder/outliers/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          nicheQuery: currentNiche,
          filters: currentFilters,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save.');
        return;
      }
      setDraftName('');
      setShowNameInput(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  }, [currentFilters, currentNiche, draftName, refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
        await fetch(`/api/niche-finder/outliers/presets/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        await refresh();
      } catch {
        // Best-effort — the next refresh will pick up the actual state.
      }
    },
    [refresh],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Section label="Quick searches">
        {BUILTIN_OUTLIER_PRESETS.map((p) => (
          <PresetChip
            key={p.id}
            preset={p}
            onClick={() => onApplyPreset(p.filters, p.nicheHint)}
          />
        ))}
      </Section>

      {saved && (saved.length > 0 || showNameInput) && (
        <Section label="My searches">
          {saved.map((s) => (
            <SavedChip
              key={s.id}
              row={s}
              onApply={() => onApplyPreset(s.filters, s.niche_query)}
              onDelete={() => onDelete(s.id)}
            />
          ))}
          {showNameInput ? (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Name this search"
                maxLength={80}
                autoFocus
                disabled={saving}
                style={{
                  padding: '4px 8px',
                  background: '#0f172a',
                  color: '#e2e8f0',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  fontSize: 12,
                  width: 180,
                }}
              />
              <button
                onClick={onSave}
                disabled={saving}
                style={{
                  padding: '4px 10px',
                  background: '#22c55e',
                  color: '#0a0e16',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setShowNameInput(false);
                  setDraftName('');
                  setError(null);
                }}
                style={{
                  padding: '4px 8px',
                  background: 'transparent',
                  color: '#94a3b8',
                  border: 'none',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              {error && <span style={{ color: '#f87171', fontSize: 11 }}>{error}</span>}
            </span>
          ) : null}
        </Section>
      )}

      {!showNameInput && saved !== null && (
        <button
          onClick={() => setShowNameInput(true)}
          style={{
            padding: '4px 10px',
            background: 'transparent',
            color: '#94a3b8',
            border: '1px dashed #334155',
            borderRadius: 6,
            fontSize: 12,
            cursor: 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          + Save current search
        </button>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 11, color: '#64748b', minWidth: 100, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function PresetChip({ preset, onClick }: { preset: OutlierPreset; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={preset.description}
      style={{
        padding: '4px 10px',
        background: 'rgba(168,139,250,0.10)',
        color: '#cbd5e1',
        border: '1px solid rgba(168,139,250,0.35)',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {preset.label}
    </button>
  );
}

function SavedChip({
  row,
  onApply,
  onDelete,
}: {
  row: SavedPresetRow;
  onApply: () => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'rgba(34,197,94,0.10)',
        border: '1px solid rgba(34,197,94,0.35)',
        borderRadius: 6,
        padding: '2px 4px 2px 10px',
        fontSize: 12,
      }}
    >
      <button
        onClick={onApply}
        title={row.niche_query ? `Niche: ${row.niche_query}` : undefined}
        style={{
          background: 'transparent',
          color: '#86efac',
          border: 'none',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {row.name}
      </button>
      <button
        onClick={onDelete}
        title="Delete saved search"
        aria-label={`Delete ${row.name}`}
        style={{
          background: 'transparent',
          color: '#94a3b8',
          border: 'none',
          fontSize: 13,
          cursor: 'pointer',
          padding: 2,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </span>
  );
}
