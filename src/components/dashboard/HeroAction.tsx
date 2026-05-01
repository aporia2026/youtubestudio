'use client';

import type * as React from 'react';

export type HeroActionTone = 'cyan' | 'purple' | 'green' | 'slate' | 'orange';

const TONES: Record<HeroActionTone, { bg: string; bgHover: string; fg: string; border: string; primaryBg: string; primaryFg: string }> = {
  cyan:   { bg: 'rgba(6,182,212,0.10)',   bgHover: 'rgba(6,182,212,0.18)',   fg: '#06b6d4', border: 'rgba(6,182,212,0.3)',  primaryBg: 'linear-gradient(135deg, #06b6d4, #0891b2)', primaryFg: '#fff' },
  purple: { bg: 'rgba(124,58,237,0.10)',  bgHover: 'rgba(124,58,237,0.18)',  fg: '#a78bfa', border: 'rgba(124,58,237,0.3)', primaryBg: 'linear-gradient(135deg, #7c3aed, #6d28d9)', primaryFg: '#fff' },
  green:  { bg: 'rgba(34,197,94,0.10)',   bgHover: 'rgba(34,197,94,0.18)',   fg: '#22c55e', border: 'rgba(34,197,94,0.3)',  primaryBg: 'linear-gradient(135deg, #22c55e, #16a34a)', primaryFg: '#fff' },
  orange: { bg: 'rgba(249,115,22,0.10)',  bgHover: 'rgba(249,115,22,0.18)',  fg: '#f97316', border: 'rgba(249,115,22,0.3)', primaryBg: 'linear-gradient(135deg, #f97316, #ea580c)', primaryFg: '#fff' },
  slate:  { bg: 'rgba(255,255,255,0.04)', bgHover: 'rgba(255,255,255,0.08)', fg: 'var(--text-secondary)', border: 'var(--border)', primaryBg: 'rgba(255,255,255,0.08)', primaryFg: 'var(--text-primary)' },
};

/**
 * Large icon-led action button used at the top of dashboards / detail pages.
 * `primary` swaps to a saturated gradient + white text — reserve for the
 * one or two hero CTAs on a page.
 */
export function HeroAction({
  tone, icon, label, hint, onClick, primary, href, target,
}: {
  tone: HeroActionTone;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick?: () => void;
  primary?: boolean;
  href?: string;
  target?: string;
}) {
  const t = TONES[tone];
  const baseStyle: React.CSSProperties = {
    background: primary ? t.primaryBg : t.bg,
    color: primary ? t.primaryFg : t.fg,
    border: primary ? '1px solid transparent' : `1px solid ${t.border}`,
    boxShadow: primary ? `0 4px 14px ${t.bg}` : 'none',
  };
  const inner = (
    <>
      <span style={{ display: 'inline-flex' }}>{icon}</span>
      <span className="flex flex-col items-start leading-tight text-left">
        <span>{label}</span>
        {hint && <span className="text-[10px] font-normal opacity-70 hidden sm:inline">{hint}</span>}
      </span>
    </>
  );
  const className = "flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:translate-y-[-1px]";
  const onMouseEnter = (e: React.MouseEvent<HTMLElement>) => { if (!primary) e.currentTarget.style.background = t.bgHover; };
  const onMouseLeave = (e: React.MouseEvent<HTMLElement>) => { if (!primary) e.currentTarget.style.background = t.bg; };

  if (href) {
    return (
      <a href={href} target={target} rel={target === '_blank' ? 'noreferrer' : undefined} title={hint} className={className} style={baseStyle} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {inner}
      </a>
    );
  }
  return (
    <button onClick={onClick} title={hint} className={className} style={baseStyle} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {inner}
    </button>
  );
}
