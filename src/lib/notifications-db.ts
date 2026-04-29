import { sql } from '@vercel/postgres';

// Singleton row id — there's only one notification settings row for the owner
const SINGLETON_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_OWNER_EMAIL = 'yoavm7@gmail.com';

let migrated = false;

export async function ensureNotificationsSchema() {
  if (migrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS notification_settings (
        id UUID PRIMARY KEY,
        owner_email TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        on_review_comment BOOLEAN NOT NULL DEFAULT true,
        on_version_uploaded BOOLEAN NOT NULL DEFAULT true,
        on_status_changed BOOLEAN NOT NULL DEFAULT true,
        on_narrator_take BOOLEAN NOT NULL DEFAULT true,
        on_narrator_comment BOOLEAN NOT NULL DEFAULT true,
        on_assignment_received BOOLEAN NOT NULL DEFAULT true,
        on_comment_resolved BOOLEAN NOT NULL DEFAULT true,
        on_retake_requested BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    migrated = true;
  } catch (err) {
    console.error('ensureNotificationsSchema error:', err);
  }
}

export interface NotificationSettings {
  id: string;
  owner_email: string | null;
  enabled: boolean;
  on_review_comment: boolean;
  on_version_uploaded: boolean;
  on_status_changed: boolean;
  on_narrator_take: boolean;
  on_narrator_comment: boolean;
  on_assignment_received: boolean;
  on_comment_resolved: boolean;
  on_retake_requested: boolean;
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  await ensureNotificationsSchema();
  // Upsert the singleton row with default email if absent
  await sql`
    INSERT INTO notification_settings (id, owner_email)
    VALUES (${SINGLETON_ID}, ${DEFAULT_OWNER_EMAIL})
    ON CONFLICT (id) DO NOTHING
  `;
  const { rows } = await sql`SELECT * FROM notification_settings WHERE id = ${SINGLETON_ID}`;
  return rows[0] as NotificationSettings;
}

export async function updateNotificationSettings(fields: Partial<Omit<NotificationSettings, 'id'>>) {
  await ensureNotificationsSchema();
  await getNotificationSettings(); // ensure row exists
  const { rows } = await sql`
    UPDATE notification_settings SET
      owner_email = COALESCE(${fields.owner_email ?? null}, owner_email),
      enabled = COALESCE(${fields.enabled ?? null}, enabled),
      on_review_comment = COALESCE(${fields.on_review_comment ?? null}, on_review_comment),
      on_version_uploaded = COALESCE(${fields.on_version_uploaded ?? null}, on_version_uploaded),
      on_status_changed = COALESCE(${fields.on_status_changed ?? null}, on_status_changed),
      on_narrator_take = COALESCE(${fields.on_narrator_take ?? null}, on_narrator_take),
      on_narrator_comment = COALESCE(${fields.on_narrator_comment ?? null}, on_narrator_comment),
      on_assignment_received = COALESCE(${fields.on_assignment_received ?? null}, on_assignment_received),
      on_comment_resolved = COALESCE(${fields.on_comment_resolved ?? null}, on_comment_resolved),
      on_retake_requested = COALESCE(${fields.on_retake_requested ?? null}, on_retake_requested),
      updated_at = NOW()
    WHERE id = ${SINGLETON_ID}
    RETURNING *
  `;
  return rows[0] as NotificationSettings;
}

/** Convenience: should the owner be notified for this event? */
export async function ownerWantsEvent(event: keyof Omit<NotificationSettings, 'id' | 'owner_email' | 'enabled'>): Promise<{ email: string; should: boolean }> {
  const s = await getNotificationSettings();
  if (!s.enabled) return { email: s.owner_email || '', should: false };
  if (!s.owner_email) return { email: '', should: false };
  return { email: s.owner_email, should: !!s[event] };
}

// ---------------------------------------------------------------------------
// Collaborator notification preferences (extends collaborators table)
// ---------------------------------------------------------------------------

export async function getCollaboratorByUnsubscribeToken(token: string) {
  const { rows } = await sql`
    SELECT id, name, email, notifications_enabled FROM collaborators WHERE unsubscribe_token = ${token}
  `;
  return rows[0] || null;
}

export async function setCollaboratorNotifications(id: string, enabled: boolean) {
  await sql`UPDATE collaborators SET notifications_enabled = ${enabled} WHERE id = ${id}`;
}

export async function getCollaboratorEmailIfWantsNotifications(id: string): Promise<{ email: string; unsubscribeToken: string } | null> {
  const { rows } = await sql`
    SELECT email, notifications_enabled, unsubscribe_token FROM collaborators WHERE id = ${id}
  `;
  if (!rows[0]) return null;
  if (!rows[0].email || !rows[0].notifications_enabled) return null;
  return { email: rows[0].email, unsubscribeToken: rows[0].unsubscribe_token || '' };
}
