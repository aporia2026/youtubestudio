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

interface StyleRow {
  id: string;
  /** The /api/production-doc/styles endpoint returns ResolvedStyle
   *  shape — built-ins carry a `label` and saved rows are mapped to
   *  `label = name` in savedRowToResolved. Either way the field is
   *  `label`, NOT `name`. Reading `s.name` here used to render every
   *  built-in option as just "(built-in)" with no preset name. */
  label: string;
  description?: string | null;
  origin: 'built-in' | 'saved';
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
  /** When set, overrides `production_doc_style_id` for the script-
   *  generation stage. Null = fall back to `production_doc_style_id`.
   *  Both null = no style preset injection. Migration 0093. */
  script_style_preset_id: string | null;
  narration_deadline_days: number;
  fallback_chains: Record<string, string[]> | null;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
  seo_template_id: string | null;
  // ─── Feature-preset bundle (migration 0097) ───────────────────────
  script_preset_id: string | null;
  qa_preset_id: string | null;
  narration_preset_id: string | null;
  idea_preset_id: string | null;
}

interface FeaturePresetOption {
  id: string;
  name: string;
  description: string | null;
}

interface FeaturePresetLists {
  script: FeaturePresetOption[];
  qa: FeaturePresetOption[];
  narration: FeaturePresetOption[];
  idea: FeaturePresetOption[];
}

const PIPELINE_FEATURES = [
  'idea-generator',
  'script-generator',
  'critic-panel',
  'production-doc',
  'seo-optimizer',
] as const;

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
  // Visual style preset — drives the production-doc and thumbnail
  // stages, AND (when scriptStylePresetId is blank) the script stage.
  const [productionDocStyleId, setProductionDocStyleId] = useState<string>('');
  // Script style preset — overrides productionDocStyleId for the
  // script-generation stage only. Blank = inherit from
  // productionDocStyleId. Both blank = no style preset injection.
  const [scriptStylePresetId, setScriptStylePresetId] = useState<string>('');
  const [ideaContextJson, setIdeaContextJson] = useState('{}');
  // Script-rules state — broken out into structured fields per the
  // 2026-05-27 follow-up. The fields below cover the documented
  // script_rules_jsonb shape (tone/style/audience/additionalContext/
  // referenceContext/targetDurationMinutes). Unknown keys the user
  // had on a pre-existing preset (e.g. `constraints`) are preserved
  // in `scriptRulesOther` and merged back at save time so we don't
  // silently drop data.
  const [scriptTone, setScriptTone] = useState('');
  const [scriptStyleNote, setScriptStyleNote] = useState('');
  const [scriptAudience, setScriptAudience] = useState('');
  const [scriptTargetMinutes, setScriptTargetMinutes] = useState<number | ''>('');
  const [scriptAdditionalContext, setScriptAdditionalContext] = useState('');
  const [scriptReferenceContext, setScriptReferenceContext] = useState('');
  const [scriptRulesOther, setScriptRulesOther] = useState<Record<string, unknown>>({});
  const [fallbackChains, setFallbackChains] = useState<Record<string, string[]>>({});
  // Feature-preset bundle FKs (migration 0097). When set, the pipeline
  // preset routes the stage handler to a per-feature preset row
  // instead of the inline columns below. The inline columns stay
  // editable for legacy presets and as a fallback path.
  const [scriptPresetId, setScriptPresetId] = useState<string>('');
  const [qaPresetId, setQaPresetId] = useState<string>('');
  const [narrationPresetId, setNarrationPresetId] = useState<string>('');
  const [ideaPresetId, setIdeaPresetId] = useState<string>('');
  const [featurePresets, setFeaturePresets] = useState<FeaturePresetLists>({
    script: [],
    qa: [],
    narration: [],
    idea: [],
  });

  const [editors, setEditors] = useState<Collaborator[]>([]);
  const [thumbnailTemplates, setThumbnailTemplates] = useState<ThumbnailTemplateRow[]>([]);
  const [seoTemplates, setSeoTemplates] = useState<SeoTemplateRow[]>([]);
  const [styles, setStyles] = useState<StyleRow[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [editorsRes, tplsRes, seoTplsRes, stylesRes, featurePresetsRes, presetRes] = await Promise.all([
          fetch('/api/team/collaborators?role=editor', { cache: 'no-store' }).catch(() => null),
          fetch('/api/thumbnail-templates', { cache: 'no-store' }).catch(() => null),
          fetch('/api/templates?field_type=seo', { cache: 'no-store' }).catch(() => null),
          fetch('/api/production-doc/styles', { cache: 'no-store' }).catch(() => null),
          fetch('/api/auto-pipeline/feature-presets', { cache: 'no-store' }).catch(() => null),
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
          const rows = Array.isArray(data) ? data : (data.templates ?? []);
          setSeoTemplates(rows as SeoTemplateRow[]);
        }
        if (stylesRes && stylesRes.ok) {
          const data = await stylesRes.json();
          setStyles((data.styles as StyleRow[]) ?? []);
        }
        if (featurePresetsRes && featurePresetsRes.ok) {
          const data = await featurePresetsRes.json();
          setFeaturePresets({
            script: (data.script as FeaturePresetOption[]) ?? [],
            qa: (data.qa as FeaturePresetOption[]) ?? [],
            narration: (data.narration as FeaturePresetOption[]) ?? [],
            idea: (data.idea as FeaturePresetOption[]) ?? [],
          });
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
          setProductionDocStyleId(p.production_doc_style_id ?? '');
          setScriptStylePresetId(p.script_style_preset_id ?? '');
          setScriptPresetId(p.script_preset_id ?? '');
          setQaPresetId(p.qa_preset_id ?? '');
          setNarrationPresetId(p.narration_preset_id ?? '');
          setIdeaPresetId(p.idea_preset_id ?? '');
          setIdeaContextJson(JSON.stringify(p.idea_context ?? {}, null, 2));
          // Decompose script_rules_jsonb into the structured fields,
          // stashing any unknown keys in scriptRulesOther so they're
          // preserved on save.
          const rawRules = (p.script_rules ?? {}) as Record<string, unknown>;
          setScriptTone(typeof rawRules.tone === 'string' ? rawRules.tone : '');
          setScriptStyleNote(typeof rawRules.style === 'string' ? rawRules.style : '');
          setScriptAudience(typeof rawRules.audience === 'string' ? rawRules.audience : '');
          setScriptTargetMinutes(
            typeof rawRules.targetDurationMinutes === 'number' && Number.isFinite(rawRules.targetDurationMinutes)
              ? Math.max(1, Math.min(120, Math.floor(rawRules.targetDurationMinutes)))
              : '',
          );
          setScriptAdditionalContext(typeof rawRules.additionalContext === 'string' ? rawRules.additionalContext : '');
          setScriptReferenceContext(typeof rawRules.referenceContext === 'string' ? rawRules.referenceContext : '');
          const KNOWN = new Set(['tone', 'style', 'audience', 'targetDurationMinutes', 'additionalContext', 'referenceContext']);
          const other: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rawRules)) {
            if (!KNOWN.has(k)) other[k] = v;
          }
          setScriptRulesOther(other);
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
    try {
      const ideaTrimmed = ideaContextJson.trim();
      parsedIdeaContext = ideaTrimmed ? (JSON.parse(ideaTrimmed) as Record<string, unknown>) : null;
    } catch {
      setInternalError('Idea context must be valid JSON.');
      return;
    }

    // Recompose script_rules from the structured fields. Known fields
    // win over any same-named keys in scriptRulesOther; empty strings
    // drop the field entirely (we want JSON null-equivalent, not an
    // empty string sitting in the prompt). Merge scriptRulesOther
    // last so it can carry preserved unknown keys like `constraints`.
    const parsedScriptRules: Record<string, unknown> = { ...scriptRulesOther };
    if (scriptTone.trim()) parsedScriptRules.tone = scriptTone.trim();
    else delete parsedScriptRules.tone;
    if (scriptStyleNote.trim()) parsedScriptRules.style = scriptStyleNote.trim();
    else delete parsedScriptRules.style;
    if (scriptAudience.trim()) parsedScriptRules.audience = scriptAudience.trim();
    else delete parsedScriptRules.audience;
    if (scriptAdditionalContext.trim()) parsedScriptRules.additionalContext = scriptAdditionalContext;
    else delete parsedScriptRules.additionalContext;
    if (scriptReferenceContext.trim()) parsedScriptRules.referenceContext = scriptReferenceContext;
    else delete parsedScriptRules.referenceContext;
    if (typeof scriptTargetMinutes === 'number' && Number.isFinite(scriptTargetMinutes)) {
      parsedScriptRules.targetDurationMinutes = scriptTargetMinutes;
    } else {
      delete parsedScriptRules.targetDurationMinutes;
    }
    const finalScriptRules = Object.keys(parsedScriptRules).length > 0 ? parsedScriptRules : null;

    const cleanChains: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(fallbackChains)) {
      if (Array.isArray(v) && v.length > 0) cleanChains[k] = v;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      niche: niche.trim() || null,
      ideas_count_default: ideasCountDefault,
      idea_context: parsedIdeaContext,
      script_rules: finalScriptRules,
      target_spoken_words: targetSpokenWords === '' ? null : Number(targetSpokenWords),
      qa_min_score: qaMinScore,
      qa_max_iterations: qaMaxIterations,
      script_gate_enabled: scriptGateEnabled,
      narration_deadline_days: narrationDeadlineDays,
      fallback_chains: Object.keys(cleanChains).length > 0 ? cleanChains : null,
      video_editor_collaborator_id: videoEditorId || null,
      thumbnail_template_id: thumbnailTemplateId || null,
      seo_template_id: seoTemplateId || null,
      production_doc_style_id: productionDocStyleId || null,
      script_style_preset_id: scriptStylePresetId || null,
      // Feature-preset bundle (migration 0097). Null = unbundled (the
      // stage handler falls back to the inline columns below).
      script_preset_id: scriptPresetId || null,
      qa_preset_id: qaPresetId || null,
      narration_preset_id: narrationPresetId || null,
      idea_preset_id: ideaPresetId || null,
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
      <div className="glass rounded-xl p-5 mb-5">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading preset…
        </div>
      </div>
    );
  }

  return (
    <div className="glass-bright rounded-xl p-6 mb-6">
      <h2 className="text-sm font-semibold mb-5" style={{ color: 'var(--text-primary)' }}>
        {isNew ? 'New preset' : 'Edit preset'}
      </h2>

      {internalError && (
        <div
          className="mb-4 p-2 rounded text-xs"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {internalError}
        </div>
      )}

      <div className="space-y-6">
        <SectionHeader title="Basics" />

        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-field"
          />
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Niche">
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="e.g. productivity"
              className="input-field"
            />
          </Field>
          <Field label="Default ideas per batch">
            <input
              type="number"
              min={1}
              max={50}
              value={ideasCountDefault}
              onChange={(e) => setIdeasCountDefault(parseInt(e.target.value, 10) || 1)}
              className="input-field"
            />
          </Field>
        </div>

        <SectionHeader title="Feature presets (bundle)" />
        <div
          className="p-3 rounded-lg mb-1"
          style={{
            background: 'rgba(124,58,237,0.05)',
            border: '1px solid rgba(124,58,237,0.20)',
          }}
        >
          <p className="text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>
            Each pipeline preset bundles a per-feature preset for script,
            QA, narration, and idea generation. Edit any of these via
            their own page (coming soon) — the field sections below are
            the legacy inline editor and stay as a fallback. When a
            dropdown here is set, the stage handler will eventually read
            from that preset instead of the inline section. For now both
            paths work; pick from the existing (auto-migrated) options.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Script preset">
              <select
                value={scriptPresetId}
                onChange={(e) => setScriptPresetId(e.target.value)}
                className="input-field"
              >
                <option value="">— Use inline fields below —</option>
                {featurePresets.script.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="QA preset">
              <select
                value={qaPresetId}
                onChange={(e) => setQaPresetId(e.target.value)}
                className="input-field"
              >
                <option value="">— Use inline fields below —</option>
                {featurePresets.qa.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Narration preset">
              <select
                value={narrationPresetId}
                onChange={(e) => setNarrationPresetId(e.target.value)}
                className="input-field"
              >
                <option value="">— Use inline fields below —</option>
                {featurePresets.narration.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Idea-gen preset">
              <select
                value={ideaPresetId}
                onChange={(e) => setIdeaPresetId(e.target.value)}
                className="input-field"
              >
                <option value="">— Use inline fields below —</option>
                {featurePresets.idea.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
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
            onChange={(e) =>
              setTargetSpokenWords(e.target.value === '' ? '' : Math.max(50, parseInt(e.target.value, 10) || 50))
            }
            className="input-field"
            style={{ maxWidth: 200 }}
          />
        </Field>

        <Field
          label="Script gate"
          hint="When on, you review each script before the AI script review runs. Saves token spend on dud ideas."
        >
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              checked={scriptGateEnabled}
              onChange={(e) => setScriptGateEnabled(e.target.checked)}
              style={{ accentColor: 'var(--accent-purple)' }}
            />
            <span>Pause for my approval after each script draft</span>
          </label>
        </Field>

        <Field
          label="Script style preset"
          hint="The producer-curated style that shapes the script's voice and structure. Picks from the same catalogue the standalone Script Generator uses (built-ins + workspace-saved styles). Leave blank to inherit the Visual style preset below."
        >
          <select
            value={scriptStylePresetId}
            onChange={(e) => setScriptStylePresetId(e.target.value)}
            className="input-field"
          >
            <option value="">— Inherit from Visual style (or none) —</option>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.origin === 'built-in' ? ' (built-in)' : ''}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Tone"
            hint="One or two words describing the voice — e.g. 'urgent and direct', 'witty', 'authoritative'."
          >
            <input
              type="text"
              value={scriptTone}
              onChange={(e) => setScriptTone(e.target.value)}
              maxLength={200}
              placeholder="e.g. urgent and direct"
              className="input-field"
            />
          </Field>
          <Field
            label="Style note"
            hint="Free-text style guidance distinct from the style preset above — sentence rhythm, formatting habits, etc."
          >
            <input
              type="text"
              value={scriptStyleNote}
              onChange={(e) => setScriptStyleNote(e.target.value)}
              maxLength={400}
              placeholder="e.g. short sentences, no rhetorical questions"
              className="input-field"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field
            label="Target audience"
            hint="Who is this video for? One line describing the viewer."
          >
            <input
              type="text"
              value={scriptAudience}
              onChange={(e) => setScriptAudience(e.target.value)}
              maxLength={400}
              placeholder="e.g. small-business IT decision makers"
              className="input-field"
            />
          </Field>
          <Field
            label="Target duration (minutes)"
            hint="Optional. Overrides the preset's target-spoken-words derivation for length sizing."
          >
            <input
              type="number"
              min={1}
              max={120}
              value={scriptTargetMinutes}
              onChange={(e) =>
                setScriptTargetMinutes(
                  e.target.value === '' ? '' : Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 1)),
                )
              }
              className="input-field"
              style={{ maxWidth: 160 }}
            />
          </Field>
        </div>

        <Field
          label="Custom script instructions"
          hint="Free-form text that goes into the script prompt as the 'additional context' block. Paste examples, taglines, must-include points, things to avoid, etc. Per-video and per-regenerate overrides on the run detail page take precedence over this."
        >
          <textarea
            value={scriptAdditionalContext}
            onChange={(e) => setScriptAdditionalContext(e.target.value)}
            rows={5}
            placeholder={`e.g.\n- always open with a 1-sentence cold hook\n- mention our internal tool by name once near the middle\n- avoid the words 'unlock' and 'leverage'`}
            className="input-field"
          />
        </Field>

        <Field
          label="Reference context / videos"
          hint="Free text. Paste transcripts, URLs, or notes the script writer should treat as reference material."
        >
          <textarea
            value={scriptReferenceContext}
            onChange={(e) => setScriptReferenceContext(e.target.value)}
            rows={3}
            className="input-field"
          />
        </Field>

        {Object.keys(scriptRulesOther).length > 0 && (
          <Field
            label="Other script_rules fields (preserved)"
            hint="This preset carries extra script-rule keys (e.g. constraints) that the form doesn't surface yet. They'll be saved unchanged. Edit them via the API or contact a developer to surface them here."
          >
            <pre
              className="input-field"
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                background: 'var(--bg-secondary)',
                color: 'var(--text-muted)',
                maxHeight: 160,
                overflow: 'auto',
              }}
            >
              {JSON.stringify(scriptRulesOther, null, 2)}
            </pre>
          </Field>
        )}

        <SectionHeader title="AI script review (QA)" />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Minimum passing score">
            <input
              type="number"
              min={0}
              max={100}
              value={qaMinScore}
              onChange={(e) => setQaMinScore(Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)))}
              className="input-field"
            />
          </Field>
          <Field label="Max retry iterations">
            <input
              type="number"
              min={0}
              max={10}
              value={qaMaxIterations}
              onChange={(e) =>
                setQaMaxIterations(Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)))
              }
              className="input-field"
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
            className="input-field"
            style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 12 }}
          />
        </Field>

        <SectionHeader title="Narration handoff" />

        <Field label="Deadline (days)">
          <input
            type="number"
            min={1}
            max={90}
            value={narrationDeadlineDays}
            onChange={(e) =>
              setNarrationDeadlineDays(Math.max(1, Math.min(90, parseInt(e.target.value, 10) || 1)))
            }
            className="input-field"
            style={{ maxWidth: 160 }}
          />
        </Field>

        <SectionHeader title="Post-production" />

        <Field
          label="Visual style preset"
          hint="Drives the production-doc shot prompts and (when set) thumbnail composition. Doubles as the script-stage style when 'Script style preset' above is blank."
        >
          <select
            value={productionDocStyleId}
            onChange={(e) => setProductionDocStyleId(e.target.value)}
            className="input-field"
          >
            <option value="">— No visual style preset —</option>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.origin === 'built-in' ? ' (built-in)' : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Thumbnail template">
          <select
            value={thumbnailTemplateId}
            onChange={(e) => setThumbnailTemplateId(e.target.value)}
            className="input-field"
          >
            <option value="">— Use defaults —</option>
            {thumbnailTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
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
            className="input-field"
          >
            <option value="">— Skip SEO step —</option>
            {seoTemplates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.is_default ? ' (default)' : ''}
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
            className="input-field"
          >
            <option value="">— No auto-assign (terminate at done) —</option>
            {editors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.email ? ` (${c.email})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
          className="w-full text-left flex items-center gap-2 pt-2 pb-1 text-xs uppercase tracking-widest font-bold transition-colors rounded hover:opacity-80"
          style={{ color: 'var(--accent-purple-bright)' }}
        >
          <span>{advancedOpen ? '▾' : '▸'}</span>
          <span>Advanced — model fallback chains</span>
        </button>

        {advancedOpen && (
          <div
            className="space-y-4 pl-3"
            style={{ borderLeft: '2px solid var(--border-bright)' }}
          >
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Each pipeline stage tries models in order on transient failure (rate-limit / 5xx / timeout /
              empty output). Refusals and unknown errors short-circuit — they never fall through. Leave empty
              to use the built-in defaults shown as placeholders.
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
        <button onClick={onClose} disabled={saving} className="btn-secondary text-sm">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving || !name.trim()}
          className="btn-primary text-sm"
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
        <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{label}</span>
        <button
          onClick={addEntry}
          className="text-xs hover:underline"
          style={{ color: 'var(--accent-purple-bright)' }}
          type="button"
        >
          + Add model
        </button>
      </div>
      {currentChain.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Using default: <code style={{ fontFamily: 'var(--font-mono), monospace' }}>{placeholder}</code>
        </div>
      ) : (
        <ul className="space-y-1">
          {currentChain.map((id, idx) => (
            <li key={idx} className="flex gap-2 items-center">
              <span
                className="w-6 text-xs font-mono shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                #{idx + 1}
              </span>
              <select
                value={id}
                onChange={(e) => setAt(idx, e.target.value)}
                className="input-field flex-1"
                style={{ padding: '6px 10px', fontSize: 12 }}
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.provider})
                  </option>
                ))}
              </select>
              <button
                onClick={() => removeAt(idx)}
                className="text-xs hover:underline"
                style={{ color: '#f87171' }}
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

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      className="pt-2 pb-1 text-xs uppercase tracking-widest font-bold"
      style={{ color: 'var(--accent-purple-bright)' }}
    >
      {title}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
