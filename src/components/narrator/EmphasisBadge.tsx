'use client';

const BADGE_STYLES: Record<string, { bg: string; text: string }> = {
  emotion: { bg: 'rgba(124,58,237,0.2)', text: '#a78bfa' },
  nonverbal: { bg: 'rgba(6,182,212,0.2)', text: '#06b6d4' },
  pacing: { bg: 'rgba(234,179,8,0.2)', text: '#eab308' },
};

interface EmphasisBadgeProps {
  tag: string;
  category: 'emotion' | 'nonverbal' | 'pacing';
}

export function EmphasisBadge({ tag, category }: EmphasisBadgeProps) {
  const style = BADGE_STYLES[category] || BADGE_STYLES.emotion;
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono font-medium mx-0.5 align-middle"
      style={{ background: style.bg, color: style.text }}
    >
      [{tag}]
    </span>
  );
}
