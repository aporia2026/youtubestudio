/**
 * Caption types + helpers shared between the regenerate endpoint and
 * the editor's display layer.
 *
 * Phase 4 of `_plans/2026-05-18-shot-graph-editor.md`. Captions are
 * DERIVED state — generated from `voiceoverUrl` via OpenAI's
 * gpt-4o-mini-transcribe, cached in the user_history payload keyed
 * by a hash of voiceoverUrl. Re-running with the same URL hits the
 * cache; changing the VO invalidates it.
 *
 * Editing caption TEXT goes through SET_ROW_SCRIPT (already shipped):
 * captions are derived from the row's script_text, so editing the
 * script edits the caption. Timing edits are out of scope for v1.
 */

export interface CaptionSegment {
  /** Segment start in seconds from the start of the audio. */
  start: number;
  /** Segment end in seconds from the start of the audio. */
  end: number;
  /** Spoken text of the segment. */
  text: string;
}

export interface CaptionsBundle {
  /** SHA-256 of `voiceoverUrl` at the time of generation. Mismatch
   *  vs the live URL means the cache is stale; the UI should offer
   *  a regenerate. */
  voiceoverUrlHash: string;
  /** Model id used. Recorded so a quality bump (e.g. swapping to
   *  gpt-4o-transcribe) invalidates the cache. */
  modelId: string;
  /** When this bundle was generated, ISO UTC. */
  generatedAt: string;
  segments: CaptionSegment[];
}

/**
 * Hash the voiceoverUrl so cache hits are stable across reads.
 * Browser uses SubtleCrypto; the server uses Node's `crypto`. Both
 * produce the same SHA-256 hex string for the same input.
 */
export async function hashVoiceoverUrl(url: string): Promise<string> {
  const text = url || '';
  if (typeof globalThis.crypto?.subtle?.digest === 'function') {
    const buf = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Node fallback. Dynamic import keeps the browser bundle clean.
  const { createHash } = await import('crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Find the active caption segment for the given playhead time. Linear
 * scan since segments are small (typically ≤ 200) and ordered by
 * start time. Returns null when no segment covers the playhead.
 */
export function activeCaption(
  segments: CaptionSegment[] | undefined,
  playheadSeconds: number,
): CaptionSegment | null {
  if (!segments || segments.length === 0) return null;
  for (const seg of segments) {
    if (playheadSeconds >= seg.start && playheadSeconds < seg.end) return seg;
  }
  return null;
}
