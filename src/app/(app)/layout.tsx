import { redirect } from 'next/navigation';
import { sql } from '@vercel/postgres';
import { AppLayout } from '@/components/layout/AppLayout';
import { getSession } from '@/lib/session';
import { findUserById } from '@/lib/users';
import { resolveActiveChannelId } from '@/lib/active-channel';
import type { ChannelOption } from '@/components/layout/ChannelSwitcher';

/**
 * Server-component layout for every protected (app) route.
 *
 * Resolves the session, the user record, the user's active channel, and the
 * list of channels in the user's workspace — once per render — and threads
 * them into AppLayout via props. The proxy already gates unauthenticated
 * users at the edge; this gate is defense-in-depth (and handles the
 * suspended-user case, which the proxy doesn't).
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const me = await findUserById(session.uid);
  if (!me || me.status === 'suspended') redirect('/login');

  // Resolve active channel against the workspace — if the user pinned a
  // channel that's since been deleted, fall back to "All channels" rather
  // than carry around a dangling id.
  const activeChannelId = await resolveActiveChannelId(session.uid, session.ws);

  // Workspace's channels for the switcher dropdown. ORDER BY name keeps the
  // dropdown stable as new channels arrive.
  const { rows: channels } = await sql<ChannelOption>`
    SELECT id, name, account_color
      FROM channels
     WHERE workspace_id = ${session.ws}::uuid
     ORDER BY name ASC, created_at ASC
  `;

  return (
    <AppLayout
      user={{
        id: me.id,
        name: me.name,
        email: me.email,
        system_role: me.system_role,
      }}
      channels={channels}
      activeChannelId={activeChannelId}
    >
      {children}
    </AppLayout>
  );
}
