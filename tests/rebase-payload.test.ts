/**
 * Tests for the auto-rebase helper that powers Phase 3 of
 * `_plans/2026-06-05-strengthen-doc-editor-sync.md`.
 *
 * When two tabs are both dirty and one of them PATCHes first, the
 * other tab loads the remote payload and re-applies its local edits
 * on top. These tests guard the per-field semantics so the merge
 * doesn't silently drop user input.
 */
import { describe, expect, it } from 'vitest';
import { emptyProjectPayload, type ProjectPayload } from '@/lib/project/payload';
import { mergeRowLockedAsStill, rebasePayload } from '@/lib/project/rebase-payload';

function makePayload(overrides: Partial<ProjectPayload> = {}): ProjectPayload {
  return { ...emptyProjectPayload(), ...overrides };
}

describe('rebasePayload — null / empty inputs', () => {
  it('returns the remote payload unchanged when localPayload is null', () => {
    const remote = makePayload({ title: 'Remote title' });
    const rebased = rebasePayload(remote, null, ['title']);
    expect(rebased).toBe(remote);
  });

  it('returns the remote payload unchanged when dirtyFields is empty', () => {
    const remote = makePayload({ title: 'Remote title' });
    const local = makePayload({ title: 'Local title' });
    const rebased = rebasePayload(remote, local, []);
    expect(rebased).toBe(remote);
  });
});

describe('rebasePayload — preserves dirty fields from local', () => {
  it('preserves a dirty title from local even though remote changed it', () => {
    const remote = makePayload({ title: 'Remote title', musicUrl: 'remote.mp3' });
    const local = makePayload({ title: 'Local title', musicUrl: 'remote.mp3' });
    const rebased = rebasePayload(remote, local, ['title']);
    expect(rebased.title).toBe('Local title');
    // Non-dirty field takes the remote value
    expect(rebased.musicUrl).toBe('remote.mp3');
  });

  it('preserves multiple dirty fields at once', () => {
    const remote = makePayload({
      title: 'Remote title',
      musicUrl: 'remote-music.mp3',
      voiceoverUrl: 'remote-voice.mp3',
    });
    const local = makePayload({
      title: 'Local title',
      musicUrl: 'local-music.mp3',
      voiceoverUrl: 'remote-voice.mp3', // not dirty — local matches remote
    });
    const rebased = rebasePayload(remote, local, ['title', 'musicUrl']);
    expect(rebased.title).toBe('Local title');
    expect(rebased.musicUrl).toBe('local-music.mp3');
    expect(rebased.voiceoverUrl).toBe('remote-voice.mp3');
  });

  it('preserves the local doc.rows when doc is dirty', () => {
    // Mirror the project-payload.test.ts pattern — relaxed row shape
    // via cast because ProductionRow's strict shape is overkill for
    // testing the rebase merge semantics.
    const remote = makePayload({
      doc: {
        title: 'Remote doc title',
        niche: 'tech',
        total_duration: '60',
        total_words: 100,
        speaking_pace_wpm: 150,
        rows: [{ timecode: '00:00', script_text: 'Remote row' } as never],
      },
    });
    const local = makePayload({
      doc: {
        title: 'Local doc title',
        niche: 'tech',
        total_duration: '60',
        total_words: 100,
        speaking_pace_wpm: 150,
        rows: [
          { timecode: '00:00', script_text: 'Local row 1' } as never,
          { timecode: '00:05', script_text: 'Local row 2' } as never,
        ],
      },
    });
    const rebased = rebasePayload(remote, local, ['doc']);
    expect(rebased.doc.title).toBe('Local doc title');
    expect(rebased.doc.rows).toHaveLength(2);
    expect((rebased.doc.rows[0]! as { script_text?: string }).script_text).toBe('Local row 1');
  });
});

describe('rebasePayload — non-dirty fields fall through to remote', () => {
  it('takes the remote value for fields not in dirtyFields', () => {
    const remote = makePayload({
      title: 'Remote title',
      voiceoverUrl: 'https://example.com/remote.mp3',
    });
    const local = makePayload({
      title: 'Local title',
      voiceoverUrl: 'https://example.com/local.mp3',
    });
    const rebased = rebasePayload(remote, local, ['title']);
    expect(rebased.voiceoverUrl).toBe('https://example.com/remote.mp3');
  });
});

describe('rebasePayload — `version` is never preserved from local', () => {
  it('always takes the remote version even if `version` is listed dirty', () => {
    const remote = makePayload();
    remote.version = 1;
    const local = makePayload();
    // Hand-roll a contrived "dirty version" — the hook never does this,
    // but the helper must be defensive against it.
    (local as unknown as { version: number }).version = 1;
    const rebased = rebasePayload(remote, local, ['version', 'title']);
    expect(rebased.version).toBe(1); // remote
  });
});

describe('rebasePayload — defensive against unknown fields', () => {
  it('silently ignores a dirty field name that does not exist on local', () => {
    const remote = makePayload({ title: 'Remote' });
    const local = makePayload({ title: 'Local' });
    const rebased = rebasePayload(remote, local, ['title', 'nonexistent_field']);
    expect(rebased.title).toBe('Local');
    expect('nonexistent_field' in rebased).toBe(false);
  });
});

describe('mergeRowLockedAsStill — Phase 4 server-side merge', () => {
  it('preserves server locks for rows the incoming patch did not touch', () => {
    const server = { 3: true };
    const incoming = { 5: true };
    expect(mergeRowLockedAsStill(server, incoming)).toEqual({ 3: true, 5: true });
  });

  it('incoming wins for shared keys (explicit overwrite)', () => {
    const server = { 3: true };
    const incoming = { 3: false };
    // Once Phase 1b lands and the client sends explicit `false`,
    // this is how an unlock will reach the server. The merge passes
    // it through; downstream pruning of false entries is up to the
    // validator.
    expect(mergeRowLockedAsStill(server, incoming)).toEqual({ 3: false });
  });

  it('empty incoming map preserves all server locks (documented Phase 1b limitation)', () => {
    const server = { 3: true, 7: true };
    const incoming: Record<number, boolean> = {};
    // This is the Phase 1b limitation: today's client deletes keys on
    // unlock instead of sending `false`. An incoming empty map could
    // mean "client never touched any locks" OR "client unlocked all" —
    // the merge sides with the former (no information loss). Phase 1b
    // fixes the ambiguity by making the client send explicit `false`.
    expect(mergeRowLockedAsStill(server, incoming)).toEqual({ 3: true, 7: true });
  });

  it('empty server + populated incoming yields the incoming map', () => {
    const server: Record<number, boolean> = {};
    const incoming = { 5: true };
    expect(mergeRowLockedAsStill(server, incoming)).toEqual({ 5: true });
  });

  it('does not mutate either input', () => {
    const server = { 3: true };
    const incoming = { 5: true };
    const serverSnapshot = { ...server };
    const incomingSnapshot = { ...incoming };
    mergeRowLockedAsStill(server, incoming);
    expect(server).toEqual(serverSnapshot);
    expect(incoming).toEqual(incomingSnapshot);
  });

  it('QA fix (2026-06-05): rebasePayload defers flags.rowLockedAsStill to remote even when flags is dirty', () => {
    // Scenario that previously could lose data:
    //   - Server has { 5: false } (Tab B just unlocked row 5).
    //   - Tab A's local has { 5: true } (stale — Tab A locked it earlier).
    //   - Tab A is dirty on `flags` (the user just toggled animateScenes).
    //
    // Without the special case, the rebase would preserve Tab A's
    // local flags wholesale and the next PATCH would round-trip
    // { 5: true } through the server-side merge — silently reviving
    // the lock that Tab B unlocked. The special case keeps Tab A's
    // animateScenes intact but takes the lock map from remote.
    const remote = makePayload({
      flags: {
        animateScenes: true,
        suppressLowerThirds: false,
        overlaysDisabled: false,
        rowLockedAsStill: { 5: false },
      },
    });
    const local = makePayload({
      flags: {
        animateScenes: false, // Tab A turned it off
        suppressLowerThirds: false,
        overlaysDisabled: false,
        rowLockedAsStill: { 5: true }, // stale
      },
    });
    const rebased = rebasePayload(remote, local, ['flags']);
    expect(rebased.flags.animateScenes).toBe(false); // local wins
    expect(rebased.flags.suppressLowerThirds).toBe(false);
    expect(rebased.flags.rowLockedAsStill).toEqual({ 5: false }); // remote wins
  });

  it('QA fix (2026-06-05): rebasePayload falls back to wholesale local flags when remote flags is missing', () => {
    const remote = makePayload();
    // Hand-roll a remote with no flags object (defensive corner)
    (remote as unknown as { flags: undefined }).flags = undefined;
    const local = makePayload({
      flags: {
        animateScenes: false,
        suppressLowerThirds: true,
        overlaysDisabled: false,
        rowLockedAsStill: { 3: true },
      },
    });
    const rebased = rebasePayload(remote, local, ['flags']);
    // Fallback: when remote has no flags to take rowLockedAsStill
    // from, the helper preserves local's wholesale.
    expect(rebased.flags.animateScenes).toBe(false);
    expect(rebased.flags.rowLockedAsStill).toEqual({ 3: true });
  });

  it('Phase 1b end-to-end: multi-tab lock + unlock converges correctly', () => {
    // Scenario: Tab A locks row 3, Tab B locks row 5, then Tab A
    // unlocks row 3. After Phase 1b's explicit-false unlock contract,
    // the server should converge on `{ 3: false, 5: true }`.

    // Step 1: server starts empty
    let server: Record<number, boolean> = {};

    // Step 2: Tab A locks row 3
    server = mergeRowLockedAsStill(server, { 3: true });
    expect(server).toEqual({ 3: true });

    // Step 3: Tab B (which has hydrated server's { 3: true } via
    // Phase 1b rehydration) locks row 5. Its outgoing patch carries
    // BOTH the server-known lock AND its new lock — so the patch
    // shape reflects the full local map.
    server = mergeRowLockedAsStill(server, { 3: true, 5: true });
    expect(server).toEqual({ 3: true, 5: true });

    // Step 4: Tab A (after hydrating { 3: true, 5: true } from server)
    // unlocks row 3 — Phase 1b sends explicit false. Merge applies.
    server = mergeRowLockedAsStill(server, { 3: false, 5: true });
    expect(server).toEqual({ 3: false, 5: true });

    // Step 5: Tab B rehydrates, sees row 3 unlocked, row 5 still
    // locked. UI renders correctly: row 3 NOT locked (falsy), row 5
    // locked. Patch from Tab B (idle) would carry { 3: false, 5: true }
    // and the merge is stable.
    server = mergeRowLockedAsStill(server, { 3: false, 5: true });
    expect(server).toEqual({ 3: false, 5: true });
  });
});

describe('rebasePayload — does not mutate inputs', () => {
  it('returns a new object; remote and local are untouched', () => {
    const remote = makePayload({ title: 'Remote' });
    const local = makePayload({ title: 'Local' });
    const remoteSnapshot = { ...remote };
    const localSnapshot = { ...local };
    rebasePayload(remote, local, ['title']);
    expect(remote).toEqual(remoteSnapshot);
    expect(local).toEqual(localSnapshot);
  });
});

