/**
 * Tests for the broadcast-sync helper that drives Phase 2 of
 * `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * Focus is on `decideBroadcastAction` — the pure function that maps a
 * BroadcastChannel message + local hook state → an action. The actual
 * `BroadcastChannel` plumbing inside `useProject` is integration-tested
 * by hand because vitest's default node env doesn't ship the API; the
 * pure function carries the logic that would break if anything subtle
 * went wrong, so the test suite focuses there.
 */
import { describe, expect, it } from 'vitest';
import {
  broadcastChannelName,
  decideBroadcastAction,
  newTabId,
  type ProjectPatchedBroadcast,
} from '@/lib/project/broadcast-sync';

describe('broadcastChannelName', () => {
  it('keys the channel by projectId so unrelated projects do not cross-talk', () => {
    expect(broadcastChannelName('abc')).toBe('project:abc');
    expect(broadcastChannelName('def')).toBe('project:def');
  });
});

describe('newTabId', () => {
  it('returns a non-empty string each call', () => {
    const a = newTabId();
    const b = newTabId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(5);
    expect(b.length).toBeGreaterThan(5);
  });

  it('is statistically unique across calls (guards against a constant return)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(newTabId());
    expect(seen.size).toBe(100);
  });
});

describe('decideBroadcastAction — malformed inputs', () => {
  const myTabId = 'tab-self';
  it('ignores null data', () => {
    expect(decideBroadcastAction(null, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
  it('ignores non-object data', () => {
    expect(decideBroadcastAction('hello', myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
    expect(decideBroadcastAction(42, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
  it('ignores a message without `type: "patched"`', () => {
    expect(decideBroadcastAction({ type: 'other' }, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
  it('ignores a message with a non-numeric version', () => {
    const msg = { type: 'patched', tabId: 'tab-x', version: '5' };
    expect(decideBroadcastAction(msg, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
  it('ignores a message with an empty tabId', () => {
    const msg = { type: 'patched', tabId: '', version: 5 };
    expect(decideBroadcastAction(msg, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
  it('ignores a message with NaN version', () => {
    const msg = { type: 'patched', tabId: 'tab-x', version: NaN };
    expect(decideBroadcastAction(msg, myTabId, 1, false)).toEqual({
      kind: 'ignore',
      reason: 'malformed',
    });
  });
});

describe('decideBroadcastAction — self echo', () => {
  it('ignores messages whose tabId matches this tab', () => {
    const myTabId = 'tab-self';
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: myTabId, version: 10 };
    expect(decideBroadcastAction(msg, myTabId, 5, false)).toEqual({
      kind: 'ignore',
      reason: 'self',
    });
  });
});

describe('decideBroadcastAction — stale broadcast (already caught up)', () => {
  it('ignores a broadcast at the same version as ours', () => {
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: 'tab-other', version: 5 };
    expect(decideBroadcastAction(msg, 'tab-self', 5, false)).toEqual({
      kind: 'ignore',
      reason: 'stale',
    });
  });
  it('ignores a broadcast below our local version', () => {
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: 'tab-other', version: 3 };
    expect(decideBroadcastAction(msg, 'tab-self', 5, false)).toEqual({
      kind: 'ignore',
      reason: 'stale',
    });
  });
});

describe('decideBroadcastAction — fresh broadcast', () => {
  it('returns reload when clean and remote is newer', () => {
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: 'tab-other', version: 7 };
    expect(decideBroadcastAction(msg, 'tab-self', 5, false)).toEqual({ kind: 'reload' });
  });
  it('returns conflict when dirty and remote is newer', () => {
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: 'tab-other', version: 7 };
    expect(decideBroadcastAction(msg, 'tab-self', 5, true)).toEqual({ kind: 'conflict' });
  });
  it('returns reload when localVersion is null (initial load in flight)', () => {
    // null localVersion = the receiving tab is still doing its first
    // load. Any broadcast that arrives is "newer than nothing" — apply.
    const msg: ProjectPatchedBroadcast = { type: 'patched', tabId: 'tab-other', version: 1 };
    expect(decideBroadcastAction(msg, 'tab-self', null, false)).toEqual({ kind: 'reload' });
  });
});
