/**
 * Encrypted per-user settings, persisted in `collaborators.encrypted_settings`.
 *
 * The column is encrypted at rest (AES-256-GCM via crypto.ts). The blob holds
 * a versioned JSON object so future fields can be added without coordinated
 * migrations. Clients read settings server-side via `getUserSettings(userId)`
 * and mutate via `updateUserSettings(userId, patch)`.
 *
 * For Phase 2 PR #1 the only field is `active_channel_id` — the channel
 * pinned to the top-bar switcher. Future fields can be slotted in alongside
 * (UI density, keyboard-shortcut overrides, default models per feature, etc.).
 */
import { sql } from '@vercel/postgres';
import { encrypt, decrypt } from './crypto';

export const SETTINGS_VERSION = 1;

export interface UserSettings {
  v: typeof SETTINGS_VERSION;
  active_channel_id?: string | null;
  /** Per-user default model for the production-doc B-roll / animation
   *  picker. `null` or absent means "fall back to the registry's
   *  DEFAULT_BROLL_MODEL_ID". Validated against the live registry at
   *  the API layer before being persisted. */
  default_broll_model_id?: string | null;
  /** Per-user default visual-style preset for the production-doc form.
   *  Stored as the style slug (e.g. 'doodle_explainer', 'cinematic') or
   *  a workspace-saved style UUID. `null` or absent means "fall back to
   *  the library default". Applied when the user starts a fresh session
   *  (no form-input cache); the in-session form-input cache takes
   *  precedence over this for normal refreshes so the user's most recent
   *  choice always wins for the current doc. */
  default_style_preset?: string | null;
}

const DEFAULTS: UserSettings = { v: SETTINGS_VERSION };

/**
 * Pure parser. Used inside getUserSettings; exported for tests so the
 * fault-tolerant logic doesn't require a real DB to verify.
 *
 * Anything that fails to decrypt, parse, or shape-check returns DEFAULTS —
 * a corrupt blob shouldn't lock the user out of the app.
 */
export function parseUserSettings(encryptedBlob: string | null): UserSettings {
  if (!encryptedBlob) return { ...DEFAULTS };
  let decoded: string;
  try {
    decoded = decrypt(encryptedBlob);
  } catch {
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== SETTINGS_VERSION) return { ...DEFAULTS };
  const out: UserSettings = { v: SETTINGS_VERSION };
  if (typeof obj.active_channel_id === 'string') {
    out.active_channel_id = obj.active_channel_id;
  } else if (obj.active_channel_id === null) {
    out.active_channel_id = null;
  }
  if (typeof obj.default_broll_model_id === 'string') {
    out.default_broll_model_id = obj.default_broll_model_id;
  } else if (obj.default_broll_model_id === null) {
    out.default_broll_model_id = null;
  }
  if (typeof obj.default_style_preset === 'string') {
    out.default_style_preset = obj.default_style_preset;
  } else if (obj.default_style_preset === null) {
    out.default_style_preset = null;
  }
  return out;
}

/** Pure serializer; always stamps the current version regardless of input. */
export function serializeUserSettings(settings: UserSettings): string {
  return encrypt(JSON.stringify({ ...settings, v: SETTINGS_VERSION }));
}

/** Read the user's settings. Falls back to defaults on missing / corrupt data. */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  if (!userId) return { ...DEFAULTS };
  const { rows } = await sql<{ encrypted_settings: string | null }>`
    SELECT encrypted_settings FROM collaborators WHERE id = ${userId} LIMIT 1
  `;
  return parseUserSettings(rows[0]?.encrypted_settings ?? null);
}

/** Merge `patch` into the user's settings + persist. Returns the merged shape. */
export async function updateUserSettings(
  userId: string,
  patch: Partial<UserSettings>,
): Promise<UserSettings> {
  if (!userId) throw new Error('userId is required');
  const current = await getUserSettings(userId);
  const merged: UserSettings = { ...current, ...patch, v: SETTINGS_VERSION };
  const encrypted = serializeUserSettings(merged);
  await sql`
    UPDATE collaborators SET encrypted_settings = ${encrypted} WHERE id = ${userId}
  `;
  return merged;
}
