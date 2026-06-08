/**
 * Channel-style derivation — turns the analyze stage's visual
 * profile + the intake's extracted frames into a per-job custom
 * style that the rowify stage uses INSTEAD of one of the built-in
 * presets.
 *
 * This is what makes channel-clone actually clone. The old path
 * "match profile → pick built-in preset" classified the channel;
 * this path "generate suffix from profile + pick frames as refs"
 * preserves the channel's actual visual DNA so the image-gen
 * pipeline can render every shot in the channel's own look.
 *
 * Two outputs:
 *   - `aiImageSuffix` — the textual style lock baked into every
 *     row's ai_image_prompt by the rowify LLM call. Encodes the
 *     channel's art style, palette, lighting, mood, etc.
 *   - `refR2Keys` — a curated subset of the intake's frames (3-6
 *     spread across the sample videos) that the image-gen pipeline
 *     uses as Atlas i2i reference images.
 */

import type {
  ChannelCloneIntakeResult,
  ChannelCloneVisualProfile,
} from './types';

export interface ChannelStyle {
  /** Textual suffix appended to every ai_image_prompt. Mirrors the
   *  shape built-in presets use (a comma-joined list of style cues)
   *  so the rowify LLM can splice it onto prompts naturally. */
  aiImageSuffix: string;
  /** R2 keys (relative paths inside the review bucket) of the
   *  representative frames chosen as image-gen reference images. */
  refR2Keys: string[];
  /** One-line human-readable summary of the derivation — surfaced
   *  in logs + the UI so the operator can sanity-check what the
   *  pipeline thinks the channel's style is. */
  reason: string;
}

/** Target number of frames pulled as the channel-style POOL.
 *  Atlas i2i caps at 4 refs per call, but we want VARIETY across the
 *  doc — different shots should look like different parts of the
 *  channel, not all draw from the same 4 frames. The image-gen
 *  pipeline slices a per-row window of 4 frames out of this pool
 *  based on row index, so scene 7 sees a different ref subset than
 *  scene 0. 12 covers the common cases (3 frames per ref subset
 *  rotation × 4 calls before repeat). 2026-06-08. */
const TARGET_REF_COUNT = 12;

/** Build a comma-joined style cue list from the visual profile.
 *  Handles missing/sparse profiles by falling back to the cleanest
 *  descriptive fields available. */
export function deriveChannelStyleSuffix(profile: ChannelCloneVisualProfile | undefined): string {
  if (!profile) {
    return 'hand-drawn illustration style, simple composition, neutral palette';
  }
  const parts: string[] = [];

  if (profile.artStyle?.trim()) {
    parts.push(profile.artStyle.trim());
  }
  if (profile.paletteHex && profile.paletteHex.length > 0) {
    const palette = profile.paletteHex.slice(0, 5).filter((h) => /^#?[0-9a-f]{3,8}$/i.test(h));
    if (palette.length > 0) {
      parts.push(`palette: ${palette.join(' ')}`);
    }
  }
  if (profile.lightingStyle?.trim()) {
    parts.push(`lighting: ${profile.lightingStyle.trim()}`);
  }
  if (profile.compositionPatterns?.trim()) {
    parts.push(`composition: ${profile.compositionPatterns.trim()}`);
  }
  if (profile.detailLevel?.trim()) {
    parts.push(`detail: ${profile.detailLevel.trim()}`);
  }
  if (profile.mood?.trim()) {
    parts.push(`mood: ${profile.mood.trim()}`);
  }

  if (parts.length === 0) {
    return 'hand-drawn illustration style, simple composition, neutral palette';
  }
  return parts.join(', ');
}

/** Pick `targetCount` representative frames from across the intake's
 *  sample videos.
 *
 *  Strategy: round-robin across videos so the ref set has variety —
 *  if we have 4 videos and want 4 frames, we pick one mid-ish frame
 *  per video. If we have fewer videos than slots, we draw multiple
 *  frames from the same video at evenly-spaced indices. The frames
 *  picked are biased toward the middle of each video (not the first
 *  or last frame) where the "real" content lives.
 *
 *  Returns an empty array when the intake has no frames at all — the
 *  caller decides whether to fall back to a built-in preset's refs. */
export function selectRepresentativeFrames(
  intake: ChannelCloneIntakeResult,
  targetCount: number = TARGET_REF_COUNT,
): string[] {
  const videosWithFrames = intake.sampleVideos.filter((v) => v.frameR2Keys && v.frameR2Keys.length > 0);
  if (videosWithFrames.length === 0) return [];

  const picks: string[] = [];
  // Round-robin slots across videos. Slot 0 → video 0, slot 1 → video 1, etc.
  for (let slot = 0; slot < targetCount; slot++) {
    const video = videosWithFrames[slot % videosWithFrames.length];
    const keys = video.frameR2Keys;
    // For each pass over a given video, advance the index so we don't
    // pick the same frame twice. floor(N/2) on the first pass for the
    // middle frame, then walk outward.
    const passNumber = Math.floor(slot / videosWithFrames.length);
    const center = Math.floor(keys.length / 2);
    const offset = passNumber === 0 ? 0 : (passNumber * 2 - 1) * (passNumber % 2 === 0 ? -1 : 1);
    const idx = Math.max(0, Math.min(keys.length - 1, center + offset));
    const key = keys[idx];
    if (key && !picks.includes(key)) {
      picks.push(key);
    }
  }
  return picks;
}

/** Public entry point — derive both halves of the channel style in
 *  one call. Caller persists the result on the job state. */
export function deriveChannelStyle(
  profile: ChannelCloneVisualProfile | undefined,
  intake: ChannelCloneIntakeResult | undefined,
  targetRefCount: number = TARGET_REF_COUNT,
): ChannelStyle {
  const aiImageSuffix = deriveChannelStyleSuffix(profile);
  const refR2Keys = intake ? selectRepresentativeFrames(intake, targetRefCount) : [];
  const reason = describeReason(profile, intake, refR2Keys.length);
  return { aiImageSuffix, refR2Keys, reason };
}

function describeReason(
  profile: ChannelCloneVisualProfile | undefined,
  intake: ChannelCloneIntakeResult | undefined,
  pickedFrameCount: number,
): string {
  const profileBits = profile
    ? `profile: ${[profile.artStyle, profile.mood].filter(Boolean).join(' / ')}`
    : 'no visual profile';
  const intakeBits = intake
    ? `${intake.sampleVideos.length} videos, ${pickedFrameCount} refs picked`
    : 'no intake';
  return `${profileBits} · ${intakeBits}`;
}
