'use client';

/**
 * Step 1 — generate hook-first ideas via /api/shorts/ideas, then let
 * the user multi-select the ones they want in this batch.
 *
 * UX choices:
 *   - Niche is either picked from the workspace's saved niches OR
 *     typed manually. Saved niches auto-load their description +
 *     keywords on the server via the `nicheRowId` body param, so
 *     the LLM has richer context.
 *   - "Avoid topics I've already uploaded" toggle pulls titles from
 *     shorts in the workspace with `youtube_video_id IS NOT NULL`
 *     and passes them as `avoidTitles` so the LLM doesn't suggest
 *     duplicates of already-published shorts.
 *   - Visual language matches the rest of the app: dark surface,
 *     violet primary CTA, subtle white-on-dark elevation.
 */

import { useEffect, useState } from 'react';
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

interface SavedNiche {
  id: string;
  name: string;
  description: string | null;
  keywords: string[] | null;
}

interface ShortListItem {
  id: string;
  title: string | null;
  youtube_video_id: string | null;
}

interface Props {
  selectedIdeas: BatchIdeaInput[];
  onChange: (ideas: BatchIdeaInput[]) => void;
  onContinue: () => void;
}

const SENTINEL_MANUAL = '__manual__';

export function Step1IdeaPicker({ selectedIdeas, onChange, onContinue }: Props) {
  const [savedNiches, setSavedNiches] = useState<SavedNiche[]>([]);
  const [nicheChoice, setNicheChoice] = useState<string>(SENTINEL_MANUAL);
  const [manualNiche, setManualNiche] = useState('');
  const [count, setCount] = useState(8);
  const [tone, setTone] = useState('');
  const [excludeUploaded, setExcludeUploaded] = useState(true);
  const [uploadedTitleCount, setUploadedTitleCount] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ideas, setIdeas] = useState<RawIdea[]>([]);

  // Load saved niches on mount. Failures degrade silently — user
  // can still type manually.
  useEffect(() => {
    fetch('/api/niches')
      .then((r) => (r.ok ? r.json() : { niches: [] }))
      .then((data: { niches?: SavedNiche[] }) => {
        setSavedNiches(data.niches ?? []);
      })
      .catch(() => {
        /* noop — manual entry still works */
      });
  }, []);

  // Pre-count uploaded shorts so the toggle label can show "Exclude 12
  // already-uploaded shorts" instead of just "Exclude uploaded shorts".
  useEffect(() => {
    if (!excludeUploaded) return;
    fetch('/api/shorts?limit=200')
      .then((r) => (r.ok ? r.json() : { shorts: [] }))
      .then((data: { shorts?: ShortListItem[] }) => {
        const uploaded = (data.shorts ?? []).filter((s) => s.youtube_video_id);
        setUploadedTitleCount(uploaded.length);
      })
      .catch(() => setUploadedTitleCount(null));
  }, [excludeUploaded]);

  const activeNiche: SavedNiche | null =
    nicheChoice === SENTINEL_MANUAL ? null : savedNiches.find((n) => n.id === nicheChoice) ?? null;

  const effectiveNicheName = activeNiche ? activeNiche.name : manualNiche.trim();

  const generate = async () => {
    if (!effectiveNicheName) {
      toast.error('Pick a saved niche or type one manually.');
      return;
    }
    setGenerating(true);
    try {
      // Pull avoidTitles from already-uploaded shorts if the toggle
      // is on. Only fetch when needed; cap to a sensible number so
      // the prompt doesn't bloat.
      let avoidTitles: string[] = [];
      if (excludeUploaded) {
        try {
          const res = await fetch('/api/shorts?limit=200');
          if (res.ok) {
            const data = (await res.json()) as { shorts?: ShortListItem[] };
            avoidTitles = (data.shorts ?? [])
              .filter((s) => s.youtube_video_id && s.title)
              .map((s) => s.title!)
              .slice(0, 60);
          }
        } catch {
          /* best-effort; if the fetch fails the user still gets ideas */
        }
      }

      const res = await fetch('/api/shorts/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche: effectiveNicheName,
          nicheRowId: activeNiche?.id,
          count,
          formatHints: tone ? { tone } : undefined,
          avoidTitles: avoidTitles.length > 0 ? avoidTitles : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { ideas: RawIdea[] };
      setIdeas(data.ideas ?? []);
      onChange(
        (data.ideas ?? []).map((idea) => rawToInput(idea, effectiveNicheName, tone)),
      );
      console.info('[shorts-batch ui step1] ideas-generated', {
        count: data.ideas?.length ?? 0,
        niche_source: activeNiche ? 'saved' : 'manual',
        avoid_count: avoidTitles.length,
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
      onChange([...selectedIdeas, rawToInput(idea, effectiveNicheName, tone)]);
    }
  };

  return (
    <section className="space-y-6">
      <Panel title="1. Generate ideas">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <FieldLabel>Niche / topic</FieldLabel>
            {savedNiches.length > 0 ? (
              <select
                value={nicheChoice}
                onChange={(e) => setNicheChoice(e.target.value)}
                className={selectClass}
              >
                <option value={SENTINEL_MANUAL}>Type manually…</option>
                <optgroup label="Saved niches">
                  {savedNiches.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            ) : null}
            {nicheChoice === SENTINEL_MANUAL ? (
              <input
                type="text"
                value={manualNiche}
                onChange={(e) => setManualNiche(e.target.value)}
                placeholder="e.g. compound interest for beginners"
                className={`${inputClass} ${savedNiches.length > 0 ? 'mt-2' : ''}`}
              />
            ) : activeNiche ? (
              <NichePreview niche={activeNiche} />
            ) : null}
          </div>

          <div>
            <FieldLabel>How many ideas</FieldLabel>
            <input
              type="number"
              min={3}
              max={15}
              value={count}
              onChange={(e) => setCount(Math.max(3, Math.min(15, Number(e.target.value) || 0)))}
              className={inputClass}
            />
          </div>

          <div>
            <FieldLabel>Tone (optional)</FieldLabel>
            <input
              type="text"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder="e.g. punchy, contrarian"
              className={inputClass}
            />
          </div>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={excludeUploaded}
            onChange={(e) => setExcludeUploaded(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent-purple)]"
          />
          <span>
            Avoid topics from shorts I&apos;ve already uploaded
            {excludeUploaded && uploadedTitleCount !== null && (
              <span className="ml-1 text-xs text-[var(--text-muted)]">
                ({uploadedTitleCount} found)
              </span>
            )}
          </span>
        </label>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-[var(--text-muted)]">
            One AI call. Costs a few cents. You can regenerate.
          </p>
          <PrimaryButton
            onClick={generate}
            disabled={generating || !effectiveNicheName}
          >
            {generating ? 'Generating…' : ideas.length > 0 ? 'Regenerate' : 'Generate ideas'}
          </PrimaryButton>
        </div>
      </Panel>

      {ideas.length > 0 && (
        <Panel
          title="2. Pick the ones to make"
          subtitle={`${selectedIdeas.length} of ${ideas.length} selected`}
        >
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
                      ? 'border-[var(--accent-purple-bright)] bg-[var(--accent-purple)]/15'
                      : 'border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--border-bright)] hover:bg-[var(--bg-card-hover)]',
                  ].join(' ')}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={selected}
                      readOnly
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent-purple)]"
                    />
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{idea.title}</h3>
                      <p className="mt-1 text-xs italic text-[var(--text-secondary)]">&ldquo;{idea.hook}&rdquo;</p>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">→ {idea.payoff}</p>
                      {idea.thesis && (
                        <p className="mt-2 text-xs text-[var(--text-muted)]">{idea.thesis}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>
      )}

      <div className="flex items-center justify-end gap-3">
        <PrimaryButton onClick={onContinue} disabled={selectedIdeas.length === 0}>
          Continue with {selectedIdeas.length} selected →
        </PrimaryButton>
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

function NichePreview({ niche }: { niche: SavedNiche }) {
  return (
    <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3 text-xs text-[var(--text-primary)]">
      {niche.description && <p>{niche.description}</p>}
      {niche.keywords && niche.keywords.length > 0 && (
        <p className="mt-1.5 text-[var(--text-muted)]">
          Keywords: {niche.keywords.slice(0, 8).join(', ')}
          {niche.keywords.length > 8 ? '…' : ''}
        </p>
      )}
    </div>
  );
}

// ─── Shared visual tokens (matches the rest of the app) ──────────────

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">{title}</h2>
        {subtitle && <span className="text-sm text-[var(--text-secondary)]">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">{children}</span>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-purple-bright)] disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[var(--text-muted)]"
    >
      {children}
    </button>
  );
}

const inputClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-purple)] focus:outline-none';
const selectClass = inputClass;
