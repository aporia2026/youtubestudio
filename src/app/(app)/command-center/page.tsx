/**
 * Command Center — Wave 2 home of the QA/cross-feature redesign.
 *
 * Server component. Loads the workspace's in-flight cards + the current
 * ISO week + the channel catalogue + the user's stuck threshold (default
 * 48h, lives in settings) in one round-trip, then hands the snapshot to
 * the client component for filter + kanban + drag interactions.
 *
 * Reads only — no mutations happen on this page render. Mutations
 * (advance, create video, kill) all go through their existing API
 * routes and trigger router.refresh() on success.
 */
import { redirect } from 'next/navigation';
import { sql } from '@vercel/postgres';
import { getSession } from '@/lib/session';
import {
  loadCommandCenterCards,
  currentIsoWeek,
  type CommandCenterCard,
} from '@/lib/command-center';
import { getWorkspaceQaSettings } from '@/lib/qa-workspace-settings';
import { CommandCenterClient } from './CommandCenterClient';

export const dynamic = 'force-dynamic';

interface ChannelOption {
  id: string;
  name: string;
  account_color: string | null;
}

export default async function CommandCenterPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  // Independent queries — parallelise.
  const [cards, channelsRes, qaSettings] = await Promise.all([
    loadCommandCenterCards(session.ws),
    sql<ChannelOption>`
      SELECT id, name, account_color
        FROM channels
       WHERE workspace_id = ${session.ws}::uuid
       ORDER BY name ASC, created_at ASC
    `,
    getWorkspaceQaSettings(session.ws),
  ]);

  const week = currentIsoWeek();
  return (
    <CommandCenterClient
      initialCards={cards}
      channels={channelsRes.rows}
      initialWeek={week}
      stuckThresholdHours={qaSettings.stuckThresholdHours}
    />
  );
}

export type { CommandCenterCard };
