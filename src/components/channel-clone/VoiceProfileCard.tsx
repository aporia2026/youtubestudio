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

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChannelCloneJobState, ChannelCloneJobStatus } from '@/lib/channel-clone/types';
import { ModelRetryPicker } from './ModelRetryPicker';
import { pickRetryAlternative } from '@/lib/channel-clone/retry-alternative';
import { getFeatureDefaultModelId } from '@/lib/ai-models';

interface SourceChannel {
  /** Best-effort source channel name. Drives the default clone-name
   *  pattern `Clone: {channelName}` per the plan. */
  name: string | null;
}

export interface VoiceProfileCardProps {
  jobId: string;
  status: ChannelCloneJobStatus;
  state: ChannelCloneJobState | undefined;
  /** Source channel info — drives the default clone name pattern.
   *  Optional: card still renders a sensible default if null. */
  sourceChannel?: SourceChannel;
  /** Notify parent (the panel) so it can re-poll state after a
   *  successful clone or delete. Cheap signal, no payload needed. */
  onCloneStateChanged?: () => void;
}

/** Status values during which the operator hasn't yet had a chance
 *  to see the voice profile result, so the card hides entirely. */
const PRE_INTAKE_STATUSES: ReadonlySet<ChannelCloneJobStatus> = new Set([
  'intake_pending',
  'intake_running',
]);

export function VoiceProfileCard({
  jobId,
  status,
  state,
  sourceChannel,
  onCloneStateChanged,
}: VoiceProfileCardProps) {
  const profile = state?.voiceProfile;
  const sample = state?.voiceSample;
  const cloned = state?.clonedVoice;

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
       
      console.info('[channel-clone voice-card]', { state: 'toggled', jobId, collapsed: next });
      return next;
    });
  }, [jobId, sessionKey]);

  // Operator-initiated skip — the voice-profile runner can hang
  // indefinitely when Kie's Gemini audio path is broken (rate limit,
  // outage, returns empty body), and the picker offers no clear way
  // to move past it because the rest of the pipeline doesn't actually
  // depend on a voice profile. The skip flag is per-jobId per-session
  // so the operator can dismiss the card and continue, without
  // touching server state. To bring the card back: clear the
  // sessionStorage key.
  const skipKey = `cc-voice-profile-skipped:${jobId}`;
  const [skipped, setSkipped] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.sessionStorage.getItem(skipKey) === '1';
  });
  const handleSkip = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(skipKey, '1');
    }
    setSkipped(true);
     
    console.info('[channel-clone voice-card]', { state: 'skipped', jobId });
  }, [jobId, skipKey]);

  if (!shouldShowCard) return null;
  if (skipped && !profile) return null;

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
            <LoadedView
              profile={profile}
              sample={sample}
              cloned={cloned}
              jobId={jobId}
              defaultCloneName={buildDefaultCloneName(sourceChannel)}
              onCloneStateChanged={onCloneStateChanged}
            />
          ) : sample ? (
            <PendingView
              sample={sample}
              jobId={jobId}
              onChanged={onCloneStateChanged}
              onSkip={handleSkip}
            />
          ) : (
            <EmptyView status={status} />
          )}
        </div>
      )}
    </section>
  );
}

function buildDefaultCloneName(sourceChannel: SourceChannel | undefined): string {
  const name = sourceChannel?.name?.trim();
  return name ? `Clone: ${name}` : 'Clone: channel narrator';
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
  cloned,
  jobId,
  defaultCloneName,
  onCloneStateChanged,
}: {
  profile: NonNullable<ChannelCloneJobState['voiceProfile']>;
  sample: ChannelCloneJobState['voiceSample'];
  cloned: ChannelCloneJobState['clonedVoice'];
  jobId: string;
  defaultCloneName: string;
  onCloneStateChanged: (() => void) | undefined;
}) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profile.voiceDesignPrompt);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
       
      console.info('[channel-clone voice-card]', { state: 'prompt-copied' });
    } catch (err) {
      setCopyStatus('failed');
       
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

      <CloneControls
        jobId={jobId}
        defaultName={defaultCloneName}
        cloned={cloned}
        onChanged={onCloneStateChanged}
      />
    </div>
  );
}

function CloneControls({
  jobId,
  defaultName,
  cloned,
  onChanged,
}: {
  jobId: string;
  defaultName: string;
  cloned: ChannelCloneJobState['clonedVoice'];
  onChanged: (() => void) | undefined;
}) {
  const [name, setName] = useState<string>(defaultName);
  const [ownershipAck, setOwnershipAck] = useState<boolean>(false);
  const [busy, setBusy] = useState<'idle' | 'cloning' | 'deleting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [voiceIdCopyStatus, setVoiceIdCopyStatus] = useState<'idle' | 'copied'>('idle');

  const handleClone = useCallback(async () => {
    if (busy !== 'idle') return;
    if (!ownershipAck) {
      setError('Tick the ownership consent first.');
      return;
    }
    if (!name.trim()) {
      setError('Voice name is required.');
      return;
    }
    setBusy('cloning');
    setError(null);
     
    console.info('[channel-clone voice-card]', { state: 'clone-start', jobId, name });
    try {
      const res = await fetch('/api/channel-clone/voice/clone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, name: name.trim(), ownershipAck: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Clone failed (${res.status})`);
         
        console.warn('[channel-clone voice-card]', { state: 'clone-failed', status: res.status, error: data.error });
        return;
      }
       
      console.info('[channel-clone voice-card]', { state: 'clone-done', jobId });
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  }, [busy, ownershipAck, name, jobId, onChanged]);

  const handleDelete = useCallback(async () => {
    if (busy !== 'idle' || !cloned) return;
    if (!window.confirm(`Delete the cloned voice "${cloned.name}" from ElevenLabs? This frees the voice slot on your account.`)) {
      return;
    }
    setBusy('deleting');
    setError(null);
     
    console.info('[channel-clone voice-card]', { state: 'delete-start', jobId, voiceId: cloned.voiceId });
    try {
      const res = await fetch('/api/channel-clone/voice/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Delete failed (${res.status})`);
        return;
      }
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  }, [busy, cloned, jobId, onChanged]);

  const copyVoiceId = useCallback(async () => {
    if (!cloned) return;
    try {
      await navigator.clipboard.writeText(cloned.voiceId);
      setVoiceIdCopyStatus('copied');
      setTimeout(() => setVoiceIdCopyStatus('idle'), 2000);
    } catch {
      // Silent — operator can select-and-copy from the displayed text.
    }
  }, [cloned]);

  // Already-cloned state: show the voice_id + delete button. No new
  // clones until the operator deletes the existing one. Plan 2
  // template-load path persists an "inherited" subscriptionTier when
  // a saved template carries a voice_id from the original run — we
  // render a softer line for that case so the operator knows it
  // wasn't freshly cloned on this run.
  if (cloned) {
    const isInheritedFromTemplate = cloned.subscriptionTier === 'inherited';
    return (
      <div className="space-y-2 rounded border border-emerald-900/60 bg-emerald-950/30 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="text-[11px] font-medium text-emerald-300">
              {isInheritedFromTemplate
                ? 'ElevenLabs voice carried over from template'
                : `Cloned on ElevenLabs · ${cloned.subscriptionTier} plan`}
            </p>
            <p className="text-[10px] text-emerald-200/70">{cloned.name}</p>
            {isInheritedFromTemplate && (
              <p className="text-[10px] text-amber-200/70">
                If this voice was deleted from your ElevenLabs account, the id is stale — press Delete
                here and Clone again to refresh.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={busy !== 'idle'}
            className="text-[10px] text-red-300 underline-offset-2 hover:underline disabled:text-neutral-500"
          >
            {busy === 'deleting' ? 'Deleting…' : 'Delete from ElevenLabs'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-emerald-950 px-2 py-1 text-[10px] text-emerald-100">
            {cloned.voiceId}
          </code>
          <button
            type="button"
            onClick={() => void copyVoiceId()}
            className="text-[10px] text-emerald-300 hover:text-emerald-100"
          >
            {voiceIdCopyStatus === 'copied' ? 'Copied ✓' : 'Copy voice_id'}
          </button>
        </div>
        {error && <p className="text-[10px] text-red-300">{error}</p>}
      </div>
    );
  }

  // Not yet cloned: show the form.
  return (
    <div className="space-y-2 rounded border border-neutral-800 bg-neutral-900 p-2">
      <p className="text-[11px] font-medium text-neutral-200">Clone this voice on ElevenLabs</p>
      <p className="text-[10px] text-neutral-500">
        Instant Voice Cloning is included on every paid ElevenLabs tier (Starter and up). The clone
        operation itself costs no credits; text-to-speech with the cloned voice consumes characters
        from your plan. The sample stays in your R2 — only ElevenLabs sees the uploaded audio.
      </p>
      <label className="block space-y-1">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">Voice name</span>
        <input
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          disabled={busy !== 'idle'}
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 outline-none focus:border-neutral-500 disabled:opacity-60"
        />
      </label>
      <label className="flex items-start gap-2 text-[10px] text-neutral-300">
        <input
          type="checkbox"
          checked={ownershipAck}
          onChange={(e) => setOwnershipAck(e.target.checked)}
          disabled={busy !== 'idle'}
          className="mt-0.5"
        />
        <span>
          I confirm I have the rights to clone this voice (consent from the speaker, or a public
          figure exception per ElevenLabs' AUP).
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleClone()}
          disabled={busy !== 'idle' || !ownershipAck || !name.trim()}
          className="rounded bg-emerald-200 px-3 py-1 text-[11px] font-medium text-neutral-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
        >
          {busy === 'cloning' ? 'Uploading to ElevenLabs…' : 'Clone this voice'}
        </button>
        {error && <span className="text-[10px] text-red-300">{error}</span>}
      </div>
    </div>
  );
}

function PendingView({
  sample,
  jobId,
  onChanged,
  onSkip,
}: {
  sample: NonNullable<ChannelCloneJobState['voiceSample']>;
  jobId: string;
  onChanged: (() => void) | undefined;
  /** Hide the card for this session. Used when the operator has tried
   *  every model variant and Kie's Gemini audio path is genuinely
   *  unavailable. The rest of the pipeline doesn't depend on a voice
   *  profile, so skipping is safe. */
  onSkip: () => void;
}) {
  // Detect "stuck analyzing" — the runner is fire-and-forget after
  // intake completes and can silently bail (Kie 500, model defaults
  // not pointing at a Kie-Gemini model, R2 read failure, parse
  // failure). Anything more than 60s without the profile landing
  // means it's not coming; surface a clear retry CTA + explanation.
  const extractedAtMs = new Date(sample.extractedAt).getTime();
  const ageSec = Number.isFinite(extractedAtMs)
    ? Math.max(0, Math.floor((Date.now() - extractedAtMs) / 1000))
    : 0;
  const [isStuck, setIsStuck] = useState<boolean>(ageSec > 60);
  const [retrying, setRetrying] = useState<boolean>(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Model picker for the retry. Defaults to a Kie Gemini alternative
  // to whatever the workspace's configured default is — so a Kie 500
  // on one variant routes to a sibling variant on click.
  const configuredDefault = useMemo<string | null>(
    () => getFeatureDefaultModelId('channel-clone-voice-profile'),
    [],
  );
  const [modelId, setModelId] = useState<string>(
    () => pickRetryAlternative(configuredDefault ?? '', 'voice-profile'),
  );

  useEffect(() => {
    if (isStuck) return;
    if (ageSec > 60) {
      setIsStuck(true);
      return;
    }
    const remaining = (60 - ageSec) * 1000;
    const t = setTimeout(() => setIsStuck(true), remaining);
    return () => clearTimeout(t);
  }, [ageSec, isStuck]);

  const handleRetry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
     
    console.info('[channel-clone voice-card]', { state: 'profile-retry-start', jobId, modelId });
    try {
      const res = await fetch('/api/channel-clone/voice/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, modelId }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setRetryError(data.error ?? `Retry failed (${res.status})`);
        return;
      }
      onChanged?.();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [jobId, modelId, retrying, onChanged]);

  return (
    <div className="space-y-2 text-neutral-400">
      <p>
        Audio sample captured ({sample.durationSec}s, {Math.round(sample.bytes / 1024)} KB).
      </p>
      {isStuck ? (
        <div className="space-y-2 rounded border border-amber-900/60 bg-amber-950/30 p-2 text-[11px]">
          <p className="text-amber-200">
            Voice analysis hasn't completed after {Math.floor(ageSec / 60)}m. The runner walks
            every Kie Gemini variant first, then falls through to OpenAI's gpt-audio-1.5 /
            gpt-4o-audio-preview if Kie's audio path is broken. Re-running with a different
            primary model is the fastest way to retrigger the whole chain.
          </p>
          <p className="text-[10px] text-amber-200/70">
            Pick a Kie Gemini variant below to start the chain. OpenAI audio kicks in
            automatically only after every Kie variant fails — it's a paid fallback (~$0.06
            per 30s sample at gpt-audio-1.5 pricing), so the runner only tries it as a last
            resort.
          </p>
          <div className="space-y-2">
            <ModelRetryPicker
              value={modelId}
              onChange={setModelId}
              stage="voice-profile"
              originalModelId={configuredDefault}
              disabled={retrying}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={retrying}
                className="rounded bg-amber-200 px-3 py-1 text-[11px] font-medium text-neutral-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {retrying ? 'Re-running…' : 'Re-run voice analysis'}
              </button>
              <button
                type="button"
                onClick={onSkip}
                disabled={retrying}
                className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip — continue without voice profile
              </button>
              {retryError && <span className="text-[10px] text-red-300">{retryError}</span>}
            </div>
            <p className="text-[10px] text-neutral-500">
              Voice profile is informational — the rest of the pipeline (analyze, topics,
              hooks, script, rowify, publish-pack, handoff) does not depend on it. Skip to move
              past this card; the only feature you lose is the auto-suggested ElevenLabs Voice
              Design prompt.
            </p>
          </div>
        </div>
      ) : (
        <p>Listening to the narrator and producing a voice description…</p>
      )}
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
