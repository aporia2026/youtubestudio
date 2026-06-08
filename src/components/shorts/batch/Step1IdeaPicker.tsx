'use client';

/**
 * Step 1 — generate hook-first ideas via /api/shorts/ideas, then let
 * the user multi-select the ones they want in this batch.
 *
 * UX: the form is minimal (niche + count). After "Generate", each
 * idea appears as a checkbox-augmented card. Selected ones are
 * highlighted. "Continue" advances to step 2 with the selected set.
 *
 * Manual idea entry deliberately out of MVP scope — generated ideas
 * cover the typical "give me 10 shorts on X" flow with one click.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import type { BatchIdeaInput } from '@/lib/shorts-batches';

interface RawIdea {
  hook: string;
  title: string;
  payoff: string;
  thesis?: string;
  shotConcept?: string;
  confidence?: number;
}

interface Props {
  selectedIdeas: BatchIdeaInput[];
  onChange: (ideas: BatchIdeaInput[]) => void;
  onContinue: () => void;
}

export function Step1IdeaPicker({ selectedIdeas, onChange, onContinue }: Props) {
  const [niche, setNiche] = useState('');
  const [count, setCount] = useState(8);
  const [tone, setTone] = useState('');
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState<RawIdea[]>([]);

  const generate = async () => {
    if (!niche.trim()) {
      toast.error('Niche is required');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch('/api/shorts/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: niche.trim(),
          count,
          formatHints: tone ? { tone } : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { ideas: RawIdea[] };
      setIdeas(data.ideas ?? []);
      // Pre-select all generated ideas as a lazy-user-friendly default
      // (rule 10) — they generated them, they probably want them all
      // until they say otherwise.
      onChange(
        (data.ideas ?? []).map((idea) => rawToInput(idea, niche.trim(), tone)),
      );
      console.info('[shorts-batch ui step1] ideas-generated', {
        count: data.ideas?.length ?? 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate ideas';
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const isSelected = (idea: RawIdea) =>
    selectedIdeas.some((s) => s.hook === idea.hook && s.payoff === idea.payoff);

  const toggle = (idea: RawIdea) => {
    if (isSelected(idea)) {
      onChange(
        selectedIdeas.filter((s) => !(s.hook === idea.hook && s.payoff === idea.payoff)),
      );
    } else {
      onChange([...selectedIdeas, rawToInput(idea, niche.trim(), tone)]);
    }
  };

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="mb-4 text-lg font-medium text-zinc-900 dark:text-zinc-100">
          1. Generate ideas
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Niche / topic
            </span>
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="e.g. compound interest for beginners"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              How many ideas
            </span>
            <input
              type="number"
              min={3}
              max={15}
              value={count}
              onChange={(e) => setCount(Math.max(3, Math.min(15, Number(e.target.value) || 0)))}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Tone (optional)
            </span>
            <input
              type="text"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder="e.g. punchy, contrarian"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-900 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            One AI call. Costs a few cents. You can regenerate.
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={generating || !niche.trim()}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-400 hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {generating ? 'Generating…' : ideas.length > 0 ? 'Regenerate' : 'Generate ideas'}
          </button>
        </div>
      </div>

      {ideas.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-medium text-zinc-900 dark:text-zinc-100">
              2. Pick the ones to make
            </h2>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              {selectedIdeas.length} of {ideas.length} selected
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {ideas.map((idea) => {
              const selected = isSelected(idea);
              return (
                <button
                  key={`${idea.hook}|${idea.payoff}`}
                  type="button"
                  onClick={() => toggle(idea)}
                  className={[
                    'flex flex-col gap-2 rounded-md border p-4 text-left transition-colors',
                    selected
                      ? 'border-zinc-900 bg-zinc-100 dark:border-white dark:bg-zinc-700'
                      : 'border-zinc-300 bg-white hover:border-zinc-500 dark:border-zinc-600 dark:bg-zinc-900',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={selected}
                      readOnly
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-zinc-900 dark:accent-white"
                    />
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {idea.title}
                      </h3>
                      <p className="mt-1 text-xs italic text-zinc-700 dark:text-zinc-300">
                        “{idea.hook}”
                      </p>
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                        → {idea.payoff}
                      </p>
                      {idea.thesis && (
                        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
                          {idea.thesis}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onContinue}
          disabled={selectedIdeas.length === 0}
          className="rounded-md bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-400 hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Continue with {selectedIdeas.length} selected →
        </button>
      </div>
    </section>
  );
}

function rawToInput(raw: RawIdea, niche: string, tone: string): BatchIdeaInput {
  return {
    ideaTitle: raw.title,
    hook: raw.hook,
    payoff: raw.payoff,
    thesis: raw.thesis,
    shotConcept: raw.shotConcept,
    niche,
    tone: tone || undefined,
  };
}
