'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import type { DashboardSummary } from '@/lib/dashboard-summary';
import { CompetitorSignalsCard } from '@/components/dashboard/CompetitorSignalsCard';
import { PredictionAccuracyCard } from '@/components/dashboard/PredictionAccuracyCard';
import { TrafficSourceCard } from '@/components/dashboard/TrafficSourceCard';

// -- Quick action shortcuts -------------------------------------------------
// Six high-frequency actions surfaced as gradient cards above the operational
// sections. Picked from the prior dashboard's QUICK_ACTIONS + the most-clicked
// FEATURE_CARDS — the rest stay reachable via the sidebar / Cmd-K palette.
const QUICK_ACTIONS: Array<{
  label: string;
  description: string;
  href: string;
  gradient: string;
  glow: string;
  icon: React.ReactNode;
}> = [
  {
    label: 'Generate script',
    description: 'AI from topic + length',
    href: '/generator',
    gradient: 'linear-gradient(135deg, #7c3aed, #06b6d4)',
    glow: 'rgba(124,58,237,0.35)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
  {
    label: 'QA a script',
    description: 'Brutal multi-pass review',
    href: '/qa',
    gradient: 'linear-gradient(135deg, #ec4899, #f59e0b)',
    glow: 'rgba(236,72,153,0.3)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
        <path d="M11 8v3l2 2" />
      </svg>
    ),
  },
  {
    label: 'Find ideas',
    description: 'Niche-aware brainstorm',
    href: '/ideas',
    gradient: 'linear-gradient(135deg, #10b981, #06b6d4)',
    glow: 'rgba(16,185,129,0.3)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
      </svg>
    ),
  },
  {
    label: 'New project',
    description: 'Full video production',
    href: '/projects/new',
    gradient: 'linear-gradient(135deg, #f59e0b, #ec4899)',
    glow: 'rgba(245,158,11,0.3)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 5v14M5 12h14" />
      </svg>
    ),
  },
  {
    label: 'Voiceover',
    description: 'ElevenLabs studio',
    href: '/voiceover',
    gradient: 'linear-gradient(135deg, #6366f1, #ec4899)',
    glow: 'rgba(99,102,241,0.3)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    ),
  },
  {
    label: 'Thumbnails',
    description: 'Concepts + A/B variants',
    href: '/thumbnails',
    gradient: 'linear-gradient(135deg, #06b6d4, #10b981)',
    glow: 'rgba(6,182,212,0.3)',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    ),
  },
];

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/summary', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DashboardSummary;
      setSummary(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold gradient-text">Dashboard</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            What needs your attention today.
          </p>
        </div>
        <button onClick={refresh} disabled={loading} className="btn-secondary text-sm">
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div
          className="text-sm px-4 py-3 rounded-lg mb-4"
          style={{
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          {error}
        </div>
      )}

      <QuickActions />


      {summary?.errors && summary.errors.length > 0 && (
        <div
          className="text-xs px-4 py-2 rounded-lg mb-3"
          style={{
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.3)',
            color: '#f59e0b',
          }}
        >
          Some sections couldn’t be fetched: {summary.errors.join(' · ')}
        </div>
      )}

      {summary && (
        <motion.div
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
          style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
        >
          <CompetitorSignalsCard />
          <TrafficSourceCard />
          <PredictionAccuracyCard />
          <Section title="Today's publishes" empty="Nothing scheduled for today.">
            {summary.today_publishes.length > 0 ? (
              <Table
                head={['Title', 'Status', 'Channel', 'Editor', 'Narrator', 'Time']}
                rows={summary.today_publishes.map(it => [
                  <Link
                    key={it.id}
                    href={`/schedule?focus=${it.id}`}
                    className="hover:underline"
                    style={{ color: 'var(--text-primary)', fontWeight: 500 }}
                  >
                    {it.title}
                  </Link>,
                  <Pill key={`${it.id}-status`} text={it.status} />,
                  it.channel_name ?? '—',
                  it.editor_name ?? '—',
                  it.narrator_name ?? '—',
                  formatTime(it.scheduled_for),
                ])}
              />
            ) : null}
          </Section>

          <Section title={`Stuck (${summary.stuck.length})`} empty="Nothing past its stage threshold. Nice.">
            {summary.stuck.length > 0 ? (
              <Table
                head={['Title', 'Stage', 'Days in stage', 'Threshold', 'Channel']}
                rows={summary.stuck.map(it => [
                  <Link
                    key={it.id}
                    href={`/schedule?focus=${it.id}`}
                    className="hover:underline"
                    style={{ color: 'var(--text-primary)', fontWeight: 500 }}
                  >
                    {it.title}
                  </Link>,
                  <Pill key={`${it.id}-stage`} text={it.status} />,
                  <span key={`${it.id}-days`} style={{ color: '#ef4444', fontWeight: 600 }}>
                    {it.days_in_stage}d
                  </span>,
                  `${it.threshold_days}d`,
                  it.channel_name ?? '—',
                ])}
              />
            ) : null}
          </Section>

          <Section
            title={`Underperformers (${summary.underperformers.length})`}
            empty="No flagged underperformers in the last 14 days."
          >
            {summary.underperformers.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 12,
                }}
              >
                {summary.underperformers.map(u => (
                  <UnderperformerCard key={u.youtube_video_id} item={u} />
                ))}
              </div>
            ) : null}
          </Section>

          <Section title="Cadence — last 4 weeks" empty="No channels yet — add one in /channel.">
            {summary.cadence.length > 0 ? (
              <Table
                head={['Channel', 'Target / week', 'Actual / week', 'Gap']}
                rows={summary.cadence.map(c => [
                  c.channel_name,
                  c.target_per_week.toFixed(1),
                  c.actual_per_week.toFixed(2),
                  <span
                    key={`${c.channel_id}-gap`}
                    style={{
                      color: c.gap > 0.5 ? '#ef4444' : c.gap > 0 ? '#f59e0b' : '#10b981',
                      fontWeight: 600,
                    }}
                  >
                    {c.gap > 0
                      ? `behind by ${c.gap.toFixed(2)}/wk`
                      : c.gap < 0
                        ? `ahead by ${Math.abs(c.gap).toFixed(2)}/wk`
                        : 'on target'}
                  </span>,
                ])}
              />
            ) : null}
          </Section>

          <p
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              textAlign: 'right',
              marginTop: 8,
            }}
          >
            Generated {new Date(summary.generated_at).toLocaleString()}
          </p>
        </motion.div>
      )}
    </div>
  );
}

function QuickActions() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 12,
        marginBottom: 24,
      }}
    >
      {QUICK_ACTIONS.map((a, i) => (
        <motion.div
          key={a.href}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.04 * i }}
          whileHover={{ y: -2 }}
        >
          <Link
            href={a.href}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '14px 16px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.08)',
              textDecoration: 'none',
              transition: 'all 200ms ease',
              position: 'relative',
              overflow: 'hidden',
              minHeight: 92,
            }}
            className="quick-action-card"
            onMouseEnter={(e) => {
              const target = e.currentTarget;
              target.style.borderColor = 'rgba(255,255,255,0.18)';
              target.style.boxShadow = `0 0 24px ${a.glow}`;
            }}
            onMouseLeave={(e) => {
              const target = e.currentTarget;
              target.style.borderColor = 'rgba(255,255,255,0.08)';
              target.style.boxShadow = 'none';
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: a.gradient,
                color: 'white',
                flexShrink: 0,
              }}
            >
              {a.icon}
            </div>
            <div>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  letterSpacing: -0.1,
                }}
              >
                {a.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  marginTop: 2,
                  lineHeight: 1.35,
                }}
              >
                {a.description}
              </div>
            </div>
          </Link>
        </motion.div>
      ))}
    </motion.div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 12,
        padding: 18,
      }}
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
        {title}
      </h2>
      {children ?? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{empty}</p>}
    </motion.section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {head.map(h => (
              <th
                key={h}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  letterSpacing: 0.5,
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pill({ text }: { text: string }) {
  const palette: Record<string, string> = {
    idea: '#a78bfa',
    scripting: '#06b6d4',
    recording: '#f59e0b',
    editing: '#ec4899',
    ready: '#10b981',
    published: '#64748b',
  };
  const color = palette[text] || '#64748b';
  return (
    <span
      style={{
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 999,
        background: `${color}22`,
        border: `1px solid ${color}66`,
        color,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {text}
    </span>
  );
}

function UnderperformerCard({
  item,
}: {
  item: DashboardSummary['underperformers'][number];
}) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {item.thumbnail_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbnail_url}
          alt={item.title || 'video thumbnail'}
          style={{ width: '100%', display: 'block', aspectRatio: '16/9', objectFit: 'cover' }}
        />
      )}
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.3 }}>
          {item.title || item.youtube_video_id}
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          {item.views !== null && <span>{formatBig(item.views)} views</span>}
          {item.ctr_percentage !== null && <span>CTR {item.ctr_percentage.toFixed(1)}%</span>}
          {item.average_view_percentage !== null && (
            <span>AVP {item.average_view_percentage.toFixed(1)}%</span>
          )}
        </div>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            fontSize: 11,
            color: '#ef4444',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {item.reasons.map(r => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
        {item.schedule_item_id && (
          <Link
            href={`/schedule?focus=${item.schedule_item_id}`}
            className="hover:underline"
            style={{ fontSize: 11, color: 'var(--text-secondary)' }}
          >
            Open schedule item →
          </Link>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

function formatBig(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}
