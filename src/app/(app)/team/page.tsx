'use client';

import { useSearchParams } from 'next/navigation';

import { TeamPeopleView } from '@/components/team/TeamPeopleView';
import { TeamBoardView } from '@/components/team-hub/TeamBoardView';

/**
 * /team — one unified Team surface with two views:
 *
 *   People (default) — collaborator CRUD + access management
 *   Board (?view=board) — three-pane cockpit, per-person task boards
 *
 * The two were originally separate routes (/team and /team-hub). They
 * are merged here so the sidebar can carry a single "Team" entry and
 * the naming is unambiguous; /team-hub now redirects in.
 */
export default function TeamPage() {
  const searchParams = useSearchParams();
  const view = searchParams.get('view') === 'board' ? 'board' : 'people';
  return view === 'board' ? <TeamBoardView /> : <TeamPeopleView />;
}
