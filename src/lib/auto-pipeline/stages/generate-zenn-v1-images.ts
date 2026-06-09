/**
 * Stage handler: generate the zenn_v1-specific assets that the
 * existing `generating_production_doc_images` stage does not produce.
 *
 * Active for stage `generating_zenn_v1_images`. Runs AFTER the
 * generic per-row image generation has populated every row's
 * `image_url`. The base per-row generation is shared with every
 * other style and stays in `generate-production-doc-images.ts`;
 * this handler only adds the two zenn-specific sub-passes:
 *
 *   1. Character bank generation — one canonical PNG per unique
 *      `zenn_character_id` on the doc's rows, generated via the same
 *      `generateBaseImage` dispatcher the per-row stage uses. The
 *      dispatcher reads the style preset's `preferred_cloud_model`
 *      and routes to Kie gpt-image-2-i2i for zenn_v1 (per the user
 *      decision recorded in _plans/2026-06-10-zenn-v1-style.md §11).
 *      Cached on `doc.zenn_v1_character_bank[id]`. The Mode B
 *      renderer (PR 3) composes scenes from this bank rather than
 *      regenerating the character per shot — that's the visual
 *      contract that separates Zenn from doodle_explainer_2.
 *
 *   2. World palette fill — pure data, no AI calls. Looks at the
 *      `zenn_world_overlay` values on rows and populates the
 *      doc-level `zenn_v1_world.{sky_color_hex, ground_color_hex,
 *      wall_color_hex}` with the canonical defaults when unset.
 *      Mode B world backgrounds are CSS-painted bands of these
 *      colors (cyan sky over yellow desert, grey wall over grey
 *      floor, etc.), not raster images, so no Kie call is needed.
 *
 * A third sub-pass — per-row one-off assets (canvas_reveal sibling
 * layers, one-off prop PNGs) — is scaffolded for PR 4 but not run
 * in PR 2. Until the LLM emits the relevant fields (PR 5), there is
 * nothing to generate per row.
 *
 * Hard cost cap (PIPELINE_IMAGE_GEN_CAP_USD env, default $10/job) is
 * shared across stages via the `image_gen_stage_cost_usd` running
 * total persisted on the production_doc artefact's metadata. The
 * cap counts prior-stage spend so a $4 spend in the per-row stage
 * is visible here and we refuse to start if our remaining estimate
 * would push the total over the cap. Per plan §11, real zenn_v1
 * videos under Kie pricing land in the $10-20 range; the project
 * was advised to bump the cap env to $20 before the first real
 * zenn_v1 run.
 *
 * Idempotency: every character_id check is `if (bank[id]?.base_url)
 * skip`. Mid-tick failures persist what completed; the next tick
 * re-claims the same video, re-scans, and finishes the remaining
 * work. World palette fill is a pure overwrite of unset fields, so
 * re-running is a no-op once populated.
 *
 * See `_plans/2026-06-10-zenn-v1-style.md` §5.3.
 */
import { sql } from '@vercel/postgres';
import { logger } from '../../logger';
import { generateGptImage2Edit } from '../../gpt-image-2-edit';
import { mirrorImageToR2 } from '../../image-gen-dispatch';
import type { StageHandlerContext, StageOutcome } from '../types';
import {
  generateBaseImage,
  type PipelineImageDoc,
  type PipelineImageRow,
} from '../production-doc-image-gen';

/** Per-tick deadline. Vercel's function maxDuration is 300 s; we
 *  bail out of the sub-pass loops when we've used ~85 % of that so
 *  the persist + cleanup at the end has comfortable headroom.
 *  Matches the constant in `generate-production-doc-images.ts`. */
const TICK_DEADLINE_BUDGET_MS = 255_000;

/** Hard cap on how many fresh character-bank generations a single
 *  tick can run. Three is enough for a typical zenn_v1 doc (3-7
 *  unique characters per video) to finish in 1-3 ticks. Each call
 *  is Kie i2i at ~$0.05 / ~30 s. Three per tick × 30 s = 90 s,
 *  well under the deadline budget. */
const MAX_ZENN_CHARACTER_PER_TICK = 3;

/** Defensive cap on the total unique characters this stage will
 *  process per doc, regardless of how many `zenn_character_id`
 *  slugs the LLM emitted. Matches `ZENN_V1_DEFAULTS.max_unique_characters`
 *  in src/remotion/utils.ts. Per plan §6, when the LLM emits more
 *  than this cap we silently keep the first N and merge any later
 *  near-duplicates into the existing bank by slug normalization
 *  (lowercase + non-alphanumeric → '-'). Real Zenn videos use 3-7
 *  characters; 12 is a generous ceiling. */
const ZENN_CHARACTER_BANK_HARD_CAP = 12;

/** Conservative per-call cost estimate for Kie gpt-image-2-i2i.
 *  Used for the cap pre-check before any work runs. The actual
 *  cost rolled up at the end of the tick comes from the
 *  dispatcher's `result.costUsd` (which may be slightly under).
 *  Matches the live-verified Kie i2i price documented in plan §11. */
const COST_PER_CHARACTER_BANK_ENTRY = 0.05;

/** Hard cap on how many fresh canvas_reveal sibling-layer
 *  generations a single tick can run. Each is a Kie i2i Edit call
 *  at ~$0.05 / ~30 s. Three per tick × 30 s = 90 s, well under the
 *  TICK_DEADLINE_BUDGET_MS budget alongside the character-bank
 *  sub-pass. Deferred layers come back next tick because the
 *  row's `zenn_canvas_reveal_layers` entry is still missing its
 *  `image_url`. PR 4. */
const MAX_ZENN_CANVAS_REVEAL_PER_TICK = 3;

/** Same per-call cost as character-bank Kie i2i. Used for the
 *  cap pre-check on the canvas_reveal sub-pass. */
const COST_PER_CANVAS_REVEAL_LAYER = 0.05;

/** Per-job hard cost cap. Read from env so Vercel can override
 *  without a redeploy. Defaults to $10. Mirrors the helper in
 *  `generate-production-doc-images.ts` exactly so both stages
 *  enforce the same ceiling. */
function readCostCap(): number {
  const raw = process.env.PIPELINE_IMAGE_GEN_CAP_USD;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** Parse the per-stage running cost total from the production_doc
 *  artefact's metadata. Both `generate-production-doc-images.ts`
 *  and this stage write to / read from the same
 *  `image_gen_stage_cost_usd` field so the cap survives stage
 *  handoffs. Missing or malformed values count as $0. */
function parsePriorStageSpend(metadata: Record<string, unknown>): number {
  const raw = metadata.image_gen_stage_cost_usd;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return 0;
}

// ─── zenn_v1 doc shape ──────────────────────────────────────────────
//
// PipelineImageDoc in production-doc-image-gen.ts is a strict subset
// of the canonical ProductionDoc (from src/remotion/utils.ts). The
// canonical type pulls React-only deps and is unsafe to import in a
// server-only module, so we re-state the zenn_v1-specific fields
// here as a local extension. Shape must stay in sync with the
// canonical fields — pipeline runs would silently miss new sub-
// fields otherwise.

interface ZennCharacterBankEntry {
  base_url: string;
  palette?: {
    skin?: string;
    hair?: string;
    clothes?: string;
    accent?: string;
  };
  poses?: Record<string, string>;
  first_seen_row_index: number;
}

interface ZennWorldDef {
  sky_color_hex?: string;
  ground_color_hex?: string;
  wall_color_hex?: string;
  recurring_props?: Array<{ name: string; image_url: string }>;
}

/** Mirror of the canvas_reveal layer entry on
 *  `ProductionRow.zenn_canvas_reveal_layers`. Pipeline reads
 *  `prompt_hint` and writes `image_url` once the Kie i2i Edit
 *  generates the sibling frame. Other fields are renderer-only and
 *  pass through unchanged. */
interface ZennCanvasRevealLayer {
  prompt_hint?: string;
  image_url?: string;
  reveal_at_ms: number;
  duration_ms?: number;
  fade_in_ms?: number;
}

interface ZennPipelineRow extends PipelineImageRow {
  zenn_character_id?: string;
  zenn_world_overlay?: 'sky_only' | 'sky_ground' | 'room' | 'underwater' | null;
  zenn_canvas_reveal_layers?: ZennCanvasRevealLayer[];
}

interface ZennPipelineDoc extends PipelineImageDoc {
  rows: ZennPipelineRow[];
  zenn_v1_character_bank?: Record<string, ZennCharacterBankEntry>;
  zenn_v1_world?: ZennWorldDef;
}

// ─── canonical world palette defaults ───────────────────────────────
//
// Mode B world backgrounds are two-tone color bands painted by the
// renderer (PR 3) from these palette entries. Sourced from the
// reference frames at refs/zenn/_analysis/hires/: cyan sky over
// warm yellow ground for Kalahari (ancient_day_240s), light grey
// wall over darker grey floor for the mouse interior (calhoun_35s),
// green ground strip with white sky for the animal-kingdom scenes
// (aliens_80s).

const WORLD_PALETTE_DEFAULTS: Record<
  'sky_only' | 'sky_ground' | 'room' | 'underwater',
  Required<Pick<ZennWorldDef, 'sky_color_hex' | 'ground_color_hex' | 'wall_color_hex'>>
> = {
  sky_only: {
    sky_color_hex: '#FFFFFF',
    ground_color_hex: '#9E9E9E',
    wall_color_hex: '#E0E0E0',
  },
  sky_ground: {
    sky_color_hex: '#BFE4F3',
    ground_color_hex: '#F2D69A',
    wall_color_hex: '#E0E0E0',
  },
  room: {
    sky_color_hex: '#E8E8E8',
    ground_color_hex: '#9E9E9E',
    wall_color_hex: '#E8E8E8',
  },
  underwater: {
    sky_color_hex: '#1B4F72',
    ground_color_hex: '#0B2A4A',
    wall_color_hex: '#1F618D',
  },
};

/** Normalize a `zenn_character_id` slug for near-duplicate detection.
 *  Lowercase + replace any non-alphanumeric run with a single hyphen +
 *  trim leading / trailing hyphens. Two slugs that normalize to the
 *  same value are treated as the SAME character. The first
 *  normalized-equivalent wins; later rows silently use the existing
 *  bank entry. Plan §6 security mitigation. */
export function normalizeZennCharacterId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build the canonical character-bank prompt for a given character.
 *  In PR 2 the only data we have is the character_id slug and the
 *  first row's `ai_image_prompt` (which describes the character in
 *  that row's specific context). We feed the slug into the prompt
 *  envelope and append the row's prompt as an "appearance hint" so
 *  the model has something to anchor on beyond the style refs.
 *
 *  PR 5 will add a doc-level `zenn_v1_character_descriptions` field
 *  (mirroring `doodle_explainer_2_character_descriptions`) so the
 *  LLM can emit a deliberate appearance description per character.
 *  Until then this prompt is the floor — the bundled style refs do
 *  the heavy lifting on the look.
 *
 *  Exported for testing. */
export function buildCharacterBankPrompt(
  characterId: string,
  appearanceHint: string,
): string {
  const slug = characterId.trim() || 'character';
  const hint = appearanceHint.trim();
  const hintBlock = hint
    ? `Appearance hint from the script: ${hint}.`
    : '';
  return [
    `Character bank entry for "${slug}".`,
    'Draw a single full-body character standing centered on a pure white canvas',
    'with a thin medium-grey horizontal ground baseline strip at the bottom.',
    'Front-facing, neutral idle pose, neutral expression, arms relaxed at sides.',
    'No props in the hands, no background scenery, no labels, no speech bubbles.',
    hintBlock,
    'This image will be the canonical reference for every shot featuring this',
    "character in the video — keep the silhouette, palette, and face anatomy",
    'consistent enough that downstream pose siblings can be generated from',
    'this base without identity drift.',
  ]
    .filter((line) => line.length > 0)
    .join(' ');
}

/** Plan the character-bank work for this tick. Walks doc.rows, finds
 *  every unique normalized `zenn_character_id`, filters out the ones
 *  already in the bank, and orders the result by first-seen row
 *  index so a deterministic prefix gets generated per tick (helpful
 *  for re-tick stability). Returns the slugs to generate, the
 *  normalized → canonical slug map for the renderer, and the
 *  first-seen row index for each.
 *
 *  Exported for testing. */
export function planCharacterBankWork(
  doc: ZennPipelineDoc,
): Array<{ canonicalId: string; firstSeenRowIndex: number; appearanceHint: string }> {
  const bank = doc.zenn_v1_character_bank ?? {};
  const alreadyCached = new Set<string>();
  for (const [id, entry] of Object.entries(bank)) {
    if (entry?.base_url) alreadyCached.add(normalizeZennCharacterId(id));
  }

  const seen = new Map<
    string,
    { canonicalId: string; firstSeenRowIndex: number; appearanceHint: string }
  >();
  for (let i = 0; i < doc.rows.length; i++) {
    const raw = doc.rows[i].zenn_character_id?.trim();
    if (!raw) continue;
    const normalized = normalizeZennCharacterId(raw);
    if (!normalized) continue;
    if (alreadyCached.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.set(normalized, {
      canonicalId: raw,
      firstSeenRowIndex: i,
      appearanceHint: (doc.rows[i].ai_image_prompt ?? '').trim(),
    });
    // Defensive cap per plan §6: silently stop accepting new characters
    // beyond the hard cap. Later rows that introduce new slugs are
    // dropped (the renderer will fall back to the closest existing
    // bank entry by name match). The cap covers a malformed LLM that
    // emitted hundreds of one-shot character_ids.
    if (seen.size >= ZENN_CHARACTER_BANK_HARD_CAP) break;
  }
  return [...seen.values()];
}

/** Plan the world palette fill for this tick. Walks doc.rows, finds
 *  every unique `zenn_world_overlay` value, and reports which palette
 *  entries are missing from `doc.zenn_v1_world`. The fill is a pure
 *  defaults-into-unset overwrite (the user can override at any
 *  point via the settings panel in PR 6).
 *
 *  Returns the set of overlay keys seen in the doc. Caller decides
 *  whether the world palette needs an update by comparing this set
 *  to what's already populated.
 *
 *  Exported for testing. */
export function planWorldPaletteWork(
  doc: ZennPipelineDoc,
): Set<'sky_only' | 'sky_ground' | 'room' | 'underwater'> {
  const seen = new Set<'sky_only' | 'sky_ground' | 'room' | 'underwater'>();
  for (const row of doc.rows) {
    const overlay = row.zenn_world_overlay;
    if (overlay && overlay in WORLD_PALETTE_DEFAULTS) {
      seen.add(overlay);
    }
  }
  return seen;
}

/** Fill the doc-level world palette from the overlays seen on rows.
 *  Pure: takes the current world def + the set of overlays in use,
 *  returns the updated world def. Unset fields get the canonical
 *  defaults for the FIRST overlay seen (alphabetical, for stable
 *  output). User-set fields are preserved verbatim.
 *
 *  Exported for testing. */
export function fillWorldPalette(
  current: ZennWorldDef | undefined,
  overlays: Set<'sky_only' | 'sky_ground' | 'room' | 'underwater'>,
): ZennWorldDef {
  const next: ZennWorldDef = { ...(current ?? {}) };
  if (overlays.size === 0) return next;
  // Pick the first overlay alphabetically to keep the choice
  // deterministic when multiple overlays are in use.
  const primary = [...overlays].sort()[0];
  const defaults = WORLD_PALETTE_DEFAULTS[primary];
  if (!next.sky_color_hex) next.sky_color_hex = defaults.sky_color_hex;
  if (!next.ground_color_hex) next.ground_color_hex = defaults.ground_color_hex;
  if (!next.wall_color_hex) next.wall_color_hex = defaults.wall_color_hex;
  if (!next.recurring_props) next.recurring_props = [];
  return next;
}

/** Build the Kie i2i Edit prompt envelope for a canvas_reveal layer.
 *  The envelope is the load-bearing instruction that gets the model
 *  to ADD a new element to the existing scene rather than re-paint it
 *  from scratch (which would defeat the "evolving canvas" device the
 *  beat exists for). Parallel to `buildCharacterContinuationEditPrompt`
 *  but with different intent: continuation preserves character
 *  identity across scenes; canvas_reveal preserves the whole image
 *  while adding one element.
 *
 *  Exported for testing. */
export function buildCanvasRevealEditPrompt(promptHint: string): string {
  const hint = promptHint.trim();
  return [
    `Add the following new element to this existing image: ${hint}.`,
    'CRITICAL: every existing element in the image (characters, props,',
    'backgrounds, on-screen text) must remain EXACTLY identical to the',
    'input. Do not move, recolor, redraw, or remove anything that is',
    'already in the scene. Only ADD the new element described above,',
    'positioned so it integrates naturally with the existing composition.',
    'Match the existing line weight, color palette, and overall hand-drawn',
    'style of the input image precisely.',
  ].join(' ');
}

/** One unit of canvas_reveal work — a layer that needs generation. */
interface CanvasRevealWorkItem {
  rowIndex: number;
  layerIndex: number;
  promptHint: string;
  baseImageUrl: string;
}

/** Plan the canvas_reveal work for this tick. Walks doc.rows, finds
 *  every layer entry with a non-empty `prompt_hint` and an empty
 *  `image_url`, and orders the result row-major (row 0 layers first,
 *  then row 1, etc.) so the deterministic prefix that gets generated
 *  per tick is stable across re-ticks.
 *
 *  Layers whose row has no `image_url` are skipped — canvas_reveal
 *  edits a base image, so the base must exist first. These rows
 *  come back next tick once the prior stage populates `image_url`.
 *
 *  Layers whose `prompt_hint` is empty are skipped too — the LLM
 *  emitted a layer with no instruction; nothing to generate.
 *
 *  Exported for testing. */
export function planCanvasRevealWork(doc: ZennPipelineDoc): CanvasRevealWorkItem[] {
  const out: CanvasRevealWorkItem[] = [];
  for (let i = 0; i < doc.rows.length; i++) {
    const row = doc.rows[i];
    const baseUrl = (row.image_url ?? '').trim();
    if (!baseUrl) continue;
    const layers = row.zenn_canvas_reveal_layers;
    if (!Array.isArray(layers)) continue;
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const hint = (layer?.prompt_hint ?? '').trim();
      if (!hint) continue;
      if (layer.image_url?.trim()) continue;
      out.push({
        rowIndex: i,
        layerIndex: li,
        promptHint: hint,
        baseImageUrl: baseUrl,
      });
    }
  }
  return out;
}

export async function handleGenerateZennV1Images(
  ctx: StageHandlerContext,
): Promise<StageOutcome> {
  const { video } = ctx;
  const tickStartedAtMs = Date.now();
  const deadlineExceeded = (): boolean =>
    Date.now() - tickStartedAtMs > TICK_DEADLINE_BUDGET_MS;

  // 1) Load the production_doc artefact (same row the prior
  //    image-gen stage wrote to). Cross-workspace guard via the
  //    JOIN, defense in depth — never trust the input row's id
  //    alone (rule 13).
  const { rows: artefactRows } = await sql.query<{
    attempt_number: number;
    metadata_jsonb: Record<string, unknown> | null;
  }>(
    `
    SELECT psa.attempt_number, psa.metadata_jsonb
      FROM pipeline_stage_artefacts psa
      JOIN pipeline_run_videos prv ON prv.id = psa.pipeline_run_video_id
     WHERE psa.pipeline_run_video_id = $1::uuid
       AND prv.workspace_id = $2::uuid
       AND psa.stage = 'generating_production_doc'
       AND psa.artefact_kind = 'production_doc'
     ORDER BY psa.attempt_number DESC
     LIMIT 1
    `,
    [video.id, video.workspace_id],
  );
  if (artefactRows.length === 0 || !artefactRows[0].metadata_jsonb) {
    return {
      kind: 'fail',
      terminalStage: 'zenn_v1_images_failed',
      failureClass: 'invariant_violation',
      failureMessage:
        'No production-doc artefact found; zenn_v1 image-gen stage reached without prior stage completing.',
    };
  }
  const artefactAttemptNumber = artefactRows[0].attempt_number;
  const metadata = artefactRows[0].metadata_jsonb as Record<string, unknown>;
  const doc = metadata.doc as ZennPipelineDoc | undefined;
  if (!doc || !Array.isArray(doc.rows)) {
    return {
      kind: 'fail',
      terminalStage: 'zenn_v1_images_failed',
      failureClass: 'invariant_violation',
      failureMessage:
        'Production-doc artefact has no rows array; doc structure malformed.',
    };
  }

  // 2) Defense-in-depth guard. Should never fire when the prior
  //    stage routed correctly; if it does (a malformed handoff),
  //    we want to skip cleanly rather than do zenn-specific work
  //    on a non-zenn doc.
  if (doc.style_preset !== 'zenn_v1') {
    logger.info('[zenn-v1 stage] non-zenn doc routed here; advancing to thumbnail', {
      pipeline_video_id: video.id,
      style_preset: doc.style_preset ?? null,
    });
    return { kind: 'advance', nextStage: 'generating_thumbnail', costUsd: 0 };
  }

  // 3) Plan the work for this tick.
  const charactersToGenerate = planCharacterBankWork(doc);
  const overlaysSeen = planWorldPaletteWork(doc);
  const worldNeedsFill =
    overlaysSeen.size > 0 &&
    (!doc.zenn_v1_world?.sky_color_hex ||
      !doc.zenn_v1_world?.ground_color_hex ||
      !doc.zenn_v1_world?.wall_color_hex);
  const canvasRevealToGenerate = planCanvasRevealWork(doc);

  // 4) Nothing to do — advance straight to thumbnail.
  if (
    charactersToGenerate.length === 0 &&
    !worldNeedsFill &&
    canvasRevealToGenerate.length === 0
  ) {
    logger.info('[zenn-v1 stage] all done; no character bank, world, or canvas_reveal work pending', {
      pipeline_video_id: video.id,
      total_rows: doc.rows.length,
    });
    return { kind: 'advance', nextStage: 'generating_thumbnail', costUsd: 0 };
  }

  // 5) Cost cap pre-check. Counts every character + canvas_reveal
  //    layer we'd attempt THIS tick, plus already-spent dollars
  //    carried over from the prior image-gen stage's running total.
  //    World palette fill is free.
  const characterTickPlanSize = Math.min(
    charactersToGenerate.length,
    MAX_ZENN_CHARACTER_PER_TICK,
  );
  const canvasRevealTickPlanSize = Math.min(
    canvasRevealToGenerate.length,
    MAX_ZENN_CANVAS_REVEAL_PER_TICK,
  );
  const remainingCostUsd =
    characterTickPlanSize * COST_PER_CHARACTER_BANK_ENTRY +
    canvasRevealTickPlanSize * COST_PER_CANVAS_REVEAL_LAYER;
  const alreadySpentUsd = parsePriorStageSpend(metadata);
  const capUsd = readCostCap();
  if (alreadySpentUsd + remainingCostUsd > capUsd) {
    logger.warn('[zenn-v1 stage] cost cap would be exceeded', {
      pipeline_video_id: video.id,
      already_spent_usd: alreadySpentUsd,
      remaining_cost_usd: remainingCostUsd,
      cap_usd: capUsd,
    });
    return {
      kind: 'fail',
      terminalStage: 'cost_cap_exceeded',
      failureClass: 'cost_cap_exceeded',
      failureMessage: `zenn_v1 image generation would exceed the per-job cap of $${capUsd.toFixed(
        2,
      )} ($${alreadySpentUsd.toFixed(2)} already spent + $${remainingCostUsd.toFixed(
        2,
      )} remaining).`,
    };
  }

  // 6) Sub-pass 1: character bank. Generate up to MAX_PER_TICK
  //    entries, defer the rest to the next tick via stillRemaining.
  const bank = doc.zenn_v1_character_bank ?? {};
  let charactersAttempted = 0;
  let charactersSucceeded = 0;
  let charactersFailed = 0;
  let charactersDeferred = 0;
  let tickCostUsd = 0;

  for (const entry of charactersToGenerate) {
    if (deadlineExceeded()) {
      const remaining = charactersToGenerate.length - charactersAttempted;
      charactersDeferred += remaining;
      logger.warn('[zenn-v1 stage] tick deadline reached; deferring remaining characters', {
        pipeline_video_id: video.id,
        deferred: remaining,
        elapsed_ms: Date.now() - tickStartedAtMs,
        budget_ms: TICK_DEADLINE_BUDGET_MS,
      });
      break;
    }
    if (charactersAttempted >= MAX_ZENN_CHARACTER_PER_TICK) {
      charactersDeferred += 1;
      logger.info('[zenn-v1 character-bank] deferred to next tick', {
        pipeline_video_id: video.id,
        character_id: entry.canonicalId,
        cap: MAX_ZENN_CHARACTER_PER_TICK,
      });
      continue;
    }

    const bankPrompt = buildCharacterBankPrompt(entry.canonicalId, entry.appearanceHint);
    // Synthetic row carries only the fields generateBaseImage reads.
    // The dispatcher resolves the style (zenn_v1) from doc.style_preset
    // and picks Kie gpt-image-2-i2i via preferred_cloud_model.
    const syntheticRow: PipelineImageRow = {
      ai_image_prompt: bankPrompt,
    };

    charactersAttempted += 1;
    const result = await generateBaseImage({
      row: syntheticRow,
      doc,
      workspaceId: video.workspace_id,
    });
    tickCostUsd += result.costUsd;

    if (result.imageUrl) {
      bank[entry.canonicalId] = {
        base_url: result.imageUrl,
        first_seen_row_index: entry.firstSeenRowIndex,
      };
      charactersSucceeded += 1;
      logger.info('[zenn-v1 character-bank]', {
        pipeline_video_id: video.id,
        character_id: entry.canonicalId,
        first_seen_row_index: entry.firstSeenRowIndex,
        model_used: result.modelUsed,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        source: 'generated',
      });
    } else {
      charactersFailed += 1;
      logger.warn('[zenn-v1 character-bank] failed', {
        pipeline_video_id: video.id,
        character_id: entry.canonicalId,
        error: result.error,
        duration_ms: result.durationMs,
      });
    }
  }
  doc.zenn_v1_character_bank = bank;

  // 7) Sub-pass 2: world palette fill. Pure data, no AI calls, no
  //    deadline impact. Idempotent — running on an already-populated
  //    doc is a no-op.
  let worldFilled = false;
  if (worldNeedsFill && overlaysSeen.size > 0) {
    doc.zenn_v1_world = fillWorldPalette(doc.zenn_v1_world, overlaysSeen);
    worldFilled = true;
    logger.info('[zenn-v1 world-background]', {
      pipeline_video_id: video.id,
      overlays_seen: [...overlaysSeen],
      sky_color_hex: doc.zenn_v1_world?.sky_color_hex,
      ground_color_hex: doc.zenn_v1_world?.ground_color_hex,
      wall_color_hex: doc.zenn_v1_world?.wall_color_hex,
    });
  }

  // 7.5) Sub-pass 3: canvas_reveal sibling-frame generation. For each
  //      layer carrying a `prompt_hint` without an `image_url`, run a
  //      Kie i2i Edit from the row's base image and mirror the result
  //      to R2 before stamping the URL on the layer. Capped at
  //      MAX_ZENN_CANVAS_REVEAL_PER_TICK per tick. Skips if the
  //      character-bank sub-pass already used the deadline budget.
  let canvasRevealAttempted = 0;
  let canvasRevealSucceeded = 0;
  let canvasRevealFailed = 0;
  let canvasRevealDeferred = 0;
  for (const item of canvasRevealToGenerate) {
    if (deadlineExceeded()) {
      const remaining = canvasRevealToGenerate.length - canvasRevealAttempted;
      canvasRevealDeferred += remaining;
      logger.warn('[zenn-v1 stage] tick deadline reached; deferring remaining canvas_reveal layers', {
        pipeline_video_id: video.id,
        deferred: remaining,
        elapsed_ms: Date.now() - tickStartedAtMs,
        budget_ms: TICK_DEADLINE_BUDGET_MS,
      });
      break;
    }
    if (canvasRevealAttempted >= MAX_ZENN_CANVAS_REVEAL_PER_TICK) {
      canvasRevealDeferred += 1;
      logger.info('[zenn-v1 canvas-reveal] deferred to next tick', {
        pipeline_video_id: video.id,
        row_index: item.rowIndex,
        layer_index: item.layerIndex,
        cap: MAX_ZENN_CANVAS_REVEAL_PER_TICK,
      });
      continue;
    }

    canvasRevealAttempted += 1;
    const editPrompt = buildCanvasRevealEditPrompt(item.promptHint);
    const t0 = Date.now();
    try {
      // Kie i2i Edit is the canonical zenn_v1 provider (user decision
      // 2026-06-10). Plan §11 documents the pricing acceptance.
      const dispatched = await generateGptImage2Edit({
        prompt: editPrompt,
        sourceImageUrl: item.baseImageUrl,
        primary: 'kie',
      });
      // `generateGptImage2Edit` returns a Kie CDN URL on the Kie path
      // (Atlas returns an R2-mirrored crop). Mirror to R2 ourselves so
      // the stored URL doesn't depend on Kie's CDN retention.
      const mirroredUrl = await mirrorImageToR2(dispatched.url, 'zenn-canvas-reveal');
      tickCostUsd += dispatched.costUsd;

      const targetRow = doc.rows[item.rowIndex] as ZennPipelineRow | undefined;
      const targetLayer = targetRow?.zenn_canvas_reveal_layers?.[item.layerIndex];
      if (targetLayer) {
        targetLayer.image_url = mirroredUrl;
      }
      canvasRevealSucceeded += 1;
      logger.info('[zenn-v1 canvas-reveal]', {
        pipeline_video_id: video.id,
        row_index: item.rowIndex,
        layer_index: item.layerIndex,
        vendor_used: dispatched.vendorUsed,
        fallback_used: dispatched.fallbackUsed,
        cost_usd: dispatched.costUsd,
        duration_ms: Date.now() - t0,
        prompt_chars: editPrompt.length,
        source: 'generated',
      });
    } catch (err) {
      canvasRevealFailed += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[zenn-v1 canvas-reveal] failed', {
        pipeline_video_id: video.id,
        row_index: item.rowIndex,
        layer_index: item.layerIndex,
        error: message.slice(0, 240),
        duration_ms: Date.now() - t0,
      });
    }
  }

  // 8) Persist the updated doc back into the artefact metadata.
  //    Mirrors the persistence pattern in
  //    `generate-production-doc-images.ts:1421-1431` exactly.
  const updatedMetadata: Record<string, unknown> = {
    ...metadata,
    doc,
    image_gen_stage_cost_usd: alreadySpentUsd + tickCostUsd,
  };
  await sql.query(
    `
    UPDATE pipeline_stage_artefacts
       SET metadata_jsonb = $1::jsonb
     WHERE pipeline_run_video_id = $2::uuid
       AND stage = 'generating_production_doc'
       AND attempt_number = $3
       AND artefact_kind = 'production_doc'
    `,
    [JSON.stringify(updatedMetadata), video.id, artefactAttemptNumber],
  );

  // 9) stillRemaining: any character_ids the LLM emitted that still
  //    aren't in the bank, OR any canvas_reveal layer with a prompt
  //    but no image_url, means another tick is needed. World palette
  //    fill is synchronous so it either succeeded this tick or there
  //    was nothing to do; it never triggers a re-tick.
  const remainingCharacterPlan = planCharacterBankWork(doc);
  const remainingCanvasRevealPlan = planCanvasRevealWork(doc);
  const stillRemaining =
    remainingCharacterPlan.length > 0 || remainingCanvasRevealPlan.length > 0;

  // 10) End-of-tick telemetry. Mirrors the structured-fields shape
  //     of the paint_explainer_v1 stage so dashboards can roll up
  //     both styles uniformly.
  logger.info('[zenn-v1 cost-tick]', {
    pipeline_video_id: video.id,
    tick_id: ctx.tickId,
    plan_size: charactersToGenerate.length,
    characters_attempted: charactersAttempted,
    characters_succeeded: charactersSucceeded,
    characters_failed: charactersFailed,
    characters_deferred: charactersDeferred,
    world_palette_filled: worldFilled,
    canvas_reveal_plan_size: canvasRevealToGenerate.length,
    canvas_reveal_attempted: canvasRevealAttempted,
    canvas_reveal_succeeded: canvasRevealSucceeded,
    canvas_reveal_failed: canvasRevealFailed,
    canvas_reveal_deferred: canvasRevealDeferred,
    tick_cost_usd: tickCostUsd,
    cumulative_cost_usd: alreadySpentUsd + tickCostUsd,
    cap_remaining_usd: Math.max(0, capUsd - (alreadySpentUsd + tickCostUsd)),
    still_remaining: stillRemaining,
  });

  return {
    kind: 'advance',
    nextStage: stillRemaining ? 'generating_zenn_v1_images' : 'generating_thumbnail',
    costUsd: tickCostUsd,
  };
}
