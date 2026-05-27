import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';

/**
 * GET  /api/auto-pipeline/presets — list workspace presets.
 * POST /api/auto-pipeline/presets — create a new preset.
 *
 * Minimal CRUD for the v1 pipeline UI. Update + delete come in a
 * follow-up push (the user can re-create presets in the
 * meantime).
 */

export const GET = apiRoute.authed(async (session) => {
  // `production_doc_style_id` is included so the Auto-continue modal
  // (and other pickers) can render the default visual style without
  // a fan-out of N follow-up GET requests for each preset's full row.
  const { rows } = await sql.query<{
    id: string;
    name: string;
    niche: string | null;
    ideas_count_default: number;
    qa_min_score: string;
    qa_max_iterations: number;
    script_gate_enabled: boolean;
    narration_deadline_days: number;
    video_editor_collaborator_id: string | null;
    thumbnail_template_id: string | null;
    seo_template_id: string | null;
    production_doc_style_id: string | null;
    updated_at: string;
  }>(
    `
    SELECT id::text AS id,
           name,
           niche,
           ideas_count_default,
           qa_min_score::text AS qa_min_score,
           qa_max_iterations,
           script_gate_enabled,
           narration_deadline_days,
           video_editor_collaborator_id::text AS video_editor_collaborator_id,
           thumbnail_template_id::text AS thumbnail_template_id,
           seo_template_id::text AS seo_template_id,
           production_doc_style_id::text AS production_doc_style_id,
           updated_at::text AS updated_at
      FROM pipeline_presets
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [session.ws],
  );
  return NextResponse.json({ presets: rows });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: 'name max 200 chars' }, { status: 400 });

  const niche = typeof b.niche === 'string' ? b.niche.trim() : null;
  const ideasCountDefault = clampInt(b.ideas_count_default ?? 5, 1, 50, 5);
  const qaMinScore = clampInt(b.qa_min_score ?? 75, 0, 100, 75);
  const qaMaxIterations = clampInt(b.qa_max_iterations ?? 3, 0, 10, 3);
  const scriptGateEnabled = b.script_gate_enabled !== false; // default true
  const narrationDeadlineDays = clampInt(b.narration_deadline_days ?? 7, 1, 90, 7);
  const targetSpokenWords =
    typeof b.target_spoken_words === 'number' && Number.isFinite(b.target_spoken_words)
      ? Math.max(50, Math.min(50000, Math.floor(b.target_spoken_words)))
      : null;
  const videoEditorCollaboratorId =
    typeof b.video_editor_collaborator_id === 'string' && b.video_editor_collaborator_id.length > 0
      ? b.video_editor_collaborator_id
      : null;
  const thumbnailTemplateId =
    typeof b.thumbnail_template_id === 'string' && b.thumbnail_template_id.length > 0
      ? b.thumbnail_template_id
      : null;
  const seoTemplateId =
    typeof b.seo_template_id === 'string' && b.seo_template_id.length > 0
      ? b.seo_template_id
      : null;
  const productionDocStyleId =
    typeof b.production_doc_style_id === 'string' && b.production_doc_style_id.length > 0
      ? b.production_doc_style_id
      : null;
  const scriptStylePresetId =
    typeof b.script_style_preset_id === 'string' && b.script_style_preset_id.length > 0
      ? b.script_style_preset_id
      : null;
  const ideaContext = isObject(b.idea_context) ? b.idea_context : null;
  const scriptRules = isObject(b.script_rules) ? b.script_rules : null;
  const fallbackChains = isObject(b.fallback_chains) ? b.fallback_chains : null;

  try {
    const { rows } = await sql.query<{ id: string }>(
      `
      INSERT INTO pipeline_presets (
        workspace_id, name, niche, ideas_count_default,
        idea_context_jsonb, script_rules_jsonb, target_spoken_words,
        qa_min_score, qa_max_iterations, script_gate_enabled,
        narration_deadline_days, fallback_chains_jsonb,
        video_editor_collaborator_id, thumbnail_template_id, seo_template_id,
        production_doc_style_id, script_style_preset_id, created_by
      ) VALUES (
        $1::uuid, $2, $3, $4,
        $5::jsonb, $6::jsonb, $7,
        $8, $9, $10,
        $11, $12::jsonb,
        $13::uuid, $14::uuid, $15::uuid,
        $16::uuid, $17::uuid, $18::uuid
      )
      RETURNING id::text AS id
      `,
      [
        session.ws,
        name,
        niche,
        ideasCountDefault,
        ideaContext ? JSON.stringify(ideaContext) : null,
        scriptRules ? JSON.stringify(scriptRules) : null,
        targetSpokenWords,
        qaMinScore,
        qaMaxIterations,
        scriptGateEnabled,
        narrationDeadlineDays,
        fallbackChains ? JSON.stringify(fallbackChains) : null,
        videoEditorCollaboratorId,
        thumbnailTemplateId,
        seoTemplateId,
        productionDocStyleId,
        scriptStylePresetId,
        session.uid,
      ],
    );
    return NextResponse.json({ id: rows[0].id }, { status: 201 });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'auto-pipeline: create preset',
      knownPatterns: [
        { match: /pipeline_presets_workspace_id_name_key|duplicate key/i, status: 409 },
      ],
      fallbackMessage: 'Failed to create preset.',
    });
  }
});

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return Math.max(min, Math.min(max, n));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
