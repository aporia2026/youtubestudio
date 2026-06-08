'use client';

/**
 * ResumeBatchClient — resume UI for an existing batch row.
 *
 * Plan: _plans/2026-06-08-shorts-bulk-batch-youtube-upload.md.
 *
 * Renders the stepper + the appropriate step component based on
 * batch status. Steps 1+2 are pre-create; they never apply here,
 * because the batch row already exists. Steps 3-5 are server-backed
 * so a refresh just reloads the same state.
 *
 * Status → step mapping:
 *   'generating' → step 3 (progress, polling)
 *   'review'     → step 4 (review queue)
 *   'uploading'  → step 5 (already mid-upload — confirms the drain)
 *   'done'       → step 5 (final results)
 *   'failed'     → step 4 with an error banner so the user can inspect
 *   'setup'      → fall through to step 3 (shouldn't normally happen
 *                  via this route, but is harmless if it does)
 */

import { useState } from 'react';
import Link from 'next/link';
import { BatchStepper, type BatchStep } from '@/components/shorts/batch/BatchStepper';
import { Step3Progress } from '@/components/shorts/batch/Step3Progress';
import { Step4ReviewQueue } from '@/components/shorts/batch/Step4ReviewQueue';
import { Step5UploadConfirm } from '@/components/shorts/batch/Step5UploadConfirm';
import type { ShortsBatchStatus } from '@/lib/shorts-batches-types';

function statusToStep(status: ShortsBatchStatus): BatchStep {
  switch (status) {
    case 'generating':
      return 3;
    case 'review':
      return 4;
    case 'uploading':
    case 'done':
      return 5;
    case 'failed':
      return 4;
    case 'setup':
      return 3;
  }
}

export function ResumeBatchClient({
  batchId,
  initialStatus,
  channelId,
}: {
  batchId: string;
  initialStatus: ShortsBatchStatus;
  channelId: string;
}) {
  const [step, setStep] = useState<BatchStep>(statusToStep(initialStatus));

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold text-[var(--text-primary)]">
            Bulk shorts batch
          </h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Resuming batch{' '}
            <code className="font-mono text-xs text-[var(--text-muted)]">
              {batchId.slice(0, 8)}
            </code>
          </p>
        </div>
        <Link
          href="/shorts/batch"
          className="rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-white/[0.05] hover:text-[var(--text-primary)]"
        >
          ← All batches
        </Link>
      </header>

      <BatchStepper current={step} batchId={batchId} />

      <div className="mt-8">
        {step === 3 && (
          <Step3Progress batchId={batchId} onDone={() => setStep(4)} />
        )}
        {step === 4 && (
          <Step4ReviewQueue batchId={batchId} onContinue={() => setStep(5)} />
        )}
        {step === 5 && (
          <Step5UploadConfirm batchId={batchId} channelId={channelId} />
        )}
      </div>
    </div>
  );
}
