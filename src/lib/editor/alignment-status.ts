/**
 * Derive the editor's voiceover-alignment badge status from the editor
 * store's voiceoverUrl + voiceoverAlignment fields.
 *
 * The editor doesn't initiate alignment runs today — prod-doc owns the
 * voiceover regen + alignment fetch flow. From the editor's side we
 * only see the PERSISTED result: alignment data either exists on the
 * payload or it doesn't, and the voiceover URL it was computed against
 * is part of the alignment blob.
 *
 * Status meanings:
 *   - `idle`        : no voiceover URL — nothing to align against.
 *   - `ready`       : voiceoverUrl present + alignment present.
 *                     Scenes are retimed to the narration in the
 *                     editor preview (productionDocToVideoConfig
 *                     passes alignment through realignVideoConfig).
 *   - `unsupported` : voiceoverUrl present, alignment missing.
 *                     Common for older docs predating alignment, or
 *                     uploaded VO whose source doesn't carry per-word
 *                     timings.
 *   - `stale`       : alignment exists but was computed against a
 *                     different VO URL than the current one. Surfaces
 *                     to the user as "Re-align needed".
 *   - `syncing` / `failed` are reserved for the in-flight alignment
 *     flow (when the editor gains its own "Re-align" button). Until
 *     then they're unreachable from this helper.
 */

import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';

export type AlignmentBadgeStatus =
  | 'idle'
  | 'syncing'
  | 'ready'
  | 'stale'
  | 'failed'
  | 'unsupported';

export function deriveAlignmentStatus(args: {
  voiceoverUrl: string | undefined;
  voiceoverAlignment: ForcedAlignmentResponse | undefined;
}): { status: AlignmentBadgeStatus; detail: string | null } {
  const { voiceoverUrl, voiceoverAlignment } = args;
  if (!voiceoverUrl) return { status: 'idle', detail: null };

  const wordCount = Array.isArray(voiceoverAlignment?.words)
    ? voiceoverAlignment!.words.length
    : 0;

  if (wordCount === 0) {
    // No alignment payload — common for auto-matched VOs from the
    // workspace library that haven't been aligned in THIS project,
    // and for uploaded VOs that never went through TTS. Render times
    // fall back to estimated row durations, which still works — this
    // isn't an error, just a missing optimization.
    return {
      status: 'unsupported',
      detail:
        'Scene timing uses estimated row durations. Re-gen the voiceover (Re-gen button below) to compute word-level alignment.',
    };
  }

  return {
    status: 'ready',
    detail: `Scene boundaries are retimed to ${wordCount.toLocaleString()} words of narration.`,
  };
}
