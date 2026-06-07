'use client';

/**
 * Voice profile card for the channel-clone panel.
 *
 * Shows the structured narrator-voice description produced by the
 * voice-profile LLM stage (Plan 1A), plus a paste-ready ElevenLabs
 * Voice Design prompt. Renders three states:
 *
 *   1. Pending — intake is still running or just landed but the
 *      voice-profile stage hasn't reported yet. Shows a short
 *      "listening to the narrator…" line so the operator knows it's
 *      coming.
 *   2. Empty — intake completed but no voiceProfile lands (silent
 *      sample, model failure). Shows a one-line apology + retry hint.
 *   3. Loaded — the structured description + copy-to-clipboard for
 *      the voice design prompt + a placeholder clone button (wired
 *      up in Plan 1B).
 *
 * The card is collapsible. It defaults to EXPANDED the first time a
 * voiceProfile appears, then respects the operator's collapse choice
 * for the rest of the session (sessionStorage).
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ChannelCloneJobState, ChannelCloneJobStatus } from '@/lib/channel-clone/types';

export interface VoiceProfileCardProps {
  jobId: string;
  status: ChannelCloneJobStatus;
  state: ChannelCloneJobState | undefined;
}

/** Status values during which the operator hasn't yet had a chance
 *  to see the voice profile result, so the card hides entirely. */
const PRE_INTAKE_STATUSES: ReadonlySet<ChannelCloneJobStatus> = new Set([
  'intake_pending',
  'intake_running',
]);

export function VoiceProfileCard({ jobId, status, state }: VoiceProfileCardProps) {
  const profile = state?.voiceProfile;
  const sample = state?.voiceSample;

  // Card visibility: hide entirely until intake leaves its running
  // states. After that, render in whatever sub-state applies.
  const intakeFinished = !PRE_INTAKE_STATUSES.has(status) && !status.startsWith('intake_');
  const renderableAfterIntake =
    status === 'intake_complete' ||
    status === 'intake_failed' ||
    // Any post-intake status: analyze/topics/hooks/etc.
    intakeFinished;
  const shouldShowCard = renderableAfterIntake;

  // Operator collapse choice persists across reloads within the
  // session — but defaults to EXPANDED the first time a voiceProfile
  // exists (so the operator notices the new feature).
  const sessionKey = `cc-voice-profile-collapsed:${jobId}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const saved = window.sessionStorage.getItem(sessionKey);
    if (saved === '1') return true;
    if (saved === '0') return false;
    return !profile; // collapsed when no profile yet
  });

  useEffect(() => {
    // When the profile first arrives AND the operator hasn't already
    // expressed a preference, expand the card.
    if (typeof window === 'undefined') return;
    const saved = window.sessionStorage.getItem(sessionKey);
    if (saved !== null) return;
    if (profile) setCollapsed(false);
  }, [profile, sessionKey]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem(sessionKey, next ? '1' : '0');
      }
      // eslint-disable-next-line no-console
      console.info('[channel-clone voice-card]', { state: 'toggled', jobId, collapsed: next });
      return next;
    });
  }, [jobId, sessionKey]);

  if (!shouldShowCard) return null;

  return (
    <section className="rounded border border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-100">Narrator voice profile</span>
          <ProfileBadge profile={profile} sample={sample} status={status} />
        </div>
        <button
          type="button"
          onClick={toggle}
          className="text-xs text-neutral-400 hover:text-neutral-200"
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </header>

      {!collapsed && (
        <div className="border-t border-neutral-800 p-3 text-xs">
          {profile ? (
            <LoadedView profile={profile} sample={sample} />
          ) : sample ? (
            <PendingView sample={sample} />
          ) : (
            <EmptyView status={status} />
          )}
        </div>
      )}
    </section>
  );
}

function ProfileBadge({
  profile,
  sample,
  status,
}: {
  profile: ChannelCloneJobState['voiceProfile'];
  sample: ChannelCloneJobState['voiceSample'];
  status: ChannelCloneJobStatus;
}) {
  if (profile) {
    return (
      <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
        ready
      </span>
    );
  }
  if (sample) {
    return (
      <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
        analyzing…
      </span>
    );
  }
  if (status === 'intake_failed') {
    return (
      <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
        skipped (intake failed)
      </span>
    );
  }
  return (
    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
      unavailable
    </span>
  );
}

function LoadedView({
  profile,
  sample,
}: {
  profile: NonNullable<ChannelCloneJobState['voiceProfile']>;
  sample: ChannelCloneJobState['voiceSample'];
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profile.voiceDesignPrompt);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
      // eslint-disable-next-line no-console
      console.info('[channel-clone voice-card]', { state: 'prompt-copied' });
    } catch (err) {
      setCopyStatus('failed');
      // eslint-disable-next-line no-console
      console.warn('[channel-clone voice-card]', { state: 'copy-failed', err });
    }
  }, [profile.voiceDesignPrompt]);

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Field label="Gender" value={profile.gender} />
        <Field label="Age bracket" value={profile.ageBracket} />
        <Field label="Pace" value={profile.pace} />
        <Field label="Energy" value={profile.energy} />
        <Field label="Timbre" value={profile.timbre} />
        <Field label="Accent" value={profile.accent} />
        <Field label="Emotional register" value={profile.emotionalRegister} span={2} />
        <Field
          label="Signature moves"
          value={profile.signatureMoves.join(' · ')}
          span={2}
        />
      </dl>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-neutral-300">
            ElevenLabs Voice Design prompt
          </span>
          <button
            type="button"
            onClick={() => void copyPrompt()}
            className="text-[10px] text-neutral-400 hover:text-neutral-200"
          >
            {copyStatus === 'copied' ? 'Copied ✓' : copyStatus === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
        </div>
        <p className="whitespace-pre-wrap rounded bg-neutral-900 p-2 text-[11px] text-neutral-200">
          {profile.voiceDesignPrompt}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-800 pt-2 text-[10px] text-neutral-500">
        <span>
          Model: <span className="text-neutral-300">{profile.modelUsed}</span>
        </span>
        {sample && (
          <span>
            Sample: {Math.round(sample.bytes / 1024)} KB · {sample.durationSec}s from t={sample.startSec}s
          </span>
        )}
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-900 p-2 text-[10px] text-neutral-400">
        Clone this voice on ElevenLabs — coming in the next push. Until then, paste the prompt above into
        ElevenLabs Voice Design to generate a similar voice.
      </div>
    </div>
  );
}

function PendingView({ sample }: { sample: NonNullable<ChannelCloneJobState['voiceSample']> }) {
  return (
    <div className="space-y-1 text-neutral-400">
      <p>
        Audio sample captured ({sample.durationSec}s, {Math.round(sample.bytes / 1024)} KB).
      </p>
      <p>Listening to the narrator and producing a voice description…</p>
    </div>
  );
}

function EmptyView({ status }: { status: ChannelCloneJobStatus }) {
  if (status === 'intake_failed') {
    return (
      <p className="text-neutral-400">
        Intake failed before a voice sample could be captured. Fix the intake error and rerun to
        generate a voice profile.
      </p>
    );
  }
  return (
    <div className="space-y-1 text-neutral-400">
      <p>No voice profile available for this run.</p>
      <p className="text-[10px] text-neutral-500">
        Most likely the reference videos contained no spoken narration in the first ~90 seconds.
        Re-running on a different reference video usually fixes it.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  span = 1,
}: {
  label: string;
  value: string;
  span?: 1 | 2;
}) {
  return (
    <div className={span === 2 ? 'col-span-2' : ''}>
      <dt className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="text-neutral-200">{value}</dd>
    </div>
  );
}
