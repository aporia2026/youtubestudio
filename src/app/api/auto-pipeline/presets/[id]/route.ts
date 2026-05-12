import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * GET / PATCH / DELETE for a single pipeline_preset row.
 *
 * Workspace-scoped — cross-workspace ids surface as 404.
 *
 * DELETE is blocked when one or more `pipeline_runs` still
 * reference the preset (FK is RESTRICT). The route translates
 * that to a 409 with a "still in use" message so the UI can
 * suggest renaming / cloning instead.
 */

interface PresetFull {
  id: string;
  workspace_id: string;
  name: string;
  niche: string | null;
  ideas_count_default: number;
  idea_context: Record<string, unknown> | null;
  script_rules: Record<string, unknown> | null;
  target_spoken_words: number | null;
  qa_min_score: string;
  qa_max_iterations: number;
  script_gate_enabled: boolean;
  production_doc_style_id: string | null;
  narration_deadline_days: number;
  fallback_chains: Record<string, string[]> | null;
  video_editor_collaborator_id: string | null;
  thumbnail_template_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  niche,
  ideas_count_default,
  idea_context_jsonb AS idea_context,
  script_rules_jsonb AS script_rules,
  target_spoken_words,
  qa_min_score::text AS qa_min_score,
  qa_max_iterations,
  script_gate_enabled,
  production_doc_style_id::text AS production_doc_style_id,
  narration_deadline_days,
  fallback_chains_jsonb AS fallback_chains,
  video_editor_collaborator_id::text AS video_editor_collaborator_id,
  thumbnail_template_id::text AS thumbnail_template_id,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export const GET = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id } = await ctx.params;
  const { rows } = await sql.query<PresetFull>(
    `SELECT ${ROW_SHAPE} FROM pipeline_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, session.ws],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Preset not found.' }, { status: 404 });
  }
  return NextResponse.json({ preset: rows[0] });
});

export const PATCH = apiRoute.authed<{ id: string }>(async (session, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // Defensive normalisation — every field is optional. Unknown
  // fields ignored. Type-mismatched fields rejected with a clear
  // error.
  const patch: Record<string, unknown> = {};
  try {
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) throw new Error('name must be a non-empty string');
      if (b.name.length > 200) throw new Error('name max 200 chars');
      patch.name = b.name.trim();
    }
    if (b.niche !== undefined) patch.niche = b.niche === null ? null : asStringOrThrow(b.niche, 'niche');
    if (b.ideas_count_default !== undefined) patch.ideas_count_default = clampInt(b.ideas_count_default, 1, 50, 'ideas_count_default');
    if (b.idea_context !== undefined) patch.idea_context_jsonb = asJsonObjectOrNull(b.idea_context, 'idea_context');
    if (b.script_rules !== undefined) patch.script_rules_jsonb = asJsonObjectOrNull(b.script_rules, 'script_rules');
    if (b.target_spoken_words !== undefined) {
      patch.target_spoken_words = b.target_spoken_words === null ? null : clampInt(b.target_spoken_words, 50, 50000, 'target_spoken_words');
    }
    if (b.qa_min_score !== undefined) patch.qa_min_score = clampInt(b.qa_min_score, 0, 100, 'qa_min_score');
    if (b.qa_max_iterations !== undefined) patch.qa_max_iterations = clampInt(b.qa_max_iterations, 0, 10, 'qa_max_iterations');
    if (b.script_gate_enabled !== undefined) {
      if (typeof b.script_gate_enabled !== 'boolean') throw new Error('script_gate_enabled must be boolean');
      patch.script_gate_enabled = b.script_gate_enabled;
    }
    if (b.production_doc_style_id !== undefined) {
      patch.production_doc_style_id = b.production_doc_style_id === null ? null : asUuidOrThrow(b.production_doc_style_id, 'production_doc_style_id');
    }
    if (b.narration_deadline_days !== undefined) patch.narration_deadline_days = clampInt(b.narration_deadline_days, 1, 90, 'narration_deadline_days');
    if (b.fallback_chains !== undefined) patch.fallback_chains_jsonb = asFallbackChainsOrNull(b.fallback_chains);
    if (b.video_editor_collaborator_id !== undefined) {
      patch.video_editor_collaborator_id = b.video_editor_collaborator_id === null ? null : asUuidOrThrow(b.video_editor_collaborator_id, 'video_editor_collaborator_id');
    }
    if (b.thumbnail_template_id !== undefined) {
      patch.thumbnail_template_id = b.thumbnail_template_id === null ? null : asUuidOrThrow(b.thumbnail_template_id, 'thumbnail_template_id');
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid input' }, { status: 400 });
  }

  if (Object.keys(patch).length === 0) {
    // Nothing to update — return the current row.
    const { rows } = await sql.query<PresetFull>(
      `SELECT ${ROW_SHAPE} FROM pipeline_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [id, session.ws],
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Preset not found.' }, { status: 404 });
    return NextResponse.json({ preset: rows[0] });
  }

  // Build the COALESCE-based UPDATE so unspecified fields are
  // preserved. JSONB fields need an explicit cast. Verbose but
  // safe — no dynamic SQL composition.
  try {
    const { rows } = await sql.query<PresetFull>(
      `
      UPDATE pipeline_presets
         SET name = COALESCE($3, name),
             niche = CASE WHEN $4::boolean THEN $5 ELSE niche END,
             ideas_count_default = COALESCE($6, ideas_count_default),
             idea_context_jsonb = CASE WHEN $7::boolean THEN $8::jsonb ELSE idea_context_jsonb END,
             script_rules_jsonb = CASE WHEN $9::boolean THEN $10::jsonb ELSE script_rules_jsonb END,
             target_spoken_words = CASE WHEN $11::boolean THEN $12 ELSE target_spoken_words END,
             qa_min_score = COALESCE($13, qa_min_score),
             qa_max_iterations = COALESCE($14, qa_max_iterations),
             script_gate_enabled = COALESCE($15, script_gate_enabled),
             production_doc_style_id = CASE WHEN $16::boolean THEN $17::uuid ELSE production_doc_style_id END,
             narration_deadline_days = COALESCE($18, narration_deadline_days),
             fallback_chains_jsonb = CASE WHEN $19::boolean THEN $20::jsonb ELSE fallback_chains_jsonb END,
             video_editor_collaborator_id = CASE WHEN $21::boolean THEN $22::uuid ELSE video_editor_collaborator_id END,
             thumbnail_template_id = CASE WHEN $23::boolean THEN $24::uuid ELSE thumbnail_template_id END,
             updated_at = NOW()
       WHERE id = $1::uuid AND workspace_id = $2::uuid
      RETURNING ${ROW_SHAPE}
      `,
      [
        id,
        session.ws,
        patch.name ?? null,
        patch.niche !== undefined, patch.niche ?? null,
        patch.ideas_count_default ?? null,
        patch.idea_context_jsonb !== undefined, patch.idea_context_jsonb ? JSON.stringify(patch.idea_context_jsonb) : null,
        patch.script_rules_jsonb !== undefined, patch.script_rules_jsonb ? JSON.stringify(patch.script_rules_jsonb) : null,
        patch.target_spoken_words !== undefined, patch.target_spoken_words ?? null,
        patch.qa_min_score ?? null,
        patch.qa_max_iterations ?? null,
        patch.script_gate_enabled ?? null,
        patch.production_doc_style_id !== undefined, patch.production_doc_style_id ?? null,
        patch.narration_deadline_days ?? null,
        patch.fallback_chains_jsonb !== undefined, patch.fallback_chains_jsonb ? JSON.stringify(patch.fallback_chains_jsonb) : null,
        patch.video_editor_collaborator_id !== undefined, patch.video_editor_collaborator_id ?? null,
        patch.thumbnail_template_id !== undefined, patch.thumbnail_template_id ?? null,
      ],
    );
    if (rows.length === 0) return NextResponse.json({ error: 'Preset not found.' }, { status: 404 });
    return NextResponse.json({ preset: rows[0] });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'auto-pipeline: update preset',
      knownPatterns: [
        { match: /pipeline_presets_workspace_id_name_key|duplicate key/i, status: 409 },
      ],
      fallbackMessage: 'Failed to update preset.',
    });
  }
});

export const DELETE = apiRoute.authed<{ id: string }>(async (session, _req, ctx) => {
  const { id } = await ctx.params;
  try {
    const { rowCount } = await sql.query(
      `DELETE FROM pipeline_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
      [id, session.ws],
    );
    if (!rowCount) return NextResponse.json({ error: 'Preset not found.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'auto-pipeline: delete preset',
      knownPatterns: [
        // Preset has dependent runs — FK is RESTRICT.
        { match: /foreign key constraint|violates foreign key/i, status: 409 },
      ],
      fallbackMessage: 'Preset still has runs referencing it; delete the runs first or rename the preset.',
    });
  }
});

// ─── pure validators ───────────────────────────────────────────────

function asStringOrThrow(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  const trimmed = v.trim();
  if (!trimmed) throw new Error(`${field} cannot be empty`);
  if (trimmed.length > 500) throw new Error(`${field} max 500 chars`);
  return trimmed;
}

function clampInt(v: unknown, min: number, max: number, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${field} must be a number`);
  const n = Math.floor(v);
  if (n < min || n > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return n;
}

function asJsonObjectOrNull(v: unknown, field: string): Record<string, unknown> | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${field} must be a JSON object or null`);
  return v as Record<string, unknown>;
}

function asUuidOrThrow(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a UUID string`);
  // Loose UUID check — db will reject malformed via the cast.
  if (v.length < 32 || v.length > 40) throw new Error(`${field} doesn't look like a UUID`);
  return v;
}

function asFallbackChainsOrNull(v: unknown): Record<string, string[]> | null {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('fallback_chains must be { [feature]: string[] } or null');
  const out: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(val)) throw new Error(`fallback_chains.${k} must be an array of model ids`);
    if (val.length > 10) throw new Error(`fallback_chains.${k}: max 10 entries`);
    const ids = val.filter((x): x is string => typeof x === 'string');
    out[k] = ids;
  }
  return out;
}
