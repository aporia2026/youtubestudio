'use client';

import { useEffect, useState } from 'react';
import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_EVENTS,
  type ConditionOp,
  type WorkflowActionRunRow,
  type WorkflowActionType,
  type WorkflowRuleRow,
  type WorkflowTriggerEventType,
} from '@/lib/workflows-types';

const COND_OPS: ConditionOp[] = ['equals', 'not_equals', 'lt', 'lte', 'gt', 'gte', 'in', 'exists'];

export default function WorkflowsPage() {
  const [rules, setRules] = useState<WorkflowRuleRow[]>([]);
  const [runs, setRuns] = useState<WorkflowActionRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // Create-form state
  const [name, setName] = useState('');
  const [triggerEventType, setTriggerEventType] = useState<WorkflowTriggerEventType>('ab_test_concluded');
  const [actionType, setActionType] = useState<WorkflowActionType>('sync_video_analytics');
  const [delayMinutes, setDelayMinutes] = useState(0);
  const [condField, setCondField] = useState('');
  const [condOp, setCondOp] = useState<ConditionOp>('equals');
  const [condValue, setCondValue] = useState('');
  const [actionConfigText, setActionConfigText] = useState('{}');

  async function refresh() {
    try {
      const [rulesRes, runsRes] = await Promise.all([
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        fetch('/api/workflows/rules', { cache: 'no-store' }),
        // eslint-disable-next-line no-restricted-syntax -- GET, read
        fetch('/api/workflows/runs?limit=30', { cache: 'no-store' }),
      ]);
      if (rulesRes.ok) setRules(((await rulesRes.json()).rules as WorkflowRuleRow[]) || []);
      if (runsRes.ok) setRuns(((await runsRes.json()).runs as WorkflowActionRunRow[]) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function buildCondition(): Record<string, unknown> {
    if (!condField || !condOp) return {};
    if (condOp === 'exists') return { field: condField, op: condOp };
    if (!condValue) return {};
    // Auto-coerce value to number when the op is numeric.
    const numericOps: ConditionOp[] = ['lt', 'lte', 'gt', 'gte'];
    let parsed: unknown = condValue;
    if (numericOps.includes(condOp)) {
      const n = Number(condValue);
      if (Number.isFinite(n)) parsed = n;
    } else if (condOp === 'in') {
      // Comma-separated.
      parsed = condValue.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return { field: condField, op: condOp, value: parsed };
  }

  async function createRule() {
    setError(null);
    setInfo(null);
    let actionConfig: Record<string, unknown> = {};
    try {
      actionConfig = actionConfigText.trim() ? JSON.parse(actionConfigText) : {};
    } catch {
      setError('Action config must be valid JSON.');
      return;
    }
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/workflows/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          triggerEventType,
          actionType,
          condition: buildCondition(),
          actionConfig,
          delaySeconds: Math.max(0, Math.round(delayMinutes * 60)),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      setName('');
      setCondField('');
      setCondValue('');
      setDelayMinutes(0);
      setActionConfigText('{}');
      setShowCreate(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    }
  }

  async function toggleEnabled(rule: WorkflowRuleRow) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited PATCH RPC - awaits and uses response
      await fetch(`/api/workflows/rules/${rule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function deleteRule(id: string) {
    if (!confirm('Delete this rule? Pending action runs for it will stay queued.')) return;
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
      await fetch(`/api/workflows/rules/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function runNow() {
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST RPC - awaits and uses response
      const res = await fetch('/api/workflows/runs', { method: 'POST' });
      const data = await res.json();
      setInfo(`Drained: ${data.picked} picked, ${data.succeeded} ok, ${data.failed} failed, ${data.skipped} skipped.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed');
    }
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="flex items-start justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">Workflows</h1>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Auto-pilot rules that fire when something happens in the studio. Cron drains the queue every hour.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={runNow} className="text-sm px-3 py-1.5 rounded" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>
            ↻ Run due now
          </button>
          <button type="button" onClick={() => setShowCreate((v) => !v)} className="btn-primary text-sm">
            {showCreate ? 'Cancel' : '＋ New rule'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          {error}
        </div>
      )}
      {info && !error && (
        <div className="mb-4 p-3 rounded text-sm" style={{ background: 'rgba(74,222,128,0.10)', color: '#4ade80' }}>
          {info}
        </div>
      )}

      {showCreate && (
        <div className="glass rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold mb-4">New rule</h2>
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
              placeholder='e.g. "Snapshot any video that drops below 4% CTR"'
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <Field label="Trigger event">
              <select
                value={triggerEventType}
                onChange={(e) => setTriggerEventType(e.target.value as WorkflowTriggerEventType)}
                className="input-field"
              >
                {WORKFLOW_TRIGGER_EVENTS.map((e) => (
                  <option key={e.type} value={e.type}>{e.label}</option>
                ))}
              </select>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {WORKFLOW_TRIGGER_EVENTS.find((e) => e.type === triggerEventType)?.description}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Available payload fields: <span className="font-mono">
                  {WORKFLOW_TRIGGER_EVENTS.find((e) => e.type === triggerEventType)?.payload_fields.join(', ')}
                </span>
              </p>
            </Field>
            <Field label="Action">
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as WorkflowActionType)}
                className="input-field"
              >
                {WORKFLOW_ACTION_TYPES.map((a) => (
                  <option key={a.type} value={a.type}>{a.label}</option>
                ))}
              </select>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {WORKFLOW_ACTION_TYPES.find((a) => a.type === actionType)?.description}
              </p>
              {WORKFLOW_ACTION_TYPES.find((a) => a.type === actionType)!.config_fields.length > 0 && (
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Config keys: <span className="font-mono">
                    {WORKFLOW_ACTION_TYPES.find((a) => a.type === actionType)!.config_fields.join(', ')}
                  </span>
                </p>
              )}
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
            <Field label="Condition: field" hint="Optional. Empty = always fire.">
              <input
                type="text"
                value={condField}
                onChange={(e) => setCondField(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="e.g. ctr_percentage"
              />
            </Field>
            <Field label="Op">
              <select
                value={condOp}
                onChange={(e) => setCondOp(e.target.value as ConditionOp)}
                className="input-field"
              >
                {COND_OPS.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            </Field>
            <Field label="Value" hint='Numbers auto-cast for lt/lte/gt/gte. Comma-separate for "in".'>
              <input
                type="text"
                value={condValue}
                onChange={(e) => setCondValue(e.target.value)}
                className="input-field font-mono text-xs"
                placeholder="e.g. 4"
                disabled={condOp === 'exists'}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <Field label="Delay (minutes)" hint="0 = run immediately. Cron picks up due actions every hour.">
              <input
                type="number"
                min={0}
                max={43200}
                value={delayMinutes}
                onChange={(e) => setDelayMinutes(Number(e.target.value) || 0)}
                className="input-field"
              />
            </Field>
            <Field label="Action config (JSON)" hint='e.g. { "scriptText": "..." } for run_dip_analysis'>
              <textarea
                value={actionConfigText}
                onChange={(e) => setActionConfigText(e.target.value)}
                rows={3}
                className="input-field font-mono text-xs"
              />
            </Field>
          </div>

          <div className="mt-4 flex justify-end">
            <button type="button" onClick={createRule} disabled={!triggerEventType || !actionType} className="btn-primary text-sm">
              Create rule
            </button>
          </div>
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
        Rules ({rules.length})
      </h2>
      {rules.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No rules yet. Create one above.
        </div>
      ) : (
        <div className="space-y-3 mb-8">
          {rules.map((r) => (
            <RuleCard key={r.id} rule={r} onToggle={() => toggleEnabled(r)} onDelete={() => deleteRule(r.id)} />
          ))}
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
        Recent action runs
      </h2>
      {runs.length === 0 ? (
        <div className="glass rounded-xl p-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No runs yet.
        </div>
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
              <tr>
                <Th>When</Th>
                <Th>Trigger</Th>
                <Th>Action</Th>
                <Th>Status</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <Td>{new Date(r.created_at).toLocaleString()}</Td>
                  <Td>{r.trigger_event_type}</Td>
                  <Td>{r.action_type}</Td>
                  <Td>
                    <span style={{ color: statusColor(r.status) }}>{r.status}</span>
                  </Td>
                  <Td title={r.error_message || JSON.stringify(r.result)}>
                    {r.error_message ? r.error_message.slice(0, 60) : JSON.stringify(r.result).slice(0, 60)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function statusColor(s: WorkflowActionRunRow['status']): string {
  if (s === 'succeeded') return '#4ade80';
  if (s === 'failed') return '#f87171';
  if (s === 'running') return '#60a5fa';
  if (s === 'skipped') return '#94a3b8';
  return '#fbbf24'; // pending
}

function RuleCard({ rule, onToggle, onDelete }: { rule: WorkflowRuleRow; onToggle: () => void; onDelete: () => void }) {
  const trigger = WORKFLOW_TRIGGER_EVENTS.find((e) => e.type === rule.trigger_event_type);
  const action = WORKFLOW_ACTION_TYPES.find((a) => a.type === rule.action_type);
  const condStr = JSON.stringify(rule.condition);
  return (
    <div className="glass rounded-xl p-4" style={{ opacity: rule.enabled ? 1 : 0.55 }}>
      <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{rule.name}</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            On <span style={{ color: 'var(--text-secondary)' }}>{trigger?.label ?? rule.trigger_event_type}</span>
            {' → '}
            <span style={{ color: 'var(--text-secondary)' }}>{action?.label ?? rule.action_type}</span>
            {rule.delay_seconds > 0 && (
              <span> · after {Math.round(rule.delay_seconds / 60)} min</span>
            )}
          </div>
          {condStr !== '{}' && (
            <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--text-muted)' }}>
              when {condStr}
            </div>
          )}
        </div>
        <button type="button" onClick={onToggle} className="text-xs px-2 py-1 rounded" style={{ background: rule.enabled ? 'rgba(74,222,128,0.10)' : 'rgba(120,120,120,0.10)', color: rule.enabled ? '#4ade80' : 'var(--text-muted)' }}>
          {rule.enabled ? 'Enabled' : 'Disabled'}
        </button>
        <button type="button" onClick={onDelete} className="text-xs px-2 py-1 rounded" style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}>
          ✕
        </button>
      </div>
      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
        Fired {rule.fire_count} time{rule.fire_count === 1 ? '' : 's'}
        {rule.last_fired_at && ` · last ${new Date(rule.last_fired_at).toLocaleString()}`}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '8px 12px',
        textAlign: 'left',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        fontSize: '0.7rem',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }} title={title}>
      {children}
    </td>
  );
}
