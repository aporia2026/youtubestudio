'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface PresetRow {
  id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  script_gate_enabled: boolean;
  qa_min_score: string;
  qa_max_iterations: number;
  narration_deadline_days: number;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
}

interface IdeaRow {
  id: string;
  title: string;
  niche: string;
  hook: string | null;
  is_used: boolean;
}

type Mode = 'fresh' | 'existing';

export default function NewPipelinePage() {
  const router = useRouter();
  const [presets, setPresets] = useState<PresetRow[]>([]);
  const [ideas, setIdeas] = useState<IdeaRow[]>([]);
  const [presetId, setPresetId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('fresh');
  const [count, setCount] = useState<number>(5);
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preset quick-create form (inline, only shown when no presets exist).
  const [presetName, setPresetName] = useState('');
  const [presetNiche, setPresetNiche] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [presetsRes, ideasRes] = await Promise.all([
          fetch('/api/auto-pipeline/presets', { cache: 'no-store' }),
          fetch('/api/ideas?saved=true&limit=100', { cache: 'no-store' }).catch(() => null),
        ]);
        if (presetsRes.ok) {
          const data = await presetsRes.json();
          setPresets((data.presets as PresetRow[]) ?? []);
          if (data.presets?.[0]) setPresetId(data.presets[0].id);
        }
        if (ideasRes && ideasRes.ok) {
          const data = await ideasRes.json();
          const rows = (data.ideas as IdeaRow[]) ?? [];
          setIdeas(rows.filter((i) => !i.is_used));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selectedPreset = presets.find((p) => p.id === presetId);

  useEffect(() => {
    if (selectedPreset && selectedPreset.ideas_count_default) {
      setCount(selectedPreset.ideas_count_default);
    }
  }, [selectedPreset]);

  function toggleIdea(id: string) {
    setSelectedIdeaIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    setError(null);
    if (!presetId) {
      setError('Pick a preset first.');
      return;
    }
    if (mode === 'fresh' && (count < 1 || count > 50)) {
      setError('Count must be between 1 and 50.');
      return;
    }
    if (mode === 'existing' && selectedIdeaIds.length === 0) {
      setError('Pick at least one idea.');
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { presetId };
      if (mode === 'fresh') body.countToGenerate = count;
      else body.existingIdeaIds = selectedIdeaIds;

      const res = await fetch('/api/auto-pipeline/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const { runId } = await res.json();
      router.push(`/pipeline/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start batch');
      setSubmitting(false);
    }
  }

  async function createQuickPreset() {
    setError(null);
    if (!presetName.trim()) {
      setError('Preset name is required.');
      return;
    }
    try {
      const res = await fetch('/api/auto-pipeline/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: presetName.trim(),
          niche: presetNiche.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const { id } = await res.json();
      const listRes = await fetch('/api/auto-pipeline/presets', { cache: 'no-store' });
      if (listRes.ok) {
        const data = await listRes.json();
        setPresets((data.presets as PresetRow[]) ?? []);
        setPresetId(id);
      }
      setPresetName('');
      setPresetNiche('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create preset');
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <div className="mb-6">
        <Link
          href="/pipeline"
          className="text-sm hover:underline"
          style={{ color: 'var(--text-muted)' }}
        >
          ← All batches
        </Link>
        <h1 className="text-2xl font-bold gradient-text mt-2">Start a batch</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Need to tune a preset?{' '}
          <Link href="/pipeline/presets" className="underline">
            Manage presets
          </Link>{' '}
          ·{' '}
          <Link href="/pipeline/thumbnail-templates" className="underline">
            Thumbnail templates
          </Link>
        </p>
      </div>

      {error && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{ background: 'rgba(239,68,68,0.10)', color: '#f87171' }}
        >
          {error}
        </div>
      )}

      {presets.length === 0 ? (
        <div className="glass rounded-xl p-6">
          <h2 className="text-sm font-semibold mb-2">Create your first preset</h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            Presets bundle the rules and contexts every video in a batch uses — niche, script tone, QA score
            threshold, model choices, narrator deadline. You can refine them later from the same screen.
          </p>
          <div className="space-y-3">
            <Field label="Preset name">
              <input
                type="text"
                placeholder="e.g. 'Productivity 8-min explainers'"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                className="input-field"
              />
            </Field>
            <Field label="Niche (optional)">
              <input
                type="text"
                placeholder="e.g. productivity"
                value={presetNiche}
                onChange={(e) => setPresetNiche(e.target.value)}
                className="input-field"
              />
            </Field>
            <button onClick={createQuickPreset} className="btn-primary text-sm">
              Create preset
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <Section title="Preset">
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="input-field"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.niche ? `— ${p.niche}` : ''}
                </option>
              ))}
            </select>
            {selectedPreset && (
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                Script gate: {selectedPreset.script_gate_enabled ? 'on (you approve each script)' : 'off (fully unattended)'} ·
                QA threshold: {selectedPreset.qa_min_score}/100 ·
                Max retries: {selectedPreset.qa_max_iterations} ·
                Narration deadline: {selectedPreset.narration_deadline_days}d
              </p>
            )}
          </Section>

          <Section title="Mode">
            <div className="flex gap-3">
              <ModeCard
                active={mode === 'fresh'}
                onClick={() => setMode('fresh')}
                title="Generate fresh ideas"
                subtitle="Brainstorm N new ideas, you drag-rank them once, the pipeline runs."
              />
              <ModeCard
                active={mode === 'existing'}
                onClick={() => setMode('existing')}
                title="Use existing idea(s)"
                subtitle="Pick from your saved ideas. Skip idea-gen, go straight to script."
              />
            </div>
          </Section>

          {mode === 'fresh' ? (
            <Section title="How many ideas?">
              <input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)))}
                className="input-field"
                style={{ maxWidth: 140 }}
              />
              <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                {count} video{count !== 1 ? 's' : ''} will be created. After the ideas are generated,
                drag-rank them to set priority — the pipeline runs in that order.
              </p>
            </Section>
          ) : (
            <Section title="Pick ideas">
              {ideas.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  No saved ideas in this workspace yet. Switch to fresh mode or save some ideas first from
                  the Ideas page.
                </p>
              ) : (
                <>
                  <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                    Selected order = priority. {selectedIdeaIds.length} selected.
                  </p>
                  <div
                    className="rounded-lg overflow-hidden"
                    style={{ border: '1px solid var(--border)', maxHeight: 384, overflowY: 'auto' }}
                  >
                    <ul>
                      {ideas.map((idea, idx) => {
                        const selected = selectedIdeaIds.includes(idea.id);
                        const position = selected ? selectedIdeaIds.indexOf(idea.id) + 1 : null;
                        return (
                          <li
                            key={idea.id}
                            onClick={() => toggleIdea(idea.id)}
                            className="px-3 py-2 cursor-pointer text-sm flex items-start gap-3 transition-colors"
                            style={{
                              background: selected ? 'rgba(124,58,237,0.10)' : 'transparent',
                              borderTop: idx === 0 ? 'none' : '1px solid var(--border)',
                            }}
                          >
                            <div
                              className="w-6 shrink-0 text-xs font-mono pt-0.5"
                              style={{ color: selected ? 'var(--accent-purple-bright)' : 'var(--text-muted)' }}
                            >
                              {position ? `#${position}` : '·'}
                            </div>
                            <div className="flex-1">
                              <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {idea.title}
                              </div>
                              {idea.hook && (
                                <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                                  {idea.hook}
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </>
              )}
            </Section>
          )}

          <div className="flex justify-end">
            <button
              onClick={submit}
              disabled={submitting}
              className="btn-primary text-sm"
            >
              {submitting ? 'Starting…' : 'Start batch'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  subtitle,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 px-4 py-3 rounded-lg text-left text-sm transition-all"
      style={{
        background: active ? 'rgba(124,58,237,0.10)' : 'var(--bg-card)',
        border: `1px solid ${active ? 'var(--accent-purple-bright)' : 'var(--border)'}`,
        boxShadow: active ? '0 0 0 3px rgba(124,58,237,0.15)' : 'none',
      }}
    >
      <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
      {hint && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </p>
      )}
    </div>
  );
}
