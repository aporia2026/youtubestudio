/**
 * Per-user cross-machine UI-preferences API.
 *
 * Phase 3.1 of the 2026-05-29 persistence-rebuild plan
 * (_plans/2026-05-29-persistence-rebuild.md). Backs the
 * `src/lib/user-prefs.ts` client helper, which migrates the
 * production-doc page's localStorage-only preferences (image model,
 * overlay default, brand kit, etc.) into the `user_settings` table
 * from migration 0102.
 *
 * Naming note: this lives under /api/user-prefs/ and uses the
 * client-side term "preferences" (UI choices: image-model picker
 * default, overlay default, brand kit, editor zoom). It is DISTINCT
 * from `src/lib/user-settings.ts` which handles encrypted server-side
 * account settings stored on collaborators.encrypted_settings
 * (active channel id, broll model defaults). The two concepts shared
 * the "settings" name historically — keep them separate going forward.
 *
 * Endpoints:
 *   GET  /api/user-prefs        → { prefs: Record<string, unknown> }
 *   PUT  /api/user-prefs        → upsert one (key, value); body { key, value }
 *
 * Storage: the `user_settings` table from migration 0102. Composite
 * PK (user_id, key); JSONB value; updated_at for last-write-wins
 * conflict resolution across machines.
 *
 * Auth: standard apiRoute.authed gate. user_id binds to session.uid;
 * no cross-user reads possible by design.
 *
 * Dedup: the PUT route honors X-Intent-Id via the mutation_ids
 * helper. A retried client PUT with the same id short-circuits
 * without re-running the upsert. The client mutate() chokepoint
 * sets X-Intent-Id automatically.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { apiRoute } from '@/lib/route-helpers';
import { tryClaimIntent } from '@/lib/mutation-ids';
import { logger } from '@/lib/logger';
import { encrypt, decrypt } from '@/lib/crypto';

const MAX_KEY_LEN = 120;
const MAX_VALUE_BYTES = 32_768;

// Keys whose value is encrypted at rest with AES-256-GCM. Read +
// write paths transparently encrypt / decrypt for these so the
// client receives plaintext on GET and sends plaintext on PUT — the
// only difference vs a regular pref is the on-disk shape, which is
// `{ "__enc": "<base64 ciphertext>" }` instead of the raw value.
//
// Adding a key here means the next write of that key will be
// encrypted. Existing plaintext values continue to read correctly
// (the GET path falls back to the raw value when the row's JSONB
// doesn't carry the `__enc` envelope).
//
// Do NOT add a key here without also rotating it on the client side
// — the prior plaintext copy persists in localStorage and could be
// scraped by anything with DOM access. The Settings UI's "save key"
// flow should clear the legacy localStorage key after the first
// encrypted write lands.
const ENCRYPTED_KEYS = new Set<string>([
  'perplexity_api_key',
  'elevenlabs_api_key',
]);

/** Wrap any JSON-serialisable value in the encryption envelope.
 *  Format: { __enc: <base64 of aes-256-gcm(iv|tag|ciphertext)> }. */
function encryptEnvelope(value: unknown): { __enc: string } {
  const plaintext = JSON.stringify(value);
  return { __enc: encrypt(plaintext) };
}

/** Reverse `encryptEnvelope`. Returns the unwrapped value when the
 *  row carries the envelope; returns the raw value as-is when it
 *  doesn't (back-compat for any pre-encryption rows in the DB at
 *  the time the encryption list was extended). Failure to decrypt
 *  (key rotated, ciphertext corrupted) returns `null` and logs;
 *  the client treats null as "no value" and falls back to its
 *  default, which is safer than throwing a 500 and bricking the
 *  whole settings GET. */
function decryptEnvelopeIfNeeded(value: unknown, key: string): unknown {
  if (value && typeof value === 'object' && '__enc' in value) {
    const enc = (value as { __enc: unknown }).__enc;
    if (typeof enc !== 'string') return null;
    try {
      return JSON.parse(decrypt(enc));
    } catch (err) {
      logger.warn('[user-prefs decrypt failed]', {
        key,
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  return value;
}

interface PutBody {
  key?: unknown;
  value?: unknown;
}

interface SettingRow {
  key: string;
  value: unknown;
  updated_at: Date;
}

export const GET = apiRoute.authed(async (session) => {
  try {
    const { rows } = await sql<SettingRow>`
      SELECT key, value, updated_at
        FROM user_settings
       WHERE user_id = ${session.uid}::uuid
    `;
    const prefs: Record<string, unknown> = {};
    for (const r of rows) {
      prefs[r.key] = decryptEnvelopeIfNeeded(r.value, r.key);
    }
    logger.info('[user-prefs get]', { user_id: session.uid, count: rows.length });
    return NextResponse.json({ prefs });
  } catch (err) {
    logger.error('[user-prefs get] failed', {
      user_id: session.uid,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Could not load preferences' },
      { status: 500 },
    );
  }
});

export const PUT = apiRoute.authed(async (session, req: NextRequest) => {
  // Phase 1.2 idempotency: X-Intent-Id dedup via mutation_ids.
  const dedup = await tryClaimIntent(req, session.uid, 'user-prefs.set');
  if (dedup === 'duplicate') {
    return NextResponse.json({ ok: true, deduped: true });
  }
  if (dedup === 'kind-mismatch') {
    return NextResponse.json(
      { error: 'X-Intent-Id reused with a different kind' },
      { status: 409 },
    );
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate key — bounded string, no whitespace surround. The PK
  // in user_settings is (user_id, key); a malformed key would
  // pollute the keyspace permanently if it slipped through.
  if (typeof body.key !== 'string') {
    return NextResponse.json({ error: 'key must be a string' }, { status: 400 });
  }
  const key = body.key.trim();
  if (!key || key.length > MAX_KEY_LEN || /\s/.test(key)) {
    return NextResponse.json({ error: 'key invalid or too long' }, { status: 400 });
  }
  if (body.value === undefined) {
    return NextResponse.json({ error: 'value is required (pass null to clear)' }, { status: 400 });
  }

  // null clears the pref (DELETE) so the next GET drops back to
  // whatever default the client uses. Non-null upserts.
  if (body.value === null) {
    try {
      await sql`
        DELETE FROM user_settings
         WHERE user_id = ${session.uid}::uuid
           AND key = ${key}
      `;
      logger.info('[user-prefs clear]', { user_id: session.uid, key });
      return NextResponse.json({ ok: true, cleared: true });
    } catch (err) {
      logger.error('[user-prefs clear] failed', {
        user_id: session.uid,
        key,
        detail: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: 'Could not clear preference' }, { status: 500 });
    }
  }

  // For encrypted keys, wrap in the envelope BEFORE the size check
  // so we account for the ciphertext expansion (~33% base64 + IV +
  // tag overhead). The cap stays at 32 KB which is plenty for an
  // API key but loose enough that the envelope overhead doesn't
  // trip legitimate writes.
  const isEncrypted = ENCRYPTED_KEYS.has(key);
  const storedValue = isEncrypted ? encryptEnvelope(body.value) : body.value;
  const serialized = JSON.stringify(storedValue);
  if (serialized.length > MAX_VALUE_BYTES) {
    return NextResponse.json(
      { error: `value too large (${serialized.length} > ${MAX_VALUE_BYTES} bytes)` },
      { status: 400 },
    );
  }

  try {
    await sql`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (${session.uid}::uuid, ${key}, ${serialized}::jsonb, NOW())
      ON CONFLICT (user_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = NOW()
    `;
    logger.info('[user-prefs set]', {
      user_id: session.uid,
      key,
      bytes: serialized.length,
      encrypted: isEncrypted,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('[user-prefs set] failed', {
      user_id: session.uid,
      key,
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Could not save preference' }, { status: 500 });
  }
});
