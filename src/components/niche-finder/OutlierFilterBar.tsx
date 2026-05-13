'use client';

/**
 * Filter bar for the outlier finder. Eight filter dimensions
 * rendered as segmented controls (faster than dropdowns, every
 * option visible at a glance per the lazy-user walkthrough).
 *
 * Stateless — fully driven by `value` + `onChange`. The parent
 * owns the filter object so presets can apply a snapshot in one
 * action.
 *
 * The "Custom ranges" panel below the chip rows exposes precise
 * numeric sliders for six numeric dimensions (duration, subs,
 * views, published-age, outlier score, title length). When a slider
 * is set, it supersedes the chip-based field for that dimension
 * (see `applyOutlierFilters` for the precedence rules). Touching a
 * slider clears the related chip field; clicking a chip clears the
 * related range field — one source of truth per dimension at a time.
 */
import { useState } from 'react';
import type {
  OutlierFilters,
  VideoFormat,
  ChannelSize,
  TitleLength,
  SortBy,
} from '@/lib/niche-finder/outlier-filters';
import {
  DURATION_RANGE_MAX_SEC,
  SUBS_RANGE_MAX,
  VIEWS_RANGE_MAX,
  PUBLISHED_AGE_RANGE_MAX_DAYS,
  OUTLIER_SCORE_RANGE_MAX,
  TITLE_LENGTH_RANGE_MAX,
} from '@/lib/niche-finder/outlier-filters';
import { RangeSlider } from './RangeSlider';

/** Maps each chip-based filter field to its range counterpart and
 *  vice versa. Used to keep the two in sync — touching one clears
 *  the other so they never contradict. */
const CHIP_TO_RANGE: Partial<Record<keyof OutlierFilters, keyof OutlierFilters>> = {
  formats: 'durationRangeSec',
  channelSizes: 'subsRange',
  minViews: 'viewsRange',
  publishedWithinDays: 'publishedAgeRangeDays',
  minOutlierScore: 'outlierScoreRange',
  titleLengths: 'titleLengthRange',
};
const RANGE_TO_CHIP: Partial<Record<keyof OutlierFilters, keyof OutlierFilters>> =
  Object.fromEntries(
    Object.entries(CHIP_TO_RANGE).map(([k, v]) => [v!, k as keyof OutlierFilters]),
  );

interface FilterBarProps {
  value: OutlierFilters;
  onChange: (next: OutlierFilters) => void;
  onReset: () => void;
}

const FORMAT_OPTIONS: { v: VideoFormat; label: string }[] = [
  { v: 'short', label: 'Shorts (≤60s)' },
  { v: 'normal', label: 'Normal (1–8m)' },
  { v: 'long', label: 'Long-form (8m+)' },
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

/** Compact number formatter — "5K", "1.2M", "120". Drives the value
 *  badges on the subscriber + view sliders. */
function fmtCompact(n: number): string {
  const v = Math.round(n);
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m >= 100 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (v >= 1_000) {
    const k = v / 1_000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return String(v);
}

/** Seconds → m:ss or h:mm:ss. */
function fmtDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Days since publish → "Xd" or "Xm" or "Xy". */
function fmtDays(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d < 60) return `${d}d`;
  if (d < 730) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

/** Outlier score → "3.5×". */
function fmtScore(n: number): string {
  if (n >= 100) return `100×+`;
  return `${n.toFixed(n >= 10 ? 0 : 1)}×`;
}

/** Title length in chars. */
function fmtChars(n: number): string {
  return `${Math.round(n)}`;
}

export function OutlierFilterBar({ value, onChange, onReset }: FilterBarProps): React.ReactElement {
  const [rangesOpen, setRangesOpen] = useState(false);
  const anyRangeSet =
    !!value.durationRangeSec ||
    !!value.subsRange ||
    !!value.viewsRange ||
    !!value.publishedAgeRangeDays ||
    !!value.outlierScoreRange ||
    !!value.titleLengthRange;

  /**
   * Toggle membership of `v` in a multi-select filter field.
   *
   * Takes the value as the final argument so call sites can use the
   * standard `onClick={() => toggleMulti(...)}` pattern. Earlier
   * versions of this component returned a curried `(v) => void` and
   * accidentally invoked it during render, causing an infinite
   * setState loop. The arrow-wrapped form is the only correct shape.
   *
   * If the resulting set is empty OR contains every option, the
   * field is deleted from the filters object (no-filter ≡ all-options).
   */
  function toggleMulti<T>(
    field: keyof OutlierFilters,
    options: ReadonlyArray<T>,
    current: ReadonlyArray<T> | undefined,
    v: T,
  ): void {
    const set = new Set(current ?? []);
    if (set.has(v)) set.delete(v);
    else set.add(v);
    const next: OutlierFilters = { ...value };
    if (set.size === 0 || set.size === options.length) {
      delete (next as Record<string, unknown>)[field as string];
    } else {
      (next as Record<string, unknown>)[field as string] = Array.from(set);
    }
    const related = CHIP_TO_RANGE[field];
    if (related) delete (next as Record<string, unknown>)[related as string];
    onChange(next);
  }

  function setScalar<K extends keyof OutlierFilters>(key: K, val: OutlierFilters[K]): void {
    const next: OutlierFilters = { ...value };
    if (val === undefined || val === 0 || val === false) {
      delete next[key];
    } else {
      next[key] = val;
    }
    const related = CHIP_TO_RANGE[key];
    if (related) delete (next as Record<string, unknown>)[related as string];
    onChange(next);
  }

  /** Update a range field. Clears the corresponding chip-based field
   *  so the two never contradict. Pass `undefined` to clear. */
  function setRange<K extends keyof OutlierFilters>(
    key: K,
    val: OutlierFilters[K] | undefined,
  ): void {
    const next: OutlierFilters = { ...value };
    if (val === undefined) {
      delete next[key];
    } else {
      next[key] = val;
    }
    const related = RANGE_TO_CHIP[key];
    if (related) delete (next as Record<string, unknown>)[related as string];
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
            onClick={() =>
              toggleMulti('formats', FORMAT_OPTIONS.map((x) => x.v), value.formats, o.v)
            }
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Channel size">
        {SIZE_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={!!value.channelSizes?.includes(o.v)}
            onClick={() =>
              toggleMulti('channelSizes', SIZE_OPTIONS.map((x) => x.v), value.channelSizes, o.v)
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
            onClick={() =>
              toggleMulti(
                'titleLengths',
                TITLE_LENGTH_OPTIONS.map((x) => x.v),
                value.titleLengths,
                o.v,
              )
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
        <Chip
          active={!!value.likelyMonetized}
          onClick={() => setScalar('likelyMonetized', !value.likelyMonetized)}
          label="Likely monetized (≥1K subs, ≥8min)"
          title="Heuristic — the YouTube API doesn't publish monetization status for other channels. Filters to videos whose channel meets the YPP minimum (1K subs) and whose duration clears the mid-roll floor (8 min)."
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

      <div
        style={{
          marginTop: 4,
          borderTop: '1px dashed rgba(255,255,255,0.08)',
          paddingTop: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <button
          type="button"
          onClick={() => setRangesOpen((x) => !x)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 0,
            background: 'transparent',
            color: anyRangeSet ? '#86efac' : '#94a3b8',
            border: 'none',
            fontSize: 12,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          aria-expanded={rangesOpen}
        >
          <span
            style={{
              display: 'inline-block',
              width: 14,
              textAlign: 'center',
              transform: rangesOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}
          >
            ▸
          </span>
          Custom ranges
          <span style={{ color: '#475569', fontSize: 11 }}>
            {anyRangeSet
              ? '(active — overriding presets above)'
              : '(precise min/max for every numeric filter)'}
          </span>
        </button>

        {rangesOpen && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 14,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 10,
            }}
          >
            <RangeSlider
              label="Duration"
              min={0}
              max={DURATION_RANGE_MAX_SEC}
              value={value.durationRangeSec ?? [0, DURATION_RANGE_MAX_SEC]}
              onChange={(v) => setRange('durationRangeSec', v)}
              onClear={() => setRange('durationRangeSec', undefined)}
              scale="log"
              step={1}
              format={fmtDuration}
            />
            <RangeSlider
              label="Channel subs"
              min={0}
              max={SUBS_RANGE_MAX}
              value={value.subsRange ?? [0, SUBS_RANGE_MAX]}
              onChange={(v) => setRange('subsRange', v)}
              onClear={() => setRange('subsRange', undefined)}
              scale="log"
              step={1}
              format={fmtCompact}
            />
            <RangeSlider
              label="Views"
              min={0}
              max={VIEWS_RANGE_MAX}
              value={value.viewsRange ?? [0, VIEWS_RANGE_MAX]}
              onChange={(v) => setRange('viewsRange', v)}
              onClear={() => setRange('viewsRange', undefined)}
              scale="log"
              step={1}
              format={fmtCompact}
            />
            <RangeSlider
              label="Published age"
              min={0}
              max={PUBLISHED_AGE_RANGE_MAX_DAYS}
              value={value.publishedAgeRangeDays ?? [0, PUBLISHED_AGE_RANGE_MAX_DAYS]}
              onChange={(v) => setRange('publishedAgeRangeDays', v)}
              onClear={() => setRange('publishedAgeRangeDays', undefined)}
              scale="linear"
              step={1}
              format={fmtDays}
            />
            <RangeSlider
              label="Outlier score"
              min={0}
              max={OUTLIER_SCORE_RANGE_MAX}
              value={value.outlierScoreRange ?? [0, OUTLIER_SCORE_RANGE_MAX]}
              onChange={(v) => setRange('outlierScoreRange', v)}
              onClear={() => setRange('outlierScoreRange', undefined)}
              scale="log"
              step={0.1}
              format={fmtScore}
            />
            <RangeSlider
              label="Title length"
              min={0}
              max={TITLE_LENGTH_RANGE_MAX}
              value={value.titleLengthRange ?? [0, TITLE_LENGTH_RANGE_MAX]}
              onChange={(v) => setRange('titleLengthRange', v)}
              onClear={() => setRange('titleLengthRange', undefined)}
              scale="linear"
              step={1}
              format={fmtChars}
            />
            {anyRangeSet && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => {
                    const next: OutlierFilters = { ...value };
                    delete next.durationRangeSec;
                    delete next.subsRange;
                    delete next.viewsRange;
                    delete next.publishedAgeRangeDays;
                    delete next.outlierScoreRange;
                    delete next.titleLengthRange;
                    onChange(next);
                  }}
                  style={{
                    padding: '4px 10px',
                    background: 'transparent',
                    color: '#94a3b8',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Clear all ranges
                </button>
              </div>
            )}
          </div>
        )}
      </div>

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
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={title}
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
