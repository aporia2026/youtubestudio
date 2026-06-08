'use client';

/**
 * BatchClient — the stateful shell that drives the /shorts/batch
 * stepper. Owns the cross-step state (selected ideas, batch defaults,
 * batch id once created, current step) and delegates rendering to the
 * per-step components.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * State machine:
 *   1 → idea picker (no batch row yet)
 *   2 → setup form (no batch row yet)
 *   3 → progress (batch row created, polling /run-tick)
 *   4 → review (batch row in 'review' status)
 *   5 → upload (uploading + done)
 *
 * Persistence: every piece of pre-create state lives in localStorage
 * via useBatchDraft, namespaced by workspaceId+userId. A refresh
 * lands the user back on their current step with their selected
 * ideas, niche choice, generated ideas list, and defaults intact.
 * Post-create state is server-backed (the batch row); the in-progress
 * batchId is also kept in the draft so a refresh during steps 3-5
 * doesn't strand the user.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BatchStepper, type BatchStep } from '@/components/shorts/batch/BatchStepper';
import { RecentBatchesPanel } from '@/components/shorts/batch/RecentBatchesPanel';
import { Step1IdeaPicker, type Step1FormState } from '@/components/shorts/batch/Step1IdeaPicker';
import { Step2BatchSetup } from '@/components/shorts/batch/Step2BatchSetup';
import { Step3Progress } from '@/components/shorts/batch/Step3Progress';
import { Step4ReviewQueue } from '@/components/shorts/batch/Step4ReviewQueue';
import { Step5UploadConfirm } from '@/components/shorts/batch/Step5UploadConfirm';
import { useBatchDraft } from '@/lib/use-batch-draft';
import type { BatchIdeaInput } from '@/lib/shorts-batches';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';

interface ChannelOption {
  id: string;
  title: string | null;
  oauth_connected: boolean;
}

interface Props {
  workspaceId: string;
  userId: string;
  channels: ChannelOption[];
  activeChannelId: string;
  defaultVoiceId: string | null;
  defaultLanguage: string;
  defaultCategoryId: string | null;
  defaultMadeForKids: boolean | null;
  defaultTimezone: string | null;
  defaultDescriptionTemplate: string;
  defaultAgeRestricted: boolean;
  defaultPaidPromotion: boolean;
  defaultAiContentDisclosure: boolean;
}

interface BatchDraft {
  step: BatchStep;
  selectedIdeas: BatchIdeaInput[];
  channelId: string;
  defaults: ShortsBatchDefaults;
  step1Form: Step1FormState;
  batchId: string | null;
}

const EMPTY_STEP1_FORM: Step1FormState = {
  nicheChoice: '__manual__',
  manualNiche: '',
  count: 8,
  tone: '',
  excludeUploaded: true,
  generatedIdeas: [],
};

export function BatchClient(props: Props) {
  const router = useRouter();

  const seedDraft: BatchDraft = {
    step: 1,
    selectedIdeas: [],
    channelId: props.activeChannelId,
    defaults: {
      voiceId: props.defaultVoiceId ?? undefined,
      language: props.defaultLanguage,
      categoryId: props.defaultCategoryId ?? undefined,
      descriptionTemplate: props.defaultDescriptionTemplate || undefined,
      tagsPool: [],
      defaultPrivacy: 'public',
      scheduleCadence: 'manual',
      madeForKids: props.defaultMadeForKids ?? undefined,
      ageRestricted: props.defaultAgeRestricted,
      paidPromotion: props.defaultPaidPromotion,
      aiContentDisclosure: props.defaultAiContentDisclosure,
      timezone: props.defaultTimezone ?? 'UTC',
    },
    step1Form: EMPTY_STEP1_FORM,
    batchId: null,
  };

  const [draft, setDraft, clearDraft] = useBatchDraft<BatchDraft>(
    props.workspaceId,
    props.userId,
    seedDraft,
  );

  // Detect the browser's timezone once on mount and patch the draft
  // if the seed was UTC (server-side default) and the draft hasn't
  // been edited yet. This is a one-shot UX nicety — once the user
  // picks a timezone explicitly, we leave it alone.
  const [tzPatched, setTzPatched] = useState(false);
  useEffect(() => {
    if (tzPatched) return;
    if (draft.defaults.timezone && draft.defaults.timezone !== 'UTC') {
      setTzPatched(true);
      return;
    }
    if (typeof window === 'undefined') return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz && tz !== 'UTC') {
        setDraft((d) => ({ ...d, defaults: { ...d.defaults, timezone: tz } }));
      }
    } catch {
      /* noop */
    }
    setTzPatched(true);
  }, [tzPatched, draft.defaults.timezone, setDraft]);

  const setStep = (next: BatchStep) => setDraft((d) => ({ ...d, step: next }));
  const setSelectedIdeas = (ideas: BatchIdeaInput[]) =>
    setDraft((d) => ({ ...d, selectedIdeas: ideas }));
  const setChannelId = (next: string) => setDraft((d) => ({ ...d, channelId: next }));
  const setDefaults = (next: ShortsBatchDefaults) =>
    setDraft((d) => ({ ...d, defaults: next }));
  const setStep1Form = (next: Step1FormState) =>
    setDraft((d) => ({ ...d, step1Form: next }));

  const onBatchCreated = (id: string) => {
    // Switch to the resume URL so refreshes after this point reload
    // from the server. Then clear the local draft — the batch row
    // is now the source of truth.
    router.push(`/shorts/batch/${id}`);
    clearDraft();
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-[var(--text-primary)]">
          Bulk shorts batch
        </h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Generate several shorts together, then upload them all to YouTube
          on a schedule.
        </p>
      </header>

      <RecentBatchesPanel />

      <BatchStepper current={draft.step} batchId={draft.batchId} />

      <div className="mt-8">
        {draft.step === 1 && (
          <Step1IdeaPicker
            form={draft.step1Form}
            onFormChange={setStep1Form}
            selectedIdeas={draft.selectedIdeas}
            onSelectedIdeasChange={setSelectedIdeas}
            onContinue={() => setStep(2)}
          />
        )}
        {draft.step === 2 && (
          <Step2BatchSetup
            channels={props.channels}
            channelId={draft.channelId}
            onChannelChange={setChannelId}
            defaults={draft.defaults}
            onChange={setDefaults}
            selectedCount={draft.selectedIdeas.length}
            onBack={() => setStep(1)}
            onCreated={onBatchCreated}
            ideaInputs={draft.selectedIdeas}
          />
        )}
        {draft.step === 3 && draft.batchId && (
          <Step3Progress batchId={draft.batchId} onDone={() => setStep(4)} />
        )}
        {draft.step === 4 && draft.batchId && (
          <Step4ReviewQueue batchId={draft.batchId} onContinue={() => setStep(5)} />
        )}
        {draft.step === 5 && draft.batchId && (
          <Step5UploadConfirm batchId={draft.batchId} channelId={draft.channelId} />
        )}
      </div>
    </div>
  );
}
