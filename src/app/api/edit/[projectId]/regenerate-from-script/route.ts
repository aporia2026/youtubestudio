import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { EDITOR_V1_ENABLED } from '@/lib/feature-flags';
import { sql } from '@/lib/db';
import { logger } from '@/lib/logger';
import { generateText } from '@/lib/ai';
import { productionDocPrompt } from '@/lib/prompts';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { resolveStyle } from '@/lib/production-doc-styles';
import { getEffectiveModelId } from '@/lib/model-defaults';
import { validateAndSplitOverlongRows } from '@/lib/production-doc-postprocess';
import { readRowEditedAt } from '@/lib/editor/edited-at';
import type { ProductionDoc } from '@/remotion/utils';

/**
 * Regenerate doc from script — Phase 5 of
 * `_plans/2026-05-18-shot-graph-editor.md`.
 *
 * POST /api/edit/:projectId/regenerate-from-script
 *
 * The user edits the script (combined narration text) in the
 * editor's modal; this endpoint runs the production-doc generator
 * on the new script and MERGES the result with the existing doc:
 *
 *   - Editor-only fields (duration_override_ms, trim_*, muted,
 *     video_url_override, transition_in) carry over from the old
 *     row at the same position — the regen has no opinion on these
 *     so we keep the user's choices.
 *   - Generator-produced fields (visual_description, ai_image_prompt,
 *     on_screen_text, script_text) get the new value UNLESS the old
 *     row's per-field `edited_at` timestamp is more recent than this
 *     regen started — in which case the user's manual edit wins.
 *   - rowImages map carries over by index — regen doesn't touch
 *     generated images.
 *   - text_overlays + voiceoverUrl + captions on the doc carry over
 *     untouched (regen operates at the row level).
 *
 * The result JSONB-merges into payload and bumps version. Editor
 * reloads from server to pick it up.
 *
 * What "matching by position" means
 * ──────────────────────────────────
 * Old doc has N rows, new doc has M rows. For i in 0..min(N,M):
 *   merge old row i + new row i (per the rules above).
 * For i in [min(N,M), M): take new row as-is (no old row to merge).
 * For i in [M, N): drop the old row (script no longer has it).
 *
 * Brittle? Yes. But the alternative (semantic matching by script_text
 * similarity) requires fuzzy logic that gives different answers on
 * different runs. Position-based is predictable; the user can hand-
 * fix mismatches after.
 */

export const maxDuration = 300;
const MAX_SCRIPT_CHARS = 50_000;

interface PostBody {
  newScript?: unknown;
  niche?: unknown;
  topic?: unknown;
  modelId?: unknown;
  stylePreset?: unknown;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

interface MergeRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  ai_image_prompt: string;
  on_screen_text: string;
  notes: string;
  stock_search_terms: string;
  // Editor-only fields preserved across regens.
  duration_override_ms?: number;
  trim_start_ms?: number;
  trim_end_ms?: number;
  muted?: boolean;
  playback_rate?: number;
  video_url_override?: string;
  video_duration_seconds_override?: number;
  transition_in?: 'cross-fade' | null;
  edited_at?: ProductionDoc['rows'][number]['edited_at'];
  // Other generator-produced fields we round-trip but don't touch
  // in the merge logic explicitly.
  [k: string]: unknown;
}

/** Field-level merge: per-row, decide each generator-touched field
 *  by comparing the old row's per-field edited_at timestamp against
 *  `regenStartMs`. Newer-than-regen = manual edit wins; older or
 *  absent = regen value wins. */
function mergeRow(oldRow: MergeRow, newRow: MergeRow, regenStartMs: number): MergeRow {
  const oldEdits = readRowEditedAt(oldRow.edited_at);

  const keepIfRecentlyEdited = (
    category: 'script_text' | 'visual_description' | 'ai_image_prompt' | 'on_screen_text',
    candidate: unknown,
  ): unknown => {
    const ts = oldEdits.fields[category];
    if (!ts) return candidate; // never edited via this category → use new
    const editedAtMs = new Date(ts).getTime();
    if (!Number.isFinite(editedAtMs) || editedAtMs < regenStartMs) return candidate;
    // User edited after regen started → preserve their value
    return (oldRow as Record<string, unknown>)[category] ?? candidate;
  };

  return {
    // Generator-produced fields: regen wins unless user edited
    // them after the regen started.
    timecode: newRow.timecode,
    script_text: keepIfRecentlyEdited('script_text', newRow.script_text) as string,
    visual_type: newRow.visual_type,
    visual_description: keepIfRecentlyEdited('visual_description', newRow.visual_description) as string,
    ai_image_prompt: keepIfRecentlyEdited('ai_image_prompt', newRow.ai_image_prompt) as string,
    on_screen_text: keepIfRecentlyEdited('on_screen_text', newRow.on_screen_text) as string,
    notes: newRow.notes,
    stock_search_terms: newRow.stock_search_terms,

    // Editor-only fields carry over from the old row. The regen has
    // no opinion on these and the user's edits should survive.
    duration_override_ms: oldRow.duration_override_ms,
    trim_start_ms: oldRow.trim_start_ms,
    trim_end_ms: oldRow.trim_end_ms,
    muted: oldRow.muted,
    playback_rate: oldRow.playback_rate,
    video_url_override: oldRow.video_url_override,
    video_duration_seconds_override: oldRow.video_duration_seconds_override,
    transition_in: oldRow.transition_in,

    // edited_at: keep the OLD shape so subsequent merges can still
    // honor per-field stamps. A row whose generator fields were
    // freshly written by this regen doesn't get a NEW stamp — the
    // regen isn't a "user edit."
    edited_at: oldRow.edited_at,
  };
}

export const POST = apiRoute.authed(async (
  session,
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) => {
  if (!EDITOR_V1_ENABLED) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Heavy operation. 5 req/min/IP is generous — a creator iterating
  // on the script can run this several times per minute without
  // hitting the limit.
  const { limited } = checkRateLimit(`editor-regen-doc:${getClientIP(req)}`, 5, 60_000);
  if (limited) {
    return NextResponse.json({ error: 'Too many regenerations — slow down.' }, { status: 429 });
  }

  const { projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const newScript = typeof body.newScript === 'string' ? body.newScript.trim() : '';
  if (!newScript) {
    return NextResponse.json({ error: 'newScript is required' }, { status: 400 });
  }
  if (newScript.length > MAX_SCRIPT_CHARS) {
    return NextResponse.json(
      { error: `Script exceeds ${MAX_SCRIPT_CHARS}-char cap` },
      { status: 400 },
    );
  }

  // Mark the regen-start time NOW — any user edit older than this
  // gets overwritten; newer edits survive.
  const regenStartMs = Date.now();

  // Load the saved doc.
  const { rows } = await sql<{ payload: unknown }>`
    SELECT payload
      FROM user_history
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
     LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (!isPlainObject(rows[0].payload)) {
    return NextResponse.json({ error: 'Payload not parseable' }, { status: 500 });
  }
  const payload = rows[0].payload;
  const oldDoc = isPlainObject(payload.doc) ? (payload.doc as unknown as ProductionDoc) : null;
  if (!oldDoc || !Array.isArray(oldDoc.rows)) {
    return NextResponse.json({ error: 'Doc payload missing rows' }, { status: 500 });
  }

  // Resolve generator inputs: niche / topic / style / model. Body
  // can override, but defaults flow from the existing doc so a
  // bare-bones request still works.
  const niche = typeof body.niche === 'string' && body.niche.trim()
    ? body.niche.trim()
    : oldDoc.niche || '';
  const topic = typeof body.topic === 'string' && body.topic.trim()
    ? body.topic.trim()
    : oldDoc.title || '';
  if (!niche) {
    return NextResponse.json({ error: 'No niche on the existing doc and none supplied' }, { status: 400 });
  }

  const stylePresetId = typeof body.stylePreset === 'string' && body.stylePreset
    ? body.stylePreset
    : undefined;
  const resolvedStyle = await resolveStyle(stylePresetId, session.ws);
  const style = resolvedStyle
    ? {
        id: resolvedStyle.id,
        label: resolvedStyle.label,
        ai_image_suffix: resolvedStyle.ai_image_suffix,
        mixing_rules: resolvedStyle.mixing_rules,
        allow_overlay_stock: resolvedStyle.allow_overlay_stock,
      }
    : null;

  const effectiveModelId =
    typeof body.modelId === 'string' && body.modelId
      ? body.modelId
      : await getEffectiveModelId(session.ws, 'production-doc');

  // Build the prompt + run the generator.
  const { system, user } = productionDocPrompt({
    script: newScript,
    niche,
    topic,
    speakingPaceWpm: oldDoc.speaking_pace_wpm,
    style,
    startTimecodeSeconds: 0,
    isChunk: false,
  });

  let raw: string;
  try {
    raw = await generateText({
      modelId: effectiveModelId,
      prompt: user,
      systemPrompt: system,
      maxTokens: 16000,
      temperature: 0.4,
      spend: {
        workspaceId: session.ws,
        featureArea: 'editor_regen_from_script',
        metadata: { niche, project_id: projectId },
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'AI generation failed';
    logger.error('[editor regen-from-script] generation failed', { detail, project_id: projectId });
    return NextResponse.json({ error: detail }, { status: 502 });
  }

  let regenResult: { rows?: MergeRow[]; speaking_pace_wpm?: number; [k: string]: unknown };
  try {
    regenResult = parseLlmJson(raw) as typeof regenResult;
  } catch (parseErr) {
    const detail = parseErr instanceof Error ? parseErr.message : 'unknown parser error';
    return NextResponse.json({ error: `Failed to parse regenerated doc — ${detail}` }, { status: 500 });
  }

  if (!Array.isArray(regenResult.rows) || regenResult.rows.length === 0) {
    return NextResponse.json({ error: 'Regenerated doc has no rows' }, { status: 502 });
  }

  // Apply the row-overflow post-validator (same as the production-doc
  // generator does) before merging.
  const wpm =
    typeof regenResult.speaking_pace_wpm === 'number'
      ? regenResult.speaking_pace_wpm
      : oldDoc.speaking_pace_wpm || 135;
  const split = validateAndSplitOverlongRows(regenResult.rows, wpm);

  // Position-based merge with per-field edited_at preservation.
  const oldRows = oldDoc.rows as MergeRow[];
  const mergedRows: MergeRow[] = split.rows.map((newRow, i) => {
    const oldRow = oldRows[i];
    if (!oldRow) return newRow;
    return mergeRow(oldRow, newRow, regenStartMs);
  });

  // Build the new doc. Doc-level fields (title, niche, total_duration,
  // total_words, speaking_pace_wpm, text_overlays, thumbnail) come
  // from the regen output where present, else carry over from the
  // old doc.
  const newDoc: ProductionDoc = {
    ...oldDoc,
    ...(regenResult as Partial<ProductionDoc>),
    rows: mergedRows as ProductionDoc['rows'],
    // text_overlays + thumbnail are doc-level editor fields the
    // generator doesn't know about — never let it overwrite.
    text_overlays: oldDoc.text_overlays,
    thumbnail: oldDoc.thumbnail,
  };

  await sql`
    UPDATE user_history
       SET payload = payload || ${JSON.stringify({ doc: newDoc })}::jsonb,
           version = version + 1
     WHERE id = ${projectId}::uuid
       AND workspace_id = ${session.ws}::uuid
       AND collaborator_id = ${session.uid}::uuid
       AND kind = 'production_doc'
  `;

  logger.info('[editor regen-from-script] success', {
    project_id: projectId,
    workspace_id: session.ws,
    old_row_count: oldRows.length,
    new_row_count: mergedRows.length,
    merged_count: Math.min(oldRows.length, split.rows.length),
    overlong_split_count: split.splitCount,
    warning_count: split.warnings.length,
  });

  return NextResponse.json({
    ok: true,
    rowCount: mergedRows.length,
    warnings: split.warnings,
  });
});
