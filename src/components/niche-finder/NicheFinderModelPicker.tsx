'use client';

/**
 * Inline AI-model picker for the niche finder.
 *
 * Renders as a small pill ("Model: <name> ▾"). Click → compact
 * dropdown grouped by provider (Anthropic / OpenAI / Google /
 * Kie.ai / Perplexity). Selection persists per-workspace via the
 * existing `/api/settings/model-defaults` endpoint — the same one the
 * Settings page uses — so users see the same picks everywhere.
 *
 * Parameterised by `feature` so this can be reused for other niche-
 * finder AI features (cluster map, deep-dive memo) later. The
 * persistence scope is always `feature:<feature>` — the most specific
 * scope in the model-defaults precedence chain — so a picker change
 * here overrides any section / workspace defaults.
 *
 * Inline styles to match the surrounding niche-finder bar aesthetic
 * (the rest of the tab doesn't use Tailwind class strings).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AI_MODELS,
  APP_FEATURES,
  formatModelPricing,
  getModelById,
  type AIProvider,
  type AppFeature,
} from '@/lib/ai-models';

interface NicheFinderModelPickerProps {
  feature: AppFeature;
  /** Short label shown before the pill (e.g. "Brainstorm with"). */
  label?: string;
}

const PROVIDER_COLORS: Record<AIProvider, string> = {
  anthropic: '#7c3aed',
  openai: '#10b981',
  google: '#3b82f6',
  kie: '#f59e0b',
  perplexity: '#06b6d4',
};

const PROVIDER_LABELS: Record<AIProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  kie: 'Kie.ai',
  perplexity: 'Perplexity',
};

const PROVIDER_ORDER: readonly AIProvider[] = [
  'anthropic',
  'openai',
  'google',
  'kie',
  'perplexity',
];

interface DefaultsBlob {
  workspace: string | null;
  sections: Record<string, string | null | undefined>;
  features: Record<string, string | null | undefined>;
}

/** Resolve the effective model id given the workspace's defaults blob
 *  + the feature's hardcoded fallback. Mirrors the server-side
 *  `resolveFeatureModelId` precedence (feature → section → workspace →
 *  hardcoded) without making a second round trip. */
function resolveEffectiveModelId(
  defaults: DefaultsBlob | null,
  feature: AppFeature,
  hardcodedFallback: string,
): string {
  if (defaults?.features?.[feature]) return defaults.features[feature] as string;
  const spec = APP_FEATURES.find((f) => f.id === feature);
  if (spec && defaults?.sections?.[spec.section])
    return defaults.sections[spec.section] as string;
  if (defaults?.workspace) return defaults.workspace;
  return hardcodedFallback;
}

export function NicheFinderModelPicker({
  feature,
  label = 'Model',
}: NicheFinderModelPickerProps): React.ReactElement {
  const featureSpec = APP_FEATURES.find((f) => f.id === feature);
  const hardcodedFallback = featureSpec?.defaultModelId ?? AI_MODELS[0].id;

  const [defaults, setDefaults] = useState<DefaultsBlob | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initial fetch — get the workspace's current defaults blob.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings/model-defaults');
        if (!res.ok) return;
        const body = (await res.json()) as { defaults: DefaultsBlob };
        if (!cancelled) setDefaults(body.defaults);
      } catch {
        /* leave defaults null; we fall back to the hardcoded model id */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const effectiveId = resolveEffectiveModelId(defaults, feature, hardcodedFallback);
  const effectiveModel = getModelById(effectiveId);
  const isOverridden = !!defaults?.features?.[feature];

  const grouped = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const matches = (m: typeof AI_MODELS[number]): boolean => {
      if (q.length === 0) return true;
      return `${m.name} ${m.id} ${m.description ?? ''}`.toLowerCase().includes(q);
    };
    const out: Record<AIProvider, typeof AI_MODELS> = {
      anthropic: [],
      openai: [],
      google: [],
      kie: [],
      perplexity: [],
    };
    for (const m of AI_MODELS) {
      if (matches(m)) out[m.provider].push(m);
    }
    return out;
  }, [searchTerm]);

  const pick = useCallback(
    async (modelId: string) => {
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch('/api/settings/model-defaults', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: `feature:${feature}`, modelId }),
        });
        if (res.ok) {
          setDefaults((prev) => ({
            workspace: prev?.workspace ?? null,
            sections: prev?.sections ?? {},
            features: { ...(prev?.features ?? {}), [feature]: modelId },
          }));
          setOpen(false);
          return;
        }
        // Non-OK: pull the error message out of the response body so
        // the user (and devs) see WHY the save failed instead of a
        // silent dead click.
        const body = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        const errorPart = body?.error ?? `HTTP ${res.status}`;
        const detailPart = body?.detail ? ` — ${body.detail}` : '';
        setSaveError(`${errorPart}${detailPart}`);
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setSaving(false);
      }
    },
    [feature],
  );

  const resetToDefault = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/settings/model-defaults?scope=${encodeURIComponent(`feature:${feature}`)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        setDefaults((prev) => {
          if (!prev) return prev;
          const nextFeatures = { ...prev.features };
          delete nextFeatures[feature];
          return { ...prev, features: nextFeatures };
        });
        setOpen(false);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { error?: string; detail?: string }
        | null;
      const errorPart = body?.error ?? `HTTP ${res.status}`;
      const detailPart = body?.detail ? ` — ${body.detail}` : '';
      setSaveError(`${errorPart}${detailPart}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }, [feature]);

  const pillName = effectiveModel?.name ?? effectiveId;
  const pillColor = effectiveModel ? PROVIDER_COLORS[effectiveModel.provider] : '#94a3b8';

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => {
          setOpen((x) => {
            const next = !x;
            if (next) setSaveError(null);
            return next;
          });
        }}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          effectiveModel
            ? `${PROVIDER_LABELS[effectiveModel.provider]} — ${formatModelPricing(effectiveModel)}`
            : effectiveId
        }
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: 'rgba(255,255,255,0.02)',
          color: '#cbd5e1',
          border: '1px solid #334155',
          borderRadius: 6,
          fontSize: 12,
          cursor: saving ? 'wait' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: '#64748b' }}>{label}:</span>
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: pillColor,
          }}
        />
        <span style={{ fontWeight: 500 }}>{pillName}</span>
        {isOverridden && (
          <span
            title="Overriding the workspace default"
            style={{ color: '#86efac', fontSize: 9, marginLeft: 2 }}
          >
            ●
          </span>
        )}
        <span style={{ color: '#475569', fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 50,
            width: 340,
            maxHeight: 380,
            overflowY: 'auto',
            background: '#0d0d14',
            border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
          }}
        >
          <div
            style={{
              padding: 8,
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              position: 'sticky',
              top: 0,
              background: '#0d0d14',
              zIndex: 1,
            }}
          >
            <input
              autoFocus
              placeholder={`Search ${AI_MODELS.length} models…`}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 10px',
                background: '#0f172a',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: 6,
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>

          {PROVIDER_ORDER.map((p) => {
            const list = grouped[p];
            if (list.length === 0) return null;
            return (
              <div key={p}>
                <div
                  style={{
                    padding: '6px 12px 2px',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: '#64748b',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: PROVIDER_COLORS[p],
                    }}
                  />
                  {PROVIDER_LABELS[p]}
                </div>
                {list.map((m) => {
                  const isActive = m.id === effectiveId;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => void pick(m.id)}
                      disabled={saving}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        background: isActive ? 'rgba(34,197,94,0.08)' : 'transparent',
                        color: isActive ? '#86efac' : '#cbd5e1',
                        border: 'none',
                        borderLeft: isActive ? '2px solid #22c55e' : '2px solid transparent',
                        cursor: saving ? 'wait' : 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 500 }}>{m.name}</span>
                        <span
                          style={{
                            fontSize: 10,
                            color: isActive ? '#86efac' : '#64748b',
                            padding: '0 4px',
                            background: 'rgba(255,255,255,0.04)',
                            borderRadius: 3,
                          }}
                        >
                          {m.tier}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#475569' }}>
                          {m.contextWindow}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#64748b' }}>
                        {formatModelPricing(m)}
                        {m.pricingNote ? ` · ${m.pricingNote}` : ''}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}

          {saveError && (
            <div
              role="alert"
              style={{
                padding: '6px 10px',
                margin: '4px 8px 0',
                fontSize: 11,
                color: '#fca5a5',
                background: 'rgba(248,113,113,0.10)',
                border: '1px solid rgba(248,113,113,0.30)',
                borderRadius: 6,
                lineHeight: 1.4,
                wordBreak: 'break-word',
              }}
            >
              Save failed — {saveError}
            </div>
          )}
          <div
            style={{
              padding: 8,
              borderTop: '1px solid rgba(255,255,255,0.06)',
              position: 'sticky',
              bottom: 0,
              background: '#0d0d14',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={resetToDefault}
              disabled={!isOverridden || saving}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                color: isOverridden ? '#94a3b8' : '#475569',
                border: '1px solid #334155',
                borderRadius: 6,
                fontSize: 11,
                cursor: isOverridden && !saving ? 'pointer' : 'not-allowed',
              }}
            >
              Reset to default
            </button>
            <span style={{ fontSize: 10, color: '#64748b', marginLeft: 'auto' }}>
              {featureSpec?.label ?? feature}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
