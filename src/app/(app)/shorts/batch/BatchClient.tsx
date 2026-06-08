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
 * Transitions are deliberate (only the per-step "Continue" buttons
 * advance) — never automatic except 3→4 when the orchestrator reports
 * the batch is done, and 4→5 when the user clicks "Continue to upload".
 */

import { useState } from 'react';
import { BatchStepper, type BatchStep } from '@/components/shorts/batch/BatchStepper';
import { Step1IdeaPicker } from '@/components/shorts/batch/Step1IdeaPicker';
import { Step2BatchSetup } from '@/components/shorts/batch/Step2BatchSetup';
import { Step3Progress } from '@/components/shorts/batch/Step3Progress';
import { Step4ReviewQueue } from '@/components/shorts/batch/Step4ReviewQueue';
import { Step5UploadConfirm } from '@/components/shorts/batch/Step5UploadConfirm';
import type { BatchIdeaInput } from '@/lib/shorts-batches';
import type { ShortsBatchDefaults } from '@/lib/shorts-batches-types';

interface ChannelOption {
  id: string;
  title: string | null;
  oauth_connected: boolean;
}

interface Props {
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

export function BatchClient(props: Props) {
  const [step, setStep] = useState<BatchStep>(1);
  const [selectedIdeas, setSelectedIdeas] = useState<BatchIdeaInput[]>([]);
  const [channelId, setChannelId] = useState<string>(props.activeChannelId);
  const [defaults, setDefaults] = useState<ShortsBatchDefaults>(() => ({
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
    timezone:
      props.defaultTimezone
      ?? (typeof window !== 'undefined'
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : 'UTC'),
  }));
  const [batchId, setBatchId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-zinc-900 dark:text-zinc-100">
          Bulk shorts batch
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Generate several shorts together, then upload them all to YouTube
          on a schedule.
        </p>
      </header>

      <BatchStepper current={step} batchId={batchId} />

      <div className="mt-8">
        {step === 1 && (
          <Step1IdeaPicker
            selectedIdeas={selectedIdeas}
            onChange={setSelectedIdeas}
            onContinue={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <Step2BatchSetup
            channels={props.channels}
            channelId={channelId}
            onChannelChange={setChannelId}
            defaults={defaults}
            onChange={setDefaults}
            selectedCount={selectedIdeas.length}
            onBack={() => setStep(1)}
            onCreated={(id) => {
              setBatchId(id);
              setStep(3);
            }}
            ideaInputs={selectedIdeas}
          />
        )}
        {step === 3 && batchId && (
          <Step3Progress
            batchId={batchId}
            onDone={() => setStep(4)}
          />
        )}
        {step === 4 && batchId && (
          <Step4ReviewQueue
            batchId={batchId}
            onContinue={() => setStep(5)}
          />
        )}
        {step === 5 && batchId && (
          <Step5UploadConfirm
            batchId={batchId}
            channelId={channelId}
          />
        )}
      </div>
    </div>
  );
}
