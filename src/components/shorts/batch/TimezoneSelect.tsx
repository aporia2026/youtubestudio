'use client';

/**
 * TimezoneSelect — IANA timezone picker for the schedule UI.
 *
 * The full IANA list is ~600 zones; we surface a short curated set
 * up top + the full list below. Native <select> over a custom widget
 * because OS-native pickers handle search/keyboard-nav better than
 * any custom solution, and the lazy user (rule 10) gets the platform
 * convention they already know.
 */

import { useMemo } from 'react';

/** Common timezones surfaced at the top of the dropdown. Order is by
 *  rough US-creator-friendliness; international zones follow. */
const COMMON: ReadonlyArray<string> = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Jerusalem',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];

/** Discover the full IANA list from the runtime — modern Node + every
 *  modern browser exposes `Intl.supportedValuesOf('timeZone')`.
 *  Falls back to COMMON if unsupported. */
function fullTimezoneList(): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      /* fall through */
    }
  }
  return [...COMMON];
}

export function TimezoneSelect({
  value,
  onChange,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const all = useMemo(() => {
    const full = fullTimezoneList();
    const rest = full.filter((tz) => !COMMON.includes(tz));
    return { common: COMMON, rest };
  }, []);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={[
        'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none',
        className,
      ].join(' ')}
    >
      <optgroup label="Common">
        {all.common.map((tz) => (
          <option key={tz} value={tz}>
            {tz}
          </option>
        ))}
      </optgroup>
      {all.rest.length > 0 && (
        <optgroup label="All">
          {all.rest.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
