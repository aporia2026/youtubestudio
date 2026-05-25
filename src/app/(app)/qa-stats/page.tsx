/**
 * QA stats — the measurement surface for the QA hardening plan.
 *
 * Server component. Reads the workspace's recent auto-pipeline QA outcomes
 * and renders three views:
 *
 *   1. First-pass score distribution (histogram by bucket).
 *   2. Iteration count distribution (how many qa_retry loops to pass).
 *   3. Pre-QA self-check decision tally (kept vs. rewrote).
 *
 * No interactivity needed in v1 — read-only static render of the snapshot.
 * The page is the source of truth for "is Lever B / Lever A actually moving
 * the needle?" Read it before flipping the feature flag, read it again
 * after a week of runs, compare.
 *
 * Standing rule 14 (observability): the queries themselves are logged by
 * the underlying sql client; no extra logging needed in the page.
 */
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  loadQaStatsSnapshot,
  bucketScores,
  bucketIterations,
  meanScore,
} from '@/lib/qa-stats';

export const dynamic = 'force-dynamic';

export default async function QaStatsPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const snapshot = await loadQaStatsSnapshot(session.ws);

  const allScores = snapshot.firstPassScores.map(r => r.score);
  const scoreHistogram = bucketScores(allScores);
  const avgScore = meanScore(allScores);

  const allRetries = snapshot.iterations.map(r => r.retry_count);
  const retryHistogram = bucketIterations(allRetries);
  const passedFirstTryCount = allRetries.filter(n => n === 0).length;
  const passedFirstTryPct = allRetries.length === 0 ? 0 : (passedFirstTryCount / allRetries.length) * 100;
  const failedCount = snapshot.iterations.filter(r => r.terminal_stage === 'qa_failed_after_max_retries').length;

  const selfCheckTotal = snapshot.selfCheckTally.reduce((a, r) => a + r.count, 0);
  const rewroteCount = snapshot.selfCheckTally.find(r => r.decision === 'rewrote')?.count ?? 0;
  const keptCount = snapshot.selfCheckTally.find(r => r.decision === 'kept')?.count ?? 0;

  // Group first-pass scores by preset for the per-preset breakdown.
  const byPreset = new Map<string, { name: string; scores: number[] }>();
  for (const row of snapshot.firstPassScores) {
    const key = row.preset_id ?? `__noid__${row.preset_name}`;
    if (!byPreset.has(key)) byPreset.set(key, { name: row.preset_name, scores: [] });
    byPreset.get(key)!.scores.push(row.score);
  }
  const perPreset = Array.from(byPreset.values())
    .map(p => ({ name: p.name, n: p.scores.length, mean: meanScore(p.scores) }))
    .sort((a, b) => b.n - a.n);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          QA Stats
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Auto-pipeline first-pass scoring + iteration counts + pre-QA self-check decisions for this workspace.
          Read it before and after flipping QA levers to attribute deltas honestly.
        </p>
      </header>

      {/* Summary cards */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-8">
        <SummaryCard
          label="Auto-pipeline videos"
          value={snapshot.totalAutoVideos.toLocaleString()}
          sub="lifetime in this workspace"
        />
        <SummaryCard
          label="First-pass mean score"
          value={avgScore > 0 ? avgScore.toFixed(1) : '—'}
          sub={`across ${allScores.length} panels`}
          accent={avgScore >= 85 ? 'green' : avgScore >= 70 ? 'yellow' : avgScore > 0 ? 'red' : null}
        />
        <SummaryCard
          label="Passed first try"
          value={allRetries.length === 0 ? '—' : `${passedFirstTryPct.toFixed(0)}%`}
          sub={`${passedFirstTryCount} of ${allRetries.length} videos`}
          accent={passedFirstTryPct >= 50 ? 'green' : passedFirstTryPct >= 25 ? 'yellow' : passedFirstTryPct > 0 ? 'red' : null}
        />
        <SummaryCard
          label="QA failed terminally"
          value={failedCount.toLocaleString()}
          sub="hit qa_max_iterations"
          accent={failedCount > 0 ? 'red' : null}
        />
      </section>

      {/* First-pass score distribution */}
      <Section title="First-pass score distribution" subtitle={`Last ${allScores.length} panels (auto-pipeline only). Higher buckets = stronger drafts before any qa_retry.`}>
        <Histogram data={scoreHistogram} />
      </Section>

      {/* Iteration distribution */}
      <Section title="Iterations to pass QA" subtitle={`Last ${allRetries.length} videos that reached or past narration. 0 retries means the first script cleared the threshold.`}>
        <Histogram data={retryHistogram} />
      </Section>

      {/* Self-check tally */}
      <Section
        title="Pre-QA self-check decisions"
        subtitle={
          selfCheckTotal === 0
            ? 'No pre-QA self-checks run yet. Enable QA_PRE_CHECK_ENABLED=true in the environment and run a batch to populate this section.'
            : `${selfCheckTotal} script(s) self-checked. "Rewrote" means the self-critic found a weak section and replaced it before the panel saw the draft.`
        }
      >
        {selfCheckTotal === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Pending data.
          </p>
        ) : (
          <div className="flex items-center gap-6">
            <DecisionPill label="Kept" count={keptCount} total={selfCheckTotal} />
            <DecisionPill label="Rewrote" count={rewroteCount} total={selfCheckTotal} accent />
          </div>
        )}
      </Section>

      {/* Per-preset breakdown */}
      <Section title="Per-preset first-pass mean" subtitle="Mean first-pass score broken down by preset. Use this to identify which presets benefit most from the next QA lever.">
        {perPreset.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            No completed panels in the window.
          </p>
        ) : (
          <div className="grid gap-2">
            {perPreset.map(p => (
              <div
                key={p.name}
                className="flex items-center justify-between px-3 py-2 rounded"
                style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
              >
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{p.mean.toFixed(1)}</span>
                  {' · '}
                  {p.n} panel{p.n === 1 ? '' : 's'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <footer className="mt-8 text-xs" style={{ color: 'var(--text-muted)' }}>
        <p>
          Snapshot bounded to the most recent ~200 panels and 200 videos. Reload after a batch of runs to see updated numbers. This page does not poll.
        </p>
      </footer>
    </div>
  );
}

function Section(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{props.title}</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>{props.subtitle}</p>
      {props.children}
    </section>
  );
}

function SummaryCard(props: { label: string; value: string; sub: string; accent?: 'green' | 'yellow' | 'red' | null }) {
  const valueColor = props.accent === 'green'
    ? 'var(--accent-green)'
    : props.accent === 'yellow'
      ? 'var(--accent-yellow)'
      : props.accent === 'red'
        ? 'var(--accent-pink)'
        : 'var(--text-primary)';
  return (
    <div
      className="px-3 py-2.5 rounded"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>{props.label}</div>
      <div className="text-xl font-semibold mt-0.5" style={{ color: valueColor }}>{props.value}</div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{props.sub}</div>
    </div>
  );
}

function Histogram(props: { data: Array<{ label: string; count: number; pct: number }> }) {
  const max = props.data.reduce((m, b) => Math.max(m, b.count), 0);
  return (
    <div className="grid gap-1.5">
      {props.data.map(b => (
        <div key={b.label} className="flex items-center gap-3">
          <span className="text-xs w-16 text-right" style={{ color: 'var(--text-muted)' }}>{b.label}</span>
          <div className="flex-1 h-6 rounded overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
            <div
              className="h-full"
              style={{
                width: max === 0 ? '0%' : `${(b.count / max) * 100}%`,
                background: 'linear-gradient(90deg, var(--accent-purple), var(--accent-cyan))',
                minWidth: b.count > 0 ? 2 : 0,
              }}
              aria-label={`${b.count} (${b.pct.toFixed(0)}%)`}
            />
          </div>
          <span className="text-xs w-24" style={{ color: 'var(--text-primary)' }}>
            <span style={{ fontWeight: 600 }}>{b.count}</span>
            <span style={{ color: 'var(--text-muted)' }}> · {b.pct.toFixed(0)}%</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function DecisionPill(props: { label: string; count: number; total: number; accent?: boolean }) {
  const pct = props.total === 0 ? 0 : (props.count / props.total) * 100;
  const bg = props.accent ? 'var(--accent-purple)' : 'var(--bg-secondary)';
  const fg = props.accent ? 'white' : 'var(--text-primary)';
  return (
    <div
      className="px-4 py-2.5 rounded flex flex-col"
      style={{ background: bg, border: '1px solid var(--border)', color: fg, minWidth: 120 }}
    >
      <span className="text-xs uppercase tracking-wider opacity-80">{props.label}</span>
      <span className="text-xl font-semibold">{props.count.toLocaleString()}</span>
      <span className="text-xs opacity-80">{pct.toFixed(0)}% of self-checks</span>
    </div>
  );
}
