/**
 * Shared types for /team-hub. Lives in a dep-free module so both the
 * server-side roster helpers and the client-side components can import
 * it without dragging in postgres / next-headers.
 *
 * Routing contract:
 *   /team-hub?person=<id>&tab=<tab>&surface=<surface_descriptor>
 *
 *   - person: the selected roster entry (collaborator id OR channel-editor
 *     id; the `kind` field on the entry disambiguates).
 *   - tab: one of TEAM_HUB_TABS. Defaults to 'tasks'.
 *   - surface: optional opaque descriptor for the right pane content
 *     (`script:<projectId>`, `takes:<takeId>`, etc.). Empty = right pane
 *     closed. Parsed by parseSurfaceDescriptor below.
 */

export const TEAM_HUB_TABS = ['tasks', 'their-view', 'activity', 'settings'] as const;
export type TeamHubTab = (typeof TEAM_HUB_TABS)[number];

export function isTeamHubTab(value: string): value is TeamHubTab {
  return (TEAM_HUB_TABS as readonly string[]).includes(value);
}

/** Roster entry kinds. Discriminator on RosterEntry. */
export type RosterEntryKind = 'collaborator' | 'channel_editor';

export interface RosterEntry {
  /** Stable id used as the URL `?person=` value. For collaborators this
   *  is `collaborators.id`; for channel editors it is `channel_editors.id`.
   *  The two id namespaces don't collide because they live in different
   *  tables and the `kind` field disambiguates. */
  id: string;
  kind: RosterEntryKind;
  name: string;
  email: string | null;
  /** Avatar / chip background colour. Channel editors don't have a stored
   *  colour so the helper picks a deterministic one based on their id. */
  color: string;
  /** For collaborators: the de-duped roles array (one or more of
   *  narrator/editor/reviewer/client). For channel editors: ['channel_editor']. */
  roles: string[];
  /** Token for opening the team member's own portal. NULL for channel
   *  editors (they don't have a personal portal — their work surface
   *  is /schedule filtered by their id). */
  personal_token: string | null;
  /** Most recent access across every assignment + share link the
   *  collaborator has in this workspace. NULL when the person has been
   *  added but has never accessed anything. */
  last_activity: string | null;
  /** Per-source counts. Sum gives "how much work this person has in this
   *  workspace right now." Used in left-rail filter chips + ambient
   *  counters. Channel editors only set channel_count. */
  narrator_assignment_count: number;
  editor_assignment_count: number;
  review_link_count: number;
  channel_count: number;
  /** Channel-editor-only fields (null for collaborators). Used to render
   *  "Editor of <Channel>" subtitle in the rail. */
  channel_id: string | null;
  channel_name: string | null;
}

export interface TeamHubRoster {
  entries: RosterEntry[];
}

/** Role-key the left rail groups by. Channel-editor is a synthetic group
 *  (its members don't carry a `role` column on the collaborators table). */
export const ROSTER_GROUPS = ['narrator', 'editor', 'reviewer', 'client', 'channel_editor'] as const;
export type RosterGroup = (typeof ROSTER_GROUPS)[number];

/** Visual ordering of role groups in the left rail. Mirrors the order the
 *  user mentioned ("narrator, video editor, reviewer/client, channel editor"). */
export const ROSTER_GROUP_ORDER: readonly RosterGroup[] = [
  'narrator',
  'editor',
  'reviewer',
  'client',
  'channel_editor',
];

/** Group label shown above each rail section. */
export const ROSTER_GROUP_LABELS: Record<RosterGroup, string> = {
  narrator: 'Narrators',
  editor: 'Video editors',
  reviewer: 'Reviewers',
  client: 'Clients',
  channel_editor: 'Channel editors',
};

/** Deterministic colour for entries that don't carry their own (channel
 *  editors). Hashes the id into a fixed palette so the same person gets
 *  the same colour every render. */
const FALLBACK_PALETTE = ['#7c3aed', '#06b6d4', '#f59e0b', '#22c55e', '#ec4899', '#8b5cf6', '#14b8a6'];

export function deterministicColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

/**
 * Decide which group an entry should appear under. Collaborators with
 * multiple roles appear under EACH of their role's groups (a person who
 * is both narrator + editor shows up in both sections). Channel editors
 * always go into the channel_editor group.
 */
export function entryGroups(entry: RosterEntry): RosterGroup[] {
  if (entry.kind === 'channel_editor') return ['channel_editor'];
  const groups: RosterGroup[] = [];
  for (const r of entry.roles) {
    if (r === 'narrator' || r === 'editor' || r === 'reviewer' || r === 'client') {
      if (!groups.includes(r)) groups.push(r);
    }
  }
  return groups;
}

/** Total active-work count for an entry. Powers the ambient counter on
 *  each rail row + the "Has work" filter chip. */
export function totalWorkCount(entry: RosterEntry): number {
  return (
    entry.narrator_assignment_count +
    entry.editor_assignment_count +
    entry.review_link_count +
    entry.channel_count
  );
}

/**
 * Idle-days filter: returns true when the entry hasn't had any activity
 * in the last `thresholdDays`. Entries that have never accessed anything
 * (last_activity IS NULL) count as idle the moment they exist.
 */
export function isIdle(entry: RosterEntry, thresholdDays: number, now: Date = new Date()): boolean {
  if (!entry.last_activity) return true;
  const last = new Date(entry.last_activity).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > thresholdDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Surface descriptors — opaque strings that name what the right pane shows.
// Format: `<kind>:<id>` (e.g. `takes:abc-123`, `review:def-456`).
// ---------------------------------------------------------------------------

export const SURFACE_KINDS = [
  'script',       // /projects/[projectId] iframe scoped to the script editor
  'takes',        // <TakeReview takeId={id} ... />
  'review',       // <ReviewPage ownerProjectId=... initialVersionId={id} />
  'editor-tab',   // <EditorTab projectId={id} />
] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface SurfaceDescriptor {
  kind: SurfaceKind;
  id: string;
}

/** Strict UUID check (lower- or upper-case hex). Surface ids that don't
 *  pass this drop out of the parser as null — defensive against URL
 *  tampering. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Round-trippable parser. Returns null for any malformed input — the
 * caller treats null as "no surface, right pane closed."
 */
export function parseSurfaceDescriptor(value: string | null | undefined): SurfaceDescriptor | null {
  if (!value) return null;
  const sep = value.indexOf(':');
  if (sep < 1) return null;
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (!(SURFACE_KINDS as readonly string[]).includes(kind)) return null;
  if (!UUID_RE.test(id)) return null;
  return { kind: kind as SurfaceKind, id };
}

export function formatSurfaceDescriptor(desc: SurfaceDescriptor): string {
  return `${desc.kind}:${desc.id}`;
}
