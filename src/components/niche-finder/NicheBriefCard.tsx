'use client';

/**
 * Niche Brief card — the AI-written promise memo rendered inside a
 * favorite panel.
 *
 * Self-managed lifecycle:
 *   1. On mount, fetch /favorites/[slug]/brief.
 *   2. If `latest.status` is 'pending' or 'running', shimmer + poll
 *      every 3s until it flips. Stops polling on unmount or status
 *      flip.
 *   3. If `latest.status` is 'failed', show an error banner + Retry
 *      button.
 *   4. If `active` is non-null, render the structured brief with
 *      Promise Score gauge, section confidence pills, and citation
 *      list grouped by domain quality.
 *   5. If neither active nor latest exists, show a "Generate brief"
 *      empty-state button — only when scores are non-placeholder
 *      (otherwise a brief would be pure speculation).
 *
 * Regenerate / Switch model / Version history live behind a single
 * ⋯ menu, per the plan's clean-UI rule.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BriefCompetitionChannel,
  ConfidenceLabel,
} from '@/lib/niche-finder/brief';
import type { BriefRow } from '@/lib/niche-finder/brief-db';
import type { BriefCitation } from '@/lib/ai/perplexity-deep-research';
import { getModelById } from '@/lib/ai-models';

interface NicheBriefCardProps {
  nicheSlug: string;
  /** True when the parent favorite was created with placeholder
   *  scores (no deep-dive run yet). We block the "Generate brief"
   *  affordance because a brief without demand/competition/monetization
   *  signal would be speculative. */
  scoresArePlaceholder: boolean;
}

interface BriefResponse {
  active: BriefRow | null;
  latest: BriefRow | null;
  history: BriefRow[];
}

export function NicheBriefCard({ nicheSlug, scoresArePlaceholder }: NicheBriefCardProps): React.ReactElement {
  const [state, setState] = useState<BriefResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBrief = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch(`/api/niche-finder/favorites/${encodeURIComponent(nicheSlug)}/brief`);
      if (!res.ok) {
        setError(`Brief fetch failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as BriefResponse;
      setState(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [nicheSlug]);

  // Initial fetch + polling while a brief is in flight.
  useEffect(() => {
    void fetchBrief();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [fetchBrief]);

  useEffect(() => {
    // Schedule the next poll IFF the latest brief is pending/running.
    if (!state?.latest) return;
    const s = state.latest.status;
    if (s !== 'pending' && s !== 'running') return;
    pollTimer.current = setTimeout(() => {
      void fetchBrief();
    }, 3000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [state?.latest, fetchBrief]);

  // Close ⋯ menu on outside click / Esc.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const regenerate = useCallback(async () => {
    if (generating) return;
    setMenuOpen(false);
    setGenerating(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch(`/api/niche-finder/favorites/${encodeURIComponent(nicheSlug)}/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Regenerate failed (${res.status})`);
        return;
      }
      // Poll immediately to pick up the new pending row.
      await fetchBrief();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setGenerating(false);
    }
  }, [generating, nicheSlug, fetchBrief]);

  const copyMarkdown = useCallback(() => {
    if (!state?.active) return;
    setMenuOpen(false);
    const md = briefToMarkdown(state.active);
    void navigator.clipboard?.writeText(md);
  }, [state]);

  // ─── Render ────────────────────────────────────────────────────────────
  if (loading) {
    return <Shimmer />;
  }

  const active = state?.active ?? null;
  const latest = state?.latest ?? null;
  const inFlight =
    latest && (latest.status === 'pending' || latest.status === 'running');

  if (!active && !latest) {
    // Never generated. Show a Generate button — disabled when scores
    // are placeholder.
    return (
      <EmptyBriefState
        scoresArePlaceholder={scoresArePlaceholder}
        onGenerate={() => void regenerate()}
        generating={generating}
        error={error}
      />
    );
  }

  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10,
        background: 'rgba(15,23,42,0.5)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* In-flight banner (shimmer over an existing brief while regenerating) */}
      {inFlight && (
        <div
          style={{
            fontSize: 12,
            padding: '6px 10px',
            background: 'rgba(168,85,247,0.10)',
            border: '1px solid rgba(168,85,247,0.30)',
            color: '#c4b5fd',
            borderRadius: 8,
          }}
        >
          {latest!.status === 'pending' ? 'Queued — brief will start within a few seconds…' : 'Writing brief…'} {' '}
          <span style={{ color: '#94a3b8' }}>
            (model: {getModelById(latest!.model_id)?.name ?? latest!.model_id})
          </span>
        </div>
      )}

      {/* Failed banner */}
      {latest && latest.status === 'failed' && (
        <div
          style={{
            fontSize: 12,
            padding: '8px 10px',
            background: 'rgba(248,113,113,0.10)',
            border: '1px solid rgba(248,113,113,0.30)',
            color: '#fca5a5',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            Last brief generation failed
            {latest.attempts >= 3 ? ' (retries exhausted)' : ` (attempt ${latest.attempts}/3)`}.
            {latest.error_message && (
              <span style={{ color: '#fda4af', marginLeft: 6 }} title={latest.error_message}>
                — {latest.error_message.slice(0, 100)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={generating}
            style={smallPillBtn('#f87171')}
          >
            Retry
          </button>
        </div>
      )}

      {/* Headline + Promise Score + ⋯ menu — only when we have an active brief */}
      {active && (
        <>
          <BriefHeader
            active={active}
            onMenuToggle={() => setMenuOpen((x) => !x)}
            menuOpen={menuOpen}
            menuRef={menuRef}
            onRegenerate={() => void regenerate()}
            onCopyMarkdown={copyMarkdown}
            onShowHistory={() => {
              setHistoryOpen(true);
              setMenuOpen(false);
            }}
            historyCount={state?.history.length ?? 0}
            generating={generating}
          />
          <BriefSectionsBlock brief={active} />
          {active.citations && active.citations.length > 0 && (
            <CitationsBlock citations={active.citations} />
          )}
          <BriefFooter brief={active} />
        </>
      )}

      {historyOpen && state && (
        <VersionHistoryOverlay history={state.history} activeId={active?.id ?? null} onClose={() => setHistoryOpen(false)} />
      )}

      {error && (
        <div style={{ fontSize: 11, color: '#fca5a5' }} title={error}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Shimmer(): React.ReactElement {
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10,
        background: 'rgba(15,23,42,0.5)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ height: 14, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '40%' }} />
      <div style={{ height: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '80%' }} />
      <div style={{ height: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '95%' }} />
      <div style={{ height: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 4, width: '70%' }} />
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Loading brief…</div>
    </div>
  );
}

function EmptyBriefState({
  scoresArePlaceholder,
  onGenerate,
  generating,
  error,
}: {
  scoresArePlaceholder: boolean;
  onGenerate: () => void;
  generating: boolean;
  error: string | null;
}): React.ReactElement {
  return (
    <div
      style={{
        border: '1px dashed rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 500 }}>No AI brief yet</div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 1.4 }}>
          {scoresArePlaceholder
            ? 'This niche has placeholder scores — run a deep-dive first so the brief has demand, competition, and monetization signals to ground on.'
            : 'Generate a Niche Brief — AI-written promise memo covering market demand, competition, monetization, operator fit, risks, and next steps.'}
        </div>
        {error && (
          <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 4 }}>{error}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onGenerate}
        disabled={generating || scoresArePlaceholder}
        title={
          scoresArePlaceholder
            ? 'Run a deep-dive on this niche first'
            : 'Generate a brief — about 30-60 seconds with Sonar Deep Research'
        }
        style={{
          padding: '6px 14px',
          background: generating || scoresArePlaceholder ? '#1e293b' : '#7c3aed',
          color: generating || scoresArePlaceholder ? '#64748b' : '#fff',
          border: 'none',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          cursor: generating || scoresArePlaceholder ? 'not-allowed' : 'pointer',
        }}
      >
        {generating ? 'Starting…' : 'Generate brief'}
      </button>
    </div>
  );
}

function BriefHeader({
  active,
  onMenuToggle,
  menuOpen,
  menuRef,
  onRegenerate,
  onCopyMarkdown,
  onShowHistory,
  historyCount,
  generating,
}: {
  active: BriefRow;
  onMenuToggle: () => void;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onRegenerate: () => void;
  onCopyMarkdown: () => void;
  onShowHistory: () => void;
  historyCount: number;
  generating: boolean;
}): React.ReactElement {
  const promiseScore = active.promise_score;
  const promiseLabel = active.promise_label;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <PromiseGauge score={promiseScore} label={promiseLabel} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Niche Brief
        </div>
        <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 500, marginTop: 4, lineHeight: 1.4 }}>
          {active.sections.headline}
        </div>
      </div>
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Brief actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            background: 'transparent',
            color: '#94a3b8',
            border: '1px solid #334155',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 14,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: 0,
              zIndex: 30,
              minWidth: 200,
              background: '#0d0d14',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
              padding: 4,
            }}
          >
            <MenuItem onClick={onRegenerate} disabled={generating}>
              Regenerate brief
            </MenuItem>
            <MenuItem onClick={onCopyMarkdown}>Copy as Markdown</MenuItem>
            <MenuItem onClick={onShowHistory} disabled={historyCount === 0}>
              Version history {historyCount > 0 ? `(${historyCount})` : ''}
            </MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        background: 'transparent',
        color: disabled ? '#475569' : '#cbd5e1',
        border: 'none',
        borderRadius: 6,
        fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

function PromiseGauge({ score, label }: { score: number; label: string }): React.ReactElement {
  const color =
    score >= 70 ? '#22c55e' : score >= 40 ? '#f59e0b' : '#f87171';
  return (
    <div
      style={{
        flexShrink: 0,
        width: 56,
        height: 56,
        borderRadius: '50%',
        background: `conic-gradient(${color} ${score * 3.6}deg, rgba(255,255,255,0.08) 0deg)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
      title={`Promise score: ${score} / 100 (${label})`}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: '#0d0d14',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color }}>{score}</div>
        <div style={{ fontSize: 8, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function BriefSectionsBlock({ brief }: { brief: BriefRow }): React.ReactElement {
  const sections = brief.sections;
  const conf = brief.section_confidences;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Section title="Market demand" body={sections.market_demand} confidence={conf.market_demand} />
      <Section title="Competition" body={sections.competition} confidence={conf.competition}>
        {sections.competition_channels && sections.competition_channels.length > 0 && (
          <CompetitionChannelsList channels={sections.competition_channels} />
        )}
      </Section>
      <Section title="Monetization" body={sections.monetization} confidence={conf.monetization} />
      <Section title="Operator fit" body={sections.operator_fit} confidence={conf.operator_fit} />
      <Section title="Risks" body={sections.risks} confidence={conf.risks} />
      <Section title="Recommended angle" body={sections.recommended_angle} confidence={conf.recommended_angle} />
      {sections.next_steps && sections.next_steps.length > 0 && (
        <div>
          <SectionHeader title="Next steps" />
          <ul style={{ margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 12, lineHeight: 1.55 }}>
            {sections.next_steps.map((s, i) => (
              <li key={i} style={{ marginBottom: 2 }}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Channel URL from a model-supplied handle/channel_id. Both have been
 *  regex-validated upstream by `clampCompetitionChannels`, so by the
 *  time they reach this component they are safe to interpolate. */
function channelHref(ch: BriefCompetitionChannel): string | null {
  if (ch.handle) return `https://www.youtube.com/${ch.handle}`;
  if (ch.channel_id) return `https://www.youtube.com/channel/${ch.channel_id}`;
  return null;
}

function CompetitionChannelsList({
  channels,
}: {
  channels: readonly BriefCompetitionChannel[];
}): React.ReactElement {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: '6px 0 0',
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      {channels.map((ch, i) => {
        const href = channelHref(ch);
        return (
          <li
            key={i}
            style={{
              fontSize: 11,
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: '#cbd5e1',
                  textDecoration: 'underline',
                  textDecorationColor: 'rgba(203,213,225,0.3)',
                  fontWeight: 500,
                }}
                title={`Open ${ch.name} on YouTube`}
              >
                {ch.name}
              </a>
            ) : (
              <span style={{ color: '#cbd5e1', fontWeight: 500 }}>{ch.name}</span>
            )}
            {ch.subs != null && (
              <span style={{ color: '#475569' }}>· {compactSubs(ch.subs)} subs</span>
            )}
            {ch.note && <span style={{ color: '#64748b' }}>— {ch.note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function compactSubs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function Section({
  title,
  body,
  confidence,
  children,
}: {
  title: string;
  body: string;
  confidence: ConfidenceLabel;
  children?: React.ReactNode;
}): React.ReactElement | null {
  if (!body || body.length === 0) return null;
  return (
    <div>
      <SectionHeader title={title} confidence={confidence} />
      <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.55 }}>{body}</div>
      {children}
    </div>
  );
}

function SectionHeader({ title, confidence }: { title: string; confidence?: ConfidenceLabel }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <span style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
        {title}
      </span>
      {confidence && <ConfidencePill value={confidence} />}
    </div>
  );
}

function ConfidencePill({ value }: { value: ConfidenceLabel }): React.ReactElement {
  const styles: Record<ConfidenceLabel, { fg: string; bg: string; border: string; label: string }> = {
    low: { fg: '#fca5a5', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)', label: 'low confidence' },
    medium: { fg: '#fbbf24', bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.30)', label: 'medium confidence' },
    high: { fg: '#86efac', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.30)', label: 'high confidence' },
  };
  const s = styles[value];
  return (
    <span
      title={s.label}
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 3,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontWeight: 600,
      }}
    >
      {value}
    </span>
  );
}

function CitationsBlock({ citations }: { citations: BriefCitation[] }): React.ReactElement {
  return (
    <div>
      <SectionHeader title="Sources" />
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {citations.map((c, i) => (
          <li key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CitationQualityBadge value={c.domain_quality} />
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#94a3b8',
                textDecoration: 'underline',
                textDecorationColor: 'rgba(148,163,184,0.3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
              title={c.title ?? c.url}
            >
              {c.title ?? c.domain}
            </a>
            <span style={{ fontSize: 10, color: '#475569', flexShrink: 0 }}>{c.domain}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CitationQualityBadge({ value }: { value: 'high' | 'medium' | 'low' }): React.ReactElement {
  const colors = {
    high: '#22c55e',
    medium: '#f59e0b',
    low: '#64748b',
  };
  const labels = {
    high: 'High-quality source (authoritative or primary)',
    medium: 'Mid-tier source (community or aggregate)',
    low: 'Low-quality source (likely SEO blogspam / listicle)',
  };
  return (
    <span
      title={labels[value]}
      style={{
        flexShrink: 0,
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: colors[value],
      }}
    />
  );
}

function BriefFooter({ brief }: { brief: BriefRow }): React.ReactElement {
  const model = getModelById(brief.model_id);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 10,
        color: '#475569',
        flexWrap: 'wrap',
        paddingTop: 6,
        borderTop: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <span>Generated {timeAgo(brief.generated_at)}</span>
      <span>·</span>
      <span title={brief.model_id}>{model?.name ?? brief.model_id}</span>
      {brief.cost_usd != null && (
        <>
          <span>·</span>
          <span title={`Input ${brief.prompt_tokens ?? 0} tok, output ${brief.completion_tokens ?? 0} tok`}>
            ${brief.cost_usd.toFixed(3)}
          </span>
        </>
      )}
    </div>
  );
}

function VersionHistoryOverlay({
  history,
  activeId,
  onClose,
}: {
  history: BriefRow[];
  activeId: string | null;
  onClose: () => void;
}): React.ReactElement {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Brief version history"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0d0d14',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 14,
          maxWidth: 560,
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', flex: 1 }}>Brief versions</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: 20, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
        <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {history.map((h) => (
            <li
              key={h.id}
              style={{
                padding: 10,
                border: `1px solid ${h.id === activeId ? 'rgba(34,197,94,0.30)' : 'rgba(255,255,255,0.06)'}`,
                background: h.id === activeId ? 'rgba(34,197,94,0.05)' : 'transparent',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#94a3b8' }}>
                <span>{timeAgo(h.generated_at)}</span>
                <span>·</span>
                <span>{getModelById(h.model_id)?.name ?? h.model_id}</span>
                <span style={{ flex: 1 }} />
                <StatusPill status={h.status} />
                {h.id === activeId && (
                  <span style={{ fontSize: 9, color: '#86efac' }}>current</span>
                )}
              </div>
              {h.status === 'ready' && (
                <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
                  {h.sections.headline}
                </div>
              )}
              {h.status === 'failed' && h.error_message && (
                <div style={{ fontSize: 11, color: '#fca5a5' }} title={h.error_message}>
                  {h.error_message.slice(0, 200)}
                </div>
              )}
              {h.status === 'ready' && h.cost_usd != null && (
                <div style={{ fontSize: 10, color: '#475569' }}>
                  Promise {h.promise_score}/100 · ${h.cost_usd.toFixed(3)}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: BriefRow['status'] }): React.ReactElement {
  const styles: Record<BriefRow['status'], { fg: string; bg: string; border: string }> = {
    pending: { fg: '#c4b5fd', bg: 'rgba(168,85,247,0.10)', border: 'rgba(168,85,247,0.30)' },
    running: { fg: '#c4b5fd', bg: 'rgba(168,85,247,0.10)', border: 'rgba(168,85,247,0.30)' },
    ready: { fg: '#86efac', bg: 'rgba(34,197,94,0.10)', border: 'rgba(34,197,94,0.30)' },
    failed: { fg: '#fca5a5', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)' },
  };
  const s = styles[status];
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 3,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function smallPillBtn(borderColor: string): React.CSSProperties {
  return {
    padding: '3px 10px',
    background: 'transparent',
    color: borderColor,
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: 600,
  };
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function briefToMarkdown(brief: BriefRow): string {
  const s = brief.sections;
  const c = brief.section_confidences;
  const conf = (k: ConfidenceLabel) => `(confidence: ${k})`;
  const cite = (brief.citations ?? []).length === 0
    ? ''
    : '\n\n## Sources\n' + (brief.citations ?? []).map((cit) => `- [${cit.title ?? cit.domain}](${cit.url}) — ${cit.domain_quality} quality`).join('\n');
  const competitionChannels = (s.competition_channels ?? []).length === 0
    ? ''
    : '\n\n**Channels:**\n' +
      (s.competition_channels ?? [])
        .map((ch) => {
          const href = channelHref(ch);
          const label = href ? `[${ch.name}](${href})` : ch.name;
          const meta = [
            ch.subs != null ? `${compactSubs(ch.subs)} subs` : null,
            ch.note,
          ]
            .filter((x) => x)
            .join(' — ');
          return `- ${label}${meta ? ` — ${meta}` : ''}`;
        })
        .join('\n');
  return [
    `# Niche Brief — ${s.headline}`,
    ``,
    `**Promise score:** ${brief.promise_score}/100 (${brief.promise_label})`,
    ``,
    `## Market demand ${conf(c.market_demand)}`,
    s.market_demand,
    ``,
    `## Competition ${conf(c.competition)}`,
    s.competition + competitionChannels,
    ``,
    `## Monetization ${conf(c.monetization)}`,
    s.monetization,
    ``,
    `## Operator fit ${conf(c.operator_fit)}`,
    s.operator_fit,
    ``,
    `## Risks ${conf(c.risks)}`,
    s.risks,
    ``,
    `## Recommended angle ${conf(c.recommended_angle)}`,
    s.recommended_angle,
    ``,
    `## Next steps`,
    ...(s.next_steps ?? []).map((step) => `- ${step}`),
    cite,
  ].join('\n');
}
