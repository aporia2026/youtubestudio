/**
 * Pure-logic tests for team-hub-types. The helpers here are the only
 * defensible boundary between user-controllable URL strings and the
 * server-side surface mounter, so test them strictly.
 */
import { describe, expect, it } from 'vitest';
import {
  ROSTER_GROUP_ORDER,
  ROSTER_GROUPS,
  TEAM_HUB_TABS,
  type RosterEntry,
  deterministicColor,
  entryGroups,
  formatSurfaceDescriptor,
  isIdle,
  isTeamHubTab,
  parseSurfaceDescriptor,
  totalWorkCount,
} from '@/lib/team-hub-types';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';
const VALID_UUID_UPPER = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

const baseEntry: RosterEntry = {
  id: 'a',
  kind: 'collaborator',
  name: 'Alice',
  email: 'a@example.com',
  color: '#7c3aed',
  roles: ['narrator'],
  personal_token: 'tok',
  last_activity: null,
  narrator_assignment_count: 0,
  editor_assignment_count: 0,
  review_link_count: 0,
  channel_count: 0,
  channel_id: null,
  channel_name: null,
};

describe('TEAM_HUB_TABS / isTeamHubTab', () => {
  it('contains exactly the four declared tabs', () => {
    expect([...TEAM_HUB_TABS].sort()).toEqual(['activity', 'settings', 'tasks', 'their-view']);
  });

  it('isTeamHubTab accepts every declared tab', () => {
    for (const t of TEAM_HUB_TABS) expect(isTeamHubTab(t)).toBe(true);
  });

  it.each([
    'TASKS',     // case-sensitive
    '',
    'unknown',
    'tasks ',    // trailing space
    'their_view',// underscore vs hyphen
  ])('isTeamHubTab rejects %j', (bad) => {
    expect(isTeamHubTab(bad)).toBe(false);
  });
});

describe('ROSTER_GROUPS', () => {
  it('group order is a permutation of group set', () => {
    expect([...ROSTER_GROUP_ORDER].sort()).toEqual([...ROSTER_GROUPS].sort());
  });
});

describe('deterministicColor', () => {
  it('returns the same colour for the same id every call', () => {
    expect(deterministicColor('foo')).toBe(deterministicColor('foo'));
  });

  it('returns a value from the fallback palette', () => {
    const palette = new Set([
      '#7c3aed',
      '#06b6d4',
      '#f59e0b',
      '#22c55e',
      '#ec4899',
      '#8b5cf6',
      '#14b8a6',
    ]);
    for (const id of ['x', 'y', 'z', 'aaaaaaaaaaa', '0000']) {
      expect(palette.has(deterministicColor(id))).toBe(true);
    }
  });

  it('does not throw on an empty id', () => {
    expect(() => deterministicColor('')).not.toThrow();
  });
});

describe('entryGroups', () => {
  it('channel-editor entries always belong to the channel_editor group only', () => {
    const e: RosterEntry = { ...baseEntry, kind: 'channel_editor', roles: ['channel_editor'] };
    expect(entryGroups(e)).toEqual(['channel_editor']);
  });

  it('multi-role collaborators appear in every role group they hold', () => {
    const e: RosterEntry = { ...baseEntry, roles: ['narrator', 'editor', 'reviewer'] };
    expect(entryGroups(e)).toEqual(['narrator', 'editor', 'reviewer']);
  });

  it('drops unknown roles silently — does not pollute groups', () => {
    const e: RosterEntry = { ...baseEntry, roles: ['narrator', 'something_else'] };
    expect(entryGroups(e)).toEqual(['narrator']);
  });

  it('de-dupes a duplicated role array', () => {
    const e: RosterEntry = { ...baseEntry, roles: ['editor', 'editor', 'narrator', 'narrator'] };
    expect(entryGroups(e)).toEqual(['editor', 'narrator']);
  });
});

describe('totalWorkCount', () => {
  it('sums the four count fields', () => {
    const e: RosterEntry = {
      ...baseEntry,
      narrator_assignment_count: 1,
      editor_assignment_count: 2,
      review_link_count: 3,
      channel_count: 4,
    };
    expect(totalWorkCount(e)).toBe(10);
  });

  it('returns 0 when every count is 0', () => {
    expect(totalWorkCount(baseEntry)).toBe(0);
  });
});

describe('isIdle', () => {
  const NOW = new Date('2026-05-09T12:00:00Z');

  it('treats no last_activity as idle', () => {
    expect(isIdle({ ...baseEntry, last_activity: null }, 7, NOW)).toBe(true);
  });

  it('treats a malformed last_activity as idle (defensive)', () => {
    expect(isIdle({ ...baseEntry, last_activity: 'not-a-date' }, 7, NOW)).toBe(true);
  });

  it('returns false when activity is within the threshold', () => {
    const recent = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(isIdle({ ...baseEntry, last_activity: recent }, 7, NOW)).toBe(false);
  });

  it('returns true when activity is older than the threshold', () => {
    const old = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(isIdle({ ...baseEntry, last_activity: old }, 7, NOW)).toBe(true);
  });

  it('boundary: exactly threshold days is NOT idle (strict greater-than)', () => {
    const exactly = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isIdle({ ...baseEntry, last_activity: exactly }, 7, NOW)).toBe(false);
  });
});

describe('parseSurfaceDescriptor', () => {
  it('parses every declared kind with a valid lower-case UUID', () => {
    for (const kind of ['script', 'takes', 'review', 'editor-tab'] as const) {
      const out = parseSurfaceDescriptor(`${kind}:${VALID_UUID}`);
      expect(out).toEqual({ kind, id: VALID_UUID });
    }
  });

  it('accepts upper-case UUIDs', () => {
    const out = parseSurfaceDescriptor(`takes:${VALID_UUID_UPPER}`);
    expect(out).toEqual({ kind: 'takes', id: VALID_UUID_UPPER });
  });

  it.each([
    null,
    undefined,
    '',
    'no-colon',
    ':missing-kind',
    `unknown:${VALID_UUID}`,
    `takes:not-a-uuid`,
    `takes:11111111-2222-3333-4444-555555555555 `, // trailing space → invalid uuid
    `script:`,
    `:${VALID_UUID}`,
  ])('rejects malformed input %j', (bad) => {
    expect(parseSurfaceDescriptor(bad as string | null | undefined)).toBeNull();
  });

  it('round-trips via formatSurfaceDescriptor', () => {
    const desc = { kind: 'review' as const, id: VALID_UUID };
    expect(parseSurfaceDescriptor(formatSurfaceDescriptor(desc))).toEqual(desc);
  });
});
