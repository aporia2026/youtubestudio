import { redirect } from 'next/navigation';

/**
 * Default landing.
 *
 * Wave 2 of the Command Center plan flipped this from `/dashboard` to
 * `/command-center` — the kanban home is the new center of gravity.
 * The Dashboard page still exists and is reachable via the sidebar so
 * a user who prefers the old surface can pin it. Per the plan, a
 * follow-up may move Dashboard into Settings → Workspace → Default
 * landing page; for now both are reachable.
 */
export default function RootPage() {
  redirect('/command-center');
}
