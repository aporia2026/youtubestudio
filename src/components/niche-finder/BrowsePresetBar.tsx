'use client';

/**
 * Preset chip row for the Browse Categories tab.
 *
 * Two rows of chips:
 *   - Built-in presets (5 curated, purple chips)
 *   - Saved searches (per-workspace, green chips with delete X)
 *
 * Plus a "+ Save current search" inline name-input button. Mirrors the
 * OutlierPresetBar pattern so users learn one preset-bar UI.
 *
 * Active preset is highlighted green. Saved searches are stored as
 * BrowseFilters specs in `niche_watchlist` (migration 0062, kind='search');
 * clicking one applies the spec verbatim. Running a saved search across
 * every category at once is a separate action — see the
 * "Find sweet spot across all" button at the top of CategoryTab.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  BUILTIN_BROWSE_PRESETS,
  type BrowseFilters,
  type BrowsePreset,
} from '@/lib/niche-finder/browse-filters';

interface SavedSearchRow {
  niche_slug: string;
  search_label: string;
  search_spec: BrowseFilters;
  last_match_count: number | null;
  last_rescored_at: string | null;
  created_at: string;
}

interface PresetBarProps {
  /** Currently active filter set — used to highlight the matching preset
   *  chip AND to populate the "Save current" body when the user names
   *  and saves a new search. */
  currentFilters: BrowseFilters;
  /** Called when the user clicks a built-in OR saved preset chip.
   *  The full filter snapshot replaces the parent's filter state. */
  onApplyPreset: (filters: BrowseFilters) => void;
}

export function BrowsePresetBar({
  currentFilters,
  onApplyPreset,
}: PresetBarProps): React.ReactElement {
  const [saved, setSaved] = useState<SavedSearchRow[] | null>(null);
  const [showNameInput, setShowNameInput] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeId = currentFilters.preset ?? null;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/niche-finder/watchlist/searches');
      if (!res.ok) {
        setSaved([]);
        return;
      }
      const body = (await res.json()) as { rows: SavedSearchRow[] };
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
      const res = await fetch('/api/niche-finder/watchlist/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: name, spec: currentFilters }),
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
  }, [currentFilters, draftName, refresh]);

  const onDelete = useCallback(
    async (slug: string) => {
      try {
        await fetch(`/api/niche-finder/watchlist/searches/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
        });
        await refresh();
      } catch {
        // Best-effort — next refresh picks up the actual state.
      }
    },
    [refresh],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Section label="Quick searches">
        {BUILTIN_BROWSE_PRESETS.map((p) => (
          <PresetChip
            key={p.id}
            preset={p}
            active={activeId === p.id}
            onClick={() => onApplyPreset(p.filters)}
          />
        ))}
      </Section>

      {saved && (saved.length > 0 || showNameInput) && (
        <Section label="My searches">
          {saved.map((s) => (
            <SavedChip
              key={s.niche_slug}
              row={s}
              onApply={() => onApplyPreset(s.search_spec)}
              onDelete={() => onDelete(s.niche_slug)}
            />
          ))}
          {showNameInput && (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Name this search"
                maxLength={80}
                autoFocus
                disabled={saving}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSave();
                  if (e.key === 'Escape') {
                    setShowNameInput(false);
                    setDraftName('');
                    setError(null);
                  }
                }}
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
          )}
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
      <div
        style={{
          fontSize: 11,
          color: '#64748b',
          minWidth: 100,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function PresetChip({
  preset,
  active,
  onClick,
}: {
  preset: BrowsePreset;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={preset.description}
      style={{
        padding: '4px 10px',
        background: active ? 'rgba(34,197,94,0.15)' : 'rgba(168,139,250,0.10)',
        color: active ? '#86efac' : '#cbd5e1',
        border: active
          ? '1px solid rgba(34,197,94,0.5)'
          : '1px solid rgba(168,139,250,0.35)',
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
  row: SavedSearchRow;
  onApply: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const matchCount = row.last_match_count;
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
        title={
          matchCount != null
            ? `Last run: ${matchCount} matches`
            : 'Apply this filter spec'
        }
        style={{
          background: 'transparent',
          color: '#86efac',
          border: 'none',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {row.search_label}
        {matchCount != null && (
          <span style={{ color: '#64748b', marginLeft: 4 }}>· {matchCount}</span>
        )}
      </button>
      <button
        onClick={onDelete}
        title="Delete saved search"
        aria-label={`Delete ${row.search_label}`}
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
