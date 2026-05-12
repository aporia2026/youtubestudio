'use client';

/**
 * Filter bar for the outlier finder. Eight filter dimensions
 * rendered as segmented controls (faster than dropdowns, every
 * option visible at a glance per the lazy-user walkthrough).
 *
 * Stateless — fully driven by `value` + `onChange`. The parent
 * owns the filter object so presets can apply a snapshot in one
 * action.
 */
import type {
  OutlierFilters,
  VideoFormat,
  ChannelSize,
  TitleLength,
  SortBy,
} from '@/lib/niche-finder/outlier-filters';

interface FilterBarProps {
  value: OutlierFilters;
  onChange: (next: OutlierFilters) => void;
  onReset: () => void;
}

const FORMAT_OPTIONS: { v: VideoFormat; label: string }[] = [
  { v: 'short', label: 'Shorts' },
  { v: 'normal', label: 'Normal' },
  { v: 'long', label: 'Long-form' },
];

const SIZE_OPTIONS: { v: ChannelSize; label: string }[] = [
  { v: 'tiny', label: '<10K' },
  { v: 'small', label: '10K–100K' },
  { v: 'mid', label: '100K–1M' },
  { v: 'large', label: '1M+' },
];

const TITLE_LENGTH_OPTIONS: { v: TitleLength; label: string }[] = [
  { v: 'punchy', label: 'Punchy (≤40)' },
  { v: 'medium', label: 'Medium' },
  { v: 'descriptive', label: 'Descriptive (>70)' },
];

const VIEW_THRESHOLDS: { v: number; label: string }[] = [
  { v: 0, label: 'Any' },
  { v: 10_000, label: '10K+' },
  { v: 100_000, label: '100K+' },
  { v: 1_000_000, label: '1M+' },
  { v: 10_000_000, label: '10M+' },
];

const WINDOW_OPTIONS: { v: number; label: string }[] = [
  { v: 0, label: 'All time' },
  { v: 7, label: '7d' },
  { v: 30, label: '30d' },
  { v: 90, label: '90d' },
  { v: 365, label: '1yr' },
];

const OUTLIER_THRESHOLDS: { v: number; label: string }[] = [
  { v: 0, label: 'All' },
  { v: 1, label: 'Normal+' },
  { v: 3, label: 'Breakout+' },
  { v: 10, label: 'Viral only' },
];

const SORT_OPTIONS: { v: SortBy; label: string }[] = [
  { v: 'outlier', label: 'Outlier ↓' },
  { v: 'views', label: 'Views' },
  { v: 'subsDesc', label: 'Subs ↓' },
  { v: 'subsAsc', label: 'Subs ↑' },
  { v: 'newest', label: 'Newest' },
  { v: 'titleShortest', label: 'Shortest title' },
];

export function OutlierFilterBar({ value, onChange, onReset }: FilterBarProps): React.ReactElement {
  function toggleMulti<T>(
    field: keyof OutlierFilters,
    options: ReadonlyArray<T>,
    current: ReadonlyArray<T> | undefined,
  ): (v: T) => void {
    return (v: T) => {
      const set = new Set(current ?? []);
      if (set.has(v)) set.delete(v);
      else set.add(v);
      const next: OutlierFilters = { ...value };
      if (set.size === 0 || set.size === options.length) {
        delete (next as Record<string, unknown>)[field as string];
      } else {
        (next as Record<string, unknown>)[field as string] = Array.from(set);
      }
      onChange(next);
    };
  }

  function setScalar<K extends keyof OutlierFilters>(key: K, val: OutlierFilters[K]): void {
    const next: OutlierFilters = { ...value };
    if (val === undefined || val === 0 || val === false) {
      delete next[key];
    } else {
      next[key] = val;
    }
    onChange(next);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 14,
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.015)',
      }}
    >
      <Row label="Format">
        {FORMAT_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={!!value.formats?.includes(o.v)}
            onClick={toggleMulti('formats', FORMAT_OPTIONS.map((x) => x.v), value.formats)(o.v) as unknown as () => void}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Channel size">
        {SIZE_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={!!value.channelSizes?.includes(o.v)}
            onClick={
              toggleMulti('channelSizes', SIZE_OPTIONS.map((x) => x.v), value.channelSizes)(
                o.v,
              ) as unknown as () => void
            }
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Min views">
        {VIEW_THRESHOLDS.map((o) => (
          <Chip
            key={o.v}
            active={(value.minViews ?? 0) === o.v}
            onClick={() => setScalar('minViews', o.v)}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Published">
        {WINDOW_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.publishedWithinDays ?? 0) === o.v}
            onClick={() => setScalar('publishedWithinDays', o.v)}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Outlier ≥">
        {OUTLIER_THRESHOLDS.map((o) => (
          <Chip
            key={o.v}
            active={(value.minOutlierScore ?? 0) === o.v}
            onClick={() => setScalar('minOutlierScore', o.v)}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Title length">
        {TITLE_LENGTH_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={!!value.titleLengths?.includes(o.v)}
            onClick={
              toggleMulti('titleLengths', TITLE_LENGTH_OPTIONS.map((x) => x.v), value.titleLengths)(
                o.v,
              ) as unknown as () => void
            }
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Quality">
        <Chip
          active={!!value.consistentWinnersOnly}
          onClick={() => setScalar('consistentWinnersOnly', !value.consistentWinnersOnly)}
          label="Consistent winners only (≥3 hits per channel)"
        />
      </Row>

      <Row label="Sort by">
        {SORT_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.sortBy ?? 'outlier') === o.v}
            onClick={() => setScalar('sortBy', o.v)}
            label={o.label}
          />
        ))}
      </Row>

      <div>
        <button
          onClick={onReset}
          style={{
            padding: '6px 12px',
            background: 'transparent',
            color: '#94a3b8',
            border: '1px solid #334155',
            borderRadius: 8,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Reset filters
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 12, color: '#64748b', minWidth: 100 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 10px',
        background: active ? 'rgba(34,197,94,0.15)' : 'transparent',
        color: active ? '#86efac' : '#cbd5e1',
        border: active ? '1px solid rgba(34,197,94,0.5)' : '1px solid #334155',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
