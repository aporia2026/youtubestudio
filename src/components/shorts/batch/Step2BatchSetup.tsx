'use client';

/**
 * Step 2 — batch setup form. The user picks: channel (if multiple),
 * voice, language, YouTube category, default playlist(s),
 * description template, tag pool, default privacy, schedule cadence,
 * timezone, and the three mandatory disclosures (made-for-kids,
 * age-restricted, paid-promotion, AI-content).
 *
 * On "Start generation", POSTs /api/shorts/batches and PATCHes the
 * status to 'generating' — the orchestrator picks up from there.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { YOUTUBE_CATEGORIES } from '@/lib/youtube-categories';
import { TimezoneSelect } from './TimezoneSelect';
import { TagTokenInput } from './TagTokenInput';
import { PlaylistMultiSelect } from './PlaylistMultiSelect';
import type { BatchIdeaInput } from '@/lib/shorts-batches';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';

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
  { value: 'manual', label: 'Manual (set per-short later)' },
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
  const activeChannel = channels.find((c) => c.id === channelId);

  const patch = (p: Partial<ShortsBatchDefaults>) => onChange({ ...defaults, ...p });

  const start = async () => {
    if (!activeChannel) {
      toast.error('Pick a YouTube channel first.');
      return;
    }
    if (!activeChannel.oauth_connected) {
      toast.error('This channel is not OAuth-connected. Connect it in Settings → Channels first.');
      return;
    }
    if (defaults.madeForKids === undefined) {
      toast.error('Made-for-kids must be set explicitly (COPPA requirement).');
      return;
    }
    if (!defaults.voiceId) {
      toast.error('Pick a voice — every short in the batch will use it.');
      return;
    }

    setSubmitting(true);
    try {
      const createRes = await fetch('/api/shorts/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId,
          defaults,
          ideaInputs,
        }),
      });
      if (!createRes.ok) {
        const errBody = await createRes.json().catch(() => ({ error: `HTTP ${createRes.status}` }));
        throw new Error(errBody.error || `HTTP ${createRes.status}`);
      }
      const { batchId } = (await createRes.json()) as { batchId: string };

      // Transition into 'generating' so the orchestrator picks it up
      // on the next /run-tick poll.
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
        <h2 className="mb-4 text-lg font-medium text-[var(--text-primary)]">
          Batch defaults
        </h2>
        <p className="mb-6 text-sm text-[var(--text-secondary)]">
          These apply to every short in this batch ({selectedCount} selected). You can
          override any of them per-short in the review queue.
        </p>

        {channels.length > 1 && (
          <div className="mb-6">
            <Label hint="Where uploads land at the end of the batch.">YouTube channel</Label>
            <select
              value={channelId}
              onChange={(e) => onChannelChange(e.target.value)}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title ?? c.id} {c.oauth_connected ? '' : ' — not connected'}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <Label hint="Used for every voiceover in the batch. Voice id from the TTS picker.">
              Voice id <Required />
            </Label>
            <input
              type="text"
              value={defaults.voiceId ?? ''}
              onChange={(e) => patch({ voiceId: e.target.value || undefined })}
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-purple)] focus:outline-none"
            />
          </div>

          <div>
            <Label hint="ISO 639-1 (en, es, he, fr, …). Sets defaultLanguage on the YouTube snippet.">
              Language
            </Label>
            <input
              type="text"
              value={defaults.language ?? ''}
              onChange={(e) => patch({ language: e.target.value || undefined })}
              placeholder="en"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-purple)] focus:outline-none"
            />
          </div>

          <div>
            <Label hint="The YouTube category for every uploaded video.">
              Category
            </Label>
            <select
              value={defaults.categoryId ?? ''}
              onChange={(e) => patch({ categoryId: e.target.value || undefined })}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
            >
              <option value="">— pick a category —</option>
              {YOUTUBE_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label hint="Privacy at publish time. If you set a schedule below, the video stays private until publishAt and flips to this value.">
              Default privacy at publish
            </Label>
            <select
              value={defaults.defaultPrivacy ?? 'public'}
              onChange={(e) =>
                patch({ defaultPrivacy: e.target.value as 'public' | 'private' | 'unlisted' })
              }
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
            >
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <Label hint="Attach every uploaded short to these playlists. Optional.">
              Default playlists
            </Label>
            <PlaylistMultiSelect
              channelId={channelId}
              value={defaults.playlistIds ?? []}
              onChange={(next) => patch({ playlistIds: next })}
            />
          </div>

          <div className="md:col-span-2">
            <Label hint="Tags get a 500-char combined cap from YouTube — including the commas it inserts.">
              Default tag pool
            </Label>
            <TagTokenInput
              tags={defaults.tagsPool ?? []}
              onChange={(next) => patch({ tagsPool: next })}
            />
          </div>

          <div className="md:col-span-2">
            <Label hint="Used as the YouTube description. Placeholders: {{title}}, {{hook}}, {{payoff}}. Leave empty to use the SEO-generated description verbatim.">
              Description template
            </Label>
            <textarea
              value={defaults.descriptionTemplate ?? ''}
              onChange={(e) => patch({ descriptionTemplate: e.target.value || undefined })}
              rows={5}
              placeholder="{{title}}\n\nNew short: {{hook}}\n\nSubscribe for more!"
              className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-purple)] focus:outline-none"
            />
          </div>

          <div>
            <Label hint="Determines when each short publishes. Applies one offset per short starting from your chosen first time in step 5.">
              Schedule cadence
            </Label>
            <select
              value={defaults.scheduleCadence ?? 'manual'}
              onChange={(e) =>
                patch({
                  scheduleCadence: e.target.value as ShortsBatchDefaults['scheduleCadence'],
                })
              }
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent-purple)] focus:outline-none"
            >
              {SCHEDULE_CADENCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label hint="The timezone the scheduler uses to interpret your chosen times.">
              Timezone
            </Label>
            <TimezoneSelect
              value={defaults.timezone ?? 'UTC'}
              onChange={(tz) => patch({ timezone: tz })}
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--accent-yellow)]/40 bg-[var(--accent-yellow)]/10 p-5">
        <h2 className="mb-3 text-lg font-medium text-[var(--text-primary)]">
          YouTube disclosures
        </h2>
        <p className="mb-4 text-xs text-[var(--text-secondary)]">
          Made-for-kids is required by YouTube on every upload (COPPA). The other
          three default to the values you set; you can flip any of them per-short
          in the review queue.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <RadioBool
            label="Made for kids (COPPA)"
            hint="YouTube rejects uploads without an explicit answer."
            required
            value={defaults.madeForKids}
            onChange={(v) => patch({ madeForKids: v })}
          />
          <RadioBool
            label="Age restricted (18+)"
            hint="Note: this flag is read-only via the YouTube API today; you'll need to set it in YouTube Studio after upload."
            value={defaults.ageRestricted}
            onChange={(v) => patch({ ageRestricted: v })}
          />
          <RadioBool
            label="Contains paid promotion"
            hint="Note: also read-only via the YouTube API; set in YouTube Studio after upload."
            value={defaults.paidPromotion}
            onChange={(v) => patch({ paidPromotion: v })}
          />
          <RadioBool
            label="AI content disclosure"
            hint="On by default since this pipeline generates with AI. Flip off per-short if the short isn't realistic-looking (e.g. obvious doodle art)."
            value={defaults.aiContentDisclosure}
            onChange={(v) => patch({ aiContentDisclosure: v })}
          />
        </div>
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
          className="rounded-md bg-[var(--accent-purple)] px-5 py-2 text-sm font-medium text-white shadow-[0_0_30px_rgba(124,58,237,0.35)] disabled:cursor-not-allowed disabled:bg-white/[0.05] disabled:text-[var(--text-muted)] hover:bg-[var(--accent-purple-bright)]"
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

function RadioBool({
  label,
  hint,
  value,
  onChange,
  required,
}: {
  label: string;
  hint?: string;
  value: boolean | undefined;
  onChange: (next: boolean) => void;
  required?: boolean;
}) {
  return (
    <fieldset className="rounded-md border border-[var(--accent-yellow)]/40 bg-[var(--bg-card)] p-3">
      <legend className="text-sm font-medium text-[var(--text-primary)]">
        {label} {required && <Required />}
      </legend>
      {hint && <p className="mb-2 text-xs text-[var(--text-muted)]">{hint}</p>}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value === true}
            onChange={() => onChange(true)}
            className="h-4 w-4 accent-[var(--accent-purple)]"
          />
          Yes
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value === false}
            onChange={() => onChange(false)}
            className="h-4 w-4 accent-[var(--accent-purple)]"
          />
          No
        </label>
      </div>
    </fieldset>
  );
}
