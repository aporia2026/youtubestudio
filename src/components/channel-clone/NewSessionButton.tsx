'use client';

/**
 * "New Session" — clears every channel-clone localStorage DRAFT key
 * so the operator can start the upload + URL forms from scratch
 * without seeing leftover URLs, source labels, or typed transcripts
 * from a previous attempt.
 *
 * Independent of the server-side run state:
 *   - DOES clear: form drafts (URL paste, source label, source
 *     channel URL, intake-mode tab, frame interval, sample count,
 *     per-filename transcript drafts, landing-scope panel knobs).
 *   - DOES NOT clear: per-job knob state (cc-<jobId>-*), since
 *     those are tied to specific persisted runs; templates; recent
 *     runs list; or any server-side data. Reuse-from-recent-runs
 *     keeps working after a New Session because it reads from the
 *     server, not localStorage.
 *
 * 2026-06-08 user request: "do also an option for a new session that
 * clears everything and lets you start from scratch" + "restoring
 * previous videos and their transcripts should also work after
 * starting a new session" (it does — Reuse is server-side).
 */

import { useCallback } from 'react';

/** Returns true if `key` is a channel-clone localStorage entry that
 *  belongs to the PRE-submit / draft layer (vs per-job state keyed
 *  by an actual jobId, which we never touch). Exported for unit
 *  tests in case we ever wire one up. */
export function isChannelCloneDraftKey(key: string): boolean {
  if (!key.startsWith('cc-')) return false;
  // Per-job state has a UUID segment in the second position
  // (e.g. cc-<uuid>-chosenTopicIndex). Those are NOT drafts.
  // Everything else under cc- prefix is a draft or a landing-scope
  // placeholder.
  if (/^cc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i.test(key)) {
    return false;
  }
  // Voice-card collapse preferences are per-job too.
  if (key.startsWith('cc-voice-profile-collapsed:')) return false;
  return true;
}

export function NewSessionButton() {
  const handleClick = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (!window.confirm(
      'Start a new session? This clears the URL paste, source label, source channel URL, and any typed transcripts you haven\'t yet sent. Your previous runs and their videos stay safe in the recent runs list — Reuse still works after this.',
    )) return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (k && isChannelCloneDraftKey(k)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) {
        window.localStorage.removeItem(k);
      }
      // eslint-disable-next-line no-console
      console.info('[channel-clone new-session]', { cleared: keysToRemove.length });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[channel-clone new-session] failed', err);
    }
    // Hard reload so every persisted-state hook re-hydrates from
    // empty + the form re-renders with defaults. Cheap to do here
    // because the operator just explicitly asked for a fresh start.
    window.location.reload();
  }, []);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
      title="Clear pre-submit form drafts (URL, label, typed transcripts) and start a clean page. Your previous runs stay safe and Reuse still works."
    >
      ⤺ New session
    </button>
  );
}
