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

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { highlight, matchesAny } from '@/lib/model-search';

interface SectionMeta { id: FeatureSection; label: string; description: string }

const EMPTY_BLOB: ModelDefaultsBlob = { workspace: null, sections: {}, features: {} };

export function ModelDefaultsPanel() {
  const [loading, setLoading] = useState(true);
  const [defaults, setDefaults] = useState<ModelDefaultsBlob>(EMPTY_BLOB);
  const [sections, setSections] = useState<SectionMeta[]>([]);
  const [features, setFeatures] = useState<AppFeatureSpec[]>([]);
  const [expanded, setExpanded] = useState<Set<FeatureSection>>(new Set());
  const [savingScope, setSavingScope] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line no-restricted-syntax -- GET, read
    fetch('/api/settings/model-defaults')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const blob = data.defaults ?? EMPTY_BLOB;
        setDefaults(blob);
        setSections(data.sections ?? []);
        setFeatures(data.features ?? []);
        // Mirror to localStorage so other client pages that read
        // getFeatureDefaultModelId (which falls back to localStorage when
        // no blob is supplied) see the workspace's saved defaults.
        try { localStorage.setItem('feature_model_defaults_v2', JSON.stringify(blob)); } catch {}
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

  // Keep the localStorage mirror in sync after every save/clear so
  // navigation to another page picks up the change immediately.
  useEffect(() => {
    if (loading) return;
    try { localStorage.setItem('feature_model_defaults_v2', JSON.stringify(defaults)); } catch {}
  }, [defaults, loading]);

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

  // One log on first ready render so the console always tells me what the
  // panel started with — keeps the observability bar (rule 14) without
  // flooding on every keystroke.
  const loggedReadyRef = useRef(false);
  useEffect(() => {
    if (loading || loggedReadyRef.current) return;
    loggedReadyRef.current = true;
    console.info('[settings model-defaults] panel ready', {
      sections: sections.length,
      features: features.length,
      models: AI_MODELS.length,
    });
  }, [loading, sections.length, features.length]);

  /** Does the workspace-default card match the current search? */
  function workspaceMatches(): boolean {
    if (!search.trim()) return true;
    const resolved = defaults.workspace ? getModelById(defaults.workspace) : null;
    return matchesAny(
      search,
      'Workspace default',
      'global fallback model',
      resolved?.name,
      resolved?.id,
      resolved?.provider,
    );
  }

  /** Does a per-section row match? */
  function sectionMatches(meta: SectionMeta): boolean {
    if (!search.trim()) return true;
    const sectionOverride = defaults.sections[meta.id];
    const resolvedId = sectionOverride || defaults.workspace || undefined;
    const resolved = resolvedId ? getModelById(resolvedId) : null;
    return matchesAny(search, meta.label, meta.description, resolved?.name, resolved?.id, resolved?.provider);
  }

  /** Does a per-feature row match? Includes the parent section's label so
   *  typing "create" surfaces every feature under the Create section. */
  function featureMatches(feature: AppFeatureSpec): boolean {
    if (!search.trim()) return true;
    const sectionMeta = sections.find((s) => s.id === feature.section);
    const resolved = getModelById(resolveFeatureModelId(feature.id, defaults));
    return matchesAny(
      search,
      feature.label,
      feature.description,
      feature.id,
      sectionMeta?.label,
      resolved?.name,
      resolved?.id,
      resolved?.provider,
    );
  }

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
      // eslint-disable-next-line no-restricted-syntax -- awaited PUT RPC - awaits and uses response
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
      // eslint-disable-next-line no-restricted-syntax -- awaited DELETE RPC
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

  // ── Search-driven visibility ──────────────────────────────────────
  const searchActive = search.trim().length > 0;
  const showWorkspace = workspaceMatches();

  // Per-section: a section is "visible" if the section row itself
  // matches OR any of its features match. The feature list within a
  // visible section is also filtered.
  const visibleSectionsByMeta = sectionsWithFeatures
    .map((meta) => {
      const sectionFeatures = featuresBySection.get(meta.id) ?? [];
      const matchedFeatures = searchActive
        ? sectionFeatures.filter((f) => featureMatches(f))
        : sectionFeatures;
      const sectionItselfMatches = sectionMatches(meta);
      return {
        meta,
        sectionFeatures,             // full list (for card 3 counts)
        matchedFeatures,             // filtered list (for card 3 render)
        sectionRowVisible: !searchActive || sectionItselfMatches, // card 2
        anyMatch: sectionItselfMatches || matchedFeatures.length > 0,
      };
    })
    .filter((s) => !searchActive || s.anyMatch);

  // Tallies for the "X of Y" header.
  const totalScopes =
    1 /* workspace */ +
    sectionsWithFeatures.length +
    sectionsWithFeatures.reduce((n, s) => n + (featuresBySection.get(s.id) ?? []).length, 0);
  const visibleScopes =
    (showWorkspace ? 1 : 0) +
    visibleSectionsByMeta.filter((s) => s.sectionRowVisible).length +
    visibleSectionsByMeta.reduce((n, s) => n + s.matchedFeatures.length, 0);

  const nothingMatches = searchActive && !showWorkspace && visibleSectionsByMeta.length === 0;

  return (
    <div className="space-y-4">
      {/* ─── Search bar ───────────────────────────────────────────── */}
      <div
        className="sticky top-0 z-30 -mx-1 px-1 py-2"
        style={{ background: 'var(--bg-primary)' }}
      >
        <div className="relative">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-muted)' }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearch('');
            }}
            placeholder={`Search ${totalScopes} scopes — by name, feature, or model…`}
            className="w-full pl-9 pr-20 py-2.5 rounded-lg text-sm"
            style={{
              background: 'var(--bg-secondary)',
              border: `1px solid ${searchActive ? 'var(--accent-purple)' : 'var(--border)'}`,
              color: 'var(--text-primary)',
              boxShadow: searchActive ? '0 0 0 3px rgba(124,58,237,0.12)' : 'none',
            }}
          />
          {searchActive && (
            <button
              type="button"
              onClick={() => { setSearch(''); searchRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] px-2 py-1 rounded hover:underline"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear
            </button>
          )}
        </div>
        {searchActive && (
          <p className="text-[11px] mt-1.5 pl-1" style={{ color: 'var(--text-muted)' }}>
            Showing <strong style={{ color: 'var(--text-secondary)' }}>{visibleScopes}</strong> of {totalScopes} scopes
            {' · '}
            <span>matches scope names, feature names, and assigned models</span>
          </p>
        )}
      </div>

      {nothingMatches && (
        <div className="glass rounded-xl p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
            No scopes match <strong>&ldquo;{search.trim()}&rdquo;</strong>.
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Try a model name (&ldquo;opus&rdquo;, &ldquo;gemini&rdquo;), a provider (&ldquo;anthropic&rdquo;), or a feature word (&ldquo;thumbnail&rdquo;, &ldquo;script&rdquo;).
          </p>
          <button
            onClick={() => { setSearch(''); searchRef.current?.focus(); }}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            Clear search
          </button>
        </div>
      )}

      {/* ─── Card 1: Workspace default ─────────────────────────────── */}
      {showWorkspace && (
        <div className="glass rounded-xl p-5">
          <div className="flex items-baseline justify-between mb-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              <HL text="Workspace default" q={search} />
            </h2>
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
      )}

      {/* ─── Card 2: By section ─────────────────────────────────────── */}
      {visibleSectionsByMeta.some((s) => s.sectionRowVisible) && (
        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>By section</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Pick a model for everything in a section. Section overrides beat the workspace default but lose to per-feature overrides.
          </p>
          <div className="space-y-4">
            {visibleSectionsByMeta
              .filter((s) => s.sectionRowVisible)
              .map(({ meta: section }) => {
                const scope = `section:${section.id}`;
                const current = defaults.sections[section.id];
                return (
                  <div key={section.id}>
                    <div className="flex items-baseline justify-between mb-1">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        <HL text={section.label} q={search} />
                      </p>
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
      )}

      {/* ─── Card 3: Per feature ───────────────────────────────────── */}
      {visibleSectionsByMeta.some((s) => s.matchedFeatures.length > 0) && (
        <div className="glass rounded-xl p-5">
          <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Per feature</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
            Override the model for a specific feature. Per-feature overrides beat section + workspace defaults.{' '}
            {searchActive ? 'Sections with matches are auto-expanded.' : 'Click a section to expand.'}
          </p>
          <div className="space-y-2">
            {visibleSectionsByMeta.map(({ meta: section, sectionFeatures, matchedFeatures }) => {
              if (matchedFeatures.length === 0) return null;
              // While a search is active, force-open every section that has a
              // match — otherwise the user would have to expand them manually
              // just to see the rows they searched for.
              const isOpen = searchActive ? true : expanded.has(section.id);
              const overrideCount = sectionFeatures.filter((f) => defaults.features[f.id]).length;
              return (
                <div key={section.id} className="rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
                  <button
                    onClick={() => !searchActive && toggleSection(section.id)}
                    className="w-full flex items-center justify-between p-3 cursor-pointer disabled:cursor-default"
                    disabled={searchActive}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{isOpen ? '▾' : '▸'}</span>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{section.label}</p>
                      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                        {searchActive
                          ? `${matchedFeatures.length} of ${sectionFeatures.length}`
                          : `${sectionFeatures.length} feature${sectionFeatures.length === 1 ? '' : 's'}`}
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
                      {matchedFeatures.map((feature) => (
                        <FeatureRow
                          key={feature.id}
                          feature={feature}
                          defaults={defaults}
                          savingScope={savingScope}
                          onSave={saveScope}
                          onClear={clearScope}
                          highlightQuery={search}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline highlight helper — bolds the matched substrings without
 *  changing layout. Used in the scope labels of the panel cards. */
function HL({ text, q }: { text: string; q: string }) {
  const parts = highlight(q, text);
  return (
    <>
      {parts.map((p, i) =>
        p.match
          ? <strong key={i} style={{ background: 'rgba(124,58,237,0.18)', color: 'var(--text-primary)', borderRadius: 2, padding: '0 1px' }}>{p.text}</strong>
          : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

interface FeatureRowProps {
  feature: AppFeatureSpec;
  defaults: ModelDefaultsBlob;
  savingScope: string | null;
  onSave: (scope: string, modelId: string) => void;
  onClear: (scope: string) => void;
  highlightQuery?: string;
}

function FeatureRow({ feature, defaults, savingScope, onSave, onClear, highlightQuery = '' }: FeatureRowProps) {
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
          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            <HL text={feature.label} q={highlightQuery} />
          </p>
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
