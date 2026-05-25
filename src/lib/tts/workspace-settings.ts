/**
 * Per-workspace TTS preferences.
 *
 * Stored in `workspaces.tts_settings` (JSONB, migration 0089). Each
 * field is optional — un-set keys fall back to sensible defaults that
 * preserve pre-migration behavior:
 *
 *   - defaultProvider unset      → 'elevenlabs' (the pre-2026-05-25 default)
 *   - allowStudioTier unset      → false        (cost-safety: hide Studio)
 *   - enabledProviders unset     → both         (no NDA restriction)
 *
 * The lib functions here are the single read/write surface — every
 * call site goes through them so validation lives in one place and
 * the JSONB column can never hold malformed shapes.
 */

import { sql } from '@vercel/postgres';
import { logger } from '../logger';
import type { TtsProviderId, VoiceTier } from './types';

export interface WorkspaceTtsSettings {
  defaultProvider?: TtsProviderId;
  defaultVoiceId?: string;
  defaultVoiceProvider?: TtsProviderId;
  defaultLanguageCode?: string;
  defaultTier?: VoiceTier;
  /** Gates Google Studio ($160/1M). Default false so a misconfigured
   *  auto-pipeline can't generate Studio voiceovers without an
   *  explicit per-workspace opt-in. */
  allowStudioTier?: boolean;
  /** When set, only voices from these providers are surfaced in the
   *  picker (e.g. NDA workspaces blocking Google). Undefined or empty
   *  array means both providers are enabled. */
  enabledProviders?: TtsProviderId[];
}

/**
 * Effective settings — every field has a value resolved against the
 * default. Callers consume this; they should never read the raw
 * JSONB directly.
 */
export interface EffectiveTtsSettings {
  defaultProvider: TtsProviderId;
  defaultVoiceId: string | null;
  defaultVoiceProvider: TtsProviderId;
  defaultLanguageCode: string;
  defaultTier: VoiceTier;
  allowStudioTier: boolean;
  enabledProviders: TtsProviderId[];
}

const VALID_PROVIDERS: ReadonlySet<TtsProviderId> = new Set(['elevenlabs', 'google']);
const VALID_TIERS: ReadonlySet<VoiceTier> = new Set([
  'standard',
  'wavenet',
  'neural2',
  'polyglot',
  'chirp3-hd',
  'studio',
  'multilingual-v2',
  'turbo-v2-5',
  'turbo-v2',
  'monolingual-v1',
]);

const DEFAULTS: EffectiveTtsSettings = {
  defaultProvider: 'elevenlabs',
  defaultVoiceId: null,
  defaultVoiceProvider: 'elevenlabs',
  defaultLanguageCode: 'en-US',
  defaultTier: 'multilingual-v2',
  allowStudioTier: false,
  enabledProviders: ['elevenlabs', 'google'],
};

/**
 * Validate + sanitize an incoming settings shape. Drops unknown keys
 * silently, coerces invalid enum values to undefined, normalizes
 * arrays. Returns the cleaned partial — caller persists it to JSONB.
 */
export function validateTtsSettings(raw: unknown): WorkspaceTtsSettings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: WorkspaceTtsSettings = {};

  if (typeof r.defaultProvider === 'string' && VALID_PROVIDERS.has(r.defaultProvider as TtsProviderId)) {
    out.defaultProvider = r.defaultProvider as TtsProviderId;
  }
  if (typeof r.defaultVoiceId === 'string' && r.defaultVoiceId.trim()) {
    out.defaultVoiceId = r.defaultVoiceId.trim();
  }
  if (typeof r.defaultVoiceProvider === 'string' && VALID_PROVIDERS.has(r.defaultVoiceProvider as TtsProviderId)) {
    out.defaultVoiceProvider = r.defaultVoiceProvider as TtsProviderId;
  }
  if (typeof r.defaultLanguageCode === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(r.defaultLanguageCode)) {
    out.defaultLanguageCode = r.defaultLanguageCode;
  }
  if (typeof r.defaultTier === 'string' && VALID_TIERS.has(r.defaultTier as VoiceTier)) {
    out.defaultTier = r.defaultTier as VoiceTier;
  }
  if (typeof r.allowStudioTier === 'boolean') {
    out.allowStudioTier = r.allowStudioTier;
  }
  if (Array.isArray(r.enabledProviders)) {
    const filtered = r.enabledProviders.filter(
      (p): p is TtsProviderId => typeof p === 'string' && VALID_PROVIDERS.has(p as TtsProviderId),
    );
    // Refuse to save an empty allowlist — it would lock out all voice
    // generation. Treat empty as "no restriction" (both providers).
    if (filtered.length > 0) {
      out.enabledProviders = [...new Set(filtered)];
    }
  }
  return out;
}

/** Merge stored settings with defaults to produce the effective shape. */
export function effectiveSettings(stored: WorkspaceTtsSettings): EffectiveTtsSettings {
  return {
    defaultProvider: stored.defaultProvider ?? DEFAULTS.defaultProvider,
    defaultVoiceId: stored.defaultVoiceId ?? DEFAULTS.defaultVoiceId,
    defaultVoiceProvider:
      stored.defaultVoiceProvider ?? stored.defaultProvider ?? DEFAULTS.defaultVoiceProvider,
    defaultLanguageCode: stored.defaultLanguageCode ?? DEFAULTS.defaultLanguageCode,
    defaultTier: stored.defaultTier ?? DEFAULTS.defaultTier,
    allowStudioTier: stored.allowStudioTier ?? DEFAULTS.allowStudioTier,
    enabledProviders:
      stored.enabledProviders && stored.enabledProviders.length > 0
        ? stored.enabledProviders
        : DEFAULTS.enabledProviders,
  };
}

/**
 * Read raw stored settings for a workspace. Returns {} when the row
 * doesn't exist (shouldn't happen for any authed request but defensive
 * default keeps callers simple).
 *
 * Migration tolerance: if migration 0089 hasn't run yet (the column
 * doesn't exist), Postgres throws SQLSTATE 42703 (undefined_column).
 * We catch that specifically and return {} so the caller falls through
 * to defaults instead of getting a 500. Production deploys can't hit
 * this path (vercel-build runs migrations before the new code goes
 * live, and a failed migration fails the build) — but local dev
 * environments without `npm run db:migrate` would, and we don't want
 * the settings UI to surface a scary error in that case.
 */
export async function getStoredTtsSettings(workspaceId: string): Promise<WorkspaceTtsSettings> {
  try {
    const { rows } = await sql<{ tts_settings: WorkspaceTtsSettings | null }>`
      SELECT tts_settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `;
    const raw = rows[0]?.tts_settings ?? {};
    // Defensive validation — even though we wrote through validate, a
    // direct DB edit could leave malformed data.
    return validateTtsSettings(raw);
  } catch (err) {
    if (isUndefinedColumnError(err)) {
      logger.warn('[tts workspace-settings] tts_settings column missing — run migration 0089', {
        workspaceId,
      });
      return {};
    }
    throw err;
  }
}

/** Convenience: read + merge with defaults in one call. */
export async function getEffectiveTtsSettings(workspaceId: string): Promise<EffectiveTtsSettings> {
  return effectiveSettings(await getStoredTtsSettings(workspaceId));
}

/**
 * Replace the stored settings for a workspace. The provided partial
 * is merged with whatever's already there — callers can PATCH a single
 * field without reading first. Always validated before write.
 *
 * Migration tolerance: same undefined_column branch as the read path,
 * but the write surfaces the error to the caller — saving settings
 * before the migration runs would silently swallow the user's choice,
 * which is worse than a clear "settings unavailable" message in the UI.
 */
export async function updateTtsSettings(
  workspaceId: string,
  patch: unknown,
): Promise<WorkspaceTtsSettings> {
  const cleaned = validateTtsSettings(patch);
  const existing = await getStoredTtsSettings(workspaceId);
  const merged: WorkspaceTtsSettings = { ...existing, ...cleaned };
  try {
    await sql`
      UPDATE workspaces
         SET tts_settings = ${JSON.stringify(merged)}::jsonb
       WHERE id = ${workspaceId}::uuid
    `;
  } catch (err) {
    if (isUndefinedColumnError(err)) {
      throw new Error(
        'Voiceover settings storage is not ready yet. ' +
          'Run `npm run db:migrate` (local) or wait for the next deploy to finish.',
      );
    }
    throw err;
  }
  return merged;
}

/**
 * Postgres surfaces "column does not exist" as SQLSTATE 42703. The
 * @vercel/postgres client exposes the error with a `code` property on
 * the thrown Error. We match on that AND on a substring of the
 * message to be robust against future client-library shape changes.
 */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === '42703') return true;
  if (typeof e.message === 'string' && /column .*tts_settings.* does not exist/i.test(e.message)) {
    return true;
  }
  return false;
}
