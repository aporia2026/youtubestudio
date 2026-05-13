'use client';

/**
 * Preset chip row for the Browse Categories tab.
 *
 * Five built-in presets — the "sweet-spot" preset is the default
 * applied on first load. One-click applies the filter snapshot. The
 * active preset is highlighted in green so the operator can tell which
 * starting point they're on.
 *
 * Saved searches will land in PR3 (see plan
 * `_plans/2026-05-13-niche-finder-browse-categories-v2.md`). For now
 * this bar shows only the curated presets.
 */
import {
  BUILTIN_BROWSE_PRESETS,
  type BrowseFilters,
  type BrowsePreset,
} from '@/lib/niche-finder/browse-filters';

interface PresetBarProps {
  /** Currently active filter set — used to highlight the matching preset chip. */
  currentFilters: BrowseFilters;
  /** Called when the user clicks a preset. The full filter snapshot
   *  replaces the parent's filter state. */
  onApplyPreset: (filters: BrowseFilters) => void;
}

export function BrowsePresetBar({
  currentFilters,
  onApplyPreset,
}: PresetBarProps): React.ReactElement {
  const activeId = currentFilters.preset ?? null;
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
        Quick searches
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {BUILTIN_BROWSE_PRESETS.map((p) => (
          <PresetChip
            key={p.id}
            preset={p}
            active={activeId === p.id}
            onClick={() => onApplyPreset(p.filters)}
          />
        ))}
      </div>
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
