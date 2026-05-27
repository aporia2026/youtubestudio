/**
 * Shared CRUD helpers for the four feature-preset tables introduced
 * in migration 0097 (script_presets, qa_presets, narration_presets,
 * idea_presets). Each table is a workspace-scoped row with the same
 * lifecycle:
 *
 *   GET    /api/auto-pipeline/{feature}-presets         — list
 *   POST   /api/auto-pipeline/{feature}-presets         — create
 *   GET    /api/auto-pipeline/{feature}-presets/[id]    — read one
 *   PATCH  /api/auto-pipeline/{feature}-presets/[id]    — update
 *   DELETE /api/auto-pipeline/{feature}-presets/[id]    — delete
 *
 * The route files become five-line wrappers that import the relevant
 * config + handler factory. The handlers do validation,
 * workspace-scoping, and the SQL.
 *
 * Plan: `_plans/2026-05-27-feature-preset-tables-bundle.md`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import type { FeaturePresetConfig, FeaturePresetField } from './feature-preset-configs';

// Re-export the configs from the client-safe configs file. The 4
// configs live there so React admin pages can import them without
// pulling in server-side dependencies (`apiRoute`, `sql`, etc.) that
// this file declares above.
export {
  SCRIPT_PRESET_CONFIG,
  QA_PRESET_CONFIG,
  NARRATION_PRESET_CONFIG,
  IDEA_PRESET_CONFIG,
} from './feature-preset-configs';
export type { FeaturePresetConfig, FeaturePresetField, FeaturePresetFieldType } from './feature-preset-configs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Coerce + validate a single field. Returns either the coerced value
 * (to be passed straight to a parameterized query) or an error
 * message. `null` is always a valid value for non-required fields and
 * for `required` on PATCH (the validator only enforces `required` on
 * create; PATCH treats undefined as "leave it alone" and explicit
 * null as "clear it").
 */
function coerceField(
  field: FeaturePresetField,
  raw: unknown,
  isCreate: boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === undefined) {
    if (isCreate && field.required) {
      return { ok: false, error: `${field.column} is required` };
    }
    return { ok: true, value: undefined };
  }
  if (raw === null) {
    if (isCreate && field.required) {
      return { ok: false, error: `${field.column} cannot be null` };
    }
    return { ok: true, value: null };
  }
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, error: `${field.column} must be a string` };
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        if (field.required && isCreate) return { ok: false, error: `${field.column} cannot be empty` };
        return { ok: true, value: null };
      }
      if (field.maxLength && trimmed.length > field.maxLength) {
        return { ok: false, error: `${field.column} must be ≤ ${field.maxLength} chars` };
      }
      return { ok: true, value: trimmed };
    }
    case 'int': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, error: `${field.column} must be a number` };
      }
      const n = Math.floor(raw);
      if (field.min !== undefined && n < field.min) return { ok: false, error: `${field.column} must be ≥ ${field.min}` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `${field.column} must be ≤ ${field.max}` };
      return { ok: true, value: n };
    }
    case 'numeric': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, error: `${field.column} must be a number` };
      }
      if (field.min !== undefined && raw < field.min) return { ok: false, error: `${field.column} must be ≥ ${field.min}` };
      if (field.max !== undefined && raw > field.max) return { ok: false, error: `${field.column} must be ≤ ${field.max}` };
      return { ok: true, value: raw };
    }
    case 'uuid': {
      if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
        return { ok: false, error: `${field.column} must be a UUID string` };
      }
      return { ok: true, value: raw };
    }
    case 'jsonb': {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: `${field.column} must be a JSON object` };
      }
      return { ok: true, value: JSON.stringify(raw) };
    }
    case 'enum': {
      if (typeof raw !== 'string' || !field.enumValues?.includes(raw)) {
        return { ok: false, error: `${field.column} must be one of: ${field.enumValues?.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
  }
}

// ─── SQL builders ───────────────────────────────────────────────────

function selectListColumns(config: FeaturePresetConfig): string {
  // Always returns id + the user-facing fields + created_at + updated_at.
  // UUID and JSONB columns get casted appropriately for transport.
  const cols = [`id::text AS id`];
  for (const f of config.fields) {
    if (f.type === 'uuid') cols.push(`${f.column}::text AS ${f.column}`);
    else cols.push(f.column);
  }
  cols.push(`created_at::text AS created_at`, `updated_at::text AS updated_at`);
  return cols.join(', ');
}

// ─── Handler factories ──────────────────────────────────────────────

export function listHandler(config: FeaturePresetConfig) {
  return apiRoute.authed(async (session) => {
    const { rows } = await sql.query(
      `SELECT ${selectListColumns(config)}
         FROM ${config.table}
        WHERE workspace_id = $1::uuid
        ORDER BY updated_at DESC`,
      [session.ws],
    );
    return NextResponse.json({ presets: rows });
  });
}

export function createHandler(config: FeaturePresetConfig) {
  return apiRoute.authed(async (session, req: NextRequest) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    // Coerce every field. Fail at the first invalid one — clearer than
    // batched errors for this user-facing form.
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const f of config.fields) {
      const r = coerceField(f, b[f.column], true);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      if (r.value === undefined) continue;
      columns.push(f.column);
      values.push(r.value);
    }

    // Always set workspace_id + created_by from session. The placeholders
    // are 1-indexed; column lists start with workspace_id and created_by
    // at positions 1 and 2, then the user-supplied columns after.
    const allColumns = ['workspace_id', 'created_by', ...columns];
    const placeholders = allColumns.map((c, i) => {
      if (c === 'workspace_id') return `$${i + 1}::uuid`;
      if (c === 'created_by') return `$${i + 1}::uuid`;
      // jsonb fields need explicit cast (we stringified above)
      const field = config.fields.find(f => f.column === c);
      if (field?.type === 'jsonb') return `$${i + 1}::jsonb`;
      if (field?.type === 'uuid') return `$${i + 1}::uuid`;
      return `$${i + 1}`;
    });

    try {
      const { rows } = await sql.query(
        `
        INSERT INTO ${config.table} (${allColumns.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING ${selectListColumns(config)}
        `,
        [session.ws, session.uid, ...values],
      );
      return NextResponse.json({ preset: rows[0] }, { status: 201 });
    } catch (err) {
      return domainErrorResponse(err, {
        op: `${config.table}: create`,
        knownPatterns: [
          { match: /unique constraint|duplicate key/i, status: 409 },
        ],
        fallbackMessage: `Failed to create ${config.label}.`,
      });
    }
  });
}

export function getOneHandler(config: FeaturePresetConfig) {
  return apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
    const { id } = await ctx.params;
    const { rows } = await sql.query(
      `SELECT ${selectListColumns(config)}
         FROM ${config.table}
        WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [id, session.ws],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: `${config.label} not found.` }, { status: 404 });
    }
    return NextResponse.json({ preset: rows[0] });
  });
}

export function patchHandler(config: FeaturePresetConfig) {
  return apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
    const { id } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
    }
    const b = body as Record<string, unknown>;

    // Coerce only the fields actually present in the body. Build the
    // SET list dynamically. Empty patch is a noop returning the
    // current row.
    const setParts: string[] = [];
    const values: unknown[] = [id, session.ws];
    let placeholderIdx = 3;
    for (const f of config.fields) {
      if (!(f.column in b)) continue;
      const r = coerceField(f, b[f.column], false);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      if (r.value === undefined) continue;
      let castSuffix = '';
      if (f.type === 'uuid') castSuffix = '::uuid';
      else if (f.type === 'jsonb') castSuffix = '::jsonb';
      setParts.push(`${f.column} = $${placeholderIdx}${castSuffix}`);
      values.push(r.value);
      placeholderIdx++;
    }

    if (setParts.length === 0) {
      // No changes — just return the current row.
      const { rows } = await sql.query(
        `SELECT ${selectListColumns(config)}
           FROM ${config.table}
          WHERE id = $1::uuid AND workspace_id = $2::uuid`,
        [id, session.ws],
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: `${config.label} not found.` }, { status: 404 });
      }
      return NextResponse.json({ preset: rows[0] });
    }

    setParts.push(`updated_at = NOW()`);

    try {
      const { rows } = await sql.query(
        `
        UPDATE ${config.table}
           SET ${setParts.join(', ')}
         WHERE id = $1::uuid AND workspace_id = $2::uuid
        RETURNING ${selectListColumns(config)}
        `,
        values,
      );
      if (rows.length === 0) {
        return NextResponse.json({ error: `${config.label} not found.` }, { status: 404 });
      }
      return NextResponse.json({ preset: rows[0] });
    } catch (err) {
      return domainErrorResponse(err, {
        op: `${config.table}: update`,
        knownPatterns: [
          { match: /unique constraint|duplicate key/i, status: 409 },
        ],
        fallbackMessage: `Failed to update ${config.label}.`,
      });
    }
  });
}

export function deleteHandler(config: FeaturePresetConfig) {
  return apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
    const { id } = await ctx.params;
    try {
      const { rowCount } = await sql.query(
        `DELETE FROM ${config.table} WHERE id = $1::uuid AND workspace_id = $2::uuid`,
        [id, session.ws],
      );
      if (!rowCount) {
        return NextResponse.json({ error: `${config.label} not found.` }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      // FK violation = pipeline_presets still references this preset.
      // The FK is ON DELETE SET NULL so this shouldn't happen, but be
      // defensive: a future tighter constraint would surface here.
      return domainErrorResponse(err, {
        op: `${config.table}: delete`,
        knownPatterns: [
          { match: /foreign key constraint|violates foreign key/i, status: 409 },
        ],
        fallbackMessage: `Failed to delete ${config.label}.`,
      });
    }
  });
}
