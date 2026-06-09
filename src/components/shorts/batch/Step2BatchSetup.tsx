'use client';

/**
 * Step 2 — batch setup form. INTENTIONALLY MINIMAL.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * What goes here: the things the SEO optimizer CAN'T pick for the
 * user — channel (uploads need a target), voice (every short needs
 * one), and the COPPA "made for kids" declaration (legally required).
 *
 * What does NOT go here: title, description, tags, language,
 * playlists, category. The SEO optimizer writes those per-short
 * based on the actual content; the user verifies + edits in the
 * step-4 review queue. Asking up-front before the shorts even
 * exist would be premature and content-blind.
 *
 * What's in "Advanced": optional defaults the user MIGHT want to
 * pre-set — schedule cadence, timezone, default category, default
 * privacy, the rarely-needed age-restricted / paid-promotion flags,
 * AI-content disclosure. Collapsed by default to keep the page
 * focused on the three required choices.
 */

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { YOUTUBE_CATEGORIES, DEFAULT_YOUTUBE_CATEGORY_ID } from '@/lib/youtube-categories';
import { TimezoneSelect } from './TimezoneSelect';
import { VoicePicker } from './VoicePicker';
import type { BatchIdeaInput } from '@/lib/shorts-batches';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';
import { BASE_T2I_MODELS, DEFAULT_BASE_T2I_MODEL_ID } from '@/lib/shorts-base-t2i-types';

interface ChannelOption {
  id: string;
  title: string | null;
  oauth_connected: boolean;
}

interface Props {
  channels: ChannelOption[];
  channelId: string;
  onChannelChange: (next: string) => void;
  defaults: ShortsBatchDefaults;
  onChange: (next: ShortsBatchDefaults) => void;
  selectedCount: number;
  ideaInputs: readonly BatchIdeaInput[];
  onBack: () => void;
  onCreated: (batchId: string) => void;
}

const SCHEDULE_CADENCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'manual', label: 'Manual (set per-short in step 5)' },
  { value: 'every_30_min', label: 'Every 30 minutes' },
  { value: 'every_hour', label: 'Every hour' },
  { value: 'every_3_hours', label: 'Every 3 hours' },
  { value: 'every_6_hours', label: 'Every 6 hours' },
  { value: 'daily_morning', label: 'One per day, 09:00 (batch timezone)' },
  { value: 'daily_evening', label: 'One per day, 18:00 (batch timezone)' },
];

export function Step2BatchSetup({
  channels,
  channelId,
  onChannelChange,
  defaults,
  onChange,
  selectedCount,
  ideaInputs,
  onBack,
  onCreated,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const activeChannel = channels.find((c) => c.id === channelId);

  const patch = (p: Partial<ShortsBatchDefaults>) => onChange({ ...defaults, ...p });

  // Stale-closure-safe refs so the mount-only seed effect below can
  // read the LATEST defaults + onChange when the GET resolves. Without
  // these, a slow network would cause the seed (which spreads
  // `...defaults`) to revert any field the user edited mid-flight —
  // voiceId, madeForKids, language, anything. (Bug B2 from the
  // post-session QA review.)
  const defaultsRef = useRef(defaults);
  const onChangeRef = useRef(onChange);
  useEffect(() => { defaultsRef.current = defaults; }, [defaults]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Load the user's per-account image-model default on mount and seed
  // `defaults.baseT2iModelId` if the batch doesn't have an explicit
  // pick yet. Keeps the batch's recorded choice concrete (no implicit
  // "use my account default" semantics for the orchestrator to handle
  // later) while still respecting the per-user preference up front.
  useEffect(() => {
    if (defaultsRef.current.baseT2iModelId) return; // user already picked
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, seeds image-model picker default
        const res = await fetch('/api/user/settings/shorts-base-t2i-model');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        // Re-check at fire time — the user may have picked a model
        // while the fetch was in flight.
        if (defaultsRef.current.baseT2iModelId) return;
        const id = typeof data.shorts_base_t2i_model_id === 'string'
          ? data.shorts_base_t2i_model_id
          : DEFAULT_BASE_T2I_MODEL_ID;
        // Patch ONLY the single field via the latest defaults snapshot
        // so other edits the user made mid-flight aren't reverted.
        onChangeRef.current({ ...defaultsRef.current, baseT2iModelId: id });
      } catch {
        // Network error — fall through; the picker still works,
        // it'll show DEFAULT_BASE_T2I_MODEL_ID as the visible default.
      }
    })();
    return () => { cancelled = true; };
    // Mount-only by design; the refs above keep us reading fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (!activeChannel) {
      toast.error('Pick a YouTube channel.');
      return;
    }
    if (!defaults.voiceId) {
      toast.error('Pick a voice — every short uses it.');
      return;
    }
    if (defaults.madeForKids === undefined) {
      toast.error('Made-for-kids must be answered (YouTube/COPPA requirement).');
      return;
    }

    setSubmitting(true);
    try {
      const createRes = await fetch('/api/shorts/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId,
          // Per QA finding M3: spread the user's defaults FIRST so the
          // explicit ??-fallbacks below have the final word. Previously
          // `...defaults` was at the end and re-applied `undefined`
          // values that JSON.stringify drops — the net result happened
          // to be correct by accident, but it was fragile (a future
          // tweak that stops dropping undefined would corrupt it).
          defaults: {
            ...defaults,
            language: defaults.language ?? 'en',
            categoryId: defaults.categoryId ?? DEFAULT_YOUTUBE_CATEGORY_ID,
            defaultPrivacy: defaults.defaultPrivacy ?? 'public',
            aiContentDisclosure: defaults.aiContentDisclosure ?? true,
            ageRestricted: defaults.ageRestricted ?? false,
            paidPromotion: defaults.paidPromotion ?? false,
            scheduleCadence: defaults.scheduleCadence ?? 'manual',
            timezone: defaults.timezone,
          },
          ideaInputs,
        }),
      });
      if (!createRes.ok) {
        const errBody = await createRes.json().catch(() => ({ error: `HTTP ${createRes.status}` }));
        throw new Error(errBody.error || `HTTP ${createRes.status}`);
      }
      const { batchId } = (await createRes.json()) as { batchId: string };

      const statusRes = await fetch(`/api/shorts/batches/${batchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'generating' }),
      });
      if (!statusRes.ok) {
        const errBody = await statusRes.json().catch(() => ({ error: `HTTP ${statusRes.status}` }));
        throw new Error(errBody.error || `HTTP ${statusRes.status}`);
      }

      console.info('[shorts-batch ui step2] created', { batch_id: batchId });
      onCreated(batchId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start batch';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-5">
        <h2 className="mb-2 text-lg font-medium text-[var(--text-primary)]">
          A few essentials, then we&apos;re off
        </h2>
        <p className="mb-6 text-sm text-[var(--text-secondary)]">
          The SEO optimizer writes title, description, tags, and category for
          every short — you&apos;ll review and edit them in step 4. Right here
          we just need the channel, the voice, and your COPPA declaration.
        </p>

        <div className="space-y-5">
          <div>
            <Label hint="Where uploads land at the end of the batch.">
              YouTube channel <Required />
            </Label>
            <select
              value={channelId}
              onChange={(e) => onChannelChange(e.target.value)}
              className={selectClass}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title ?? c.id}
                  {c.oauth_connected ? '' : ' — not connected'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label hint="Used for every voiceover in the batch.">
              Voice <Required />
            </Label>
            <VoicePicker
              value={defaults.voiceId ?? ''}
              onChange={(voiceId) => patch({ voiceId })}
              required
            />
          </div>

          <fieldset className="rounded-md border border-[var(--accent-yellow)]/40 bg-[var(--accent-yellow)]/10 p-3">
            <legend className="px-1 text-sm font-medium text-[var(--text-primary)]">
              Made for kids (COPPA) <Required />
            </legend>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              YouTube rejects uploads without this. You can change it per-short
              later if a particular video needs the other answer.
            </p>
            <div className="flex items-center gap-4 text-sm text-[var(--text-primary)]">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  checked={defaults.madeForKids === true}
                  onChange={() => patch({ madeForKids: true })}
                  className="h-4 w-4 accent-[var(--accent-purple)]"
                />
                Yes, made for kids
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  checked={defaults.madeForKids === false}
                  onChange={() => patch({ madeForKids: false })}
                  className="h-4 w-4 accent-[var(--accent-purple)]"
                />
                No, not for kids
              </label>
            </div>
          </fieldset>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="mt-6 text-xs text-[var(--text-secondary)] underline hover:text-[var(--text-primary)]"
        >
          {showAdvanced ? '▾ Hide advanced defaults' : '▸ Show advanced defaults (optional)'}
        </button>

        {showAdvanced && (
          <div className="mt-4 space-y-5 border-t border-[var(--border)] pt-4">
            <p className="text-xs text-[var(--text-muted)]">
              Anything you skip here gets a sensible default. You can still
              override per-short in step 4.
            </p>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <Label hint="Smart default: Education (27).">Default category</Label>
                <select
                  value={defaults.categoryId ?? DEFAULT_YOUTUBE_CATEGORY_ID}
                  onChange={(e) => patch({ categoryId: e.target.value })}
                  className={selectClass}
                >
                  {YOUTUBE_CATEGORIES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label hint="Smart default: Public. Scheduled videos go private then flip to this at publishAt.">
                  Default privacy
                </Label>
                <select
                  value={defaults.defaultPrivacy ?? 'public'}
                  onChange={(e) =>
                    patch({ defaultPrivacy: e.target.value as 'public' | 'private' | 'unlisted' })
                  }
                  className={selectClass}
                >
                  <option value="public">Public</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="private">Private</option>
                </select>
              </div>

              <div>
                <Label>Schedule cadence</Label>
                <select
                  value={defaults.scheduleCadence ?? 'manual'}
                  onChange={(e) =>
                    patch({
                      scheduleCadence: e.target.value as ShortsBatchDefaults['scheduleCadence'],
                    })
                  }
                  className={selectClass}
                >
                  {SCHEDULE_CADENCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label>Timezone</Label>
                <TimezoneSelect
                  value={defaults.timezone ?? 'UTC'}
                  onChange={(tz) => patch({ timezone: tz })}
                />
              </div>

              <div className="md:col-span-2">
                <Label hint="Same model for every short in this batch. Per-short override available in step 3 if a model misbehaves.">
                  Image model (base frame)
                </Label>
                <select
                  value={defaults.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID}
                  onChange={(e) => patch({ baseT2iModelId: e.target.value })}
                  className={selectClass}
                >
                  {BASE_T2I_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — ${m.costUsd.toFixed(3)}/image · {m.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <fieldset className="rounded-md border border-[var(--border)] p-3">
              <legend className="px-1 text-sm font-medium text-[var(--text-primary)]">
                Disclosures
              </legend>
              <p className="mb-2 text-xs text-[var(--text-muted)]">
                Apply across the batch. Per-short overrides in step 4.
                Age-restricted + paid-promotion are read-only via the YouTube
                API today — toggling them here records intent; you finish in
                YouTube Studio after upload.
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Toggle
                  label="AI content disclosure"
                  hint="On by default since we generate with AI."
                  value={defaults.aiContentDisclosure ?? true}
                  onChange={(v) => patch({ aiContentDisclosure: v })}
                />
                <Toggle
                  label="Age restricted (18+)"
                  value={defaults.ageRestricted ?? false}
                  onChange={(v) => patch({ ageRestricted: v })}
                />
                <Toggle
                  label="Contains paid promotion"
                  value={defaults.paidPromotion ?? false}
                  onChange={(v) => patch({ paidPromotion: v })}
                />
              </div>
            </fieldset>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-[var(--border)] px-4 py-2 text-sm text-[var(--text-primary)] hover:bg-white/[0.05]"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={start}
          disabled={submitting || selectedCount === 0}
          className="rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(124,58,237,0.35)] hover:bg-[var(--accent-purple-bright)] disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] disabled:shadow-none"
        >
          {submitting ? 'Starting…' : `Start generating ${selectedCount} shorts →`}
        </button>
      </div>
    </section>
  );
}

function Label({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <span className="mb-1 block">
      <span className="block text-sm font-medium text-[var(--text-primary)]">{children}</span>
      {hint && <span className="block text-xs text-[var(--text-muted)]">{hint}</span>}
    </span>
  );
}

function Required() {
  return <span className="ml-1 text-[var(--accent-yellow)]">*</span>;
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--text-primary)]">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--accent-purple)]"
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-[var(--text-muted)]">{hint}</span>}
      </span>
    </label>
  );
}

const selectClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none';
