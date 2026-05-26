'use client';

/**
 * Settings → QA panel.
 *
 * Controls workspace-level QA hardening knobs. Currently exposes one
 * setting: which model the auto-pipeline uses for nuclear-mode critic
 * drafts + deliberation (Lever D of the QA hardening plan).
 *
 * "No upgrade" is the default. When selected, nuclear-mode passes use
 * whichever model the caller (pipeline preset / manual /critics page)
 * picks — same as standard and brutal modes. Picking any other model
 * overrides only the nuclear-mode drafts and deliberation; the Chair
 * always stays on its existing model.
 *
 * Hydrates from /api/workspace/qa-settings on mount and persists via
 * PUT on every change. Optimistic UI: the new value is selected
 * locally as soon as the user picks it; the server confirms or rolls
 * back via a toast.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AI_MODELS, type AIModel } from '@/lib/ai-models';

type QaToggleState = 'on' | 'off' | 'inherit';

interface QaSettings {
  nuclearModelId: string | null;
  stuckThresholdHours: number;
  preCheck: QaToggleState;
  rubricV2: QaToggleState;
  generatorV2: QaToggleState;
  wipLimits: Record<string, number>;
}

const NO_UPGRADE_VALUE = '__no_upgrade__';
const STUCK_HOURS_OPTIONS = [12, 24, 48, 72, 168] as const; // 12h, 1d, 2d, 3d, 1wk
const DEFAULT_SETTINGS: QaSettings = {
  nuclearModelId: null,
  stuckThresholdHours: 48,
  preCheck: 'inherit',
  rubricV2: 'inherit',
  generatorV2: 'inherit',
  wipLimits: {},
};

// Stages that benefit most from a WIP limit (the ones where work
// genuinely stacks up: human-in-the-loop steps + the edit handoff).
// Other stages are still configurable via the API but hidden in this
// minimal UI to keep the panel scannable.
const WIP_STAGES: ReadonlyArray<{ id: string; label: string; suggestion: string }> = [
  { id: 'qa', label: 'QA', suggestion: 'e.g. 8 — QA failures pile up if the panel can\'t keep pace' },
  { id: 'voiceover', label: 'Voiceover', suggestion: 'e.g. 5 — a narrator can only record so many a week' },
  { id: 'edit', label: 'Edit', suggestion: 'e.g. 6 — editor throughput is usually the bottleneck' },
];

export function QaSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<QaSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspace/qa-settings')
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        setSettings(data.settings ?? DEFAULT_SETTINGS);
        console.info('[settings qa] panel ready', {
          nuclear_model_id: data.settings?.nuclearModelId ?? null,
          stuck_threshold_hours: data.settings?.stuckThresholdHours ?? 48,
        });
      })
      .catch(err => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : 'Failed to load QA settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Group models by provider so the dropdown reads naturally — easier
  // to find Anthropic models together, OpenAI together, etc.
  const grouped = useMemo(() => {
    const map = new Map<string, AIModel[]>();
    for (const m of AI_MODELS) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return map;
  }, []);

  const selectedModel = settings.nuclearModelId
    ? AI_MODELS.find(m => m.id === settings.nuclearModelId) ?? null
    : null;

  async function saveSelection(newValue: string) {
    const newModelId = newValue === NO_UPGRADE_VALUE ? null : newValue;
    // Optimistic local update so the dropdown feels instant.
    setSettings(prev => ({ ...prev, nuclearModelId: newModelId }));
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/qa-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nuclearModelId: newModelId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to save QA settings');
      }
      const data = await res.json();
      setSettings(data.settings ?? DEFAULT_SETTINGS);
      toast.success(newModelId ? `Nuclear-mode model set to ${labelFor(newModelId)}` : 'Nuclear-mode upgrade disabled');
    } catch (err) {
      // Roll back the optimistic update. The next fetch on next mount
      // will reconcile if the user navigates away and back.
      toast.error(err instanceof Error ? err.message : 'Failed to save QA settings');
      const res = await fetch('/api/workspace/qa-settings').catch(() => null);
      if (res?.ok) {
        const data = await res.json();
        setSettings(data.settings ?? DEFAULT_SETTINGS);
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveToggle(flag: 'preCheck' | 'rubricV2' | 'generatorV2', state: QaToggleState) {
    setSettings(prev => ({ ...prev, [flag]: state }));
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/qa-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [flag]: state }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to save QA setting');
      }
      const data = await res.json();
      setSettings(data.settings ?? DEFAULT_SETTINGS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save QA setting');
      const res = await fetch('/api/workspace/qa-settings').catch(() => null);
      if (res?.ok) {
        const data = await res.json();
        setSettings(data.settings ?? DEFAULT_SETTINGS);
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveWipLimit(stageId: string, limit: number | null) {
    // Optimistic local update.
    setSettings(prev => {
      const next = { ...prev, wipLimits: { ...prev.wipLimits } };
      if (limit === null) delete next.wipLimits[stageId];
      else next.wipLimits[stageId] = limit;
      return next;
    });
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/qa-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wipLimit: { stageId, limit } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to save WIP limit');
      }
      const data = await res.json();
      setSettings(data.settings ?? DEFAULT_SETTINGS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save WIP limit');
      const res = await fetch('/api/workspace/qa-settings').catch(() => null);
      if (res?.ok) {
        const data = await res.json();
        setSettings(data.settings ?? DEFAULT_SETTINGS);
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveStuckHours(newHours: number) {
    setSettings(prev => ({ ...prev, stuckThresholdHours: newHours }));
    setSaving(true);
    try {
      const res = await fetch('/api/workspace/qa-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stuckThresholdHours: newHours }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to save stuck threshold');
      }
      const data = await res.json();
      setSettings(data.settings ?? DEFAULT_SETTINGS);
      toast.success(`Stuck threshold set to ${formatHours(newHours)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save stuck threshold');
      const res = await fetch('/api/workspace/qa-settings').catch(() => null);
      if (res?.ok) {
        const data = await res.json();
        setSettings(data.settings ?? DEFAULT_SETTINGS);
      }
    } finally {
      setSaving(false);
    }
  }

  function labelFor(modelId: string): string {
    return AI_MODELS.find(m => m.id === modelId)?.name ?? modelId;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          QA Settings
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          Workspace-level controls for the QA hardening levers. Settings here apply only to <strong>automated</strong> auto-pipeline runs. Manual QA on the /qa or /critics pages keeps its own per-run model picker.
        </p>
      </div>

      {/* Nuclear-mode model picker */}
      <section
        className="px-4 py-4 rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Nuclear-mode critic model
            </h3>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              When an auto-pipeline preset runs the critic panel in <strong>nuclear</strong> mode, the critic drafts and deliberation use this model instead of the preset's default. The Chair (final synthesis) always stays on its own model. Pick "No upgrade" to use the preset's model in nuclear mode too.
            </p>
          </div>
          {selectedModel && (
            <span
              className="text-xs px-2 py-0.5 rounded shrink-0"
              style={{ background: 'var(--accent-green)22', color: 'var(--accent-green)', border: '1px solid var(--border)' }}
              title="Workspace override is active"
            >
              Override on
            </span>
          )}
        </div>

        <select
          value={settings.nuclearModelId ?? NO_UPGRADE_VALUE}
          onChange={e => saveSelection(e.target.value)}
          disabled={loading || saving}
          className="w-full px-3 py-2 rounded text-sm"
          style={{
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        >
          <option value={NO_UPGRADE_VALUE}>No upgrade — use the preset's model for nuclear mode too</option>
          {Array.from(grouped.entries()).map(([provider, models]) => (
            <optgroup key={provider} label={providerLabel(provider)}>
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} — {formatCost(m)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {selectedModel && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Active: <strong style={{ color: 'var(--text-primary)' }}>{selectedModel.name}</strong> · {selectedModel.description}
            {selectedModel.pricingNote && (
              <span style={{ color: 'var(--accent-yellow)' }}> · {selectedModel.pricingNote}</span>
            )}
          </p>
        )}
      </section>

      {/* Stuck-threshold picker */}
      <section
        className="px-4 py-4 rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Stuck threshold
        </h3>
        <p className="text-xs mt-1 mb-3" style={{ color: 'var(--text-muted)' }}>
          A video shows up in the Command Center's <strong>Stuck</strong> panel when it has not moved stage in this long. Pick a shorter threshold to catch problems earlier (more noisy) or a longer one to only see real stalls.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {STUCK_HOURS_OPTIONS.map(h => {
            const active = settings.stuckThresholdHours === h;
            return (
              <button
                key={h}
                type="button"
                onClick={() => !active && saveStuckHours(h)}
                disabled={saving || loading}
                className="text-sm px-3 py-1.5 rounded font-medium transition-colors"
                style={{
                  background: active ? 'var(--accent-purple)' : 'transparent',
                  color: active ? 'white' : 'var(--text-primary)',
                  border: `1px solid ${active ? 'var(--accent-purple)' : 'var(--border)'}`,
                  opacity: saving || loading ? 0.6 : 1,
                }}
              >
                {formatHours(h)}
              </button>
            );
          })}
        </div>
      </section>

      {/* WIP limits per stage */}
      <section
        className="px-4 py-4 rounded-lg"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          WIP limits per stage (soft warning)
        </h3>
        <p className="text-xs mt-1 mb-3" style={{ color: 'var(--text-muted)' }}>
          When a kanban column has more cards than its limit, the count badge turns red. Soft warning only — the limit doesn't block creation. Leave blank for unlimited.
        </p>
        <div className="space-y-2">
          {WIP_STAGES.map(stage => (
            <WipLimitRow
              key={stage.id}
              stage={stage}
              value={settings.wipLimits[stage.id] ?? null}
              disabled={loading || saving}
              onChange={limit => saveWipLimit(stage.id, limit)}
            />
          ))}
        </div>
      </section>

      {/* QA hardening lever toggles */}
      <section
        className="px-4 py-4 rounded-lg space-y-4"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
      >
        <div>
          <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            QA hardening levers
          </h3>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Per-lever override for this workspace. Each toggle has three states: <strong>On</strong> (force enabled), <strong>Off</strong> (force disabled), <strong>Inherit env</strong> (use the deploy-time env var — the current default).
          </p>
        </div>

        <LeverToggle
          label="Pre-QA self-check"
          description="Generator self-critiques the script before the panel sees it. Rewrites the weakest section. Costs one extra LLM call per first-pass script."
          envVar="QA_PRE_CHECK_ENABLED"
          value={settings.preCheck}
          disabled={loading || saving}
          onChange={v => saveToggle('preCheck', v)}
        />
        <LeverToggle
          label="Rubric V2 (anchor examples + deduction lists)"
          description="Critic prompts include concrete 100/70/40 anchors, explicit per-category deduction lists, and a self-criticism step. Rubric V2 is loaded at module init — flipping this requires a redeploy / fresh function instance to take effect."
          envVar="QA_RUBRIC_V2_ENABLED"
          value={settings.rubricV2}
          disabled={loading || saving}
          onChange={v => saveToggle('rubricV2', v)}
        />
        <LeverToggle
          label="Generator V2 (inline rubric digest)"
          description="Generator's system prompt is appended with a digest of the critic rubric so the first draft already targets the criteria it will be graded against. Cheap (~400 extra tokens per generation)."
          envVar="QA_GENERATOR_V2_ENABLED"
          value={settings.generatorV2}
          disabled={loading || saving}
          onChange={v => saveToggle('generatorV2', v)}
        />
      </section>
    </div>
  );
}

function WipLimitRow(props: {
  stage: { id: string; label: string; suggestion: string };
  value: number | null;
  disabled: boolean;
  onChange: (limit: number | null) => void;
}) {
  // Local input state so the user can type freely; commit on blur.
  const [draft, setDraft] = useState<string>(props.value !== null ? String(props.value) : '');
  useEffect(() => {
    setDraft(props.value !== null ? String(props.value) : '');
  }, [props.value]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === '') {
      if (props.value !== null) props.onChange(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      toast.error('WIP limit must be a number between 1 and 1000.');
      setDraft(props.value !== null ? String(props.value) : '');
      return;
    }
    const rounded = Math.round(n);
    if (rounded !== props.value) props.onChange(rounded);
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{props.stage.label}</div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{props.stage.suggestion}</div>
      </div>
      <input
        type="number"
        min={1}
        max={1000}
        step={1}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        disabled={props.disabled}
        placeholder="—"
        className="text-sm px-2 py-1 rounded w-20 text-right"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
      />
    </div>
  );
}

function LeverToggle(props: {
  label: string;
  description: string;
  envVar: string;
  value: QaToggleState;
  disabled: boolean;
  onChange: (v: QaToggleState) => void;
}) {
  const states: QaToggleState[] = ['inherit', 'on', 'off'];
  const stateLabel: Record<QaToggleState, string> = {
    on: 'On',
    off: 'Off',
    inherit: 'Inherit env',
  };
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{props.label}</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{props.description}</div>
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Env var: <code>{props.envVar}</code>
          </div>
        </div>
        <div className="inline-flex rounded overflow-hidden shrink-0" style={{ border: '1px solid var(--border)' }}>
          {states.map((s, i) => {
            const active = props.value === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => !active && props.onChange(s)}
                disabled={props.disabled}
                className="text-xs px-3 py-1.5 font-medium transition-colors disabled:opacity-60"
                style={{
                  background: active
                    ? (s === 'on' ? 'var(--accent-green)' : s === 'off' ? 'var(--accent-pink)' : 'var(--accent-purple)')
                    : 'var(--bg-primary)',
                  color: active ? 'white' : 'var(--text-primary)',
                  borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                }}
              >
                {stateLabel[s]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function formatHours(h: number): string {
  if (h < 24) return `${h}h`;
  if (h % 24 === 0) {
    const d = h / 24;
    return d === 1 ? '1 day' : d === 7 ? '1 week' : `${d} days`;
  }
  return `${h}h`;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic (direct)';
    case 'openai': return 'OpenAI (direct)';
    case 'google': return 'Google (direct)';
    case 'kie': return 'Kie.ai gateway';
    case 'perplexity': return 'Perplexity (web-search)';
    default: return provider;
  }
}

function formatCost(m: AIModel): string {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  return `${fmt(m.inputCostPerMTok)} in / ${fmt(m.outputCostPerMTok)} out per 1M tok`;
}
