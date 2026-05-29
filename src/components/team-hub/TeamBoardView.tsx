'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LeftRail, type LeftRailFilter } from '@/components/team-hub/LeftRail';
import { MiddlePane } from '@/components/team-hub/MiddlePane';
import { RightPane } from '@/components/team-hub/RightPane';
import { SurfaceMounter } from '@/components/team-hub/SurfaceMounter';
import { NarratorTasksTab } from '@/components/team-hub/NarratorTasksTab';
import { EditorTasksTab } from '@/components/team-hub/EditorTasksTab';
import { ReviewerTasksTab } from '@/components/team-hub/ReviewerTasksTab';
import { ChannelEditorTasksTab } from '@/components/team-hub/ChannelEditorTasksTab';
import { TheirViewTab } from '@/components/team-hub/TheirViewTab';
import { ActivityTab } from '@/components/team-hub/ActivityTab';
import { SettingsTab } from '@/components/team-hub/SettingsTab';
import { AddPersonModal } from '@/components/team-hub/AddPersonModal';
import {
  type RosterEntry,
  type SurfaceDescriptor,
  type TeamHubRoster,
  type TeamHubTab,
  isTeamHubTab,
  parseSurfaceDescriptor,
  formatSurfaceDescriptor,
} from '@/lib/team-hub-types';
import { TeamTabBar } from '@/components/team/TeamTabBar';

/** Owner identity for embedded surfaces. Defaults are humane; the
 *  Settings tab (commit 8) will let the owner override these once the
 *  hub starts being used in earnest. */
const OWNER_AUTHOR = { name: 'Owner', color: '#06b6d4' };

/**
 * Board view rendered at `/team?view=board` — owner-side cockpit for
 * managing every team member in one place. Three-pane layout (left rail
 * | middle command center | right slide-in surface). URL-driven state
 * so deep links work.
 *
 * URL contract (in addition to the `view=board` flag):
 *   ?person=<roster_entry_id>      selected person on the rail
 *   ?tab=<tasks|their-view|activity|settings>
 *   ?surface=<kind>:<uuid>         optional right-pane content
 *
 * The roster is fetched once on mount; refetch is triggered by the
 * "Add person" flow and on window focus so unread/last-access counters
 * stay reasonably fresh without a full poll.
 */
export function TeamBoardView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ── URL-driven state ─────────────────────────────────────────────
  const personId = searchParams.get('person');
  const tabParam = searchParams.get('tab');
  const tab: TeamHubTab = tabParam && isTeamHubTab(tabParam) ? tabParam : 'tasks';
  const surface = parseSurfaceDescriptor(searchParams.get('surface'));

  // ── Local state ──────────────────────────────────────────────────
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LeftRailFilter>('all');
  const [addModalOpen, setAddModalOpen] = useState(false);

  // ── Data fetch ───────────────────────────────────────────────────
  const loadRoster = useCallback(async () => {
    setLoading(true);
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, read
      const res = await fetch('/api/team-hub/roster', { cache: 'no-store' });
      if (!res.ok) {
        setRoster([]);
        return;
      }
      const data = (await res.json()) as TeamHubRoster;
      setRoster(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      setRoster([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  // Refresh on window focus so coming back to the tab shows current
  // counters without a manual reload.
  useEffect(() => {
    const onFocus = () => loadRoster();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRoster]);

  // ── URL writers ──────────────────────────────────────────────────
  const updateUrl = useCallback(
    (next: { person?: string | null; tab?: TeamHubTab; surface?: SurfaceDescriptor | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      if ('person' in next) {
        if (next.person) params.set('person', next.person);
        else params.delete('person');
      }
      if ('tab' in next && next.tab) params.set('tab', next.tab);
      if ('surface' in next) {
        if (next.surface) params.set('surface', formatSurfaceDescriptor(next.surface));
        else params.delete('surface');
      }
      // Always carry the `view=board` flag so the /team shell keeps
      // rendering this view across in-board navigations.
      params.set('view', 'board');
      router.replace(`/team?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const handleSelectPerson = useCallback(
    (id: string) => {
      // Switching person closes any open right-pane surface — the surface
      // ids are person-scoped (a take id only makes sense for that
      // narrator) so carrying them across people would 404 the embedded
      // component.
      updateUrl({ person: id, surface: null });
    },
    [updateUrl],
  );

  const handleTabChange = useCallback(
    (next: TeamHubTab) => updateUrl({ tab: next }),
    [updateUrl],
  );

  const handleCloseSurface = useCallback(() => updateUrl({ surface: null }), [updateUrl]);

  const handleOpenSurface = useCallback(
    (next: SurfaceDescriptor) => updateUrl({ surface: next }),
    [updateUrl],
  );

  // ── Selected entry resolution ────────────────────────────────────
  // First-render fallback: if no person is in the URL, auto-select the
  // first roster entry once data lands. This keeps the empty-middle
  // state from being the default for returning users.
  useEffect(() => {
    if (loading || personId || roster.length === 0) return;
    updateUrl({ person: roster[0].id });
  }, [loading, personId, roster, updateUrl]);

  const selectedEntry = useMemo(
    () => (personId ? roster.find((e) => e.id === personId) ?? null : null),
    [personId, roster],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] overflow-hidden">
      {/* Team view switcher — People / Board (this view). Sits above the
          three-pane so the user can flip back to the CRUD with one click. */}
      <div className="px-6 pt-4 pb-3 shrink-0">
        <TeamTabBar />
      </div>
      <div className="relative flex flex-1 overflow-hidden">
        <LeftRail
          entries={roster}
          selectedId={personId}
          onSelect={handleSelectPerson}
          search={search}
          onSearchChange={setSearch}
          filter={filter}
          onFilterChange={setFilter}
          onAddPerson={() => setAddModalOpen(true)}
          loading={loading}
        />

        <MiddlePane entry={selectedEntry} tab={tab} onTabChange={handleTabChange}>
          {selectedEntry && tab === 'tasks' && (
            <TasksTab entry={selectedEntry} onOpenSurface={handleOpenSurface} />
          )}
          {selectedEntry && tab === 'their-view' && <TheirViewTab entry={selectedEntry} />}
          {selectedEntry && tab === 'activity' && <ActivityTab entry={selectedEntry} onOpenSurface={handleOpenSurface} />}
          {selectedEntry && tab === 'settings' && <SettingsTab entry={selectedEntry} onChanged={loadRoster} />}
        </MiddlePane>

        <RightPane surface={surface} onClose={handleCloseSurface}>
          {surface && (
            <SurfaceMounter surface={surface} owner={OWNER_AUTHOR} targetEntry={selectedEntry} />
          )}
        </RightPane>

        <AddPersonModal
          open={addModalOpen}
          onClose={() => setAddModalOpen(false)}
          onCreated={(newId) => {
            // Refresh the roster, then deep-select the new entry on the
            // next tick so the user lands directly in their command center.
            loadRoster().then(() => updateUrl({ person: newId, tab: 'tasks', surface: null }));
          }}
        />
      </div>
    </div>
  );
}

// ── Tasks tab dispatcher ────────────────────────────────────────────
//
// Each role gets its own command center template. A multi-role
// collaborator (e.g. someone who is both narrator AND editor) shows up
// in BOTH role groups in the rail and can be selected from either; this
// dispatcher renders ALL applicable templates stacked, with the most
// active role first. Channel editors render their own template.

interface TasksTabProps {
  entry: RosterEntry;
  onOpenSurface: (surface: SurfaceDescriptor) => void;
}

function TasksTab({ entry, onOpenSurface }: TasksTabProps) {
  if (entry.kind === 'channel_editor') {
    return <ChannelEditorTasksTab entry={entry} />;
  }

  // Order matters: most-relevant template first. Narrator first because
  // it's the highest-traffic role for this user; editor next; then
  // reviewer/client which are read-mostly.
  const sections: React.ReactNode[] = [];
  if (entry.roles.includes('narrator')) {
    sections.push(<NarratorTasksTab key="narrator" entry={entry} onOpenSurface={onOpenSurface} />);
  }
  if (entry.roles.includes('editor')) {
    sections.push(<EditorTasksTab key="editor" entry={entry} onOpenSurface={onOpenSurface} />);
  }
  if (entry.roles.includes('reviewer') || entry.roles.includes('client')) {
    sections.push(<ReviewerTasksTab key="reviewer" entry={entry} onOpenSurface={onOpenSurface} />);
  }

  if (sections.length === 0) {
    return (
      <TabEmpty
        title="No applicable role"
        body="This person has no role mapped to a tasks template yet."
      />
    );
  }

  return <div className="space-y-6">{sections}</div>;
}

// ── Tab placeholders (replaced by remaining commits) ───────────────

function TabEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h3>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {body}
      </p>
    </div>
  );
}

