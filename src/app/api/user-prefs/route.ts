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

const MAX_KEY_LEN = 120;
const MAX_VALUE_BYTES = 32_768;

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
    for (const r of rows) prefs[r.key] = r.value;
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

  // Size guard so a misbehaving client can't write 10 MB of garbage
  // into one row.
  const serialized = JSON.stringify(body.value);
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
    logger.info('[user-prefs set]', { user_id: session.uid, key, bytes: serialized.length });
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
