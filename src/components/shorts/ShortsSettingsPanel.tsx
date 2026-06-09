'use client';

/**
 * ShortsSettingsPanel — the /settings page's Shorts tab.
 *
 * Five controls per the Phase 1 settings audit (plan §7):
 *   - Auto-fan-out enabled (toggle).
 *   - Auto-fan-out candidate count (segmented: 0 / 3 / 5).
 *   - Mode A default target seconds (slider 15–90).
 *   - Hook score threshold (segmented: 0.4 / 0.6 / 0.8).
 *   - Per-section default medium (radio: long_form / short_native / remember_last).
 *
 * Reads + writes via /api/shorts/settings. Optimistic updates on toggle;
 * other controls write-on-blur to avoid hammering the API while the user
 * drags sliders.
 *
 * Lazy-user UX bar (rule 10): every control has a one-line description
 * directly under its label. No nested tooltips, no help icons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  SHORTS_SETTINGS_DEFAULTS,
  type ShortsWorkspaceSettings,
} from '@/lib/shorts-workspace-settings';
import {
  BASE_T2I_MODELS,
  DEFAULT_BASE_T2I_MODEL_ID,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from '@/lib/shorts-base-t2i-types';

export function ShortsSettingsPanel() {
  const [settings, setSettings] = useState<ShortsWorkspaceSettings>({
    ...SHORTS_SETTINGS_DEFAULTS,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads shorts settings
        const res = await fetch('/api/shorts/settings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setSettings(data.settings ?? SHORTS_SETTINGS_DEFAULTS);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load Shorts settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Per QA finding H6: concurrent-edit race. Two quick toggles fire
  // two POSTs; responses can land out of order; the second response's
  // setSettings(data.settings) could overwrite the third response's
  // optimistic merge. Track a monotonically-increasing save id and
  // only apply server responses that match the latest in-flight id;
  // stale responses are dropped (their state is already obsolete).
  const latestSaveIdRef = useRef(0);
  const save = useCallback(async (patch: Partial<ShortsWorkspaceSettings>) => {
    const saveId = ++latestSaveIdRef.current;
    setSaving(true);
    // Optimistic merge so the UI reflects the change while the request
    // is in flight. On failure we re-fetch.
    setSettings((prev) => ({ ...prev, ...patch }));
    try {
      const res = await fetch('/api/shorts/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Drop the response if a newer save has been started — its
      // optimistic state already supersedes whatever this stale server
      // response would tell us.
      if (saveId === latestSaveIdRef.current) {
        setSettings(data.settings);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
      // Refetch on failure, but ONLY apply if no newer save raced.
      // eslint-disable-next-line no-restricted-syntax -- GET, rollback after failure
      const res = await fetch('/api/shorts/settings').catch(() => null);
      if (res?.ok && saveId === latestSaveIdRef.current) {
        setSettings((await res.json()).settings);
      }
    } finally {
      // Only clear `saving` for the latest save — earlier ones racing
      // to false would prematurely re-enable controls.
      if (saveId === latestSaveIdRef.current) setSaving(false);
    }
  }, []);

  if (loading) {
    return <div style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Auto-fan-out
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          When you save a long-form script, automatically queue N Short candidates into the inbox
          for that project. Free — no AI call — runs on every script save.
        </p>
        <Row label="Enabled" hint="Off pauses auto-fan-out without losing existing candidates.">
          <Switch
            checked={settings.autoFanOutEnabled}
            onChange={(v) => save({ autoFanOutEnabled: v })}
            disabled={saving}
          />
        </Row>
        <Row
          label="Candidates per script"
          hint="0 effectively disables the feature. 3 is the sweet spot."
        >
          <SegmentedNumber
            value={settings.autoFanOutCount}
            options={[0, 3, 5]}
            onChange={(v) => save({ autoFanOutCount: v })}
            disabled={saving || !settings.autoFanOutEnabled}
          />
        </Row>
      </div>

      <BaseT2iDefaultPanel />

      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Mode A — find clips
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Defaults used when the Scripts page's Shorts mode scores moments in your channel videos.
        </p>
        <Row label="Default target length (seconds)" hint="15–90s. The 2026 algorithm sweet spot is 30–60s.">
          <input
            type="number"
            min={15}
            max={90}
            value={settings.defaultTargetSecondsModeA}
            onChange={(e) =>
              setSettings((p) => ({
                ...p,
                defaultTargetSecondsModeA: Math.max(15, Math.min(90, Number(e.target.value) || 45)),
              }))
            }
            onBlur={(e) =>
              save({
                defaultTargetSecondsModeA: Math.max(15, Math.min(90, Number(e.target.value) || 45)),
              })
            }
            className="input-field"
            style={{ width: 100 }}
            disabled={saving}
          />
        </Row>
        <Row
          label="Hook score threshold"
          hint="Candidates below this score get a 'weak hook' badge in the inbox so you can filter them out."
        >
          <SegmentedNumber
            value={settings.hookScoreThreshold}
            options={[0.4, 0.6, 0.8]}
            onChange={(v) => save({ hookScoreThreshold: v })}
            disabled={saving}
          />
        </Row>
      </div>

      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Section toggle default
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          When you open Ideas / Scripts / QA / SEO with no <code>?medium=</code> in the URL, which
          mode do they open in?
        </p>
        <SegmentedString<ShortsWorkspaceSettings['sectionDefaultMedium']>
          value={settings.sectionDefaultMedium}
          options={[
            { value: 'long_form', label: 'Long-form (recommended)' },
            { value: 'short_native', label: 'Shorts — new' },
            { value: 'remember_last', label: 'Remember last' },
          ]}
          onChange={(v) => save({ sectionDefaultMedium: v })}
          disabled={saving}
        />
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
          The Shorts toggle still works on every section page — this just sets the default.
        </p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Small in-file primitives. Settings rows are simple enough that a dedicated
// component file would just be ceremony.
// ────────────────────────────────────────────────────────────────────────────

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-3 border-t border-white/5 first:border-t-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        {hint && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 999,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        background: checked ? 'rgba(124,58,237,0.85)' : 'rgba(255,255,255,0.12)',
        position: 'relative',
        transition: 'background 140ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 140ms ease',
        }}
      />
    </button>
  );
}

function SegmentedNumber({
  value,
  options,
  onChange,
  disabled,
}: {
  value: number;
  options: number[];
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 3,
        gap: 3,
        borderRadius: 9,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((o) => {
        const active = Math.abs(o - value) < 0.001;
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o)}
            style={{
              padding: '4px 10px',
              borderRadius: 7,
              border: 'none',
              cursor: disabled ? 'not-allowed' : active ? 'default' : 'pointer',
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              background: active ? 'rgba(124,58,237,0.85)' : 'transparent',
              color: active ? '#fff' : 'var(--text-secondary, rgba(255,255,255,0.7))',
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function SegmentedString<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.08)',
              cursor: disabled ? 'not-allowed' : active ? 'default' : 'pointer',
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              background: active ? 'rgba(124,58,237,0.85)' : 'transparent',
              color: active ? '#fff' : 'var(--text-secondary, rgba(255,255,255,0.7))',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Per-user default base T2I image model used by:
 *  - the shorts asset cron when no per-batch override is set
 *  - the editor's Shots panel "regen with new prompt" base-frame button
 *  - the bulk-batch step 2 image-model picker as its initial value
 *
 *  Reads + writes via `/api/user/settings/shorts-base-t2i-model`. Shows
 *  the full registry (BASE_T2I_MODELS) with cost + hint per option so
 *  the lazy-user can pick informed without leaving the page. */
function BaseT2iDefaultPanel() {
  const [modelId, setModelId] = useState<ShortsBaseT2iModelId>(DEFAULT_BASE_T2I_MODEL_ID);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads the image-model default
        const res = await fetch('/api/user/settings/shorts-base-t2i-model');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        if (typeof data.shorts_base_t2i_model_id === 'string') {
          setModelId(resolveBaseT2iModelId(data.shorts_base_t2i_model_id));
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Failed to load image-model default');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = useCallback(async (next: ShortsBaseT2iModelId) => {
    setSaving(true);
    const prev = modelId;
    setModelId(next); // optimistic
    try {
      // Endpoint contract is { model_id }, NOT { shorts_base_t2i_model_id }.
      // The previous shape silently wiped the user's setting because the
      // route's `body.model_id` lookup returned undefined → null branch.
      // See `src/app/api/user/settings/shorts-base-t2i-model/route.ts:44`.
      const res = await fetch('/api/user/settings/shorts-base-t2i-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Image model default saved');
    } catch (err) {
      setModelId(prev); // rollback
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [modelId]);

  return (
    <div className="glass rounded-xl p-5">
      <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Base image model
      </h2>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        Default model used to generate the base frame for each Short. Applies
        across bulk batches + the editor's Shots panel regen, unless you pick
        a different model per-batch in step 2 or per-frame in the editor.
      </p>
      {loading ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</div>
      ) : (
        <div className="space-y-2">
          {BASE_T2I_MODELS.map((m) => {
            const active = m.id === modelId;
            return (
              <button
                key={m.id}
                type="button"
                disabled={saving || active}
                onClick={() => save(m.id)}
                className={[
                  'block w-full rounded-md border px-3 py-2 text-left transition-colors',
                  active
                    ? 'border-[var(--accent-purple-bright)] bg-[var(--accent-purple)]/15'
                    : 'border-[var(--border)] bg-white/[0.02] hover:bg-white/[0.05]',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span style={{ color: 'var(--text-primary)', fontWeight: active ? 600 : 500 }}>
                    {m.label}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    ${m.costUsd.toFixed(4)}/image{active ? ' · current' : ''}
                  </span>
                </div>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {m.hint}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
