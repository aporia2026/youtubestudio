/**
 * Shorts motion-collage variant — Phase 15.18.
 *
 * One "collage" variant carries a 2×2 grid of independently-generated
 * panels composed server-side into a single portrait image. The
 * renderer stays collage-agnostic — it just sees a normal variant URL
 * — but the Shots panel surfaces the per-panel metadata so a future
 * commit can ship per-panel regen without a data migration.
 *
 * Why simpler than long-form motion_collage:
 *   - The long-form path chains panels via Atlas Edit (panel 0 anchors,
 *     panels 1..3 use it as a composition lock + reference the previous
 *     panel). Shorts have 1-3s caption windows so visual VARIETY beats
 *     composition coherence; each panel is generated INDEPENDENTLY via
 *     the standard base-T2I dispatcher.
 *   - The long-form path upscales the composed image 4× via Recraft.
 *     Shorts target 1080×1920 and the renderer does `object-fit: cover`
 *     so a 1024×1536 composed image (each panel 512×768) is sharp
 *     enough. Skips the upscale step + cost ($0.0025/collage).
 *
 * Failure posture: if any panel generation fails, the whole orchestrator
 * throws — partial collages are user-hostile (a missing quadrant is
 * worse than a "retry" message). The successful panel R2 uploads are
 * left orphaned (cheap, ~50kB/png).
 *
 * Observability (rule 14): one `[shorts frame-collage]` line per
 * dispatch + per panel + per composition step + final persist.
 */

import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import {
  DEFAULT_BASE_T2I_MODEL_ID,
  generateShortsBaseT2I,
  getBaseT2iModelSpec,
  resolveBaseT2iModelId,
  type ShortsBaseT2iModelId,
} from './shorts-base-t2i';
import {
  getImagesBucket,
  getDownloadUrlForBucket,
  uploadToBucket,
} from './r2';
import type {
  ShortFrameCollage,
  ShortFrameVariant,
  ShortRow,
  ShortStyleAssets,
} from './shorts-types';

/** Canonical grid dimensions. The data type carries an arbitrary
 *  `grid` shape so a future commit can add 3×3 / 1×4 without a
 *  migration, but v1 ships fixed 2×2 to keep the UI lean. */
const GRID_COLS = 2;
const GRID_ROWS = 2;
const PANEL_COUNT = GRID_COLS * GRID_ROWS;

/** Each panel rendered at 512×768 → composed image at 1024×1536, which
 *  matches the single-frame portrait size the renderer already
 *  consumes. The composition pads zero pixels between cells; a real
 *  border / gutter could land later as a UI knob. */
const PANEL_WIDTH = 512;
const PANEL_HEIGHT = 768;
const COMPOSED_WIDTH = PANEL_WIDTH * GRID_COLS; // 1024
const COMPOSED_HEIGHT = PANEL_HEIGHT * GRID_ROWS; // 1536

const R2_PREFIX = 'shorts-collage';

export interface AppendCollageVariantOptions {
  /** Caption-chunk index the collage swaps in at. Identical to the
   *  single-variant `captionChunkStartIndex` so the rest of the
   *  pipeline (renderer, animate, delete) needs no special casing. */
  captionChunkStartIndex: number;
  /** Exactly PANEL_COUNT prompts. Index 0 is top-left, 1 top-right,
   *  2 bottom-left, 3 bottom-right (row-major). The orchestrator
   *  validates length + per-prompt min-chars before any vendor call. */
  panelPrompts: readonly string[];
  /** Base-T2I model used for every panel. Defaults to the
   *  cost-optimal `atlas-gpt-image-2`. The route layer reads this from
   *  body override → UserSettings → default. */
  baseT2iModelId?: ShortsBaseT2iModelId;
  /** Optional brief shown later as the variant's `edit_prompt` — the
   *  Shots panel pre-populates it so the user remembers the overall
   *  intent of the collage. Falls back to `Collage: <panel-0
   *  prompt>` when omitted. */
  brief?: string;
}

export interface AppendCollageVariantResult {
  style_assets: ShortStyleAssets;
  /** Index of the new variant in the (sorted) variants array — the UI
   *  scrolls to / highlights it after the response lands. */
  newIndex: number;
  /** Aggregate panel cost. Atlas T2I = $0.009 × 4 = $0.036; Nano
   *  Banana × 4 = $0.16; Flux × 4 = $0.20. */
  costUsd: number;
  durationMs: number;
}

function resolveStyleKey(row: ShortRow): 'doodle' | 'paint' {
  if (row.style_id === 'doodle_explainer_2_short') return 'doodle';
  if (row.style_id === 'paint_explainer_v1_short') return 'paint';
  throw new Error(
    `Collage variants only apply to Doodle or Paint shorts (style_id="${row.style_id ?? 'null'}").`,
  );
}

function requireBlock(row: ShortRow, key: 'doodle' | 'paint') {
  const block = row.style_assets?.[key];
  if (!block) {
    throw new Error(
      `Shorts row has style_id="${row.style_id}" but no style_assets.${key} block yet — generate the base first.`,
    );
  }
  return block;
}

/** Validate the 4 prompts. Each panel needs enough text to drive a
 *  meaningful T2I generation; the 12-char floor mirrors the minimum
 *  used for the single-frame Animate form. Lower would silently
 *  produce noise. */
function validatePanelPrompts(panelPrompts: readonly string[]): void {
  if (panelPrompts.length !== PANEL_COUNT) {
    throw new Error(
      `Collage needs exactly ${PANEL_COUNT} panel prompts (got ${panelPrompts.length}).`,
    );
  }
  for (let i = 0; i < panelPrompts.length; i++) {
    const trimmed = panelPrompts[i]?.trim() ?? '';
    if (trimmed.length < 12) {
      throw new Error(
        `Panel ${i} prompt is too short (${trimmed.length} chars) — needs ≥12 to drive a meaningful generation.`,
      );
    }
  }
}

/** Fetch a panel image as a Buffer + run sharp resize so the
 *  composition step receives normalised pixel data. Atlas / Kie return
 *  the panels at varied sizes; resizing here keeps the composition
 *  step deterministic. */
async function fetchAndResizePanel(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch panel image (${res.status}): ${url}`);
  }
  const ab = await res.arrayBuffer();
  return sharp(Buffer.from(ab))
    .resize(PANEL_WIDTH, PANEL_HEIGHT, { fit: 'cover' })
    .png()
    .toBuffer();
}

/** Build the composed 2×2 grid PNG from the 4 resized panel buffers.
 *  Panel order (row-major): [0=TL, 1=TR, 2=BL, 3=BR]. */
async function composeGrid(panelBuffers: Buffer[]): Promise<Buffer> {
  const positions = [
    { left: 0, top: 0 }, // TL
    { left: PANEL_WIDTH, top: 0 }, // TR
    { left: 0, top: PANEL_HEIGHT }, // BL
    { left: PANEL_WIDTH, top: PANEL_HEIGHT }, // BR
  ];
  return sharp({
    create: {
      width: COMPOSED_WIDTH,
      height: COMPOSED_HEIGHT,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(
      panelBuffers.map((input, i) => ({ input, left: positions[i].left, top: positions[i].top })),
    )
    .png()
    .toBuffer();
}

/** Insert the new variant into the existing variants array sorted by
 *  `caption_chunk_start_index`. Mirrors the single-variant
 *  `appendVariantFrame` insertion logic verbatim so the renderer sees
 *  the same shape. */
function insertSorted(
  prev: ShortFrameVariant[],
  next: ShortFrameVariant,
): { variants: ShortFrameVariant[]; newIndex: number } {
  const insertAt = prev.findIndex(
    (v) => v.caption_chunk_start_index > next.caption_chunk_start_index,
  );
  const variants = prev.slice();
  const newIndex = insertAt === -1 ? variants.length : insertAt;
  variants.splice(newIndex, 0, next);
  return { variants, newIndex };
}

export async function appendCollageVariant(
  row: ShortRow,
  opts: AppendCollageVariantOptions,
): Promise<AppendCollageVariantResult> {
  const tStart = Date.now();
  const key = resolveStyleKey(row);
  const prevBlock = requireBlock(row, key);
  validatePanelPrompts(opts.panelPrompts);
  if (!Number.isFinite(opts.captionChunkStartIndex) || opts.captionChunkStartIndex < 0) {
    throw new Error(
      `captionChunkStartIndex must be a non-negative integer (got ${String(opts.captionChunkStartIndex)}).`,
    );
  }
  const modelId = resolveBaseT2iModelId(opts.baseT2iModelId ?? DEFAULT_BASE_T2I_MODEL_ID);
  const modelSpec = getBaseT2iModelSpec(modelId);

  console.info('[shorts frame-collage] dispatch start', {
    shortId: row.id,
    workspaceId: row.workspace_id,
    styleKey: key,
    chunkIndex: opts.captionChunkStartIndex,
    modelId,
    promptChars: opts.panelPrompts.map((p) => p.trim().length),
  });

  // 1) Generate all 4 panels IN PARALLEL. Independent generations →
  //    no chain → straight Promise.all. If any rejects, Promise.all
  //    rejects and the orchestrator throws; partial output is not
  //    persisted.
  const panelResults = await Promise.all(
    opts.panelPrompts.map((prompt) =>
      generateShortsBaseT2I({ prompt: prompt.trim(), modelId }),
    ),
  );
  logger.info('[shorts frame-collage] panels ready', {
    shortId: row.id,
    panelUrls: panelResults.map((p) => p.url),
    costUsd: panelResults.reduce((sum, p) => sum + p.costUsd, 0),
  });

  // 2) Fetch + resize each panel, then compose into a 2×2 grid.
  const panelBuffers = await Promise.all(
    panelResults.map((p) => fetchAndResizePanel(p.url)),
  );
  const composedBuf = await composeGrid(panelBuffers);
  logger.info('[shorts frame-collage] composed', {
    shortId: row.id,
    composedWidth: COMPOSED_WIDTH,
    composedHeight: COMPOSED_HEIGHT,
    composedBytes: composedBuf.byteLength,
  });

  // 3) Upload composed image to R2. The key prefixes by short id + a
  //    fresh UUID so multiple collages on the same short don't collide.
  const bucket = getImagesBucket();
  const r2Key = `${R2_PREFIX}/${row.id}/${Date.now()}-${randomUUID()}.png`;
  await uploadToBucket(bucket, r2Key, composedBuf, 'image/png');
  const composedUrl = await getDownloadUrlForBucket(
    bucket,
    r2Key,
    process.env.R2_IMAGES_PUBLIC_URL,
  );
  logger.info('[shorts frame-collage] uploaded', {
    shortId: row.id,
    r2Key,
    composedUrl,
  });

  // 4) Build the variant + insert sorted.
  const collage: ShortFrameCollage = {
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    panels: panelResults.map((p, i) => ({
      url: p.url,
      prompt: opts.panelPrompts[i].trim(),
      model_id: p.modelId,
      cost_usd: p.costUsd,
    })),
    composed_width: COMPOSED_WIDTH,
    composed_height: COMPOSED_HEIGHT,
    generated_at: new Date().toISOString(),
  };
  const brief =
    opts.brief?.trim()
    || `Collage: ${opts.panelPrompts[0].trim().slice(0, 120)}`;
  const variant: ShortFrameVariant = {
    url: composedUrl,
    caption_chunk_start_index: opts.captionChunkStartIndex,
    edit_prompt: brief,
    collage,
  };
  const { variants, newIndex } = insertSorted(prevBlock.variants, variant);
  const style_assets: ShortStyleAssets = {
    ...(row.style_assets ?? {}),
    [key]: { ...prevBlock, variants },
  };

  const costUsd = collage.panels.reduce((sum, p) => sum + p.cost_usd, 0);
  const durationMs = Date.now() - tStart;
  logger.info('[shorts frame-collage] done', {
    shortId: row.id,
    newIndex,
    costUsd,
    durationMs,
    composedUrl,
    panelCount: PANEL_COUNT,
    modelLabel: modelSpec.label,
  });
  return { style_assets, newIndex, costUsd, durationMs };
}

/** Public constants exposed for the UI so the form knows how many
 *  inputs to render. Kept here to keep the registry in one place. */
export const COLLAGE_PANEL_COUNT = PANEL_COUNT;
export const COLLAGE_GRID_DIMENSIONS = { cols: GRID_COLS, rows: GRID_ROWS } as const;
