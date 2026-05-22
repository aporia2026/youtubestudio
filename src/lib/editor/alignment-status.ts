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
  if (!voiceoverAlignment) {
    return {
      status: 'unsupported',
      detail:
        'No word-level timings for this voiceover. Re-generate the voiceover on the production-doc page to enable alignment.',
    };
  }
  // The alignment payload carries `audio_url` (camel-case varies by
  // version of the response). When present and it doesn't match the
  // current voiceover URL the alignment is stale.
  const alignmentUrl =
    (voiceoverAlignment as { audio_url?: string; audioUrl?: string }).audio_url ??
    (voiceoverAlignment as { audio_url?: string; audioUrl?: string }).audioUrl;
  if (alignmentUrl && alignmentUrl !== voiceoverUrl) {
    return {
      status: 'stale',
      detail:
        'The voiceover URL changed since the last alignment. Regenerate the alignment on the production-doc page.',
    };
  }
  const wordCount = Array.isArray(voiceoverAlignment.words)
    ? voiceoverAlignment.words.length
    : 0;
  return {
    status: 'ready',
    detail:
      wordCount > 0
        ? `Scene boundaries are retimed to ${wordCount.toLocaleString()} words of narration.`
        : 'Scene boundaries are retimed to the narration.',
  };
}
