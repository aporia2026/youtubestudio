'use client';

/**
 * Settings → Model Defaults panel.
 *
 * Three stacked cards:
 *   1. Workspace default — one big picker that affects every feature
 *      that doesn't have a section or feature override.
 *   2. By section — Create / Grow / Automate / Foundation pickers
 *      (Collaborate is skipped — it has no AI features today).
 *   3. Per feature — collapsible accordion grouped by section. Each
 *      row shows the resolved model + an "override" picker + a Clear
 *      button when a per-feature override is set.
 *
 * The panel hydrates from /api/settings/model-defaults (one fetch
 * returns the defaults blob plus the catalogues so the component
 * doesn't need to import APP_FEATURES at runtime).
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ModelSelector } from '@/components/ui/ModelSelector';
import {
  AI_MODELS,
  resolveFeatureModelId,
  getModelById,
  type AppFeature,
  type AppFeatureSpec,
  type FeatureSection,
  type ModelDefaultsBlob,
} from '@/lib/ai-models';

interface SectionMeta { id: FeatureSection; label: string; description: string }

const EMPTY_BLOB: ModelDefaultsBlob = { workspace: null, sections: {}, features: {} };

export function ModelDefaultsPanel() {
  const [loading, setLoading] = useState(true);
  const [defaults, setDefaults] = useState<ModelDefaultsBlob>(EMPTY_BLOB);
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [features, setFeatures] = useState<AppFeatureSpec[]>([]);
  const [expanded, setExpanded] = useState<Set<FeatureSection>>(new Set());
  const [savingScope, setSavingScope] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/model-defaults')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setDefaults(data.defaults ?? EMPTY_BLOB);
        setSections(data.sections ?? []);
        setFeatures(data.features ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : 'Failed to load model defaults');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Group features by section once the catalogue arrives.
  const featuresBySection = useMemo(() => {
    const map = new Map<FeatureSection, AppFeatureSpec[]>();
    for (const f of features) {
      const list = map.get(f.section) ?? [];
      list.push(f);
      map.set(f.section, list);
    }
    return map;
  }, [features]);

  function toggleSection(id: FeatureSection) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveScope(scope: string, modelId: string) {
    setSavingScope(scope);
    try {
      const res = await fetch('/api/settings/model-defaults', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, modelId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save');
      // Optimistic local update so the UI reflects the new value
      // immediately without a refetch.
      setDefaults((prev) => applyScope(prev, scope, modelId));
      toast.success('Default updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingScope(null);
    }
  }

  async function clearScope(scope: string) {
    setSavingScope(scope);
    try {
      const res = await fetch(`/api/settings/model-defaults?scope=${encodeURIComponent(scope)}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to clear');
      setDefaults((prev) => applyScope(prev, scope, null));
      toast.success('Reverted to inherit');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setSavingScope(null);
    }
  }

  if (loading) {
    return (
      <div className="glass rounded-xl p-6 text-center">
        <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin mx-auto" style={{ borderColor: '#7c3aed', borderTopColor: 'transparent' }} />
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Loading model defaults…</p>
      </div>
    );
  }

  // Sections with at least one feature — Collaborate has none and
  // would render an empty card otherwise.
  const sectionsWithFeatures = sections.filter((s) => (featuresBySection.get(s.id) ?? []).length > 0);

  return (
    <div className="space-y-4">
      {/* ─── Card 1: Workspace default ─────────────────────────────── */}
      <div className="glass rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Workspace default</h2>
          {defaults.workspace && (
            <button
              onClick={() => clearScope('workspace')}
              disabled={savingScope === 'workspace'}
              className="text-xs hover:underline disabled:opacity-50"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          The model used by every feature that doesn&apos;t have a section or feature override. Leave unset to use each feature&apos;s built-in default.
        </p>
        <ModelSelector
          value={defaults.workspace || AI_MODELS[0].id}
          onChange={(id) => saveScope('workspace', id)}
          label=""
        />
        {!defaults.workspace && (
          <p className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
            No workspace default set — features fall through to their hardcoded defaults.
          </p>
        )}
      </div>

      {/* ─── Card 2: By section ─────────────────────────────────────── */}
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>By section</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Pick a model for everything in a section. Section overrides beat the workspace default but lose to per-feature overrides.
        </p>
        <div className="space-y-4">
          {sectionsWithFeatures.map((section) => {
            const scope = `section:${section.id}`;
            const current = defaults.sections[section.id];
            return (
              <div key={section.id}>
                <div className="flex items-baseline justify-between mb-1">
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label}</p>
                  {current && (
                    <button
                      onClick={() => clearScope(scope)}
                      disabled={savingScope === scope}
                      className="text-[11px] hover:underline disabled:opacity-50"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <p className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>{section.description}</p>
                <ModelSelector
                  value={current || defaults.workspace || AI_MODELS[0].id}
                  onChange={(id) => saveScope(scope, id)}
                  label=""
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Card 3: Per feature ───────────────────────────────────── */}
      <div className="glass rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Per feature</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Override the model for a specific feature. Per-feature overrides beat section + workspace defaults. Click a section to expand.
        </p>
        <div className="space-y-2">
          {sectionsWithFeatures.map((section) => {
            const sectionFeatures = featuresBySection.get(section.id) ?? [];
            const isOpen = expanded.has(section.id);
            const overrideCount = sectionFeatures.filter((f) => defaults.features[f.id]).length;
            return (
              <div key={section.id} className="rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                <button
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center justify-between p-3 cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isOpen ? '▾' : '▸'}</span>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label}</p>
                    <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                      {sectionFeatures.length} feature{sectionFeatures.length === 1 ? '' : 's'}
                    </span>
                    {overrideCount > 0 && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(124,58,237,0.15)', color: '#a78bfa' }}>
                        {overrideCount} override{overrideCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-3 border-t" style={{ borderColor: 'var(--border)' }}>
                    {sectionFeatures.map((feature) => (
                      <FeatureRow
                        key={feature.id}
                        feature={feature}
                        defaults={defaults}
                        savingScope={savingScope}
                        onSave={saveScope}
                        onClear={clearScope}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface FeatureRowProps {
  feature: AppFeatureSpec;
  defaults: ModelDefaultsBlob;
  savingScope: string | null;
  onSave: (scope: string, modelId: string) => void;
  onClear: (scope: string) => void;
}

function FeatureRow({ feature, defaults, savingScope, onSave, onClear }: FeatureRowProps) {
  const scope = `feature:${feature.id}`;
  const override = defaults.features[feature.id];
  const resolved = resolveFeatureModelId(feature.id, defaults);
  const resolvedModel = getModelById(resolved);
  // Where the resolved value came from — helps the user understand why
  // a feature is using a particular model when they haven't set an
  // override on it directly.
  const resolvedFrom: 'feature' | 'section' | 'workspace' | 'default' = override
    ? 'feature'
    : defaults.sections[feature.section]
      ? 'section'
      : defaults.workspace
        ? 'workspace'
        : 'default';
  const resolvedLabel = {
    feature: 'feature override',
    section: 'section default',
    workspace: 'workspace default',
    default: 'built-in default',
  }[resolvedFrom];

  return (
    <div className="pt-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{feature.label}</p>
          <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{feature.description}</p>
        </div>
        {override && (
          <button
            onClick={() => onClear(scope)}
            disabled={savingScope === scope}
            className="text-[11px] hover:underline shrink-0 ml-2 disabled:opacity-50"
            style={{ color: 'var(--text-muted)' }}
          >
            Clear override
          </button>
        )}
      </div>
      <p className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
        Currently using <strong style={{ color: 'var(--text-secondary)' }}>{resolvedModel?.name ?? resolved}</strong> ({resolvedLabel})
      </p>
      <ModelSelector
        value={override || resolved}
        onChange={(id) => onSave(scope, id)}
        label=""
      />
    </div>
  );
}

/** Pure helper — apply a scope/modelId pair to a defaults blob. Used
 *  for optimistic local updates after a successful PUT/DELETE. */
function applyScope(blob: ModelDefaultsBlob, scope: string, modelId: string | null): ModelDefaultsBlob {
  if (scope === 'workspace') return { ...blob, workspace: modelId };
  if (scope.startsWith('section:')) {
    const section = scope.slice('section:'.length) as FeatureSection;
    const next = { ...blob.sections };
    if (modelId === null) delete next[section];
    else next[section] = modelId;
    return { ...blob, sections: next };
  }
  if (scope.startsWith('feature:')) {
    const feature = scope.slice('feature:'.length) as AppFeature;
    const next = { ...blob.features };
    if (modelId === null) delete next[feature];
    else next[feature] = modelId;
    return { ...blob, features: next };
  }
  return blob;
}
