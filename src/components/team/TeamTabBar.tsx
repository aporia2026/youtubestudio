'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Two-way switch rendered at the top of both Team surfaces.
 *
 *   People  →  /team             (collaborator CRUD + access management)
 *   Board   →  /team?view=board  (three-pane cockpit, per-person tasks)
 *
 * The Board tab preserves the existing `?person`, `?tab`, `?surface`
 * params when present, so toggling People → Board → People doesn't lose
 * the user's place inside the board.
 */
export function TeamTabBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Active branch: any pathname starting with /team-hub OR /team with
  // ?view=board both count as "Board".
  const onBoard =
    pathname.startsWith('/team-hub') ||
    (pathname === '/team' && searchParams.get('view') === 'board');

  // Carry the current params across both tab links so toggling People →
  // Board → People doesn't drop the user's selected person / tab /
  // surface. People simply strips `view`; Board re-asserts it. The
  // People view ignores the board-specific params it doesn't recognise.
  const peopleParams = new URLSearchParams(searchParams.toString());
  peopleParams.delete('view');
  const peopleQs = peopleParams.toString();
  const peopleHref = peopleQs ? `/team?${peopleQs}` : '/team';

  const boardParams = new URLSearchParams(searchParams.toString());
  boardParams.set('view', 'board');
  const boardHref = `/team?${boardParams.toString()}`;

  return (
    <div
      className="flex gap-1 p-1 rounded-lg w-fit"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      <TabLink href={peopleHref} label="People" active={!onBoard} />
      <TabLink href={boardHref} label="Board" active={onBoard} />
    </div>
  );
}

function TabLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors"
      style={{
        background: active ? 'rgba(124,58,237,0.2)' : 'transparent',
        color: active ? '#a78bfa' : 'var(--text-muted)',
      }}
    >
      {label}
    </Link>
  );
}
