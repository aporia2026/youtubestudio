'use client';

/**
 * Filter bar for the Browse Categories tab.
 *
 * Six dimensions rendered as chip rows + one expandable RangeSlider
 * for precise RPM control. Mirrors the OutlierFilterBar pattern so
 * the operator only learns one filter UI for the whole product.
 *
 * Stateless — fully driven by `value` + `onChange`. The parent owns
 * the filter object so presets can apply a snapshot in one action.
 *
 * Language and region are NOT client-side filters — they change which
 * sample the scoring engine uses, so they live on this bar as a
 * refetch trigger that bubbles up through `onLocaleChange`. Everything
 * else is a pure client-side narrowing of the already-fetched array.
 */
import { useState } from 'react';
import type {
  BrowseFilters,
  BrowseSortBy,
  CrowdednessMax,
  DemandTier,
  FitMin,
} from '@/lib/niche-finder/browse-filters';
import { RPM_RANGE_MAX } from '@/lib/niche-finder/browse-filters';
import { RangeSlider } from './RangeSlider';

interface FilterBarProps {
  value: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
  onReset: () => void;
  /** Locale selects are now rendered by the global niche-finder picker.
   *  Pass these only when this bar is used standalone (e.g. an embed
   *  outside the niche-finder hub). When omitted, the Audience row is
   *  not rendered. */
  language?: string;
  region?: string;
  onLocaleChange?: (next: { language: string; region: string }) => void;
  /** Disables locale selects while a refetch is in flight so the
   *  user can't queue up a second request. Only meaningful when the
   *  locale props are also provided. */
  refetching?: boolean;
}

const DEMAND_OPTIONS: { v: DemandTier; label: string }[] = [
  { v: 'any', label: 'Any' },
  { v: 'medium', label: 'Medium+' },
  { v: 'high', label: 'High+' },
  { v: 'very-high', label: 'Very high only' },
];

const CROWDED_OPTIONS: { v: CrowdednessMax; label: string }[] = [
  { v: 'any', label: 'Any' },
  { v: 'non-saturated', label: 'Non-saturated' },
  { v: 'room', label: 'Room+ (no crowded/saturated)' },
  { v: 'wide-open', label: 'Wide open only' },
];

const RPM_CHIP_OPTIONS: { v: number; label: string }[] = [
  { v: 0, label: 'Any' },
  { v: 5, label: '≥ $5' },
  { v: 10, label: '≥ $10' },
  { v: 20, label: '≥ $20' },
];

const FIT_OPTIONS: { v: FitMin; label: string }[] = [
  { v: 'any', label: 'Any' },
  { v: 'could-work', label: 'Could work+' },
  { v: 'strong', label: 'Strong fit only' },
];

const SORT_OPTIONS: { v: BrowseSortBy; label: string }[] = [
  { v: 'sweet-spot', label: 'Sweet spot' },
  { v: 'demand', label: 'Demand ↓' },
  { v: 'crowdedness', label: 'Least crowded' },
  { v: 'rpm', label: 'RPM ↓' },
  { v: 'fit', label: 'Best fit' },
  { v: 'combined', label: 'Combined' },
];

const LANGUAGE_OPTIONS: { v: string; label: string }[] = [
  { v: 'en', label: 'English' },
  { v: 'es', label: 'Spanish' },
  { v: 'pt', label: 'Portuguese' },
  { v: 'de', label: 'German' },
  { v: 'fr', label: 'French' },
  { v: 'hi', label: 'Hindi' },
  { v: 'id', label: 'Indonesian' },
];

// ISO 3166-1 alpha-2 country codes — what the YouTube Data API's
// `regionCode` parameter accepts. There is no "global" mode in the
// API; if no region is sent the API uses the request-IP default,
// which from our infra reads as US anyway, so we just list the
// concrete countries and let the operator pick.
const REGION_OPTIONS: { v: string; label: string }[] = [
  { v: 'US', label: 'United States' },
  { v: 'GB', label: 'United Kingdom' },
  { v: 'CA', label: 'Canada' },
  { v: 'AU', label: 'Australia' },
  { v: 'IN', label: 'India' },
  { v: 'DE', label: 'Germany' },
  { v: 'BR', label: 'Brazil' },
];

/** Format USD/1k for the RangeSlider value badges. */
function fmtUsd(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= RPM_RANGE_MAX) return `$${RPM_RANGE_MAX}+`;
  return `$${v}`;
}

export function BrowseFilterBar({
  value,
  onChange,
  onReset,
  language,
  region,
  onLocaleChange,
  refetching = false,
}: FilterBarProps): React.ReactElement {
  const [rangeOpen, setRangeOpen] = useState(false);
  const rpmRangeSet =
    !!value.rpmRange &&
    !(value.rpmRange[0] <= 0 && value.rpmRange[1] >= RPM_RANGE_MAX);

  /** Set a scalar field. Passing the bucket default (`'any'` for tier
   *  chips, 0 for numeric chips) clears the field. Also clears the
   *  `preset` breadcrumb because hand-editing always defeats a preset. */
  function setScalar<K extends keyof BrowseFilters>(
    key: K,
    val: BrowseFilters[K],
    bucketDefault?: BrowseFilters[K],
  ): void {
    const next: BrowseFilters = { ...value, preset: null };
    const cleared =
      val === undefined ||
      val === null ||
      (bucketDefault !== undefined && val === bucketDefault);
    if (cleared) {
      delete next[key];
    } else {
      next[key] = val;
    }
    onChange(next);
  }

  /** Update the RPM range. Clears `rpmMinChip` so the two never
   *  contradict (range supersedes chip when active). */
  function setRpmRange(val: readonly [number, number] | undefined): void {
    const next: BrowseFilters = { ...value, preset: null };
    if (val === undefined) {
      delete next.rpmRange;
    } else {
      next.rpmRange = val;
      delete next.rpmMinChip;
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
      <Row label="Demand">
        {DEMAND_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.demandMin ?? 'any') === o.v}
            onClick={() => setScalar('demandMin', o.v, 'any')}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Crowdedness">
        {CROWDED_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.crowdednessMax ?? 'any') === o.v}
            onClick={() => setScalar('crowdednessMax', o.v, 'any')}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="$ / 1k views">
        {RPM_CHIP_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            // When a range slider is active it supersedes the chip,
            // so visually deactivate every chip rather than showing
            // a misleading "Any" highlight.
            active={!rpmRangeSet && (value.rpmMinChip ?? 0) === o.v}
            onClick={() => {
              // Clicking a chip should clear an active range — chip
              // and range are one source of truth per dimension.
              const next: BrowseFilters = { ...value, preset: null };
              delete next.rpmRange;
              if (o.v === 0) delete next.rpmMinChip;
              else next.rpmMinChip = o.v;
              onChange(next);
            }}
            label={o.label}
          />
        ))}
      </Row>

      <Row label="Fit">
        {FIT_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.fitMin ?? 'any') === o.v}
            onClick={() => setScalar('fitMin', o.v, 'any')}
            label={o.label}
          />
        ))}
      </Row>

      {language !== undefined && region !== undefined && onLocaleChange && (
        <Row label="Audience">
          <Select
            value={language}
            onChange={(v) => onLocaleChange({ language: v, region })}
            options={LANGUAGE_OPTIONS}
            disabled={refetching}
            ariaLabel="Language"
          />
          <Select
            value={region}
            onChange={(v) => onLocaleChange({ language, region: v })}
            options={REGION_OPTIONS}
            disabled={refetching}
            ariaLabel="Region"
          />
          {refetching && (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              Rescoring with new audience…
            </span>
          )}
        </Row>
      )}

      <Row label="Sort by">
        {SORT_OPTIONS.map((o) => (
          <Chip
            key={o.v}
            active={(value.sortBy ?? 'sweet-spot') === o.v}
            onClick={() => {
              // Sort change is a UX tweak, not a filter — leave the
              // preset breadcrumb intact unless the new sort actually
              // contradicts the preset's declared sort.
              const next: BrowseFilters = { ...value, sortBy: o.v };
              onChange(next);
            }}
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
          onClick={() => setRangeOpen((x) => !x)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 0,
            background: 'transparent',
            color: rpmRangeSet ? '#86efac' : '#94a3b8',
            border: 'none',
            fontSize: 12,
            cursor: 'pointer',
            textAlign: 'left',
          }}
          aria-expanded={rangeOpen}
        >
          <span
            style={{
              display: 'inline-block',
              width: 14,
              textAlign: 'center',
              transform: rangeOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}
          >
            ▸
          </span>
          Precise RPM range
          <span style={{ color: '#475569', fontSize: 11 }}>
            {rpmRangeSet
              ? '(active — overriding the $/1k chips above)'
              : '(precise min/max for monetization)'}
          </span>
        </button>

        {rangeOpen && (
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
              label="$ / 1k views"
              min={0}
              max={RPM_RANGE_MAX}
              value={value.rpmRange ?? [0, RPM_RANGE_MAX]}
              onChange={(v) => setRpmRange(v)}
              onClear={() => setRpmRange(undefined)}
              scale="linear"
              step={1}
              format={fmtUsd}
            />
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

function Select({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<{ v: string; label: string }>;
  disabled?: boolean;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        padding: '4px 8px',
        background: '#0f172a',
        color: '#cbd5e1',
        border: '1px solid #334155',
        borderRadius: 6,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
