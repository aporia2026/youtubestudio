/**
 * Active-channel state — which channel the user has pinned to the top-bar
 * switcher. `null` means "All channels" (no per-channel filtering).
 *
 * Stored inside `users.encrypted_settings` (see user-settings.ts) so the
 * selection is durable across devices and tabs without leaking into client
 * cookies.
 */
import { sql } from '@vercel/postgres';
import { getUserSettings, updateUserSettings } from './user-settings';

export class ChannelNotInWorkspaceError extends Error {
  constructor(channelId: string) {
    super(`Channel ${channelId} is not in this workspace.`);
    this.name = 'ChannelNotInWorkspaceError';
  }
}

/** Read the user's active channel. Null = "All channels". */
export async function getActiveChannelId(userId: string): Promise<string | null> {
  const s = await getUserSettings(userId);
  return s.active_channel_id ?? null;
}

/**
 * Set the user's active channel. Validates that the channel exists in the
 * user's workspace before persisting — prevents a malicious or stale client
 * from pinning a channel outside the tenant boundary.
 *
 * Pass `null` to clear (= "All channels").
 */
export async function setActiveChannelId(
  userId: string,
  channelId: string | null,
  workspaceId: string,
): Promise<void> {
  if (channelId !== null) {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM channels
       WHERE id = ${channelId}::uuid AND workspace_id = ${workspaceId}::uuid
       LIMIT 1
    `;
    if (rows.length === 0) {
      throw new ChannelNotInWorkspaceError(channelId);
    }
  }
  await updateUserSettings(userId, { active_channel_id: channelId });
}

/**
 * Resolve an active channel id with a fallback: if the user's pinned channel
 * no longer exists in their workspace (e.g. it was deleted), behave as if
 * it's null instead of returning a dangling id. Useful at request boundaries
 * where downstream code expects either a valid id or null.
 */
export async function resolveActiveChannelId(
  userId: string,
  workspaceId: string,
): Promise<string | null> {
  const id = await getActiveChannelId(userId);
  if (id === null) return null;
  const { rows } = await sql<{ id: string }>`
    SELECT id FROM channels
     WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
     LIMIT 1
  `;
  return rows.length > 0 ? id : null;
}
