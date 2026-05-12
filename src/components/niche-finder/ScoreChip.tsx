'use client';

/**
 * Niche-finder score chip — renders one of the four dimensions in
 * plain English, the way the Outsider council pass demanded. Numbers
 * live on hover in the tooltip; the front face is the label, the
 * confidence pill, and (for monetization) the dollar range.
 */
import type {
  DemandScore,
  FitScore,
  MonetizationScore,
  SupplyScore,
} from '@/lib/niche-finder/types';

const DIMENSION_HEADING: Record<DimensionKey, string> = {
  demand: 'How many people want this',
  supply: 'How crowded it is',
  monetization: 'How much money it makes',
  fit: 'How well it fits you',
};

const DIMENSION_TONE: Record<DimensionKey, { good: number; neutral: number }> = {
  // Higher = better
  demand: { good: 0.55, neutral: 0.3 },
  // Higher = worse — UI tint inverts the band
  supply: { good: 0.3, neutral: 0.55 },
  monetization: { good: 0.55, neutral: 0.3 },
  fit: { good: 0.6, neutral: 0.35 },
};

type DimensionKey = 'demand' | 'supply' | 'monetization' | 'fit';

interface BaseChipProps {
  dimension: DimensionKey;
}

interface DemandSupplyChipProps extends BaseChipProps {
  dimension: 'demand' | 'supply' | 'fit';
  score: DemandScore | SupplyScore | FitScore;
}

interface MonetizationChipProps extends BaseChipProps {
  dimension: 'monetization';
  score: MonetizationScore;
}

export type ScoreChipProps = DemandSupplyChipProps | MonetizationChipProps;

function toneFor(dim: DimensionKey, numeric: number): 'good' | 'neutral' | 'caution' {
  const tones = DIMENSION_TONE[dim];
  if (dim === 'supply') {
    // Higher numeric is more saturated — bad. Invert.
    if (numeric <= tones.good) return 'good';
    if (numeric <= tones.neutral) return 'neutral';
    return 'caution';
  }
  if (numeric >= tones.good) return 'good';
  if (numeric >= tones.neutral) return 'neutral';
  return 'caution';
}

const TONE_BG: Record<'good' | 'neutral' | 'caution', string> = {
  good: 'rgba(34, 197, 94, 0.10)',
  neutral: 'rgba(245, 158, 11, 0.10)',
  caution: 'rgba(239, 68, 68, 0.10)',
};
const TONE_BORDER: Record<'good' | 'neutral' | 'caution', string> = {
  good: 'rgba(34, 197, 94, 0.40)',
  neutral: 'rgba(245, 158, 11, 0.40)',
  caution: 'rgba(239, 68, 68, 0.40)',
};

export function ScoreChip(props: ScoreChipProps): React.ReactElement {
  const numeric = props.score.numeric;
  const tone = toneFor(props.dimension, numeric);

  const front =
    props.dimension === 'monetization'
      ? `$${props.score.lowUsdPerMille.toFixed(0)}–$${props.score.highUsdPerMille.toFixed(0)} per 1,000 views`
      : props.score.label;

  const evidenceEntries = Object.entries(props.score.evidence).slice(0, 8);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 14,
        border: `1px solid ${TONE_BORDER[tone]}`,
        background: TONE_BG[tone],
        borderRadius: 12,
        minHeight: 116,
      }}
    >
      <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {DIMENSION_HEADING[props.dimension]}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#e2e8f0', lineHeight: 1.2 }}>
        {front}
      </div>
      <div style={{ fontSize: 12, color: '#64748b' }}>{props.score.confidence}</div>
      <details style={{ marginTop: 'auto', fontSize: 12, color: '#94a3b8' }}>
        <summary style={{ cursor: 'pointer', userSelect: 'none' }}>Show the math</summary>
        <dl style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
          {evidenceEntries.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt style={{ color: '#64748b' }}>{k}</dt>
              <dd style={{ color: '#cbd5e1', margin: 0, wordBreak: 'break-word' }}>{String(v)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
