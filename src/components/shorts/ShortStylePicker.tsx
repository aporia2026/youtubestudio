'use client';

/**
 * ShortStylePicker — Phase 15.3.
 *
 * Segmented picker over the SHORT_STYLES registry. Renders ALL declared
 * styles (available + coming) so the user sees the full roadmap without
 * having to leave the page; non-available entries are disabled with a
 * "ships in Phase 15.X" badge.
 *
 * Layout:
 *   - Three big tiles in a row (label, one-line description, cost-band
 *     chip, "Coming in Phase X" disabled state).
 *   - The active tile is unmistakably highlighted (filled accent + drop shadow).
 *
 * Caller controls which style is selected and the "change" callback.
 * The picker is presentational only — no async logic.
 */

import { listShortStyles, type ShortStyleId, type ShortStyleEntry } from '@/lib/short-styles';

interface Props {
  value: ShortStyleId;
  onChange: (next: ShortStyleId) => void;
  disabled?: boolean;
}

function costBandColor(band: ShortStyleEntry['costBand']): { bg: string; color: string; label: string } {
  switch (band) {
    case 'minimal':
      return { bg: 'rgba(34,197,94,0.18)', color: '#86efac', label: 'Cheap' };
    case 'light':
      return { bg: 'rgba(245,158,11,0.18)', color: '#fde68a', label: '~$0.13' };
    case 'heavy':
      return { bg: 'rgba(239,68,68,0.18)', color: '#fca5a5', label: '~$0.50' };
  }
}

export function ShortStylePicker({ value, onChange, disabled }: Props) {
  const styles = listShortStyles();
  return (
    <div
      role="radiogroup"
      aria-label="Short style"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 10,
      }}
    >
      {styles.map((s) => {
        const isActive = s.id === value && s.available;
        const isDisabled = disabled || !s.available;
        const cost = costBandColor(s.costBand);
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={isDisabled}
            onClick={() => s.available && onChange(s.id)}
            style={{
              textAlign: 'left',
              padding: 14,
              borderRadius: 12,
              border: isActive ? '2px solid rgba(124,58,237,0.95)' : '1px solid rgba(255,255,255,0.08)',
              background: isActive ? 'rgba(124,58,237,0.18)' : 'rgba(255,255,255,0.03)',
              color: 'inherit',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: !s.available ? 0.5 : 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              transition: 'background 120ms ease, border-color 120ms ease',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{s.label}</span>
              <span
                style={{
                  marginLeft: 'auto',
                  padding: '2px 7px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  background: cost.bg,
                  color: cost.color,
                }}
              >
                {cost.label}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))', lineHeight: 1.45 }}>
              {s.description}
            </div>
            {!s.available && s.comingPhase && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  textTransform: 'uppercase',
                  color: 'var(--text-muted, rgba(255,255,255,0.5))',
                }}
              >
                Ships in {s.comingPhase}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
