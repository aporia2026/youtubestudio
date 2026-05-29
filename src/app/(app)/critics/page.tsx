'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  CriticPanelEventRow,
  CriticPanelRow,
} from '@/lib/script-critics/panel-events';
import type {
  ScriptCharter,
  ScriptCriticId,
  ScriptCriticReport,
  ScriptDeliberationNote,
  ScriptPanelVerdict,
} from '@/lib/script-critics/types';

interface ProjectListItem {
  id: string;
  title: string;
  niche: string | null;
}

const CRITICS: { id: ScriptCriticId; label: string; color: string }[] = [
  { id: 'hook-coach', label: 'Hook Coach', color: '#fb923c' },
  { id: 'substance-auditor', label: 'Substance Auditor', color: '#60a5fa' },
  { id: 'flow-critic', label: 'Flow Critic', color: '#c084fc' },
];

interface CriticState {
  draftStatus: 'idle' | 'running' | 'done' | 'error';
  draft?: ScriptCriticReport;
  draftError?: string;
  delibStatus: 'idle' | 'running' | 'done' | 'error';
  note?: ScriptDeliberationNote;
  delibError?: string;
}

interface PanelLiveState {
  panelId: string | null;
  charter?: ScriptCharter;
  charterStatus: 'idle' | 'running' | 'done' | 'error';
  charterError?: string;
  chairStatus: 'idle' | 'running' | 'done' | 'error';
  chairError?: string;
  verdict?: ScriptPanelVerdict;
  panelStatus: 'idle' | 'running' | 'completed' | 'failed';
  panelError?: string;
  critics: Record<ScriptCriticId, CriticState>;
  durationMs?: number;
}

const initialCriticState = (): CriticState => ({
  draftStatus: 'idle',
  delibStatus: 'idle',
});

const initialPanelState = (): PanelLiveState => ({
  panelId: null,
  charterStatus: 'idle',
  chairStatus: 'idle',
  panelStatus: 'idle',
  critics: {
    'hook-coach': initialCriticState(),
    'substance-auditor': initialCriticState(),
    'flow-critic': initialCriticState(),
  },
});

export default function CriticsPage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [panels, setPanels] = useState<CriticPanelRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [niche, setNiche] = useState('');
  const [script, setScript] = useState('');
  const [modelId, setModelId] = useState('claude-sonnet-4-6');
  const [aggressiveness, setAggressiveness] = useState<'standard' | 'brutal' | 'nuclear'>('standard');

  const [live, setLive] = useState<PanelLiveState>(initialPanelState());
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Initial load: projects + recent panels.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, listRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch('/api/projects?limit=100'),
          // eslint-disable-next-line no-restricted-syntax -- GET, read
          fetch('/api/critics/panels?limit=20'),
        ]);
        if (cancelled) return;
        if (pRes.ok) setProjects(((await pRes.json()).projects as ProjectListItem[]) || []);
        if (listRes.ok) setPanels(((await listRes.json()).panels as CriticPanelRow[]) || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When project changes, default the niche.
  useEffect(() => {
    if (!selectedProjectId) return;
    const p = projects.find((x) => x.id === selectedProjectId);
    if (p?.niche) setNiche((curr) => curr || p.niche!);
  }, [selectedProjectId, projects]);

  function applyEvent(state: PanelLiveState, event: CriticPanelEventRow): PanelLiveState {
    const next: PanelLiveState = {
      ...state,
      critics: {
        ...state.critics,
        'hook-coach': { ...state.critics['hook-coach'] },
        'substance-auditor': { ...state.critics['substance-auditor'] },
        'flow-critic': { ...state.critics['flow-critic'] },
      },
    };
    const payload = event.payload as Record<string, unknown>;
    if (event.phase === 'panel') {
      if (event.event_type === 'start') next.panelStatus = 'running';
      else if (event.event_type === 'complete') {
        next.panelStatus = 'completed';
        next.verdict = payload.verdict as ScriptPanelVerdict;
        next.durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : undefined;
      } else if (event.event_type === 'error') {
        next.panelStatus = 'failed';
        next.panelError = String(payload.message ?? 'Unknown error');
      }
    } else if (event.phase === 'charter') {
      if (event.event_type === 'start') next.charterStatus = 'running';
      else if (event.event_type === 'complete') {
        next.charterStatus = 'done';
        next.charter = payload.charter as ScriptCharter;
      } else if (event.event_type === 'error') {
        next.charterStatus = 'error';
        next.charterError = String(payload.message ?? 'Charter failed');
      }
    } else if (event.phase === 'draft' && event.critic_id) {
      const c = next.critics[event.critic_id];
      if (event.event_type === 'start') c.draftStatus = 'running';
      else if (event.event_type === 'complete') {
        c.draftStatus = 'done';
        c.draft = payload.draft as ScriptCriticReport;
      } else if (event.event_type === 'error') {
        c.draftStatus = 'error';
        c.draftError = String(payload.message ?? 'Draft failed');
      }
    } else if (event.phase === 'deliberation' && event.critic_id) {
      const c = next.critics[event.critic_id];
      if (event.event_type === 'start') c.delibStatus = 'running';
      else if (event.event_type === 'complete') {
        c.delibStatus = 'done';
        c.note = payload.note as ScriptDeliberationNote;
      } else if (event.event_type === 'error') {
        c.delibStatus = 'error';
        c.delibError = String(payload.message ?? 'Deliberation failed');
      }
    } else if (event.phase === 'chair') {
      if (event.event_type === 'start') next.chairStatus = 'running';
      else if (event.event_type === 'complete') {
        next.chairStatus = 'done';
        next.verdict = payload.verdict as ScriptPanelVerdict;
      } else if (event.event_type === 'error') {
        next.chairStatus = 'error';
        next.chairError = String(payload.message ?? 'Chair failed');
      }
    }
    return next;
  }

  async function startPanel() {
    if (!script.trim() || script.trim().length < 200) {
      setError('Script must be at least 200 characters.');
      return;
    }
    if (!niche.trim()) {
      setError('Niche is required.');
      return;
    }
    setError(null);
    setLive(initialPanelState());
    setIsRunning(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/critics/panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script,
          niche,
          modelId,
          aggressiveness,
          projectId: selectedProjectId || null,
        }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processFrame(frame);
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        // user cancelled — keep partial state visible
      } else {
        setError(e instanceof Error ? e.message : 'Stream failed');
      }
    } finally {
      setIsRunning(false);
      abortRef.current = null;
      // Refresh history to include the new run.
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      fetch('/api/critics/panels?limit=20', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.panels && setPanels(d.panels))
        .catch(() => {});
    }
  }

  function processFrame(rawFrame: string) {
    const lines = rawFrame.split('\n').map((l) => l.trim()).filter(Boolean);
    let dataPayload = '';
    for (const line of lines) {
      if (line.startsWith('data:')) dataPayload += line.slice(5).trim();
    }
    if (!dataPayload) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataPayload);
    } catch {
      return;
    }
    if ('panel_id' in parsed && typeof parsed.panel_id === 'string') {
      setLive((curr) => ({ ...curr, panelId: parsed.panel_id as string }));
      return;
    }
    if ('phase' in parsed && 'event_type' in parsed) {
      const ev = parsed as unknown as CriticPanelEventRow;
      setLive((curr) => applyEvent(curr, ev));
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Court of Critics — live</h1>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Three specialists draft independently, deliberate, then a Chair (Gemini 3.1 Pro) synthesises. Watch the courtroom in real time.
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}

      {/* Setup */}
      <div className="glass rounded-xl p-5 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <Field label="Project (optional)">
            <select
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className="input-field"
              disabled={isRunning}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </Field>
          <Field label="Niche">
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              className="input-field"
              placeholder="e.g. AI tools, finance, retro tech"
              disabled={isRunning}
            />
          </Field>
          <Field label="Aggressiveness">
            <select
              value={aggressiveness}
              onChange={(e) => setAggressiveness(e.target.value as typeof aggressiveness)}
              className="input-field"
              disabled={isRunning}
            >
              <option value="standard">Standard</option>
              <option value="brutal">Brutal</option>
              <option value="nuclear">Nuclear</option>
            </select>
          </Field>
        </div>
        <Field label="Script (paste full text)">
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            className="input-field font-mono text-sm"
            rows={8}
            placeholder="Paste the full script here. Minimum 200 characters."
            disabled={isRunning}
          />
          <div className="text-[10px] mt-1 text-right" style={{ color: 'var(--text-muted)' }}>
            {script.length} chars
          </div>
        </Field>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={startPanel}
            disabled={isRunning}
            className="btn-primary text-sm"
          >
            {isRunning ? 'Court in session…' : '▶ Convene the court'}
          </button>
          {isRunning && (
            <button
              type="button"
              onClick={cancel}
              className="text-sm px-3 py-1.5 rounded"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
            >
              Cancel
            </button>
          )}
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Model: {modelId} · Chair: kie-gemini-3.1-pro
          </span>
        </div>
      </div>

      {/* Live courtroom */}
      {(isRunning || live.panelStatus !== 'idle') && (
        <div className="space-y-6 mb-8">
          {/* Charter */}
          <PhaseCard
            label="Charter"
            status={live.charterStatus}
            error={live.charterError}
            color="#a78bfa"
          >
            {live.charter && (
              <div className="text-xs space-y-1.5" style={{ color: 'var(--text-secondary)' }}>
                <div><strong>Mission:</strong> {live.charter.mission}</div>
                {live.charter.redLines.length > 0 && (
                  <div><strong>Red lines:</strong> {live.charter.redLines.join(' · ')}</div>
                )}
              </div>
            )}
          </PhaseCard>

          {/* Critics row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {CRITICS.map((c) => (
              <CriticCard key={c.id} label={c.label} color={c.color} state={live.critics[c.id]} />
            ))}
          </div>

          {/* Chair */}
          <PhaseCard label="Chair synthesis" status={live.chairStatus} error={live.chairError} color="#34d399">
            {live.verdict && live.chairStatus === 'done' && (
              <VerdictView verdict={live.verdict} durationMs={live.durationMs} />
            )}
          </PhaseCard>
        </div>
      )}

      {/* History */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent panels</h2>
        {panels.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            No panels yet — convene one above.
          </div>
        ) : (
          <div className="space-y-2">
            {panels.map((p) => (
              <div key={p.id} className="glass rounded-xl px-4 py-3 flex items-center gap-3">
                <StatusDot status={p.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">
                    {p.niche} · pass {p.pass_number} · {p.aggressiveness}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {new Date(p.started_at).toLocaleString()} · model {p.model_id}
                  </div>
                </div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  {p.verdict?.overall_score ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function PhaseCard({
  label,
  status,
  error,
  color,
  children,
}: {
  label: string;
  status: 'idle' | 'running' | 'done' | 'error';
  error?: string;
  color: string;
  children?: React.ReactNode;
}) {
  const borderColor = status === 'done' ? color : status === 'error' ? '#f87171' : 'var(--border)';
  return (
    <div
      className="rounded-xl p-4"
      style={{ border: `1.5px solid ${borderColor}`, background: 'var(--bg-card)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <PhaseStatusDot status={status} color={color} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
        {status === 'running' && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>working…</span>
        )}
      </div>
      {error && <div className="text-xs mb-2" style={{ color: '#f87171' }}>{error}</div>}
      {children}
    </div>
  );
}

function CriticCard({
  label,
  color,
  state,
}: {
  label: string;
  color: string;
  state: CriticState;
}) {
  const phase =
    state.delibStatus !== 'idle'
      ? 'Deliberating'
      : state.draftStatus === 'done'
        ? 'Draft ready'
        : state.draftStatus === 'running'
          ? 'Drafting'
          : 'Waiting';
  const score = state.note?.updatedScore ?? state.draft?.overall_score ?? null;
  return (
    <div
      className="rounded-xl p-4"
      style={{
        border: `1.5px solid ${state.draftStatus === 'done' ? color : 'var(--border)'}`,
        background: 'var(--bg-card)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <PhaseStatusDot
            status={state.delibStatus !== 'idle' ? state.delibStatus : state.draftStatus}
            color={color}
          />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        </div>
        {score !== null && (
          <span className="text-lg font-bold" style={{ color }}>
            {score}
          </span>
        )}
      </div>
      <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>{phase}</div>
      {state.draftError && <div className="text-xs" style={{ color: '#f87171' }}>{state.draftError}</div>}
      {state.draft?.summary && (
        <p className="text-xs leading-snug mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {state.draft.summary}
        </p>
      )}
      {state.note?.summary && state.note.summary !== state.draft?.summary && (
        <p className="text-xs leading-snug mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          <strong>After deliberation:</strong> {state.note.summary}
        </p>
      )}
      {state.note?.myNonNegotiables && state.note.myNonNegotiables.length > 0 && (
        <div className="text-[10px] mt-1.5" style={{ color: '#fbbf24' }}>
          Non-negotiables: {state.note.myNonNegotiables.join(' · ')}
        </div>
      )}
    </div>
  );
}

function PhaseStatusDot({
  status,
  color,
}: {
  status: 'idle' | 'running' | 'done' | 'error';
  color: string;
}) {
  if (status === 'idle') {
    return <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--text-muted)', display: 'inline-block', opacity: 0.4 }} />;
  }
  if (status === 'running') {
    return <span className="spinner" style={{ width: 10, height: 10, borderColor: color, borderTopColor: 'transparent' }} />;
  }
  if (status === 'done') {
    return <span style={{ width: 8, height: 8, borderRadius: 999, background: color, display: 'inline-block' }} />;
  }
  return <span style={{ width: 8, height: 8, borderRadius: 999, background: '#f87171', display: 'inline-block' }} />;
}

function StatusDot({ status }: { status: 'running' | 'completed' | 'failed' }) {
  const c = status === 'completed' ? '#4ade80' : status === 'failed' ? '#f87171' : '#fbbf24';
  return (
    <span style={{ width: 10, height: 10, borderRadius: 999, background: c, display: 'inline-block' }} />
  );
}

function VerdictView({ verdict, durationMs }: { verdict: ScriptPanelVerdict; durationMs?: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>{verdict.overall_score}</span>
        <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{verdict.verdict}</span>
        {verdict.consensus_pass && (
          <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'rgba(52,211,153,0.15)', color: '#34d399' }}>
            consensus pass
          </span>
        )}
        {durationMs !== undefined && (
          <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
            {Math.round(durationMs / 100) / 10}s
          </span>
        )}
      </div>
      <p className="text-xs leading-snug" style={{ color: 'var(--text-secondary)' }}>{verdict.chair_summary}</p>
      {verdict.critical_issues.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: '#f87171' }}>Critical issues</div>
          <ul className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
            {verdict.critical_issues.slice(0, 5).map((i, idx) => (
              <li key={idx}>• <strong>{i.severity}</strong> at {i.location}: {i.issue}</li>
            ))}
          </ul>
        </div>
      )}
      {verdict.rewrite_suggestions.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
            Rewrite suggestions ({verdict.rewrite_suggestions.length})
          </div>
        </div>
      )}
      {verdict.dissent && verdict.dissent.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-1" style={{ color: '#fbbf24' }}>Dissent</div>
          <ul className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
            {verdict.dissent.map((d, idx) => (
              <li key={idx}>• <strong>{d.critic}:</strong> {d.objection}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
