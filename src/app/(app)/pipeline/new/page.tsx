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
      // Refresh presets list + auto-select the new one.
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
    return <div className="p-6 text-sm text-zinc-500">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <header className="mb-6">
        <Link href="/pipeline" className="text-sm text-zinc-500 hover:underline">
          ← All batches
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Start a batch</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Need to tune a preset?{' '}
          <Link href="/pipeline/presets" className="underline">
            Manage presets
          </Link>{' '}
          ·{' '}
          <Link href="/pipeline/thumbnail-templates" className="underline">
            Thumbnail templates
          </Link>
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {presets.length === 0 ? (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 mb-6">
          <h2 className="font-medium mb-2">Create your first preset</h2>
          <p className="text-sm text-zinc-500 mb-3">
            Presets bundle the rules and contexts every video in a batch uses — niche, script tone, QA score
            threshold, model choices, narrator deadline. You can refine them later from the same screen.
          </p>
          <div className="space-y-2">
            <input
              type="text"
              placeholder="Preset name (e.g. 'Productivity 8-min explainers')"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
            <input
              type="text"
              placeholder="Niche (optional)"
              value={presetNiche}
              onChange={(e) => setPresetNiche(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            />
            <button
              onClick={createQuickPreset}
              className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-md text-sm font-medium"
            >
              Create preset
            </button>
          </div>
        </div>
      ) : (
        <>
          <Section title="Preset">
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.niche ? `— ${p.niche}` : ''}
                </option>
              ))}
            </select>
            {selectedPreset && (
              <p className="text-xs text-zinc-500 mt-2">
                Script gate: {selectedPreset.script_gate_enabled ? 'on (you approve each script)' : 'off (fully unattended)'} ·
                QA threshold: {selectedPreset.qa_min_score}/100 ·
                Max retries: {selectedPreset.qa_max_iterations} ·
                Narration deadline: {selectedPreset.narration_deadline_days}d
              </p>
            )}
          </Section>

          <Section title="Mode">
            <div className="flex gap-2">
              <button
                onClick={() => setMode('fresh')}
                className={`flex-1 px-3 py-3 rounded-md border text-left text-sm ${
                  mode === 'fresh'
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-900'
                    : 'border-zinc-300 dark:border-zinc-700'
                }`}
              >
                <div className="font-medium">Generate fresh ideas</div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  Brainstorm N new ideas, you drag-rank them once, the pipeline runs.
                </div>
              </button>
              <button
                onClick={() => setMode('existing')}
                className={`flex-1 px-3 py-3 rounded-md border text-left text-sm ${
                  mode === 'existing'
                    ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-50 dark:bg-zinc-900'
                    : 'border-zinc-300 dark:border-zinc-700'
                }`}
              >
                <div className="font-medium">Use existing idea(s)</div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  Pick from your saved ideas. Skip idea-gen, go straight to script.
                </div>
              </button>
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
                className="w-32 px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent"
              />
              <p className="text-xs text-zinc-500 mt-2">
                {count} video{count !== 1 ? 's' : ''} will be created. After the ideas are generated, drag-rank them to set
                priority — the pipeline runs in that order.
              </p>
            </Section>
          ) : (
            <Section title="Pick ideas">
              {ideas.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No saved ideas in this workspace yet. Switch to fresh mode or save some ideas first from the
                  Ideas page.
                </p>
              ) : (
                <>
                  <p className="text-xs text-zinc-500 mb-2">
                    Selected order = priority. {selectedIdeaIds.length} selected.
                  </p>
                  <ul className="max-h-96 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-md divide-y divide-zinc-100 dark:divide-zinc-900">
                    {ideas.map((idea) => {
                      const selected = selectedIdeaIds.includes(idea.id);
                      const position = selected ? selectedIdeaIds.indexOf(idea.id) + 1 : null;
                      return (
                        <li
                          key={idea.id}
                          className={`px-3 py-2 cursor-pointer text-sm flex items-start gap-3 ${
                            selected ? 'bg-zinc-50 dark:bg-zinc-900' : ''
                          }`}
                          onClick={() => toggleIdea(idea.id)}
                        >
                          <div className="w-6 shrink-0 text-zinc-500 text-xs font-mono pt-0.5">
                            {position ? `#${position}` : '·'}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium">{idea.title}</div>
                            {idea.hook && (
                              <div className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{idea.hook}</div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </Section>
          )}

          <div className="mt-6 flex justify-end">
            <button
              onClick={submit}
              disabled={submitting}
              className="bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-5 py-2 rounded-md text-sm font-medium disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start batch'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">{title}</h2>
      {children}
    </section>
  );
}
