'use client';

/**
 * QA tab inside the Shorts editor. Mirrors the visual vocabulary of
 * the standalone /qa page (ScoreRing + dimension list + critical issues
 * + rewrites) but tuned for a 60-second vertical:
 *
 *   - factual_accuracy spotlight panel up top (the headline dimension —
 *     this is the reason the tab exists).
 *   - 7 per-dimension cards with score + assessment + fix.
 *   - Critical issues list (severity-chipped).
 *   - Rewrite suggestions list (verbatim original → improved).
 *
 * "Apply fix" comes in two shapes per the user's pick:
 *   - Inline ("Apply") — runs a verbatim text replace on
 *     `row.short_script` via savePatch. Stays on the QA tab so the user
 *     can keep walking the rest of the list.
 *   - "Edit in Script tab" — switches to the Script tab with the fix
 *     preloaded for manual review when the user wants context.
 *
 * Diagnostics expand-strip at the bottom surfaces the namespaced log
 * fields (rule 14) — paste-friendly for any "this looks wrong" report.
 *
 * Plan: `_plans/2026-06-07-shorts-script-qa-tab.md`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ScoreRing } from '@/components/ui/ScoreRing';
import { NicheFinderModelPicker } from '@/components/niche-finder/NicheFinderModelPicker';
import type { ShortRow } from '@/lib/shorts-types';
import {
  SHORTS_QA_DEFAULT_COMPOSITE_THRESHOLD,
  SHORTS_QA_DEFAULT_FACT_CHECK_CLAIM_CAP,
  SHORTS_QA_DEFAULT_FACT_CHECK_ENABLED,
  SHORTS_QA_DEFAULT_PER_DIMENSION_FLOOR,
  SHORTS_QA_DIMENSION_KEYS,
  SHORTS_QA_DIMENSION_LABELS,
  type ShortsContentQaResult,
  type ShortsQaCriticalIssue,
  type ShortsQaDimensionKey,
  type ShortsQaDimensionScore,
  type ShortsQaFactVerdict,
  type ShortsQaFlaggedClaim,
  type ShortsQaRewriteSuggestion,
  type ShortsQaSeverity,
} from '@/lib/shorts-content-qa-types';

interface QaSettingsState {
  composite_threshold: number;
  per_dimension_floor: number;
  fact_check_claim_cap: number;
  fact_check_enabled: boolean;
}

interface QaTabPanelProps {
  shortId: string;
  row: ShortRow;
  /** Patch the row in the editor's state + persist. Used by inline
   *  "Apply" rewrites to push the new `short_script` back. */
  savePatch: (patch: Partial<ShortRow>) => Promise<void> | void;
  /** Switch the editor to a different tab. Used by "Edit in Script
   *  tab" so the user can review a fix in context. */
  onSwitchTab: (key: 'script' | 'qa') => void;
  /** Called after a fresh QA run so the editor refreshes the row
   *  (picks up qa_result / qa_score / qa_run_at from the server). */
  onQaCompleted: (qa: ShortsContentQaResult, modelId: string) => void;
}

const SEVERITY_STYLE: Record<ShortsQaSeverity, { bg: string; border: string; color: string; label: string }> = {
  critical: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.35)', color: '#fca5a5', label: 'Critical' },
  major: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)', color: '#fde68a', label: 'Major' },
  minor: { bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.35)', color: '#a5b4fc', label: 'Minor' },
};

const VERDICT_STYLE: Record<ShortsQaFactVerdict, { bg: string; color: string; icon: string; label: string }> = {
  verified: { bg: 'rgba(34,197,94,0.18)', color: '#86efac', icon: '✓', label: 'Verified' },
  contradicted: { bg: 'rgba(239,68,68,0.18)', color: '#fca5a5', icon: '✗', label: 'Contradicted' },
  inconclusive: { bg: 'rgba(245,158,11,0.18)', color: '#fde68a', icon: '?', label: 'Inconclusive' },
  unchecked: { bg: 'rgba(148,163,184,0.18)', color: '#cbd5e1', icon: '·', label: 'Unchecked' },
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function QaTabPanel({ shortId, row, savePatch, onSwitchTab, onQaCompleted }: QaTabPanelProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [appliedOriginals, setAppliedOriginals] = useState<Set<string>>(new Set());

  const qa: ShortsContentQaResult | null = row.qa_result ?? null;

  const compositeThreshold = qa?.meta.composite_threshold ?? SHORTS_QA_DEFAULT_COMPOSITE_THRESHOLD;

  const runQa = useCallback(
    async (force = false) => {
      setRunning(true);
      setError(null);
      try {
        console.info('[shorts qa-tab run]', { shortId, force });
        // eslint-disable-next-line no-restricted-syntax -- POST to the QA route
        const res = await fetch(`/api/shorts/${encodeURIComponent(shortId)}/qa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        });
        const data = await res.json();
        if (!res.ok) {
          const msg =
            typeof data.error === 'string' ? data.error : `QA failed (HTTP ${res.status}).`;
          throw new Error(msg);
        }
        const result = data.qa as ShortsContentQaResult;
        const modelId = typeof data.modelId === 'string' ? data.modelId : qa?.meta.model_id ?? '';
        onQaCompleted(result, modelId);
        setAppliedOriginals(new Set()); // reset apply-tracking on a new run
        console.info('[shorts qa-tab done]', {
          shortId,
          composite: result.composite,
          claimCount: result.flagged_claims.length,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to run QA.';
        setError(msg);
        toast.error(msg);
        console.warn('[shorts qa-tab error]', { shortId, error: msg });
      } finally {
        setRunning(false);
      }
    },
    [shortId, onQaCompleted, qa?.meta.model_id],
  );

  // Inline-apply a rewrite by replacing `original` with `improved` in
  // the short_script. Falls back to the script tab when the original
  // string isn't found verbatim (LLM rewrites sometimes don't quote
  // exactly — the user-facing message points them to do it manually).
  const applyRewrite = useCallback(
    async (rewrite: ShortsQaRewriteSuggestion) => {
      const script = row.short_script ?? '';
      if (!script.includes(rewrite.original)) {
        toast.error('Original text not found in the script. Open the Script tab to edit manually.');
        onSwitchTab('script');
        return;
      }
      const next = script.replace(rewrite.original, rewrite.improved);
      try {
        await savePatch({ short_script: next });
        setAppliedOriginals((prev) => new Set(prev).add(rewrite.original));
        toast.success('Rewrite applied.');
        console.info('[shorts qa-tab apply]', { shortId, originalLen: rewrite.original.length });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to save.';
        toast.error(msg);
      }
    },
    [row.short_script, savePatch, onSwitchTab, shortId],
  );

  const factualAccuracy = qa?.dimensions.factual_accuracy ?? null;
  const otherDimensions: Array<[ShortsQaDimensionKey, ShortsQaDimensionScore]> = useMemo(() => {
    if (!qa) return [];
    return SHORTS_QA_DIMENSION_KEYS.filter((k) => k !== 'factual_accuracy').map((k) => [k, qa.dimensions[k]]);
  }, [qa]);

  // -------------------------------------------------------------------
  // Empty states (rule 10 — lazy-user pass).
  // -------------------------------------------------------------------
  if (!row.short_script || row.short_script.trim().length < 30) {
    return (
      <EmptyState
        title="Write a script first"
        body="QA needs at least a short script body to grade. Write it in the Script tab, then come back here."
        action={{ label: 'Go to Script tab', onClick: () => onSwitchTab('script') }}
      />
    );
  }

  if (!qa) {
    return (
      <section style={panelStyle}>
        <h2 style={panelHeading}>QA</h2>
        <p style={panelSubtitle}>
          Grade this Short against 7 dimensions including factual accuracy. Up to 5 risky claims get
          verified against Brave web search.
        </p>
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => runQa(false)} disabled={running} style={primaryButton(running)}>
            {running ? 'Running QA…' : 'Run QA'}
          </button>
          <NicheFinderModelPicker feature="shorts-qa" label="QA model" />
        </div>
        {error && <ErrorBox message={error} />}
      </section>
    );
  }

  // -------------------------------------------------------------------
  // Result view.
  // -------------------------------------------------------------------
  return (
    <section style={panelStyle}>
      {/* Top strip — ScoreRing + actions + freshness pill */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <ScoreRing score={qa.composite} size={96} strokeWidth={8} label={`Threshold ${compositeThreshold}`} />
        <div style={{ flex: 1, minWidth: 240, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ ...panelHeading, margin: 0 }}>QA</h2>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary, rgba(255,255,255,0.8))' }}>
            {qa.verdict}
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
            <span>Last run {relativeTime(row.qa_run_at)}</span>
            <span>·</span>
            <span>Model: {qa.meta.model_id}</span>
            {qa.meta.fact_check_ran ? (
              <>
                <span>·</span>
                <span>{qa.meta.fact_check_brave_queries} fact-check searches</span>
              </>
            ) : (
              <>
                <span>·</span>
                <span style={{ color: '#fde68a' }}>Fact-check skipped</span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
          <button type="button" onClick={() => runQa(false)} disabled={running} style={primaryButton(running)}>
            {running ? 'Running QA…' : 'Re-run QA'}
          </button>
          <NicheFinderModelPicker feature="shorts-qa" label="QA model" />
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      {/* Factual-accuracy spotlight — the headline panel */}
      {factualAccuracy && (
        <FactualAccuracySpotlight
          dimension={factualAccuracy}
          claims={qa.flagged_claims}
          factCheckRan={qa.meta.fact_check_ran}
        />
      )}

      {/* Per-dimension breakdown */}
      <div style={{ marginTop: 18 }}>
        <SectionHeading>Dimensions</SectionHeading>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, marginTop: 8 }}>
          {otherDimensions.map(([key, dim]) => (
            <DimensionCard key={key} label={SHORTS_QA_DIMENSION_LABELS[key]} dimension={dim} threshold={qa.meta.per_dimension_floor} />
          ))}
        </div>
      </div>

      {/* Critical issues */}
      {qa.critical_issues.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeading>Critical issues ({qa.critical_issues.length})</SectionHeading>
          <ul style={{ marginTop: 8, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {qa.critical_issues.map((issue, i) => (
              <CriticalIssueRow key={i} issue={issue} />
            ))}
          </ul>
        </div>
      )}

      {/* Rewrite suggestions */}
      {qa.rewrite_suggestions.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <SectionHeading>Rewrite suggestions ({qa.rewrite_suggestions.length})</SectionHeading>
          <ul style={{ marginTop: 8, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {qa.rewrite_suggestions.map((rw, i) => (
              <RewriteRow
                key={i}
                rewrite={rw}
                applied={appliedOriginals.has(rw.original)}
                onApply={() => applyRewrite(rw)}
                onEditInScript={() => onSwitchTab('script')}
              />
            ))}
          </ul>
        </div>
      )}

      {/* QA settings — composite threshold, per-dim floor, claim cap, fact-check toggle */}
      <QaSettingsPanel />

      {/* Diagnostics — paste-friendly for "this looks wrong" reports */}
      <div style={{ marginTop: 18, fontSize: 11 }}>
        <button
          type="button"
          onClick={() => setShowDiagnostics((v) => !v)}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          {showDiagnostics ? '▾ Hide diagnostics' : '▸ Show diagnostics'}
        </button>
        {showDiagnostics && (
          <pre
            style={{
              marginTop: 6,
              padding: 10,
              borderRadius: 8,
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 11,
              lineHeight: 1.4,
              overflow: 'auto',
            }}
          >
{`shortId:               ${shortId}
composite:             ${qa.composite}  (threshold ${qa.meta.composite_threshold})
model:                 ${qa.meta.model_id}
duration_ms:           ${qa.meta.duration_ms}
fact_check_ran:        ${qa.meta.fact_check_ran}
fact_check_searches:   ${qa.meta.fact_check_brave_queries}
fact_check_claim_cap:  ${qa.meta.fact_check_claim_cap}
per_dimension_floor:   ${qa.meta.per_dimension_floor}
run_at:                ${qa.meta.run_at}
flagged_claims:        ${qa.flagged_claims.length} (${qa.flagged_claims.filter((c) => c.verdict === 'contradicted').length} contradicted)
critical_issues:       ${qa.critical_issues.length}
rewrite_suggestions:   ${qa.rewrite_suggestions.length}`}
          </pre>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Subcomponents.
// ---------------------------------------------------------------------

function FactualAccuracySpotlight({
  dimension,
  claims,
  factCheckRan,
}: {
  dimension: ShortsQaDimensionScore;
  claims: ShortsQaFlaggedClaim[];
  factCheckRan: boolean;
}) {
  const contradicted = claims.filter((c) => c.verdict === 'contradicted').length;
  const verified = claims.filter((c) => c.verdict === 'verified').length;
  const inconclusive = claims.filter((c) => c.verdict === 'inconclusive').length;
  const tone = contradicted > 0 ? 'danger' : dimension.score >= 80 ? 'good' : 'warn';
  const border =
    tone === 'danger' ? 'rgba(239,68,68,0.35)' : tone === 'good' ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)';
  return (
    <div
      style={{
        marginTop: 16,
        padding: 14,
        borderRadius: 12,
        background: 'rgba(0,0,0,0.18)',
        border: `1px solid ${border}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Factual accuracy</span>
        <span style={{ ...scoreChipStyle(dimension.score), fontWeight: 700 }}>{dimension.score}</span>
        {factCheckRan && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {verified} verified · {contradicted} contradicted · {inconclusive} inconclusive
          </span>
        )}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary, rgba(255,255,255,0.78))' }}>
        {dimension.assessment}
      </p>
      {claims.length > 0 ? (
        <ul style={{ marginTop: 10, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {claims.map((claim, i) => (
            <ClaimRow key={i} claim={claim} />
          ))}
        </ul>
      ) : (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          No risky factual claims detected this run.
        </p>
      )}
      {dimension.fix && dimension.score < 100 && (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
          <strong style={{ color: '#fbbf24' }}>Fix:</strong> {dimension.fix}
        </p>
      )}
    </div>
  );
}

function ClaimRow({ claim }: { claim: ShortsQaFlaggedClaim }) {
  const v = VERDICT_STYLE[claim.verdict];
  return (
    <li
      style={{
        padding: 10,
        borderRadius: 8,
        background: 'rgba(0,0,0,0.22)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: v.bg,
            color: v.color,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {v.icon} {v.label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{claim.where_in_script}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>risk {claim.riskiness}/3</span>
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 13,
          color: 'var(--text-primary, #fff)',
          fontStyle: 'italic',
          lineHeight: 1.5,
        }}
      >
        “{claim.claim}”
      </div>
      {claim.reason && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>{claim.reason}</div>
      )}
      {claim.source_url && (
        <a
          href={claim.source_url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ marginTop: 4, display: 'inline-block', fontSize: 11, color: '#93c5fd' }}
        >
          source ↗
        </a>
      )}
    </li>
  );
}

function DimensionCard({
  label,
  dimension,
  threshold,
}: {
  label: string;
  dimension: ShortsQaDimensionScore;
  threshold: number;
}) {
  const [expanded, setExpanded] = useState(dimension.score < threshold);
  const chip = scoreChipStyle(dimension.score);
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 10,
        background: 'rgba(0,0,0,0.18)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'inherit',
          padding: 0,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
        <span style={{ marginLeft: 'auto', ...chip, fontWeight: 700 }}>{dimension.score}</span>
      </button>
      <div
        style={{
          marginTop: 6,
          height: 4,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.06)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${dimension.score}%`,
            height: '100%',
            background: chip.color,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      {expanded && (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary, rgba(255,255,255,0.75))' }}>
            {dimension.assessment}
          </p>
          {dimension.issues.length > 0 && (
            <ul style={{ marginTop: 6, paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {dimension.issues.map((iss, i) => (
                <li key={i}>{iss}</li>
              ))}
            </ul>
          )}
          {dimension.fix && (
            <p style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
              <strong style={{ color: '#fbbf24' }}>Fix:</strong> {dimension.fix}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CriticalIssueRow({ issue }: { issue: ShortsQaCriticalIssue }) {
  const s = SEVERITY_STYLE[issue.severity];
  return (
    <li
      style={{
        padding: 12,
        borderRadius: 10,
        background: s.bg,
        border: `1px solid ${s.border}`,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: 'rgba(0,0,0,0.25)',
            color: s.color,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {s.label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.location}</span>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5 }}>{issue.issue}</p>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
        <strong style={{ color: '#fbbf24' }}>Fix:</strong> {issue.fix}
      </p>
    </li>
  );
}

function RewriteRow({
  rewrite,
  applied,
  onApply,
  onEditInScript,
}: {
  rewrite: ShortsQaRewriteSuggestion;
  applied: boolean;
  onApply: () => void;
  onEditInScript: () => void;
}) {
  return (
    <li
      style={{
        padding: 12,
        borderRadius: 10,
        background: 'rgba(0,0,0,0.18)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Original</span>
        <span style={{ fontSize: 13, fontStyle: 'italic', color: 'rgba(252,165,165,0.95)' }}>“{rewrite.original}”</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Improved</span>
        <span style={{ fontSize: 13, color: 'rgba(134,239,172,0.95)' }}>“{rewrite.improved}”</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}>
        {rewrite.reason}
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onApply}
          disabled={applied}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: 'none',
            cursor: applied ? 'not-allowed' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            background: applied ? 'rgba(34,197,94,0.25)' : 'rgba(124,58,237,0.95)',
            color: '#fff',
          }}
        >
          {applied ? 'Applied ✓' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={onEditInScript}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'var(--text-primary, #fff)',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Edit in Script tab
        </button>
      </div>
    </li>
  );
}

function QaSettingsPanel() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<QaSettingsState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || settings) return;
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET on mount to load saved settings
        const res = await fetch('/api/user/settings/shorts-qa');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setSettings({
          composite_threshold: data.composite_threshold ?? SHORTS_QA_DEFAULT_COMPOSITE_THRESHOLD,
          per_dimension_floor: data.per_dimension_floor ?? SHORTS_QA_DEFAULT_PER_DIMENSION_FLOOR,
          fact_check_claim_cap: data.fact_check_claim_cap ?? SHORTS_QA_DEFAULT_FACT_CHECK_CLAIM_CAP,
          fact_check_enabled: data.fact_check_enabled ?? SHORTS_QA_DEFAULT_FACT_CHECK_ENABLED,
        });
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Could not load QA settings.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, settings]);

  const updateField = useCallback(
    async (patch: Partial<QaSettingsState>) => {
      if (!settings) return;
      const next: QaSettingsState = { ...settings, ...patch };
      setSettings(next); // optimistic
      setSaving(true);
      try {
        // eslint-disable-next-line no-restricted-syntax -- user-initiated knob in an open UI; crash-survival via the mutate queue is overkill, the toast surfaces failures
        const res = await fetch('/api/user/settings/shorts-qa', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        console.info('[shorts qa-tab settings save]', { patch });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save QA setting.');
        setSettings(settings); // rollback
      } finally {
        setSaving(false);
      }
    },
    [settings],
  );

  return (
    <div style={{ marginTop: 18, fontSize: 11 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {open ? '▾ QA settings' : '▸ QA settings'}
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: 12,
            borderRadius: 10,
            background: 'rgba(0,0,0,0.18)',
            border: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {!settings ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
          ) : (
            <>
              <SettingRow
                label="Composite threshold"
                hint="Composite below this turns the tab badge red."
                value={settings.composite_threshold}
                min={0}
                max={100}
                step={5}
                onChange={(v) => updateField({ composite_threshold: v })}
              />
              <SettingRow
                label="Per-dimension floor"
                hint="Any dimension below this is auto-promoted to a critical issue."
                value={settings.per_dimension_floor}
                min={0}
                max={100}
                step={5}
                onChange={(v) => updateField({ per_dimension_floor: v })}
              />
              <SettingRow
                label="Fact-check claim cap"
                hint="Hard ceiling on Brave searches per QA run. Cost control."
                value={settings.fact_check_claim_cap}
                min={1}
                max={10}
                step={1}
                onChange={(v) => updateField({ fact_check_claim_cap: v })}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={settings.fact_check_enabled}
                  onChange={(e) => updateField({ fact_check_enabled: e.target.checked })}
                />
                <span style={{ fontSize: 12, color: 'var(--text-primary, #fff)' }}>
                  Verify flagged claims with Brave search
                </span>
              </label>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {saving ? 'Saving…' : 'Saved automatically. Defaults: 80 / 70 / 5 / on.'}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 12, color: '#fbbf24', fontWeight: 700 }}>{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%' }}
      />
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hint}</span>
    </div>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section style={panelStyle}>
      <h2 style={panelHeading}>QA</h2>
      <div
        style={{
          marginTop: 16,
          padding: 24,
          borderRadius: 12,
          border: '1px dashed rgba(255,255,255,0.12)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-secondary, rgba(255,255,255,0.7))', lineHeight: 1.5 }}>
          {body}
        </p>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{
              marginTop: 14,
              padding: '8px 16px',
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              background: 'rgba(124,58,237,0.95)',
              color: '#fff',
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </section>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        border: '1px solid rgba(239,68,68,0.3)',
        background: 'rgba(239,68,68,0.08)',
        fontSize: 12,
        color: '#fca5a5',
      }}
    >
      {message}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: 0,
        fontSize: 12,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: 'var(--text-muted)',
      }}
    >
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------
// Style helpers.
// ---------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  padding: 18,
  borderRadius: 14,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  marginBottom: 16,
};

const panelHeading: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 700,
};

const panelSubtitle: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 12,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
};

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontWeight: 600,
    fontSize: 13,
    background: disabled ? 'rgba(124,58,237,0.5)' : 'rgba(124,58,237,0.95)',
    color: '#fff',
  };
}

function scoreChipStyle(score: number): React.CSSProperties {
  const color = score >= 75 ? '#86efac' : score >= 50 ? '#fde68a' : '#fca5a5';
  const bg =
    score >= 75 ? 'rgba(34,197,94,0.18)' : score >= 50 ? 'rgba(245,158,11,0.18)' : 'rgba(239,68,68,0.18)';
  return {
    padding: '2px 10px',
    borderRadius: 999,
    fontSize: 12,
    color,
    background: bg,
  };
}
