'use client';

import { useEffect, useState } from 'react';
import { APP_FEATURES, AI_MODELS, DEFAULT_FALLBACK_CHAINS } from '@/lib/ai-models';

interface Collaborator {
  id: string;
  name: string;
  email: string | null;
  role: string;
}

interface ThumbnailTemplateRow {
  id: string;
  name: string;
}

interface SeoTemplateRow {
  id: string;
  name: string;
  is_default: boolean;
}

interface FullPreset {
  id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  idea_context: Record<string, unknown> | null;
  script_rules: Record<string, unknown> | null;
  target_spoken_words: number | null;
  qa_min_score: string;
  qa_max_iterations: number;
  script_gate_enabled: boolean;
  production_doc_style_id: string | null;
  narration_deadline_days: number;
  fallback_chains: Record<string, string[]> | null;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
  seo_template_id: string | null;
}

/** Features the auto-pipeline routes through generateTextWithFallback. */
const PIPELINE_FEATURES = ['idea-generator', 'script-generator', 'critic-panel', 'production-doc', 'seo-optimizer'] as const;

export default function PresetForm({
  presetId,
  onClose,
  onSaved,
  onError,
}: {
  presetId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const isNew = presetId === null;

  // Form state
  const [name, setName] = useState('');
  const [niche, setNiche] = useState('');
  const [ideasCountDefault, setIdeasCountDefault] = useState(5);
  const [targetSpokenWords, setTargetSpokenWords] = useState<number | ''>('');
  const [qaMinScore, setQaMinScore] = useState(75);
  const [qaMaxIterations, setQaMaxIterations] = useState(3);
  const [scriptGateEnabled, setScriptGateEnabled] = useState(true);
  const [narrationDeadlineDays, setNarrationDeadlineDays] = useState(7);
  const [videoEditorId, setVideoEditorId] = useState<string>('');
  const [thumbnailTemplateId, setThumbnailTemplateId] = useState<string>('');
  const [seoTemplateId, setSeoTemplateId] = useState<string>('');
  const [ideaContextJson, setIdeaContextJson] = useState('{}');
  const [scriptRulesJson, setScriptRulesJson] = useState('{}');
  const [fallbackChains, setFallbackChains] = useState<Record<string, string[]>>({});

  // Reference data for selectors
  const [editors, setEditors] = useState<Collaborator[]>([]);
  const [thumbnailTemplates, setThumbnailTemplates] = useState<ThumbnailTemplateRow[]>([]);
  const [seoTemplates, setSeoTemplates] = useState<SeoTemplateRow[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);

  // Load preset + reference data.
  useEffect(() => {
    void (async () => {
      try {
        const [editorsRes, tplsRes, seoTplsRes, presetRes] = await Promise.all([
          fetch('/api/team/collaborators?role=editor', { cache: 'no-store' }).catch(() => null),
          fetch('/api/thumbnail-templates', { cache: 'no-store' }).catch(() => null),
          fetch('/api/templates?field_type=seo', { cache: 'no-store' }).catch(() => null),
          presetId
            ? fetch(`/api/auto-pipeline/presets/${presetId}`, { cache: 'no-store' })
            : Promise.resolve(null),
        ]);

        if (editorsRes && editorsRes.ok) {
          const data = await editorsRes.json();
          setEditors(Array.isArray(data) ? (data as Collaborator[]) : []);
        }
        if (tplsRes && tplsRes.ok) {
          const data = await tplsRes.json();
          setThumbnailTemplates((data.templates as ThumbnailTemplateRow[]) ?? []);
        }
        if (seoTplsRes && seoTplsRes.ok) {
          const data = await seoTplsRes.json();
          // /api/templates returns the array directly (legacy shape).
          const rows = Array.isArray(data) ? data : (data.templates ?? []);
          setSeoTemplates(rows as SeoTemplateRow[]);
        }
        if (presetRes && presetRes.ok) {
          const data = await presetRes.json();
          const p = data.preset as FullPreset;
          setName(p.name);
          setNiche(p.niche ?? '');
          setIdeasCountDefault(p.ideas_count_default);
          setTargetSpokenWords(p.target_spoken_words ?? '');
          setQaMinScore(Math.round(parseFloat(p.qa_min_score)));
          setQaMaxIterations(p.qa_max_iterations);
          setScriptGateEnabled(p.script_gate_enabled);
          setNarrationDeadlineDays(p.narration_deadline_days);
          setVideoEditorId(p.video_editor_collaborator_id ?? '');
          setThumbnailTemplateId(p.thumbnail_template_id ?? '');
          setSeoTemplateId(p.seo_template_id ?? '');
          setIdeaContextJson(JSON.stringify(p.idea_context ?? {}, null, 2));
          setScriptRulesJson(JSON.stringify(p.script_rules ?? {}, null, 2));
          setFallbackChains(p.fallback_chains ?? {});
        }
      } catch (e) {
        setInternalError(e instanceof Error ? e.message : 'Failed to load reference data');
      } finally {
        setLoading(false);
      }
    })();
  }, [presetId]);

  async function save() {
    setInternalError(null);
    if (!name.trim()) {
      setInternalError('Name is required.');
      return;
    }

    let parsedIdeaContext: Record<string, unknown> | null = null;
    let parsedScriptRules: Record<string, unknown> | null = null;
    try {
      const ideaTrimmed = ideaContextJson.trim();
      parsedIdeaContext = ideaTrimmed ? (JSON.parse(ideaTrimmed) as Record<string, unknown>) : null;
    } catch {
      setInternalError('Idea context must be valid JSON.');
      return;
    }
    try {
      const rulesTrimmed = scriptRulesJson.trim();
      parsedScriptRules = rulesTrimmed ? (JSON.parse(rulesTrimmed) as Record<string, unknown>) : null;
    } catch {
      setInternalError('Script rules must be valid JSON.');
      return;
    }

    // Filter out empty fallback chains (we only persist non-empty
    // overrides; empty chains would force a degenerate single-
    // model resolver fallback that's unnecessarily noisy).
    const cleanChains: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(fallbackChains)) {
      if (Array.isArray(v) && v.length > 0) cleanChains[k] = v;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      niche: niche.trim() || null,
      ideas_count_default: ideasCountDefault,
      idea_context: parsedIdeaContext,
      script_rules: parsedScriptRules,
      target_spoken_words: targetSpokenWords === '' ? null : Number(targetSpokenWords),
      qa_min_score: qaMinScore,
      qa_max_iterations: qaMaxIterations,
      script_gate_enabled: scriptGateEnabled,
      narration_deadline_days: narrationDeadlineDays,
      fallback_chains: Object.keys(cleanChains).length > 0 ? cleanChains : null,
      video_editor_collaborator_id: videoEditorId || null,
      thumbnail_template_id: thumbnailTemplateId || null,
      seo_template_id: seoTemplateId || null,
    };

    setSaving(true);
    try {
      const res = isNew
        ? await fetch('/api/auto-pipeline/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/auto-pipeline/presets/${presetId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed';
      setInternalError(msg);
      onError(msg);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 mb-5">
        <div className="text-sm text-zinc-500">Loading preset…</div>
      </div>
    );
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 mb-5 bg-zinc-50/50 dark:bg-zinc-900/30">
      <h2 className="font-medium mb-4">{isNew ? 'New preset' : 'Edit preset'}</h2>

      {internalError && (
        <div className="mb-4 p-2 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-xs">
          {internalError}
        </div>
      )}

      <div className="space-y-5">
        <SectionHeader title="Basics" />

        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Niche">
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="e.g. productivity"
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
          </Field>
          <Field label="Default ideas per batch">
            <input
              type="number"
              min={1}
              max={50}
              value={ideasCountDefault}
              onChange={(e) => setIdeasCountDefault(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
          </Field>
        </div>

        <SectionHeader title="Script" />

        <Field
          label="Target spoken words"
          hint="Optional. When set, used to derive the script's target duration. Leave blank to use an 8-minute default."
        >
          <input
            type="number"
            min={50}
            max={50000}
            value={targetSpokenWords}
            onChange={(e) => setTargetSpokenWords(e.target.value === '' ? '' : Math.max(50, parseInt(e.target.value, 10) || 50))}
            className="w-48 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          />
        </Field>

        <Field
          label="Script gate"
          hint="When on, you review each script before the AI script review runs. Saves token spend on dud ideas."
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={scriptGateEnabled}
              onChange={(e) => setScriptGateEnabled(e.target.checked)}
            />
            <span>Pause for my approval after each script draft</span>
          </label>
        </Field>

        <Field
          label="Script rules (JSON)"
          hint="Free-form: tone, style, audience, targetDurationMinutes, additionalContext. Power-user surface."
        >
          <textarea
            value={scriptRulesJson}
            onChange={(e) => setScriptRulesJson(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full px-3 py-2 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono"
          />
        </Field>

        <SectionHeader title="AI script review (QA)" />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum passing score">
            <input
              type="number"
              min={0}
              max={100}
              value={qaMinScore}
              onChange={(e) => setQaMinScore(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
          </Field>
          <Field label="Max retry iterations">
            <input
              type="number"
              min={0}
              max={10}
              value={qaMaxIterations}
              onChange={(e) => setQaMaxIterations(Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)))}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
          </Field>
        </div>

        <SectionHeader title="Ideas" />

        <Field
          label="Idea-gen context (JSON)"
          hint="audience, focus (trending|evergreen|controversial|beginner|mixed), videoType, referenceContext, redditContext."
        >
          <textarea
            value={ideaContextJson}
            onChange={(e) => setIdeaContextJson(e.target.value)}
            rows={4}
            spellCheck={false}
            className="w-full px-3 py-2 text-xs rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent font-mono"
          />
        </Field>

        <SectionHeader title="Narration handoff" />

        <Field label="Deadline (days)">
          <input
            type="number"
            min={1}
            max={90}
            value={narrationDeadlineDays}
            onChange={(e) => setNarrationDeadlineDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 1)))}
            className="w-32 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          />
        </Field>

        <SectionHeader title="Post-production" />

        <Field label="Thumbnail template">
          <select
            value={thumbnailTemplateId}
            onChange={(e) => setThumbnailTemplateId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          >
            <option value="">— Use defaults —</option>
            {thumbnailTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </Field>

        <Field
          label="SEO template"
          hint="Runs after the editor assignment. Generates title candidates, description, tags, and chapters from the script. Leave blank to skip the SEO step entirely. Manage saved SEO templates on /seo."
        >
          <select
            value={seoTemplateId}
            onChange={(e) => setSeoTemplateId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          >
            <option value="">— Skip SEO step —</option>
            {seoTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Auto-assign editor"
          hint="When set, the pipeline creates an editor_assignment on the project with the approved script + voiceover + production doc + thumbnail attached."
        >
          <select
            value={videoEditorId}
            onChange={(e) => setVideoEditorId(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
          >
            <option value="">— No auto-assign (terminate at done) —</option>
            {editors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.email ? ` (${c.email})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <SectionHeader
          title="Advanced — model fallback chains"
          collapsible
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((v) => !v)}
        />

        {advancedOpen && (
          <div className="space-y-3 pl-2 border-l-2 border-zinc-200 dark:border-zinc-800">
            <p className="text-xs text-zinc-500">
              Each pipeline stage tries models in order on transient failure (rate-limit / 5xx / timeout / empty
              output). Refusals and unknown errors short-circuit — they never fall through. Leave empty to use
              the built-in defaults shown as placeholders.
            </p>
            {PIPELINE_FEATURES.map((feature) => {
              const spec = APP_FEATURES.find((f) => f.id === feature);
              const defaultChain = DEFAULT_FALLBACK_CHAINS[feature] ?? [];
              const currentChain = fallbackChains[feature] ?? [];
              return (
                <FallbackChainEditor
                  key={feature}
                  feature={feature}
                  label={spec?.label ?? feature}
                  defaultChain={defaultChain}
                  currentChain={currentChain}
                  onChange={(next) => setFallbackChains((prev) => ({ ...prev, [feature]: next }))}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={saving}
          className="px-4 py-2 rounded-md text-sm border border-zinc-300 dark:border-zinc-700 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !name.trim()}
          className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : isNew ? 'Create preset' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function FallbackChainEditor({
  feature,
  label,
  defaultChain,
  currentChain,
  onChange,
}: {
  feature: string;
  label: string;
  defaultChain: readonly string[];
  currentChain: string[];
  onChange: (next: string[]) => void;
}) {
  const placeholder = defaultChain.join(' → ');

  function setAt(idx: number, modelId: string) {
    const next = [...currentChain];
    next[idx] = modelId;
    onChange(next.filter(Boolean));
  }
  function addEntry() {
    onChange([...currentChain, AI_MODELS[0].id]);
  }
  function removeAt(idx: number) {
    onChange(currentChain.filter((_, i) => i !== idx));
  }

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{label}</span>
        <button
          onClick={addEntry}
          className="text-xs text-zinc-600 dark:text-zinc-400 hover:underline"
          type="button"
        >
          + Add model
        </button>
      </div>
      {currentChain.length === 0 ? (
        <div className="text-xs text-zinc-500 mb-1">
          Using default: <code>{placeholder}</code>
        </div>
      ) : (
        <ul className="space-y-1">
          {currentChain.map((id, idx) => (
            <li key={idx} className="flex gap-2 items-center">
              <span className="w-6 text-xs text-zinc-500 font-mono">#{idx + 1}</span>
              <select
                value={id}
                onChange={(e) => setAt(idx, e.target.value)}
                className="flex-1 px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-transparent"
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeAt(idx)}
                className="text-xs text-red-600 dark:text-red-400 hover:underline"
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <input type="hidden" value={feature} />
    </div>
  );
}

function SectionHeader({
  title,
  collapsible,
  open,
  onToggle,
}: {
  title: string;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  if (collapsible) {
    return (
      <button
        onClick={onToggle}
        type="button"
        className="w-full text-left flex items-center gap-2 pt-2 pb-1 text-xs uppercase tracking-wide font-medium text-zinc-500"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </button>
    );
  }
  return (
    <div className="pt-2 pb-1 text-xs uppercase tracking-wide font-medium text-zinc-500">{title}</div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {hint && <div className="text-xs text-zinc-500 mb-1.5">{hint}</div>}
      {children}
    </div>
  );
}
