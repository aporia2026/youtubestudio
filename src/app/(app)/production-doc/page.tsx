'use client';

import React, { Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { COLLAGE_TESTER_PUBLIC, EDITOR_V1_PUBLIC } from '@/lib/feature-flags';
import { queueImageGen, reportUpstream429 } from '@/lib/image-gen-throttle';
import { mutate, getState as getOutboxState } from '@/lib/mutate';
import { getPref, setPref } from '@/lib/user-prefs';
import { CollageTesterPanel } from '@/components/production-doc/CollageTesterPanel';
import type { ScheduleItem } from '@/lib/schedule';
import { getScheduleLinkId, fetchScheduleItem, loadFullContextForItem, buildContextNotesFromItem } from '@/lib/schedule-link';
import { ScheduleLinkBanner } from '@/components/ui/ScheduleLinkBanner';
import { ScheduleLinkProvider, ScheduleSaverRegistration } from '@/components/ui/ScheduleLinkContext';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { getFeatureDefaultModelId } from '@/lib/ai-models';
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, getImageModelSpec } from '@/lib/image-models';
import { formatI2ICostHint } from '@/lib/image-models-i2i';
import {
  DEFAULT_EDIT_OPTION_ID,
  formatEditOptionLabel,
  getEditOption,
  getSortedEditOptions,
  type EditOption,
} from '@/lib/image-edit-pricing';
import {
  getLastEditOptionId,
  setLastEditOptionId,
} from '@/lib/editor/settings';
import { useLocalStudioEnabled } from '@/lib/local-studio-enabled';
import {
  saveProductionDocEntry,
  getProductionDocHistory,
  getProductionDocHistoryCached,
  getVoiceoverHistory,
  updateProductionDocEntry,
  updateProductionDocEntryCacheOnly,
  HistorySaveError,
  deleteProductionDocEntry,
  clearProductionDocHistory,
  getRecentNiches,
  getRecentTopics,
  type ProductionDocHistoryEntry,
} from '@/lib/history';
import { isUuid } from '@/lib/user-history-types';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { NichePicker } from '@/components/ui/NichePicker';
import { CopyForElevenLabs } from '@/components/ui/CopyForElevenLabs';
import { HistoryPanel } from '@/components/ui/HistoryPanel';
import { StyleManagerDialog, type StyleSummary } from './StyleManagerDialog';
import {
  BrollCell,
  kickoffBrollGeneration,
  readBrollLockMap,
  writeBrollLockMap,
  readBrollLsMap,
  writeBrollLsMap,
} from '@/components/production-doc/BrollCell';
import { SectionThumbnailCard } from '@/components/production-doc/SectionThumbnailCard';
import { OverlayCell } from '@/components/production-doc/OverlayCell';
import { OverlayPositionEditor } from '@/components/production-doc/OverlayPositionEditor';
import { OverlayEditDialog } from '@/components/production-doc/OverlayEditDialog';
import { OverlayContextMenu } from '@/components/production-doc/OverlayContextMenu';
import { ImageGenThrottleToast } from '@/components/editor/ImageGenThrottleToast';
import type { RowOverlayState } from '@/components/production-doc/overlay-types';
import { SectionRowControls } from '@/components/production-doc/SectionRowControls';
import { PaintExplainerV1SettingsPanel } from '@/components/production-doc/PaintExplainerV1SettingsPanel';
import { PacingProfilePanel } from '@/components/production-doc/PacingProfilePanel';
import { TitleReviewPanel, type UserTitleSpec } from '@/components/production-doc/TitleReviewPanel';
import { DoodleExplainer2MotionCollageSettingsPanel } from '@/components/production-doc/DoodleExplainer2MotionCollageSettingsPanel';
import { MotionCollageRowEditor } from '@/components/production-doc/MotionCollageRowEditor';
import type {
  DoodleExplainer2MotionCollageSettings,
  PaintExplainerV1Settings,
} from '@/remotion/utils';
import { OstModeControl, type OstMode } from '@/components/production-doc/OstModeControl';
import { StyleSheetPanel } from '@/components/production-doc/StyleSheetPanel';
import { resolveSheetReference } from '@/lib/style-sheet';
import { pickLocalStillModel, type LocalStillModel } from '@/lib/local-still-picker';
import { MissingClipsModal } from '@/components/production-doc/MissingClipsModal';
import { MaskBrushEditor } from '@/components/production-doc/MaskBrushEditor';
import {
  brollRowSignatureInput,
  BROLL_MODELS,
  DEFAULT_BROLL_MODEL_ID,
  findBrollModel,
  pickModelForScene,
  type BrollClipRow,
  type BrollModelId,
  type BrollStatus,
} from '@/lib/broll-types';
import {
  productionDocToVideoConfig,
  parseTimecodeToMs,
  DEFAULT_MIN_SCENE_MS,
  DEFAULT_TAIL_BUFFER_MS,
  MIN_SCENE_MS_BOUNDS,
  TAIL_BUFFER_MS_BOUNDS,
  clampSceneTiming,
  // Phase 3 (2026-05-25) — variant-group helpers. See
  // _plans/2026-05-25-near-static-variants.md.
  isVariantRow,
  getVariantGroup,
  getBaseRow,
  composeVariantEditRequest,
  resolveVariantChainMode,
  MAX_VARIANTS_PER_GROUP,
  type ImageSaliencyMap,
} from '@/remotion/utils';
import type { EditorWriters } from '@/components/production-doc/editor/types';
import { EditorView } from '@/components/production-doc/editor/EditorView';
// PR2 reliability (2026-06-03): pure helpers from the auto-pipeline
// module. Safe to import client-side — no server-only deps.
import { isExhausted, labelForErrorClass } from '@/lib/auto-pipeline/image-gen-errors';
import { NotesDock } from '@/components/notes/NotesDock';
import {
  buildCharacterContinuationEditPrompt,
  getCachedCharacterBase,
  writeCharacterToCache,
} from '@/lib/character-cache';
import {
  buildSceneContinuationEditPrompt,
  getCachedSceneBase,
  writeSceneToCache,
} from '@/lib/scene-cache';
import {
  collectCharacterIds,
  collectSceneIds,
  findUntaggedDescriptions,
  prependCharacterBible,
  tallyCharacterIds,
  tallySceneIds,
} from '@/lib/character-bible';
import { SlugChip } from '@/components/production-doc/SlugChip';
import { CharacterDescriptionsPanel } from '@/components/production-doc/CharacterDescriptionsPanel';
import type { PlayerController } from '@/lib/notes/player-controller';
import { resolveOverlayPlacement } from '@/lib/overlay-placement';
import { stripProductionMarkers } from '@/lib/script-markers';
import { buildCanonicalScript, scriptDriftRatio } from '@/lib/voiceover-alignment';
import type { BrandKit, ThumbnailTransitionConfig, VideoThumbnail } from '@/remotion/types';
import {
  resolveBrandKitForRender,
  parseVisualBrandKit,
  type ChannelVisualBrandKit,
} from '@/lib/channel-visual-brand-kit';
import { VisualBrandKitOverridePanel } from '@/components/production-doc/VisualBrandKitOverridePanel';
// Voiceover picker moved out of this file into a shared module so the
// editor's Audio panel can mount the same component. Behaviour is
// preserved verbatim — see `src/components/voiceover/VoiceoverPicker.tsx`
// and `src/lib/voiceovers/picker-types.ts`. Batch A of
// `_plans/2026-05-20-editor-prod-doc-parity-batches.md`.
import { VoiceoverPicker } from '@/components/voiceover/VoiceoverPicker';
// Canonical project payload — Phase 2 of
// `_plans/2026-05-19-editor-production-doc-parity.md`. The page used
// to scatter persistence across `saveProductionDocEntry`,
// `updateProductionDocEntry`, and a bespoke autosave effect; each saved
// a different subset of fields. The editor at `/edit/[projectId]` read
// `user_history.payload` and ended up missing voiceoverUrl, music,
// alignment, brand kit, and every flag, because none of those flowed
// through the same save path. `useProject(historyEntryId)` is now the
// single canonical sink — every canonical field is mirrored into it
// by the reactive effect below.
import { useProject } from '@/lib/project/use-project';
import type { RowVideoClipState } from '@/remotion/utils';

// Dynamically import VideoPlayer — Remotion uses browser-only APIs (WebGL, Canvas)
const VideoPlayer = dynamic(
  () => import('@/components/video/VideoPlayer').then(m => m.VideoPlayer),
  { ssr: false, loading: () => <VideoPlayerSkeleton /> },
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Same-origin proxy path the voiceover-alignment cache accepts. Mirrors
 *  the validator in `/api/voiceovers/align`. ElevenLabs-direct entries
 *  (raw Vercel Blob URLs) deliberately do NOT match — those need to be
 *  saved into the workspace library first so the proxy can serve them. */
const VOICEOVER_PROXY_PATH_RE =
  /^\/api\/voiceovers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/audio$/i;

/** Safely parse a fetch response as JSON. On non-JSON bodies (e.g. Vercel timeout HTML),
 *  throws an error with the first 200 chars of the body for easier debugging. */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      res.ok
        ? `Unexpected response from server (${res.status}): ${preview}`
        : `Server error ${res.status}: ${preview}`,
    );
  }
}

/**
 * Split a script into chunks of at most `maxWords` words.
 * Treats each non-empty line as an atomic unit and greedily fills chunks.
 * Any chunk that ends up below MIN_CHUNK_WORDS is merged into the adjacent chunk
 * so the API's 20-word minimum is never hit.
 */
function splitScriptIntoChunks(script: string, maxWords: number): string[] {
  const MIN_CHUNK_WORDS = 50;
  const lines = script.split(/\n/).filter(l => l.trim().length > 0);

  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentWords = 0;

  for (const line of lines) {
    const lw = line.trim().split(/\s+/).length;
    if (currentWords + lw > maxWords && currentLines.length > 0) {
      chunks.push(currentLines.join('\n'));
      currentLines = [];
      currentWords = 0;
    }
    currentLines.push(line);
    currentWords += lw;
  }
  if (currentLines.length > 0) chunks.push(currentLines.join('\n'));

  // Merge any chunk that is too small into its neighbor to avoid API rejection
  const merged: string[] = [];
  for (const chunk of chunks) {
    const wc = chunk.trim().split(/\s+/).length;
    if (wc < MIN_CHUNK_WORDS && merged.length > 0) {
      // Append to previous chunk (it's already been sent if sequential, so prepend to next is safer)
      merged[merged.length - 1] += '\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }
  // Edge case: first chunk is tiny — merge forward into the second
  if (merged.length > 1 && merged[0].trim().split(/\s+/).length < MIN_CHUNK_WORDS) {
    const head = merged.shift()!;
    merged[0] = head + '\n' + merged[0];
  }

  return merged.length > 0 ? merged : [script];
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductionRow {
  timecode: string;
  script_text: string;
  visual_type: string;
  visual_description: string;
  stock_search_terms: string;
  ai_image_prompt: string;
  /** Optional editor-composite asset to overlay on top of the AI visual.
   *  Only populated when the chosen style has `allow_overlay_stock` and
   *  the model decides this row warrants a real-world reference. */
  overlay_stock_terms?: string;
  /** Frame region the overlay lands in. Planned by the doc generator so
   *  the `ai_image_prompt` can reserve matching negative space, then used
   *  at render time to position the fetched overlay PNG. */
  overlay_zone?:
    | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    | 'center-top' | 'center-bottom' | 'left-center' | 'right-center';
  /** Overlay scale relative to the frame width. Planned alongside
   *  `overlay_zone`. small ≈ 12%, medium ≈ 18%, large ≈ 25%. */
  overlay_size?: 'small' | 'medium' | 'large';
  /** Fetched + background-removed overlay PNG, mirrored to R2. Populated
   *  asynchronously by `/api/overlay/fetch` after the row's still is
   *  generated. Falsy means "no overlay rendered" — the still alone is
   *  used. */
  overlay_image_url?: string;
  /** Final overlay placement after saliency-aware resolution. Set by the
   *  image-gen route once `image_saliency` is computed; preferred over
   *  `overlay_zone` / `overlay_size` everywhere downstream. See plan
   *  _plans/2026-05-17-section-title-letterbox-and-overlay-blending.md. */
  overlay_zone_resolved?: ProductionRow['overlay_zone'];
  overlay_size_resolved?: ProductionRow['overlay_size'];
  /** Phase 7 — when `true`, this row generates without chaining to the
   *  doc's style sheet (t2i instead of i2i). Use for cutaways, landscapes,
   *  or any shot where the protagonist / palette of the rest of the video
   *  shouldn't influence the composition. Undefined ⇒ chain (default). */
  style_sheet_skip?: boolean;
  on_screen_text: string;
  /** How this row's `on_screen_text` is realised at production time.
   *   - `'bake'`   → text is added to the diffusion prompt and rendered
   *                  inside the generated image (animates with i2v). The
   *                  Remotion LowerThird is suppressed for the shot so
   *                  the text doesn't double-render.
   *   - `'overlay'`→ text is NOT sent to the diffusion prompt; the still
   *                  generates clean and the LowerThird renders the text
   *                  at composition time. Guaranteed legible, branded,
   *                  no garbling — the default for new docs.
   *   - `'none'`   → no text anywhere.
   *  Undefined falls back to `ProductionDoc.on_screen_text_mode_default`,
   *  then to `'bake'` (back-compat with docs created before this field). */
  on_screen_text_mode?: 'bake' | 'overlay' | 'none';
  /** Multi-block per-row OST (PR 4 of OST plan). Mirror of the
   *  same field on the canonical `ProductionRow` in remotion/utils.ts.
   *  See that file for the full structural type + bounds. Persisted
   *  through the same ProjectPayload migrator the editor uses. */
  on_screen_text_blocks?: Array<{
    id: string;
    text: string;
    x_pct: number;
    y_pct: number;
    scale: number;
    anchor?:
      | 'top-left' | 'top-center' | 'top-right'
      | 'center-left' | 'center' | 'center-right'
      | 'bottom-left' | 'bottom-center' | 'bottom-right';
    variant?: 'default' | 'doodle-yellow';
    rotation_deg?: number;
  }>;
  notes: string;
  /** Region id (from ProductionDoc.thumbnail.regions) this row's scene
   *  zooms into. When set, the row's scene becomes a thumbnail-zoom. */
  thumbnail_zoom_to?: string;
  /** Section title shown as a fixed stripe at top of frame for the row's
   *  full duration. Independent of `on_screen_text`. */
  section_title?: string;
  /** Per-row stripe ↔ scene layout (only when `section_title` is set).
   *  Undefined treated as 'letterbox' downstream. */
  section_title_layout?: 'overlay' | 'letterbox';
  /** Per-row pillarbox fill color when layout = letterbox. Hex `#RRGGBB`.
   *  Falls back to doc-level default, then white. */
  pillarbox_color?: string;
  /** Per-row static-zoom percentage applied to the rendered image / video.
   *  100 = unchanged. <100 zooms out (image appears smaller, pillarbox /
   *  scene-bg fills the surrounding area). >100 zooms in (image crops to
   *  the centered window). Animation (Ken Burns, B-roll clip motion) is
   *  unaffected — the zoom multiplies on top of the animated transform.
   *  Falls back to `ProductionDoc.scene_zoom_default`, then 100. */
  scene_zoom?: number;
  /** Manual overlay placement set via drag-and-drop. When present, the
   *  renderer ignores `overlay_zone` / `overlay_zone_resolved` and pins
   *  the overlay's top-left corner at `(x_pct, y_pct)`% of the frame
   *  (origin top-left). Cleared via the editor's "Reset" button so the
   *  AI placement kicks back in. */
  overlay_position?: { x_pct: number; y_pct: number };
  /** Manual overlay width as % of the frame width (typical range 5–40).
   *  When set, overrides `overlay_size` / `overlay_size_resolved` at
   *  render time. Cleared together with `overlay_position` on reset. */
  overlay_size_pct?: number;
  /** Manual overlay height as % of frame height — set only by Shift+drag
   *  on a resize handle (free aspect). Absent means height follows the
   *  image's natural aspect. Phase 1 of the overlay-system overhaul. */
  overlay_stretched_height_pct?: number;
  /** One-sentence AI rationale for this overlay's auto-picked placement.
   *  Surfaced as a tooltip in the position editor. Written by
   *  `/api/overlay/fetch` when smart placement ran at fetch time.
   *  Phase 2 of the overlay-system overhaul. */
  overlay_placement_reason?: string;
  /** Model id that produced the placement decision (e.g.
   *  `kie-gemini-3.1-pro`); `'doc-gen-blind'` for rows whose
   *  zone/size came from the text-only doc-gen LLM. */
  overlay_placement_model?: string;
  /** Phase 4 — `true` when the RMBG cutout was uploaded to R2,
   *  `false` when the heuristic gate / vision tiebreaker decided the
   *  original was cleaner and we re-encoded it as PNG instead. */
  overlay_rmbg_kept?: boolean;
  /** Phase 5 — stack of prior overlay URLs after AI edits. Most-recent
   *  last; cap 3. Undo pops the tail back into the live overlay slot. */
  overlay_edit_history?: string[];
  /** Per-row escape hatch from the doc-level overlay behaviour. `true`
   *  skips the auto-fetch even when the doc allows; `false` forces the
   *  auto-fetch even when the doc-level toggle is off. Undefined ⇒
   *  follow the doc-level setting. */
  skip_overlay?: boolean;
  /** Cached pixel-saliency map for this row's generated image. Populated
   *  by `/api/generate/production-doc/image` after the image lands in R2. */
  image_saliency?: ImageSaliencyMap;
  /** Server-persisted URL of the row's last-generated image. Mirrors
   *  the transient `rowImages[i].imageUrl` client state — written by a
   *  useEffect every time a generation completes, read on doc load to
   *  re-hydrate `rowImages` so a refresh / link-share / new-tab visit
   *  doesn't show blank cells. The image BYTES live in R2 regardless;
   *  this field is the editor's bookmark to find them again. Mirrors
   *  the same-named field on `ProductionRow` in `@/remotion/utils.ts`. */
  image_url?: string;
  /** Phase 2 of 2026-06-03 production-doc flow stabilization. See
   *  the same-named fields on `ProductionRow` in `@/remotion/utils.ts`
   *  for the full docstrings — kept in lockstep per AGENTS.md. */
  attempts?: number;
  last_error?: {
    class:
      | 'content_policy'
      | 'reference_rejected'
      | 'model_rejected'
      | 'blank_output'
      | 'timeout'
      | 'invalid_prompt'
      | 'no_refs'
      | 'source_missing'
      | 'killed'
      | 'validation_failed'
      | 'unknown';
    message: string;
    at: string;
  } | null;
  /** Per-variant chain toggle. When true, this variant edits the
   *  previous variant's image instead of the group's base. Default
   *  false ⇒ each variant derives independently from the base. See
   *  the same-named field on `ProductionRow` in `@/remotion/utils.ts`. */
  variant_derives_from_previous?: boolean;
  /** Group-level default for new variants in this group. Set on the
   *  BASE row (variant_index === 0) only. New variants inherit this
   *  when their own `variant_derives_from_previous` is unset. Mirrors
   *  the same-named field on `ProductionRow` in `@/remotion/utils.ts`. */
  group_variant_chain_default?: 'parallel' | 'chained';
  /** Per-row transition override. Falls back to doc-level default. */
  thumbnail_transition?: ThumbnailTransitionConfig;
  /** Per-row scene-to-scene cross-fade override. `undefined` inherits the
   *  doc-level `scene_fade_enabled`; `true` forces a fade; `false` forces
   *  a hard cut. See `_plans/2026-05-17-scene-transition-controls.md`. */
  scene_fade?: boolean;
  /** Camera padding for the thumbnail-zoom framing on this row, as a
   *  percent of the region's longest edge added on each side. Higher
   *  pulls the camera back so the marked region sits with breathing
   *  room. Range `[0, 50]`. Falls back to
   *  `ProductionDoc.region_zoom_padding_default_pct`, then to the
   *  built-in default (15). Only meaningful when `thumbnail_zoom_to`
   *  is set. See
   *  `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`. */
  region_zoom_padding_pct?: number;
  // Phase 3 (2026-05-25) — variant-group fields. Optional / JSONB-stored,
  // so old docs are back-compat (group_id = undefined ⇒ standalone row).
  // Mirrors the canonical definition in src/remotion/utils.ts. See
  // _plans/2026-05-25-near-static-variants.md.
  group_id?: string;
  variant_index?: number;
  variant_edit_prompt?: string;
  /** Phase 3.7c — base image URL captured when this variant was
   *  last generated. Mismatch with the current base image_url means
   *  the variant is stale; the editor renders a "Base changed —
   *  regenerate?" banner. Only set on variant rows. */
  variant_base_image_at_generation?: string;
  /** Phase 1 / Phase 1.6 — recurring-character slug for the
   *  doodle_explainer_2 character cache. Mirrors the canonical
   *  definition in src/remotion/utils.ts. When the active style is
   *  doodle_explainer_2 AND this is set AND the doc's
   *  `doodle_explainer_2_character_cache` already has an entry for
   *  this slug, the row's image is generated via Atlas Edit on the
   *  cached base instead of fresh i2i, preserving identity across
   *  non-consecutive shots. */
  character_id?: string;
  /** Phase 3 (scene cache) — recurring-LOCATION slug. Same dispatch
   *  shape as character_id but anchors the BACKGROUND / SETTING.
   *  When BOTH this and character_id are set AND both are cached,
   *  the character path wins (one source-image preservation per
   *  Atlas Edit call). Mirrors the canonical definition in
   *  src/remotion/utils.ts. */
  scene_id?: string;
  // ─── doodle_explainer_2 motion_collage (2026-05-31) ────────────────
  // Mirrors the canonical ProductionRow fields in src/remotion/utils.ts.
  // Both interfaces MUST stay in sync — page.tsx renders editor UI
  // against this shape and the auto-pipeline reads the canonical one.
  // See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`.
  shot_kind?: 'static' | 'motion' | 'hard_cut' | 'motion_collage';
  motion_collage_grid?: { cols: number; rows: number };
  motion_collage_panel_prompts?: string[];
  motion_collage_image_url?: string;
  motion_collage_panel_urls?: string[];
  /** Per-panel transform (X/Y offset + scale) so a poorly-framed panel
   *  can be repositioned within its viewport without regen. Mirror of
   *  the field on the canonical ProductionRow — see remotion/utils.ts
   *  for full semantics + bounds. User-asked-for 2026-06-02. */
  motion_collage_panel_transforms?: Array<{
    x_pct?: number;
    y_pct?: number;
    scale_pct?: number;
  } | null>;
}

interface ProductionDoc {
  title: string;
  niche: string;
  total_duration: string;
  total_words: number;
  speaking_pace_wpm: number;
  rows: ProductionRow[];
  /** Section-divider thumbnail (one composite image + named regions
   *  + transition defaults). Optional — docs without one render the
   *  same as before. See _plans/2026-05-13-thumbnail-zoom-section-divider.md. */
  thumbnail?: VideoThumbnail;
  /** Doc-level fallback for `ProductionRow.pillarbox_color` when a row
   *  doesn't override. Hex `#RRGGBB`; defaults to white. */
  pillarbox_color_default?: string;
  /** Doc-level fallback for `ProductionRow.section_title_layout` when a
   *  row doesn't override. Mirrors the `pillarbox_color_default` pattern.
   *  Undefined ⇒ renderer treats it as 'letterbox'. */
  section_title_layout_default?: 'overlay' | 'letterbox';
  /** Doc-level fallback for `ProductionRow.on_screen_text_mode` when a row
   *  doesn't override. New docs from the auto-pipeline should default this
   *  to `'overlay'` (clean text, no diffusion garbling). Undefined ⇒
   *  renderer treats it as `'bake'` (back-compat with pre-Phase-5 docs). */
  on_screen_text_mode_default?: 'bake' | 'overlay' | 'none';
  /** Phase 7 — R2-hosted style sheet for cross-shot visual consistency.
   *  Generated once per doc; every per-row image chains against it via
   *  i2i at denoise 0.7 (local) or as a textual hint (cloud Kie). See
   *  `_plans/2026-05-21-phase-7-style-sheet.md`. */
  style_sheet_url?: string;
  /** Which model produced the sheet — surfaced in the UI for re-roll
   *  fidelity. Optional because pre-Phase-7 docs don't have one. */
  style_sheet_model?: 'flux-schnell-local' | 'qwen-image-local';
  /** When `true`, the sheet shows a recurring protagonist (2×2 grid of
   *  poses + palette). When `false`, just a palette/style swatch. */
  style_sheet_has_protagonist?: boolean;
  /** Prompt used to generate the sheet — kept for re-roll + UI display. */
  style_sheet_prompt?: string;
  /** Short prose description of the sheet (palette + protagonist look).
   *  Appended to cloud-Kie prompts as a continuity hint. Local i2i chain
   *  uses the actual image; this is the cloud-only fallback. */
  style_sheet_description?: string;
  /** Doc-level fallback for `ProductionRow.scene_zoom` when a row doesn't
   *  override. Mirrors the `pillarbox_color_default` pattern. Undefined ⇒
   *  100 (no zoom). Sensible range: 50–200. */
  scene_zoom_default?: number;
  /** Doc-level fallback for `ProductionRow.region_zoom_padding_pct`. Per-row
   *  overrides win. Range `[0, 50]`. Undefined ⇒ built-in default (15). See
   *  `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`. */
  region_zoom_padding_default_pct?: number;
  /** Per-doc override of the workspace's minimum scene duration (ms).
   *  Forwarded into `productionDocToVideoConfig`. Editable inline in the
   *  doc header. See `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */
  min_scene_ms?: number;
  /** Per-doc override of the workspace's tail buffer after narration (ms). */
  tail_buffer_ms?: number;
  /** PR3 (2026-06-03) — see the same-named field on `ProductionDoc` in
   *  `@/remotion/utils.ts` for the full docstring. Mirrored here per
   *  AGENTS.md. */
  pacing_profile?: 'standard' | 'fast' | 'very_fast';
  /** Doc-level default for the scene-to-scene cross fade. `undefined`
   *  preserves the historical behaviour (faded). `false` makes every
   *  shot hard-cut, including removing the opening fade-in and closing
   *  fade-out. Per-row `scene_fade` overrides per-row. */
  scene_fade_enabled?: boolean;
  /** When `true`, the editor skips the auto-fetch overlay pipeline
   *  (Brave Search → RMBG → smart placement) for every row in this
   *  doc. Brand identity relies on being baked into `ai_image_prompt`
   *  instead. Per-row `skip_overlay` overrides in either direction.
   *  Undefined on legacy docs ⇒ overlays auto-fetch (historical
   *  behaviour). Seeded on first generation from the user's
   *  `overlaysDisabledPref` localStorage preference. */
  overlays_disabled?: boolean;
  /** v2 (2026-05-22) — active style preset id for this doc. Kept in
   *  sync with the page-level `stylePreset` state via a useEffect so
   *  the value lands on the saved user_history payload. Downstream
   *  surfaces (the shot-graph editor in particular) read it from the
   *  doc rather than depending on the production-doc page's
   *  localStorage. Mirrors the field on the remotion-side ProductionDoc
   *  type (`src/remotion/utils.ts`); the two interfaces must stay in
   *  sync. May be a built-in slug or a saved-style UUID. */
  style_preset?: string;
  /** Doc-level default for new variants' chain mode. When true, new
   *  variants added via the editor default to
   *  `variant_derives_from_previous = true` (chained). Per-group
   *  default on the base row wins; per-variant explicit wins over
   *  both. Existing variants are NOT mutated when this flag flips.
   *  Mirrors the same-named field on ProductionDoc in
   *  `@/remotion/utils.ts`. */
  variants_chained_by_default?: boolean;
  /** v3 (2026-05-22) — doc-level animation model override. When set,
   *  every B-roll cell on this doc adopts this model as its default
   *  (unless the user has manually overridden a specific row via the
   *  row-level picker). Tier priority: row-level lock > doc-level >
   *  user-level default. Persisted on the doc payload so it survives
   *  refresh + cross-device. Empty string / undefined ⇒ fall back to
   *  the user-level default. */
  broll_model_id?: string;
  /** Doc-level image (still) model default. Stamped at gen-time from
   *  the page-level Image Model picker so the editor opens with that
   *  choice already populated as the per-shot Regenerate default.
   *  Tier priority: row.image_model > doc.image_model_default >
   *  server-side `DEFAULT_IMAGE_MODEL`. Mirrors the same field on the
   *  remotion-side `ProductionDoc` (`src/remotion/utils.ts`); the two
   *  interfaces must stay in sync. */
  image_model_default?: string;
  /** Collage batching toggle (2026-05-24 plan). When `true`, the
   *  "Generate all missing stills" batch button and the fresh-doc
   *  generation flow group consecutive shots in chunks of 4 and ask
   *  the chosen image model to produce a single 2×2 collage per
   *  group. The server then auto-upscales the collage and crops it
   *  into 4 per-shot images. Cuts generation cost ~70–75% per group.
   *  Per-shot Regenerate always stays single-image regardless of
   *  this flag. Default `false`. Mirrors the same field on the
   *  remotion-side `ProductionDoc`; the two interfaces must stay
   *  in sync. */
  collage_mode?: boolean;
  /** paint_explainer_v1 (2026-05-28) — per-doc settings for the new
   *  motion-driven style. Every field optional; absent fields fall
   *  back to PAINT_EXPLAINER_V1_DEFAULTS via
   *  `resolvePaintExplainerV1Settings`. Mirrors the same field on
   *  the remotion-side `ProductionDoc`; the two interfaces must
   *  stay in sync. See §14 of
   *  `_plans/2026-05-28-paint-explainer-v1-architecture.md`. */
  paint_explainer_v1_settings?: PaintExplainerV1Settings;
  /** doodle_explainer_2 (2026-05-31) — per-doc controls for
   *  motion_collage shots. Mirrors the same field on the remotion-side
   *  `ProductionDoc`; the two interfaces must stay in sync. See
   *  `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */
  doodle_explainer_2_motion_collage_settings?: DoodleExplainer2MotionCollageSettings;
  /** Phase 1 / Phase 1.6 — doodle_explainer_2 character cache.
   *  Per-doc map from a recurring character's `character_id` slug
   *  to the i2i-generated base image URL captured on the FIRST row
   *  featuring that character. Subsequent rows with the same slug
   *  dispatch through Atlas Edit on this base instead of fresh i2i,
   *  preserving identity across non-consecutive shots. Mirrors the
   *  canonical definition on the remotion-side `ProductionDoc`. */
  doodle_explainer_2_character_cache?: Record<string, {
    base_url: string;
    first_seen_row_index: number;
  }>;
  /** Phase 3 — doodle_explainer_2 scene cache. Per-doc map from a
   *  recurring location's `scene_id` slug to the i2i-generated base
   *  image URL captured on the FIRST row featuring that location.
   *  Mirrors `doodle_explainer_2_character_cache`. Precedence: when
   *  a row has both character_id and scene_id, the character cache
   *  wins on dispatch. Mirrors the canonical definition on the
   *  remotion-side ProductionDoc. */
  doodle_explainer_2_scene_cache?: Record<string, {
    base_url: string;
    first_seen_row_index: number;
  }>;
  /** Phase 2 (Character Bible) — doc-level character_id → visual
   *  description map. LLM-emitted at doc-gen time; the dispatcher
   *  prepends the bible to every prompt so non-anchored characters
   *  render consistently. Mirrors the canonical field on the
   *  remotion-side ProductionDoc. */
  doodle_explainer_2_character_descriptions?: Record<string, string>;
}

interface RowImageState {
  status: 'idle' | 'pending' | 'loading' | 'uploading' | 'editing' | 'done' | 'error' | 'search';
  imageUrl?: string;
  searchUrl?: string;
  error?: string;
  /** Where the image came from. Drives small UI cues (📷 badge for
   *  uploads, ✎ badge for edits) and gates the "↻ regenerate with the
   *  original prompt" button — uploads have no prompt to regenerate
   *  with, so ↻ is hidden for those rows and the edit pencil ✎ stays. */
  source?: 'generated' | 'upload' | 'url' | 'edit';
  /** v2 (2026-05-22) — pin this row to the version of the active
   *  style at generation time. When the user later edits the style
   *  (ref swap, descriptor tweak, model change), `style.version` bumps
   *  but this row's `styleVersion` stays — the data needed for a
   *  future "this scene was generated against v2; current style is
   *  v4 — regenerate?" affordance. Undefined for legacy rows / rows
   *  whose style had no version (built-ins, uploaded images). */
  styleVersion?: number;
}


interface VisualRef {
  type: 'youtube' | 'screenshot';
  // YouTube
  url?: string;
  title?: string;
  channelTitle?: string;
  // Screenshot — `objectUrl` is a `blob:` URL produced by URL.createObjectURL.
  // Storing the full base64 data URL here previously held 5–7 MB per upload
  // on the JS heap; the blob URL is a few dozen bytes and the bytes live in
  // browser-managed memory until revoked.
  objectUrl?: string;
  mediaType?: string;
  name?: string;
  // Shared
  analyzedStyle?: string;
  analyzing?: boolean;
  analysisFailed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Fallback style picker entries shown while the workspace's full style
 * list (built-ins + saved) is still loading from /api/production-doc/styles.
 * Keeps the UI from flashing empty on a slow cold start.
 */
const FALLBACK_BUILT_IN_STYLES: StyleSummary[] = [
  { id: 'cinematic', label: 'Cinematic', ai_image_suffix: '', allow_overlay_stock: false, origin: 'built-in' },
  { id: 'animation_2d', label: '2D Animation', ai_image_suffix: '', allow_overlay_stock: false, origin: 'built-in' },
  { id: 'doodle_explainer', label: 'Doodle Explainer', ai_image_suffix: '', allow_overlay_stock: true, origin: 'built-in' },
];

const VISUAL_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  'Title Card':       { bg: 'rgba(124,58,237,0.15)', color: '#a78bfa' },
  'B-Roll':           { bg: 'rgba(6,182,212,0.12)',  color: '#22d3ee' },
  'Talking Head':     { bg: 'rgba(16,185,129,0.12)', color: '#34d399' },
  'Screen Recording': { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
  'Animation':        { bg: 'rgba(236,72,153,0.12)', color: '#f472b6' },
  'Lower Third':      { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
  'Statistics':       { bg: 'rgba(239,68,68,0.12)',  color: '#f87171' },
  'Cutaway':          { bg: 'rgba(107,114,128,0.12)', color: '#9ca3af' },
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
  } catch {
    // not a valid URL
  }
  return null;
}

function escapeCsvCell(value: string): string {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportToCsv(doc: ProductionDoc, rowImages: RowImageState[]) {
  // Only include the Overlay column when at least one row uses it —
  // keeps CSVs from styles that don't support overlays exactly the
  // same shape they were before this feature.
  const hasOverlay = doc.rows.some((r) => r.overlay_stock_terms?.trim());
  const headers = [
    'Timecode', 'Script Text', 'Visual Type', 'Visual Description',
    'Stock Search Terms',
    ...(hasOverlay ? ['Overlay Stock Terms'] : []),
    'AI Image Prompt', 'Image URL', 'Stock Search URL',
    'On-Screen Text', 'Notes',
  ];
  const rows = doc.rows.map((r, i) => [
    r.timecode,
    r.script_text,
    r.visual_type,
    r.visual_description,
    r.stock_search_terms,
    ...(hasOverlay ? [r.overlay_stock_terms || ''] : []),
    r.ai_image_prompt,
    rowImages[i]?.imageUrl || '',
    rowImages[i]?.searchUrl || '',
    r.on_screen_text,
    r.notes,
  ].map(escapeCsvCell).join(','));

  // Editors often want the full script as one continuous block at the
  // bottom — the row-by-row table is great for production but bad for
  // reading the narrative end-to-end. Append it as a comment-prefixed
  // section so spreadsheet apps still parse the table cleanly.
  const fullScript = doc.rows
    .map(r => r.script_text?.trim())
    .filter(Boolean)
    .join('\n\n');

  const csv = [
    `# Production Document: ${doc.title}`,
    `# Niche: ${doc.niche} | Duration: ${doc.total_duration} | ${doc.total_words} words @ ${doc.speaking_pace_wpm} wpm`,
    '',
    headers.join(','),
    ...rows,
    '',
    '# ─── FULL SCRIPT (continuous, for reading) ───',
    ...fullScript.split('\n').map(line => `# ${line}`),
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `production-doc-${doc.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('CSV exported — open in Excel or Google Sheets');
}

// ─── Video Preview helpers ────────────────────────────────────────────────────

const DEFAULT_BRAND: Partial<BrandKit> = {
  primaryColor: '#FF0000',
  secondaryColor: '#111111',
  backgroundColor: '#FFFFFF',
  textColor: '#111111',
  titleColor: '#111111',
};

function VideoPlayerSkeleton() {
  return (
    <div
      style={{
        width: '100%',
        aspectRatio: '16/9',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        fontSize: 14,
      }}
    >
      <div className="spinner" style={{ width: 20, height: 20 }} />
      <span className="ml-3">Loading video engine…</span>
    </div>
  );
}

function VideoPreviewBrandBar({ onBrandChange }: { onBrandChange: (b: Partial<BrandKit>) => void }) {
  // Safe defaults — no localStorage in initial state to avoid SSR hydration mismatch
  const [primary, setPrimary] = useState('#FF0000');
  const [bg, setBg] = useState('#FFFFFF');

  // Load persisted brand on client only (after hydration)
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setPrimary(stored.primaryColor);
      if (stored.backgroundColor) setBg(stored.backgroundColor);
    } catch { /* ignore corrupt storage */ }
  }, []);

  function update(p: string, b: string) {
    setPrimary(p);
    setBg(b);
    const brand: Partial<BrandKit> = {
      primaryColor: p,
      backgroundColor: b,
      titleColor: b === '#FFFFFF' ? '#111111' : '#FFFFFF',
      textColor: b === '#FFFFFF' ? '#222222' : '#EEEEEE',
    };
    onBrandChange(brand);
    // Phase 3.1: persist via user-prefs so the brand kit follows
    // the user across machines. Localstorage write happens inside
    // setPref synchronously, so the read in the next BrandKitControls
    // mount still sees the new value.
    setPref('video_brand_kit', brand);
  }

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Brand</span>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        Accent color
        <input type="color" value={primary} onChange={e => update(e.target.value, bg)}
          style={{ width: 28, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none', padding: 0 }} />
      </label>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
        Background
        <input type="color" value={bg} onChange={e => update(primary, e.target.value)}
          style={{ width: 28, height: 24, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none', padding: 0 }} />
      </label>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        (changes apply on play)
      </span>
    </div>
  );
}

/**
 * Voiceover-aligned scene-timing pill. Four states — `syncing` is the
 * only one with a spinner; `ready` is a calm green checkmark; `stale`
 * and `failed` offer a re-align action. `unsupported` and `idle` are
 * both informational and never block the user — silent when there's
 * nothing useful to say.
 *
 * Visual choices target the lazy user (rule 10): one glance at the
 * green check confirms scenes will land on the narration; anything
 * else has a one-line explanation and (where applicable) a single
 * obvious button.
 */
function AlignmentPill({
  status,
  detail,
  onRealign,
}: {
  status: 'idle' | 'syncing' | 'ready' | 'stale' | 'failed' | 'unsupported';
  detail: string | null;
  onRealign: () => void;
}) {
  if (status === 'idle') return null;

  const palette: Record<typeof status, { bg: string; fg: string; dot: string; label: string }> = {
    syncing:     { bg: 'rgba(59,130,246,0.10)',  fg: '#60a5fa', dot: '#60a5fa', label: 'Syncing scenes to voiceover…' },
    ready:       { bg: 'rgba(16,185,129,0.10)',  fg: '#34d399', dot: '#34d399', label: 'Synced to voiceover' },
    stale:       { bg: 'rgba(245,158,11,0.12)',  fg: '#fbbf24', dot: '#fbbf24', label: 'Re-align needed' },
    failed:      { bg: 'rgba(239,68,68,0.10)',   fg: '#f87171', dot: '#f87171', label: 'Alignment failed' },
    unsupported: { bg: 'rgba(148,163,184,0.10)', fg: '#94a3b8', dot: '#94a3b8', label: 'Alignment unavailable' },
  };
  const p = palette[status];
  const showRealign = status === 'stale' || status === 'failed';

  return (
    <div
      className="mt-2 flex items-start gap-2 text-xs rounded-md px-3 py-2"
      style={{ background: p.bg, color: p.fg }}
    >
      <span className="flex-shrink-0 mt-0.5">
        {status === 'syncing' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : status === 'ready' ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: p.dot }}
            aria-hidden
          />
        )}
      </span>
      <span className="flex-1 leading-snug">
        <span className="font-medium">{p.label}</span>
        {detail && (
          <span className="block opacity-75 mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {detail}
          </span>
        )}
      </span>
      {showRealign && (
        <button
          type="button"
          onClick={onRealign}
          className="flex-shrink-0 text-xs underline underline-offset-2 hover:no-underline"
          style={{ color: p.fg }}
        >
          Re-align
        </button>
      )}
    </div>
  );
}

/**
 * Memoized VideoPlayer wrapper — rebuilds config only when inputs change,
 * preventing the Player from re-mounting on every parent state update.
 */
const VideoPlayerMemo = React.memo(function VideoPlayerMemo({
  doc,
  docId,
  rowImages,
  rowVideoClips,
  rowOverlays,
  rowLockedAsStill,
  animateScenes,
  suppressLowerThirds,
  voiceoverUrl,
  voiceoverAlignment,
  brandKit,
  effectiveStyleSlug,
  onRender,
  isRendering,
  renderProgress,
  downloadUrl,
}: {
  doc: ProductionDoc;
  /** PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`.
   *  Built-in slug the doc's style_preset resolves to. Threaded into
   *  `productionDocToVideoConfig` so saved-style UUIDs derived from
   *  doodle/paint route to the yellow LowerThird variant in the
   *  preview. Computed in the parent — this component is presentational. */
  effectiveStyleSlug?: string;
  /** `user_history.id` of the current production-doc. Scopes the notes
   *  dock's REST calls. Null when the doc hasn't been server-persisted
   *  yet — the dock hides itself in that case. */
  docId: string | null;
  rowImages: RowImageState[];
  rowVideoClips: Record<number, { status: string; videoUrl?: string } | null>;
  rowOverlays: Record<number, RowOverlayState>;
  rowLockedAsStill: boolean[];
  animateScenes: boolean;
  suppressLowerThirds: boolean;
  voiceoverUrl: string;
  /** Word-level alignment payload. When present, scene timing snaps to
   *  the narration's actual word boundaries — without it the preview
   *  uses estimated WPM timecodes that drift against the audio. The
   *  render route gets this server-side; the preview needs it client-
   *  side. See `_plans/2026-05-17-render-state-hardening.md`. */
  voiceoverAlignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse | null;
  brandKit: Partial<BrandKit>;
  onRender: () => void;
  isRendering: boolean;
  renderProgress: number;
  downloadUrl?: string | null;
}) {
  const config = React.useMemo(() => {
    // Flatten the sparse `rowVideoClips` map into a positional array
    // aligned with `doc.rows[i]`. Rows without an entry get null and
    // fall back to the still-with-Ken-Burns path inside the converter.
    const rowClipsArr = doc.rows.map((_, i) => rowVideoClips[i] ?? null);
    return productionDocToVideoConfig(doc, rowImages, {
      voiceoverUrl: voiceoverUrl || undefined,
      brand: brandKit,
      rowVideoClips: rowClipsArr,
      rowLockedAsStill,
      animateScenes,
      rowOverlays,
      suppressLowerThirds,
      alignment: voiceoverAlignment ?? undefined,
      effectiveStyleSlug,
    });
  }, [doc, rowImages, rowVideoClips, rowOverlays, rowLockedAsStill, animateScenes, suppressLowerThirds, voiceoverUrl, voiceoverAlignment, brandKit, effectiveStyleSlug]);
  // PlayerController for the notes dock. Stage / VideoPlayer hand one
  // up via `onControllerReady`; we hold it in state so the dock re-
  // renders when the player mounts. NotesDock renders inert until the
  // controller exists, so the brief pre-mount window is fine.
  const [playerController, setPlayerController] = React.useState<PlayerController | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <VideoPlayer
        config={config}
        onRender={onRender}
        isRendering={isRendering}
        renderProgress={renderProgress}
        downloadUrl={downloadUrl}
        onControllerReady={setPlayerController}
      />
      {/* Notes-while-watching dock — same component the Editor view
          mounts under its Stage. Shared `useNotes(docId)` store means a
          note added here shows up there too. Hidden when the doc
          hasn't been server-persisted yet (no docId). */}
      <NotesDock
        docId={docId}
        controller={playerController}
        shots={config.shots}
        fps={config.fps}
      />
    </div>
  );
});

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * Per-doc scene-timing override control. Two numeric inputs (min scene
 * duration, tail buffer after narration) with a Reset link when the
 * user has overridden either. Empty input means "use the default".
 * Values are clamped to bounds before commit by the caller's
 * `setSceneTiming` mutator. See the scene-min-duration plan.
 */
function SceneTimingControl({
  minSceneMs,
  tailBufferMs,
  onChange,
}: {
  minSceneMs: number | undefined;
  tailBufferMs: number | undefined;
  onChange: (patch: { min_scene_ms?: number | null; tail_buffer_ms?: number | null }) => void;
}) {
  // Local draft strings so the user can type freely (including clearing
  // the field) without the parent immediately clamping a partial value.
  // We commit on blur or Enter.
  const [minDraft, setMinDraft] = useState<string>(minSceneMs != null ? String(minSceneMs) : '');
  const [tailDraft, setTailDraft] = useState<string>(tailBufferMs != null ? String(tailBufferMs) : '');
  // Sync drafts when the doc-level values change from outside (e.g.
  // history load, server patch). Avoids stale local input after navigation.
  useEffect(() => { setMinDraft(minSceneMs != null ? String(minSceneMs) : ''); }, [minSceneMs]);
  useEffect(() => { setTailDraft(tailBufferMs != null ? String(tailBufferMs) : ''); }, [tailBufferMs]);

  const hasOverride = minSceneMs != null || tailBufferMs != null;

  const commitMin = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange({ min_scene_ms: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange({ min_scene_ms: n });
  };
  const commitTail = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange({ tail_buffer_ms: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange({ tail_buffer_ms: n });
  };

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.10)',
    color: 'var(--text-primary)',
    textAlign: 'right',
    width: 72,
    padding: '2px 6px',
    borderRadius: 4,
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 mb-4 px-3 py-2 rounded text-xs"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        color: 'var(--text-muted)',
      }}
    >
      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>⏱ Scene timing</span>
      <label className="flex items-center gap-1.5" title="Minimum on-screen time for every scene. Stops too-short title cards.">
        <span>Min scene</span>
        <input
          type="number"
          min={MIN_SCENE_MS_BOUNDS.min}
          max={MIN_SCENE_MS_BOUNDS.max}
          step={100}
          placeholder={String(DEFAULT_MIN_SCENE_MS)}
          value={minDraft}
          onChange={(e) => setMinDraft(e.target.value)}
          onBlur={(e) => commitMin(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={inputStyle}
        />
        <span>ms</span>
      </label>
      <span style={{ opacity: 0.4 }}>·</span>
      <label className="flex items-center gap-1.5" title="Extra hold time after the narrator finishes a row. Capped at the gap to the next narration so audio stays in sync.">
        <span>Tail buffer</span>
        <input
          type="number"
          min={TAIL_BUFFER_MS_BOUNDS.min}
          max={TAIL_BUFFER_MS_BOUNDS.max}
          step={50}
          placeholder={String(DEFAULT_TAIL_BUFFER_MS)}
          value={tailDraft}
          onChange={(e) => setTailDraft(e.target.value)}
          onBlur={(e) => commitTail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          style={inputStyle}
        />
        <span>ms</span>
      </label>
      {hasOverride && (
        <button
          onClick={() => onChange({ min_scene_ms: null, tail_buffer_ms: null })}
          className="text-xs underline"
          style={{ color: 'var(--text-muted)' }}
          title="Clear the per-doc override and fall back to the workspace default"
        >
          Reset
        </button>
      )}
      <span className="ml-auto" style={{ opacity: 0.7, maxWidth: 420 }}>
        Defaults: {DEFAULT_MIN_SCENE_MS} ms min, {DEFAULT_TAIL_BUFFER_MS} ms tail. Affects this doc only.
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-xs px-1.5 py-0.5 rounded transition-all"
      style={{
        background: copied ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.06)',
        color: copied ? '#34d399' : 'var(--text-muted)',
        border: '1px solid transparent',
      }}
      title="Copy to clipboard"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function ImageLightbox({
  imageUrl,
  panelUrls,
  panelGrid,
  onClose,
}: {
  imageUrl: string;
  /** When set + length > 1, the lightbox shows a panel-by-panel slider
   *  with ← → arrows (mouse + keyboard) and a "N/total" counter. The
   *  current panel's URL drives the displayed image + download. Used
   *  for doodle_explainer_2 motion_collage rows so the user can step
   *  through the 4 keyframes one by one at full size. */
  panelUrls?: readonly string[];
  /** Optional cols / rows. When supplied + panelUrls is present, the
   *  lightbox offers a Grid view toggle that arranges all panels in
   *  the original N×M grid — showing what the "collage" would look
   *  like if we'd generated it as a single image (we don't anymore;
   *  per plan §D each panel is its own Atlas call). Without grid the
   *  toggle is hidden and only the slider view renders. */
  panelGrid?: { cols: number; rows: number };
  onClose: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [viewMode, setViewMode] = useState<'slider' | 'grid'>('slider');
  const hasPanels = Array.isArray(panelUrls) && panelUrls.length > 1;
  const totalPanels = hasPanels ? panelUrls!.length : 1;
  const displayUrl = hasPanels ? panelUrls![currentIndex] ?? imageUrl : imageUrl;
  const canShowGrid =
    hasPanels && panelGrid && panelGrid.cols > 0 && panelGrid.rows > 0
    && panelGrid.cols * panelGrid.rows === panelUrls!.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (!hasPanels) return;
      // 'g' toggles between slider and grid view when grid is available.
      if (e.key === 'g' && canShowGrid) {
        e.preventDefault();
        setViewMode((m) => (m === 'slider' ? 'grid' : 'slider'));
        return;
      }
      // Arrow / number navigation is meaningful only in slider mode.
      if (viewMode !== 'slider') return;
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        setCurrentIndex((i) => (i + 1) % totalPanels);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setCurrentIndex((i) => (i - 1 + totalPanels) % totalPanels);
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < totalPanels) setCurrentIndex(idx);
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, hasPanels, totalPanels, viewMode, canShowGrid]);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    try {
      // Fetch as blob so cross-origin R2 URLs save instead of navigating.
      // The browser ignores `download` on cross-origin anchors without
      // matching CORS headers, so a fetch-then-objectURL is the reliable path.
      // eslint-disable-next-line no-restricted-syntax -- CORS image-blob download, not a mutation
      const res = await fetch(displayUrl, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const filename = (() => {
        try {
          const u = new URL(displayUrl);
          const tail = u.pathname.split('/').filter(Boolean).pop();
          if (tail && /\.[a-z0-9]{2,5}$/i.test(tail)) return tail;
        } catch { /* fall through */ }
        const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
        const panelSuffix = hasPanels ? `-panel${currentIndex + 1}of${totalPanels}` : '';
        return `image${panelSuffix}-${Date.now()}.${ext}`;
      })();
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // CORS-blocked or offline — open the raw URL in a new tab as a fallback
      // so the user can right-click → Save As. Better than a silent failure.
      window.open(displayUrl, '_blank', 'noopener,noreferrer');
      toast.message('Download blocked by browser. Opened in a new tab instead.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        cursor: 'zoom-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          display: 'flex',
          gap: 8,
        }}
      >
        {canShowGrid && (
          <button
            type="button"
            onClick={() => setViewMode((m) => (m === 'slider' ? 'grid' : 'slider'))}
            aria-label={viewMode === 'slider' ? 'Switch to grid (collage) view' : 'Switch to slider (frame-by-frame) view'}
            title={
              viewMode === 'slider'
                ? `Show all ${totalPanels} panels as a ${panelGrid!.cols}×${panelGrid!.rows} collage (g)`
                : 'Back to frame-by-frame slider (g)'
            }
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 18,
              background: viewMode === 'grid' ? 'rgba(167,139,250,0.25)' : 'rgba(255,255,255,0.10)',
              border: viewMode === 'grid' ? '1px solid rgba(167,139,250,0.45)' : '1px solid rgba(255,255,255,0.20)',
              color: viewMode === 'grid' ? '#c4b5fd' : '#fff',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {viewMode === 'slider' ? '▦ Collage' : '↯ Frames'}
          </button>
        )}
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloading}
          aria-label="Download image"
          title="Download image"
          style={{
            height: 36,
            padding: '0 14px',
            borderRadius: 18,
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 500,
            cursor: downloading ? 'wait' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            opacity: downloading ? 0.7 : 1,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {downloading ? 'Downloading…' : 'Download'}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          title="Close (Esc)"
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.20)',
            color: '#fff',
            fontSize: 18,
            lineHeight: 1,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>
      {viewMode === 'grid' && canShowGrid ? (
        // Collage view — every panel arranged in the original cols×rows
        // grid, sized to fill the available viewport. Thin gap between
        // cells echoes the gutter the LLM's panel prompts implied. The
        // ↯ Frame N badges in the corner of each cell let the user
        // map cell → slider index quickly.
        <div
          onClick={e => e.stopPropagation()}
          style={{
            maxWidth: '92vw',
            maxHeight: '92vh',
            // Pick the dimension that fits the source aspect so neither
            // axis overflows. Each cell is 16:9 (matches the per-shot
            // render canvas), so total grid aspect = cols/rows * 16/9.
            aspectRatio: `${panelGrid!.cols * 16}/${panelGrid!.rows * 9}`,
            display: 'grid',
            gridTemplateColumns: `repeat(${panelGrid!.cols}, 1fr)`,
            gridTemplateRows: `repeat(${panelGrid!.rows}, 1fr)`,
            gap: 6,
            background: 'rgba(255,255,255,0.08)',
            padding: 6,
            borderRadius: 10,
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          }}
        >
          {panelUrls!.map((url, idx) => (
            <button
              key={idx}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentIndex(idx);
                setViewMode('slider');
              }}
              aria-label={`Open frame ${idx + 1} in slider view`}
              title={`Frame ${idx + 1} — click to open in slider view`}
              style={{
                position: 'relative',
                background: 'transparent',
                padding: 0,
                border: 'none',
                cursor: 'pointer',
                overflow: 'hidden',
                borderRadius: 4,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Panel ${idx + 1}`}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  left: 4,
                  fontSize: 11,
                  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                  background: 'rgba(0,0,0,0.65)',
                  color: '#fff',
                  padding: '2px 6px',
                  borderRadius: 4,
                  pointerEvents: 'none',
                }}
              >
                ↯ {idx + 1}
              </span>
            </button>
          ))}
        </div>
      ) : (
        // Slider view (default) — current panel only, full size.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={displayUrl}
          alt={hasPanels ? `Frame ${currentIndex + 1} of ${totalPanels}` : 'Full preview'}
          onClick={e => e.stopPropagation()}
          style={{
            maxWidth: '92vw',
            maxHeight: '92vh',
            objectFit: 'contain',
            borderRadius: 8,
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            cursor: 'default',
          }}
        />
      )}
      {hasPanels && viewMode === 'slider' && (
        <>
          {/* Left arrow — previous frame */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCurrentIndex((i) => (i - 1 + totalPanels) % totalPanels);
            }}
            aria-label="Previous frame"
            title="Previous frame (←)"
            style={{
              position: 'absolute',
              left: 16,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 48,
              height: 48,
              borderRadius: 24,
              background: 'rgba(255,255,255,0.10)',
              border: '1px solid rgba(255,255,255,0.20)',
              color: '#fff',
              fontSize: 24,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ‹
          </button>
          {/* Right arrow — next frame */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setCurrentIndex((i) => (i + 1) % totalPanels);
            }}
            aria-label="Next frame"
            title="Next frame (→ or Space)"
            style={{
              position: 'absolute',
              right: 16,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 48,
              height: 48,
              borderRadius: 24,
              background: 'rgba(255,255,255,0.10)',
              border: '1px solid rgba(255,255,255,0.20)',
              color: '#fff',
              fontSize: 24,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ›
          </button>
          {/* Frame counter + clickable dots — bottom centered */}
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              bottom: 24,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              color: '#fff',
            }}
          >
            <div style={{ display: 'flex', gap: 6 }}>
              {panelUrls!.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setCurrentIndex(i)}
                  aria-label={`Jump to frame ${i + 1}`}
                  title={`Frame ${i + 1}${i < 9 ? ` (press ${i + 1})` : ''}`}
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    border: 'none',
                    background:
                      i === currentIndex
                        ? '#a78bfa'
                        : 'rgba(255,255,255,0.30)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
            </div>
            <div
              style={{
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                background: 'rgba(0,0,0,0.55)',
                padding: '4px 10px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.15)',
              }}
            >
              ↯ Frame {currentIndex + 1} / {totalPanels}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Smart-edit panel for the production-doc image cell.
 *
 * Two phases:
 *   1. Compose — original image preview + prompt textarea + Apply.
 *      "Paint a region instead…" link opens the brush mask editor
 *      (passed in as `onOpenBrush`); when not provided, the link
 *      stays hidden.
 *   2. Review — before/after side-by-side + Use this / Try another /
 *      Discard. The new image is never persisted to the row until the
 *      user clicks "Use this".
 *
 * The panel survives one apply cycle. Users can iterate prompts in
 * Compose mode and the original stays on the row until they accept a
 * candidate.
 */
function EditPanel({
  sourceImageUrl,
  initialResult,
  option,
  onOptionChange,
  onApply,
  onUseThis,
  onOpenBrush,
  onClose,
}: {
  sourceImageUrl: string;
  /** When provided, the panel opens directly in review mode showing
   *  before/after. Used by the brush flow: the brush modal produces
   *  the result, then hands the panel off to render the review UI
   *  with a consistent "Use this / Discard" experience. */
  initialResult?: { imageUrl: string; saliency: ImageSaliencyMap | null } | null;
  /** Active edit option (parent owns the state so the brush surface
   *  reads the same value). */
  option: EditOption;
  onOptionChange: (next: EditOption) => void;
  onApply: (prompt: string) => Promise<EditResult>;
  onUseThis: (imageUrl: string, saliency: ImageSaliencyMap | null) => void;
  /** Open the mask brush modal. Optional; when absent the in-panel
   *  brush link stays hidden. */
  onOpenBrush?: () => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<{ imageUrl: string; saliency: ImageSaliencyMap | null } | null>(
    initialResult ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function apply() {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError(null);
    const r = await onApply(prompt.trim());
    setIsGenerating(false);
    if (r.ok) {
      setResult({ imageUrl: r.imageUrl, saliency: r.saliency });
    } else {
      setError(r.error);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #181818)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 20,
          width: 'min(960px, 96vw)',
          maxHeight: '92vh',
          overflowY: 'auto',
          color: 'var(--text-primary)',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Edit image</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {!result ? (
          <>
            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'flex-start',
                flexWrap: 'wrap',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sourceImageUrl}
                alt="Original"
                style={{
                  width: 320,
                  maxWidth: '100%',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  display: 'block',
                  background: '#000',
                }}
              />
              <div style={{ flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Model
                </label>
                <select
                  value={option.id}
                  onChange={(e) => {
                    const next = getEditOption(e.target.value);
                    if (next) onOptionChange(next);
                  }}
                  disabled={isGenerating}
                  style={{
                    background: 'var(--bg-card, #111)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    fontSize: 13,
                    fontFamily: 'inherit',
                  }}
                >
                  {getSortedEditOptions().map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {formatEditOptionLabel(opt)}{opt.maskCapable ? ' · brush' : ''}
                    </option>
                  ))}
                </select>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {option.tagline}
                </div>

                {option.maskCapable ? (
                  // Mask-capable models need a brush — the model
                  // requires `mask_url` on the API side. The panel
                  // hands the user straight to the brush editor; the
                  // textarea + Apply button only make sense for
                  // prompt-only models.
                  <div
                    className="text-xs"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'var(--bg-card, #111)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: 10,
                      marginTop: 4,
                    }}
                  >
                    This model edits a region you paint. Click below to open the brush, mark the area, and apply.
                  </div>
                ) : (
                  <>
                    <label className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                      What should change?
                    </label>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="e.g. change the t-shirt to red, make the sky stormy, add a sunset glow"
                      rows={5}
                      disabled={isGenerating}
                      style={{
                        background: 'var(--bg-card, #111)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: 8,
                        fontSize: 13,
                        resize: 'vertical',
                        fontFamily: 'inherit',
                      }}
                      maxLength={2000}
                    />
                  </>
                )}
                {error && (
                  <div className="text-xs" style={{ color: '#f87171' }} role="alert">
                    {error}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {option.maskCapable ? (
                    onOpenBrush && (
                      <button
                        type="button"
                        onClick={onOpenBrush}
                        disabled={isGenerating}
                        className="text-xs px-3 py-1.5 rounded"
                        style={{
                          background: 'rgba(168,85,247,0.20)',
                          color: '#c084fc',
                          border: '1px solid rgba(168,85,247,0.35)',
                          cursor: isGenerating ? 'not-allowed' : 'pointer',
                        }}
                      >
                        🖌 Paint a region to edit
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={apply}
                      disabled={!prompt.trim() || isGenerating}
                      className="text-xs px-3 py-1.5 rounded"
                      style={{
                        background: !prompt.trim() || isGenerating
                          ? 'rgba(120,120,120,0.18)'
                          : 'rgba(168,85,247,0.20)',
                        color: !prompt.trim() || isGenerating ? 'var(--text-muted)' : '#c084fc',
                        border: '1px solid rgba(168,85,247,0.35)',
                        cursor: !prompt.trim() || isGenerating ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isGenerating ? 'Generating…' : `Apply (${formatEditOptionLabel(option)})`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={isGenerating}
                    className="text-xs px-3 py-1.5 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      cursor: isGenerating ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
                  Before
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourceImageUrl}
                  alt="Before"
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    display: 'block',
                    background: '#000',
                  }}
                />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: '#c084fc' }}>
                  After
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={result.imageUrl}
                  alt="After"
                  style={{
                    width: '100%',
                    borderRadius: 6,
                    border: '1px solid rgba(168,85,247,0.45)',
                    display: 'block',
                    background: '#000',
                  }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  onUseThis(result.imageUrl, result.saliency);
                  onClose();
                }}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'rgba(34,197,94,0.18)',
                  color: '#86efac',
                  border: '1px solid rgba(34,197,94,0.40)',
                  cursor: 'pointer',
                }}
              >
                ✓ Use this
              </button>
              <button
                type="button"
                onClick={() => {
                  setResult(null);
                  setError(null);
                }}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Try another prompt
              </button>
              <button
                type="button"
                onClick={onClose}
                className="text-xs px-3 py-1.5 rounded"
                style={{
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                Discard
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Result shape returned by edit operations. Defined at module scope so
 *  EditPanel + future MaskBrushEditor share a single type. */
type EditResult =
  | { ok: true; imageUrl: string; saliency: ImageSaliencyMap | null }
  | { ok: false; error: string };

export function ImageCell({
  state,
  onRetry,
  onUpload,
  onUrlImport,
  onEdit,
  canGenerate = true,
  motionCollagePanelUrls,
  motionCollageGrid,
  pipelineError,
  pipelineErrorExhausted,
  onPipelineErrorRetry,
}: {
  state: RowImageState;
  onRetry: () => void;
  /** Attach a locally-selected file to the row. Wired to the ⬆ button in
   *  the idle column-of-three layout. */
  onUpload?: (file: File) => void;
  /** Mirror an external HTTPS image URL into our R2 bucket and attach. */
  onUrlImport?: (url: string) => void;
  /** Open the smart edit panel (Tier 1 prompt edit + Tier 2 brush mask).
   *  Available on rows with a ready image. */
  onEdit?: () => void;
  /** False when the row has no AI prompt to generate from — disables the
   *  idle-state Generate button. Defaults to true so unmodified callers
   *  keep their old behaviour (an enabled button). */
  canGenerate?: boolean;
  /** doodle_explainer_2 motion_collage panels — when present + length
   *  > 1, replaces the single-image preview with a mini grid showing
   *  every keyframe. Index 0 first (top-left), row-major. Undefined ⇒
   *  ImageCell renders the regular single-image preview. */
  motionCollagePanelUrls?: readonly string[];
  /** Grid layout for the panels preview. When omitted, ImageCell
   *  derives cols/rows from the panel count (preferring square layouts).
   *  See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */
  motionCollageGrid?: { cols: number; rows: number };
  /** PR2 reliability (2026-06-03). Server-persisted failure info from
   *  the auto-pipeline's last attempt at this row. When set together
   *  with `pipelineErrorExhausted=true`, the cell renders an error
   *  chip whose tooltip carries the sanitized message + timestamp.
   *  Click → `onPipelineErrorRetry` which clears the row's attempts
   *  + last_error so the pipeline picks it up again next tick. */
  pipelineError?: {
    class: string;
    message: string;
    at: string;
  } | null;
  /** True when `pipelineError.attempts >= RETRY_BUDGETS[class]`. Drives
   *  whether the chip is shown (exhausted) vs. silently retried by the
   *  pipeline (not exhausted yet). */
  pipelineErrorExhausted?: boolean;
  /** Reset this row's `attempts` and `last_error` so the next pipeline
   *  tick re-enters it. Called from the chip's Retry button. */
  onPipelineErrorRetry?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [urlInputOpen, setUrlInputOpen] = useState(false);
  const [urlInputValue, setUrlInputValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Idle state used to render nothing — leaving the cell visually empty
  // with no way to trigger generation. After sanitizing stale 'loading'
  // statuses on restore (fix from b4366fa), every row that was mid-gen
  // when the page refreshed comes back as 'idle', so this state went
  // from "uncommon" to "common after refresh". Render three actions
  // (Generate / Upload / URL) so the user has obvious next steps even
  // when the row has no AI prompt.
  if (state.status === 'idle') {
    return (
      <div className="flex flex-col gap-1">
        {/* PR2 (2026-06-03): pipeline-failure chip. Shown when the
            auto-pipeline tried this row, hit the per-class retry
            budget, and gave up. The chip's Retry button clears the
            row's last_error + attempts so the next pipeline tick
            picks it up again. The full sanitized message + timestamp
            surface in the title tooltip. */}
        {pipelineError && pipelineErrorExhausted && onPipelineErrorRetry && (
          <div
            role="alert"
            title={`${pipelineError.message}\nFailed at ${new Date(pipelineError.at).toLocaleString()}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 4,
              background: 'rgba(239,68,68,0.12)',
              border: '1px solid rgba(239,68,68,0.40)',
              color: '#fca5a5',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              alignSelf: 'flex-start',
            }}
          >
            <span aria-hidden="true">⚠</span>
            <span>{labelForErrorClass(pipelineError.class)}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPipelineErrorRetry();
              }}
              style={{
                marginLeft: 4,
                background: 'transparent',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.30)',
                borderRadius: 3,
                fontSize: 11,
                padding: '1px 6px',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={onRetry}
            disabled={!canGenerate}
            title={canGenerate ? 'Generate this image with the current prompt' : 'Add an AI prompt to this row first'}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
            style={{
              background: canGenerate ? 'rgba(168,85,247,0.12)' : 'transparent',
              color: canGenerate ? '#c084fc' : 'var(--text-muted)',
              border: `1px solid ${canGenerate ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.10)'}`,
              cursor: canGenerate ? 'pointer' : 'not-allowed',
            }}
          >
            ＋ Generate
          </button>
          {onUpload && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Upload an image from your computer"
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
                style={{
                  background: 'rgba(59,130,246,0.10)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59,130,246,0.30)',
                  cursor: 'pointer',
                }}
              >
                ⬆ Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onUpload(f);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {onUrlImport && (
            <button
              type="button"
              onClick={() => setUrlInputOpen((v) => !v)}
              title="Import an image from an external HTTPS URL"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
              style={{
                background: 'rgba(120,120,120,0.10)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.10)',
                cursor: 'pointer',
              }}
            >
              🔗 URL
            </button>
          )}
        </div>
        {urlInputOpen && onUrlImport && (
          <div className="flex items-center gap-1">
            <input
              type="url"
              value={urlInputValue}
              placeholder="https://…"
              onChange={(e) => setUrlInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && urlInputValue.trim()) {
                  onUrlImport(urlInputValue.trim());
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                } else if (e.key === 'Escape') {
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                }
              }}
              className="text-xs px-1.5 py-0.5 rounded flex-1"
              style={{
                background: 'var(--bg-elevated, #1a1a1a)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                minWidth: 140,
              }}
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                if (urlInputValue.trim()) {
                  onUrlImport(urlInputValue.trim());
                  setUrlInputValue('');
                  setUrlInputOpen(false);
                }
              }}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(59,130,246,0.18)', color: '#60a5fa' }}
            >
              Go
            </button>
          </div>
        )}
      </div>
    );
  }

  if (state.status === 'uploading') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="spinner" style={{ width: 14, height: 14 }} />
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>uploading</span>
      </div>
    );
  }

  if (state.status === 'search') {
    // Phase 1.6 (Bug F): when the row was initialized to 'search'
    // because it had no ai_image_prompt at the time AND the user has
    // since added a prompt, the row CAN generate now — surface
    // "Generate AI image" as the primary action with "Search Images"
    // demoted to a secondary link. Without this branch, the only
    // affordance on a search-state row is the search link, which
    // hides the generate path the user clearly wants. Spec:
    // _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-F).
    if (canGenerate) {
      return (
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={onRetry}
            title="Generate this image with the current prompt"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
            style={{
              background: 'rgba(168,85,247,0.12)',
              color: '#c084fc',
              border: '1px solid rgba(168,85,247,0.35)',
              cursor: 'pointer',
            }}
          >
            ＋ Generate AI image
          </button>
          <a
            href={state.searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Search Google Images for this row's stock terms (secondary — the AI prompt is what produces a doodle)"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
            style={{
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid rgba(255,255,255,0.10)',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            Search
          </a>
        </div>
      );
    }
    return (
      <a
        href={state.searchUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded whitespace-nowrap"
        style={{ background: 'rgba(59,130,246,0.12)', color: '#60a5fa' }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        Search Images
      </a>
    );
  }

  if (state.status === 'pending') {
    return (
      <span className="text-xs" style={{ color: 'var(--text-muted)', letterSpacing: 2 }}>•••</span>
    );
  }

  if (state.status === 'loading') {
    return <div className="spinner" style={{ width: 16, height: 16 }} />;
  }

  if (state.status === 'done' && state.imageUrl) {
    // Motion collage preview: when the row carries multiple panels,
    // render a mini grid of every keyframe instead of just the first.
    // Same 80×50 footprint as the regular preview so table-row heights
    // don't reflow. Each cell is a thumbnail of one keyframe — click
    // still opens the lightbox of panel 0 (state.imageUrl). The grid
    // count + layout come from the row, with a square-ish fallback
    // when only the panel array is provided.
    const panels = motionCollagePanelUrls ?? [];
    const showMotionCollageGrid = panels.length > 1;
    let collageCols = 2;
    let collageRows = 2;
    if (showMotionCollageGrid) {
      if (motionCollageGrid && motionCollageGrid.cols > 0 && motionCollageGrid.rows > 0) {
        collageCols = motionCollageGrid.cols;
        collageRows = motionCollageGrid.rows;
      } else {
        // Square-ish default: ceil(sqrt(N)) cols, ceil(N / cols) rows.
        collageCols = Math.ceil(Math.sqrt(panels.length));
        collageRows = Math.ceil(panels.length / collageCols);
      }
    }
    return (
      <>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            title={
              showMotionCollageGrid
                ? `Motion collage — ${panels.length} keyframes. Click to preview frame 1 full size.`
                : 'Click to preview full size'
            }
            style={{
              padding: 0,
              background: 'transparent',
              border: 'none',
              cursor: 'zoom-in',
              display: 'block',
            }}
          >
            {showMotionCollageGrid ? (
              <div
                style={{
                  width: 80,
                  height: 50,
                  borderRadius: 5,
                  border: '1px solid var(--border)',
                  display: 'grid',
                  gridTemplateColumns: `repeat(${collageCols}, 1fr)`,
                  gridTemplateRows: `repeat(${collageRows}, 1fr)`,
                  gap: 1,
                  background: 'var(--border)',
                  overflow: 'hidden',
                }}
                aria-label={`Motion collage with ${panels.length} keyframes`}
              >
                {panels.slice(0, collageCols * collageRows).map((url, idx) => (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={idx}
                    src={url}
                    alt={`Motion collage panel ${idx + 1}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      display: 'block',
                    }}
                  />
                ))}
              </div>
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={state.imageUrl}
                alt="AI generated"
                style={{
                  width: 80,
                  height: 50,
                  objectFit: 'cover',
                  borderRadius: 5,
                  border: '1px solid var(--border)',
                  display: 'block',
                }}
              />
            )}
          </button>
          {/* Re-generate + Edit overlay buttons. ↻ re-rolls the row's
              prompt-based generation; only shown for rows whose image
              came from generation or a prior edit (an upload / URL
              import has no prompt to re-roll, so the button would 404
              into nothing useful). ✎ opens the smart edit panel and is
              always available — uploads are edits' primary use case. */}
          {canGenerate && state.source !== 'upload' && state.source !== 'url' && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
              title="Re-generate this image with the current prompt"
              aria-label="Re-generate image"
              style={{
                position: 'absolute',
                top: 2,
                right: onEdit ? 22 : 2,
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'rgba(0,0,0,0.55)',
                color: '#e5e7eb',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↻
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              title="Edit with a prompt or paint a region to change"
              aria-label="Edit image"
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: 18,
                height: 18,
                padding: 0,
                borderRadius: 4,
                border: '1px solid rgba(168,85,247,0.45)',
                background: 'rgba(0,0,0,0.65)',
                color: '#c084fc',
                fontSize: 11,
                lineHeight: 1,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ✎
            </button>
          )}
          {state.source && state.source !== 'generated' && (
            <span
              title={
                state.source === 'upload' ? 'Uploaded image'
                : state.source === 'url' ? 'Imported from URL'
                : 'Edited image'
              }
              style={{
                position: 'absolute',
                bottom: 2,
                left: 2,
                fontSize: 9,
                lineHeight: 1,
                padding: '1px 3px',
                borderRadius: 3,
                background: 'rgba(0,0,0,0.65)',
                color: '#e5e7eb',
              }}
            >
              {state.source === 'upload' ? '📷' : state.source === 'url' ? '🔗' : '✎'}
            </span>
          )}
        </div>
        {previewOpen && (
          <ImageLightbox
            imageUrl={state.imageUrl}
            panelUrls={motionCollagePanelUrls}
            panelGrid={motionCollageGrid}
            onClose={() => setPreviewOpen(false)}
          />
        )}
      </>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: '#f87171' }} title={state.error}>⚠ Failed</span>
        <button
          onClick={onRetry}
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
        >
          Retry
        </button>
      </div>
    );
  }

  return null;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProductionDocPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading…</div>}>
      <ProductionDocPage />
    </Suspense>
  );
}

function ProductionDocPage() {
  const search = useSearchParams();
  // router.replace is used by `ensureProjectForVoiceover` below to stamp
  // a newly-auto-created `?projectId=` into the URL so a reload keeps the
  // production-doc linked to its draft project.
  const router = useRouter();
  // Whether the local ComfyUI stack is wired up in this env (controls
  // visibility of the "Local (free)" image-model entries below).
  const localStudioEnabled = useLocalStudioEnabled();
  // Phase 3 follow-up (2026-05-25) — opt-in toggle for the new
  // multi-pane editor view (`src/components/production-doc/editor/`).
  // Default off so existing grid-view workflows are unaffected.
  // Initial state honors `?view=editor` in the URL for shareable links;
  // user clicks of the header button flip it without touching the URL
  // (kept simple — no router.replace) since the toggle is exploratory.
  const [editorViewMode, setEditorViewMode] = useState<'grid' | 'editor'>(
    search?.get('view') === 'editor' ? 'editor' : 'grid',
  );
  const scheduleItemId = getScheduleLinkId(search);
  // Direct project handoff (e.g. from the project detail page's "Send to
  // Production Doc" button). Mirrors the schedule-item path but pulls the
  // metadata + active script straight off /api/projects/[id] so the
  // owner doesn't need a schedule item in the loop.
  const projectIdParam = search.get('projectId');
  // Wave 1 (?videoId=) handoff. The Command Center kanban and the
  // VideoContextStrip's Open-in-tool buttons route here with
  // ?videoId=<project-uuid>. This parallel param lets the page-body
  // prefill from /api/videos/[id] without changing the existing
  // ?projectId= path.
  const videoIdParam = search.get('videoId');
  const [scheduleItem, setScheduleItem] = useState<ScheduleItem | null>(null);
  const [schedulePrefilled, setSchedulePrefilled] = useState(false);
  const [projectPrefilled, setProjectPrefilled] = useState(false);
  const [videoPrefilled, setVideoPrefilled] = useState(false);

  // — Inputs
  const [script, setScript] = useState('');
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the user has a non-empty selection in the script textarea —
  // drives the disabled state of the "Mark as title" button. We update on
  // every select/keyup so the toolbar reacts to keyboard selection too.
  const [hasScriptSelection, setHasScriptSelection] = useState(false);
  // Pre-flight title-review overrides. `null` ⇒ the panel never reviewed
  // anything, generation falls back to the server-side extractor as
  // before. A non-null array is what the TitleReviewPanel handed back —
  // we forward it to /production-doc on chunk 0 only (continuation
  // chunks suppress Title Cards anyway). See
  // `_plans/2026-05-31-preflight-title-review.md`.
  const [reviewedTitles, setReviewedTitles] = useState<UserTitleSpec[] | null>(null);
  const [niche, setNiche] = useState('');
  const [topic, setTopic] = useState('');
  // Per-session override only. The canonical default is set in
  // Settings → Model Defaults and resolved server-side.
  const [modelId, setModelId] = useState(() => getFeatureDefaultModelId('production-doc'));
  // Phase 3.1 (2026-05-29): read default through `getPref` so cross-
  // machine sync works. The bootstrap in AppLayout populates
  // localStorage from the server before this component mounts on any
  // route the user navigates to second. First-ever load on a brand-
  // new device returns the fallback (DEFAULT_IMAGE_MODEL), which is
  // correct — the user just hasn't picked one yet.
  const [imageModel, setImageModel] = useState<string>(() => {
    const saved = getPref<string>('prodoc_image_model', DEFAULT_IMAGE_MODEL);
    if (saved && getImageModelSpec(saved)) return saved;
    return DEFAULT_IMAGE_MODEL;
  });
  useEffect(() => {
    setPref('prodoc_image_model', imageModel);
  }, [imageModel]);
  // User preference for the doc-level `overlays_disabled` flag on freshly-
  // generated docs. Now persisted via setPref so the choice follows the
  // user across machines. Existing docs carry their own
  // `overlays_disabled` field independently — this only seeds new ones.
  const [overlaysDisabledPref, setOverlaysDisabledPref] = useState<boolean>(() =>
    getPref<boolean>('prodoc_overlays_disabled_pref', false),
  );
  useEffect(() => {
    setPref('prodoc_overlays_disabled_pref', overlaysDisabledPref || null);
  }, [overlaysDisabledPref]);
  const [speakingPace, setSpeakingPace] = useState(135);
  const [actualDuration, setActualDuration] = useState(''); // "mm:ss" of actual voiceover recording
  const [stylePreset, setStylePreset] = useState('doodle_explainer');
  // Server-stored "default style for new sessions" — fetched on mount,
  // applied when the user clicks "New session" (or on first-ever load
  // when no form-input cache exists), and updated when the user clicks
  // the ⭐ on a style chip. `null` until fetched; `''` after fetch if
  // the user hasn't set one (we still surface the library default in
  // the picker UI as the fallback).
  const [userDefaultStyle, setUserDefaultStyle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads user setting
        const res = await fetch('/api/user/settings/default-style', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { stylePreset?: string; isExplicit?: boolean };
        if (cancelled) return;
        setUserDefaultStyle(data.isExplicit ? (data.stylePreset ?? null) : '');
      } catch { /* leave at library default */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const setStyleAsDefault = useCallback(async (slug: string) => {
    setUserDefaultStyle(slug);
    try {
      // eslint-disable-next-line no-restricted-syntax -- small awaited PUT for a user setting; not a tab-close-loss bug
      await fetch('/api/user/settings/default-style', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stylePreset: slug }),
      });
      toast.success('Default style updated.');
    } catch {
      toast.error('Could not save default — try again.');
    }
  }, []);
  const [creativeBrief, setCreativeBrief] = useState('');
  const [availableStyles, setAvailableStyles] = useState<StyleSummary[]>(FALLBACK_BUILT_IN_STYLES);
  const [stylesLoaded, setStylesLoaded] = useState(false);
  const [styleManagerOpen, setStyleManagerOpen] = useState(false);

  /**
   * Load the full universe of styles (built-ins + workspace-saved) once
   * on mount. The endpoint is cheap (one SELECT against an indexed
   * workspace_id) so we don't bother with stale-while-revalidate; we
   * just refetch after every mutation in the dialog.
   */
  const loadStyles = useCallback(async () => {
    try {
      // eslint-disable-next-line no-restricted-syntax -- GET, loads styles list
      const res = await fetch('/api/production-doc/styles');
      if (!res.ok) {
        // Stay on the fallback list — the picker will still work for built-ins.
        setStylesLoaded(true);
        return;
      }
      const data = await res.json();
      const list: StyleSummary[] = Array.isArray(data?.styles) ? data.styles : [];
      if (list.length > 0) setAvailableStyles(list);
      setStylesLoaded(true);
    } catch {
      setStylesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadStyles();
  }, [loadStyles]);

  // Analyzer-bridge URL prefill (Phase 3 of _plans/2026-05-19-analyzer-
  // as-input-source.md). When the operator deep-links from
  // /analyze/[id]'s "Use style in production doc" button, the URL
  // carries ?stylePreset=<id>. Apply once after styles load — if the
  // id isn't in the available-styles list, the existing reconciliation
  // effect just below this one falls it back to the first built-in,
  // matching the behavior for a deleted saved style.
  const [stylePresetUrlApplied, setStylePresetUrlApplied] = useState(false);
  useEffect(() => {
    if (stylePresetUrlApplied) return;
    if (!stylesLoaded) return;
    const fromUrl = search.get('stylePreset');
    if (!fromUrl) return;
    setStylePreset(fromUrl);
    setStylePresetUrlApplied(true);
    const match = availableStyles.find((s) => s.id === fromUrl);
    if (match) {
      toast.message(`Loaded style "${match.label}" from the analyzer`);
    }
  }, [search, stylesLoaded, availableStyles, stylePresetUrlApplied]);

  // If the currently-selected style id disappears (e.g. user deleted the
  // saved style they had picked), fall back to the first built-in so the
  // picker doesn't end up with no active selection.
  useEffect(() => {
    if (!stylesLoaded) return;
    if (availableStyles.some((s) => s.id === stylePreset)) return;
    const fallback = availableStyles.find((s) => s.origin === 'built-in') ?? availableStyles[0];
    if (fallback) setStylePreset(fallback.id);
  }, [availableStyles, stylesLoaded, stylePreset]);

  // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
  // resolve the currently-selected style id to its built-in slug. Built-ins
  // resolve to their own id; saved styles resolve to `based_on_built_in`.
  // Threaded into every `productionDocToVideoConfig` call below so the
  // Remotion preview / render routes the doodle-yellow LowerThird for
  // saved styles derived from doodle_explainer_2 / paint_explainer_v1.
  // Undefined when the resolver finds no match — the legacy path uses
  // `doc.style_preset` verbatim in that case.
  const effectiveStyleSlug = useMemo<string | undefined>(() => {
    if (!stylePreset) return undefined;
    const match = availableStyles.find((s) => s.id === stylePreset);
    if (!match) return undefined;
    if (match.origin === 'built-in') return match.id;
    if (match.origin === 'saved') return match.based_on_built_in ?? undefined;
    return undefined;
  }, [stylePreset, availableStyles]);
  const [ytRefInput, setYtRefInput] = useState('');
  const [visualRefs, setVisualRefs] = useState<VisualRef[]>([]);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  // — Generation
  const [generating, setGenerating] = useState(false);
  const [generationLog, setGenerationLog] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [doc, setDoc] = useState<ProductionDoc | null>(null);
  // Pre-generation motion-collage settings — the doc-level panel
  // (DoodleExplainer2MotionCollageSettingsPanel) writes here when
  // `doc === null` so the user can tune cadence / panel cap / per-frame
  // duration BEFORE clicking Generate. The settings flow into the
  // doc-gen API body so the LLM emits motion_collage rows that match
  // the constraints, and are stamped onto the new doc on first
  // generation so the panel stays in sync. After a doc exists, the
  // panel writes directly to doc.doodle_explainer_2_motion_collage_settings
  // and this state becomes a no-op fallback.
  const [pendingMotionCollageSettings, setPendingMotionCollageSettings] = useState<
    DoodleExplainer2MotionCollageSettings | undefined
  >(undefined);

  // Pre-generation pacing pick. Same lifetime pattern as
  // `pendingMotionCollageSettings` above: the PacingProfilePanel writes
  // here while `doc === null` so the user can choose pace BEFORE clicking
  // Generate. The value flows into the doc-gen API body so the LLM uses
  // the right per-row word budget on the first run, and gets stamped onto
  // the resulting `doc.pacing_profile` so the panel stays in sync. After
  // a doc exists, the panel writes directly to doc.pacing_profile and
  // this state becomes a no-op fallback. Default: undefined — the panel
  // visually shows 'fast' as the recommendation but doesn't claim the
  // user picked it, so post-doc edits to the default still flow through
  // for unedited docs.
  const [pendingPacingProfile, setPendingPacingProfile] = useState<
    'standard' | 'fast' | 'very_fast' | undefined
  >(undefined);

  // Row indices whose motion_collage panel prompts are currently being
  // auto-filled (one LLM call via /motion-collage/panels). Drives the
  // editor's "✨ Filling…" spinner and the in-flight guard that drops
  // overlapping triggers (convert + grid-change + button) for the same row.
  const [autoFillingRows, setAutoFillingRows] = useState<ReadonlySet<number>>(new Set());

  // motion_collage rows MUST have visual_type === 'Animation'
  // regardless of what the LLM emitted. Some runs land them on
  // 'Title Card' (visible to the user as the wrong type chip and
  // confusing the filter chips at the top of the table). The renderer
  // routes on shot_kind so playback is fine either way, but the UI
  // surfaces visual_type heavily and showing "Title Card" on a
  // motion_collage row is misleading. Normalises silently whenever a
  // doc loads (fresh gen, history restore, regenerate). Skips when
  // the row is already correct so the useEffect doesn't loop.
  // 2026-05-31 follow-up to the SFX/[VISUAL CUE] mistag round.
  useEffect(() => {
    if (!doc) return;
    let mistagged = 0;
    for (const r of doc.rows) {
      if (r.shot_kind === 'motion_collage' && r.visual_type !== 'Animation') {
        mistagged += 1;
      }
    }
    if (mistagged === 0) return;
    setDoc((prev) => {
      if (!prev) return prev;
      const nextRows = prev.rows.map((r) =>
        r.shot_kind === 'motion_collage' && r.visual_type !== 'Animation'
          ? { ...r, visual_type: 'Animation' }
          : r,
      );
      return { ...prev, rows: nextRows };
    });
    console.info('[prodoc motion-collage] normalized visual_type', { mistagged });
  }, [doc]);
  // v2 (2026-05-22) — keep doc.style_preset in sync with the page-level
  // `stylePreset` state. Persists on the user_history payload through
  // the existing auto-save pipeline so downstream surfaces (the
  // shot-graph editor in particular) can read the active style without
  // depending on transient localStorage on the production-doc page.
  // See `_plans/2026-05-21-user-defined-styles-with-reference-images.md`.
  useEffect(() => {
    if (!doc) return;
    if (doc.style_preset === stylePreset) return;
    setDoc((prev) => (prev ? { ...prev, style_preset: stylePreset } : prev));
  }, [stylePreset, doc]);

  // OST mode auto-migration for docs whose style has a non-default
  // LowerThird treatment (chunky yellow bubble in doodle_explainer_2 —
  // see SceneRouter in src/remotion/compositions/YouTubeVideo.tsx). The
  // server now sets `on_screen_text_mode_default = 'overlay'` on freshly
  // generated docs (see src/app/api/generate/production-doc/route.ts),
  // but docs created before that fix have the field undefined → fall
  // through to `'bake'` → the diffusion model paints text into the image
  // corner instead of LowerThird compositing the yellow bubble on top.
  //
  // Migration policy: only flip undefined → 'overlay'. If the user has
  // explicitly chosen `'bake'` or `'none'` for this doc (via the
  // settings toggle in EditorClient), respect that — we don't know
  // better than them.
  //
  // PR 1 of `_plans/2026-06-02-editor-ost-styling-and-positioning.md`:
  // resolve the doc's style_preset through `availableStyles` so saved
  // styles derived from doodle_explainer_2 (UUID id, not literal slug)
  // also auto-flip to overlay mode. Previously the check was a literal
  // `=== 'doodle_explainer_2'` which silently skipped every saved style.
  // Same change shape as SceneRouter's effectiveStyleSlug routing.
  //
  // The list of "styles whose OST should default to overlay" lives in
  // ONE place — when a second built-in needs the same treatment, add
  // it to YELLOW_OST_BUILTINS and the resolver below picks it up.
  useEffect(() => {
    if (!doc) return;
    if (doc.on_screen_text_mode_default !== undefined) return;
    if (!doc.style_preset) return;
    // Resolve doc.style_preset to its built-in slug:
    //  - built-in id: matches itself
    //  - saved-style UUID: resolves via `based_on_built_in`
    const match = availableStyles.find((s) => s.id === doc.style_preset);
    const effectiveSlug =
      match?.origin === 'built-in'
        ? match.id
        : match?.origin === 'saved'
          ? (match.based_on_built_in ?? null)
          : null;
    const YELLOW_OST_BUILTINS = new Set(['doodle_explainer_2', 'paint_explainer_v1']);
    if (!effectiveSlug || !YELLOW_OST_BUILTINS.has(effectiveSlug)) return;
    console.info('[production-doc OST auto-flip]', {
      stylePresetId: doc.style_preset,
      origin: match?.origin ?? '(unknown)',
      effectiveSlug,
      flippingTo: 'overlay',
    });
    setDoc((prev) =>
      prev ? { ...prev, on_screen_text_mode_default: 'overlay' } : prev,
    );
  }, [doc?.style_preset, doc?.on_screen_text_mode_default, availableStyles]);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  // Initial state from localStorage cache so the panel paints instantly;
  // useEffect below pulls the canonical list from the server (migration 0049).
  const [historyItems, setHistoryItems] = useState<ProductionDocHistoryEntry[]>(() => getProductionDocHistoryCached());
  useEffect(() => { getProductionDocHistory().then(setHistoryItems).catch(() => {}); }, []);
  // Track which history entry the current on-screen doc belongs to, so row-image
  // generations (fire-and-forget after the doc is saved) can patch back onto the
  // same entry instead of being lost.
  const [historyEntryId, setHistoryEntryId] = useState<string | null>(null);

  // Honor the `?h=<historyEntryId>` URL param. The editor's "Doc"
  // back-link carries this so navigating back lands on THIS row even
  // when localStorage doesn't have a recent session for it (cross-
  // device, cleared storage, private-browsing, etc.). Runs once on
  // mount — after this the user's interactions (history switcher,
  // generate flow) own historyEntryId. Mounted BEFORE the localStorage
  // restore effect so the URL is authoritative if both are present.
  const urlHistoryId = search.get('h');
  useEffect(() => {
    if (!urlHistoryId) return;
    if (!/^[0-9a-f-]{36}$/i.test(urlHistoryId)) {
      console.warn('[production-doc] ignoring malformed h param', { urlHistoryId });
      return;
    }
    console.info('[production-doc] loading history entry from url', { urlHistoryId });
    setHistoryEntryId(urlHistoryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Canonical project payload (Phase 2 parity refactor) ─────────
  //
  // `useProject` is the single persistence sink for everything the
  // editor at `/edit/[projectId]` needs to read: doc, rowImages,
  // rowOverlays, rowVideoClips, voiceoverUrl, voiceoverAlignment,
  // brand kit override, channelId, and every flag. Local state hooks
  // remain the WORKING copy (so the page UI doesn't have to be
  // rewritten); a single reactive effect mirrors them into
  // `project.patch` whenever any canonical field changes. The hook
  // bails internally when given an empty id — pre-generation, no
  // patches fire and no fetches hit the server.
  //
  // `onConflict` is a no-op for now: production-doc edits don't
  // typically race with editor edits unless the user has two tabs
  // open. Phase 4 polish can surface a banner; for now the version
  // conflict is logged at the hook level and the save status flips
  // to 'conflict' silently.
  const project = useProject(historyEntryId ?? '', {
    // Conflict surfacing lives on the existing yellow banner driven
    // by `project.saveStatus.kind === 'conflict'` further down the
    // page. We only need this callback for logging — without it, a
    // conflict during an off-screen poll would be invisible in the
    // browser console history when the user later reports trouble.
    onConflict: (currentVersion, currentPayload) => {
      console.warn('[doc-sync conflict]', {
        currentVersion,
        remoteRows: currentPayload.doc?.rows?.length ?? 0,
      });
    },
  });

  // ─── Hydrate local state from the canonical payload ──────────────
  //
  // When `historyEntryId` is set (URL `?h=…` or history-sidebar click)
  // `useProject` GETs the canonical row from /api/edit/[id]. The page's
  // working state lives in local hooks (doc, rowImages, rowOverlays,
  // rowVideoClips) — without this effect the fetched payload sits
  // unused and the page renders its empty form because `doc` is null.
  // The user's repeated complaint "clicking Doc shows empty form, all
  // images gone" was this missing hydration step in action.
  //
  // Guarded by a ref so it only fires the FIRST time payload arrives
  // for a given historyEntryId. Subsequent runs (after the user has
  // started editing, or after the save-effect bumps project.payload)
  // do NOT clobber local state.
  const hydratedForHistoryIdRef = useRef<string | null>(null);
  // PR1 (2026-06-03) force-rehydrate flag — set by the conflict banner's
  // Reload button so the hydration effect overrides BOTH its
  // `hydratedForHistoryIdRef` short-circuit AND the `if (doc)` guard.
  // Without this the banner Reload would either no-op (ref already
  // matched + doc still set) or require `setDoc(null)` which crashes
  // unguarded render branches that assume `doc` is non-null.
  // Consumed (set back to false) inside the hydration effect after a
  // single forced run.
  const forceRehydrateRef = useRef(false);
  useEffect(() => {
    const payload = project.payload;
    if (!payload || !historyEntryId) return;
    if (hydratedForHistoryIdRef.current === historyEntryId && !forceRehydrateRef.current) return;
    // Only hydrate when there's no local doc yet — protects against
    // the history-sidebar restore path (which already sets doc itself
    // via the entry shape) from being clobbered by a later payload
    // arrival. Bypass on a forced re-hydrate (banner Reload).
    if (doc && !forceRehydrateRef.current) {
      hydratedForHistoryIdRef.current = historyEntryId;
      return;
    }
    // Consume the force flag — applies to THIS run only.
    if (forceRehydrateRef.current) {
      forceRehydrateRef.current = false;
      console.info('[doc-sync force-rehydrate] applied', { historyEntryId });
    }
    console.info('[production-doc] hydrating local state from canonical payload', {
      historyEntryId,
      rowCount: payload.doc.rows.length,
      imageCount: Object.keys(payload.rowImages).length,
      overlayCount: Object.keys(payload.rowOverlays).length,
      clipCount: Object.keys(payload.rowVideoClips).length,
    });
    setDoc(payload.doc);
    // Convert Record<number, string> → RowImageState[] aligned to rows.
    // Variant rows (variant_index > 0) WITHOUT a saved image still need
    // their per-row "Generate variant" button as the call-to-action —
    // not the regular Generate button which would route through the
    // wrong (from-scratch i2i) path. Setting them to 'pending' renders
    // the `•••` dots in the image column instead of the misleading
    // "+ Generate" affordance. Symmetric with the fresh-doc init path
    // a few hundred lines below.
    const restoredImages: RowImageState[] = payload.doc.rows.map((row, i) => {
      const url = payload.rowImages[i];
      if (url) return { status: 'done', imageUrl: url };
      if ((row.variant_index ?? 0) > 0) return { status: 'pending' };
      return { status: 'idle' };
    });
    setRowImages(restoredImages);
    // Overlays + clips keep their Record<number, …> shape locally; just
    // copy across (the canonical entries already match the shape the
    // page expects).
    setRowOverlays({ ...payload.rowOverlays } as Record<number, RowOverlayState>);
    setRowVideoClips({ ...payload.rowVideoClips });
    // Voiceover URL + alignment must come across or the in-app player
    // shows blank audio and the scene/narration timing drifts (the
    // realigner needs alignment to retime scene boundaries from the
    // generated narration). Without these the user reported
    // "narration and scenes do not correspond suddenly".
    if (payload.voiceoverUrl) setVoiceoverUrl(payload.voiceoverUrl);
    if (payload.voiceoverAlignment) setVoiceoverAlignment(payload.voiceoverAlignment);
    if (payload.visualKitOverride) setVisualKitOverride(payload.visualKitOverride);
    hydratedForHistoryIdRef.current = historyEntryId;
  }, [project.payload, historyEntryId, doc]);

  // ─── Atomic server-side asset persistence (2026-05-22) ────────────
  //
  // Replaces the legacy "rely on the debounced parity-bridge effect
  // to save your generated image" path. The debounced path had three
  // confirmed silent-drop failure modes — `historyEntryId` not set
  // yet at gen time, useProject's GET still in flight, and tab close
  // killing the 800 ms setTimeout. Real fallout: doc d244130f-bdfe
  // had 181 rows saved but every image attach was lost; the user
  // paid for generations that never reached the server.
  //
  // This helper POSTs to /api/edit/[projectId]/row-asset, which uses
  // a single jsonb_set UPDATE to atomically merge one slot into the
  // row's payload. By the time this fn returns true, the URL is on
  // the server — surviving tab close, device switch, storage clear,
  // and useProject's whole internal state. The reload() afterwards
  // re-syncs useProject's local version cache so the next debounced
  // full-payload save doesn't conflict.
  //
  // The reload reference goes through a ref so the callback doesn't
  // re-create on every render (project is a fresh object each render);
  // historyEntryId is the only "real" dep.
  const projectReloadRef = useRef(project.reload);
  projectReloadRef.current = project.reload;
  // Phase 1.2 (2026-05-29) — route persistRowAsset through the
  // durable IDB outbox. Replaces direct `void fetch` with a `mutate()`
  // call that:
  //   1. Persists the request to IndexedDB BEFORE returning, so a
  //      refresh / tab close at this point loses nothing.
  //   2. Retries on 5xx / network failure with exponential backoff.
  //   3. Sends X-Intent-Id so the server's mutation_ids table dedupes
  //      retries instead of writing the asset twice.
  // The toast that used to fire on failure is gone — the retry queue
  // now owns delivery, and Phase 1.4's UI status pill surfaces dead
  // entries instead of using mid-flow toasts.
  //
  // historyEntryId race: when historyEntryId isn't set yet (fresh doc
  // creation), we capture the call into pendingPersistsRef and replay
  // it via the useEffect below once the id arrives. This eliminates
  // the silent-drop mode that swallowed every image attach on doc
  // d244130f-bdfe — the original symptom that drove this whole
  // rebuild.
  const pendingPersistsRef = useRef<Array<() => void>>([]);
  const persistRowAsset = useCallback(
    (
      rowIndex: number,
      slot: 'image' | 'overlay' | 'clip',
      value:
        | string
        | { status: string; url?: string }
        | { status: string; videoUrl?: string; durationSeconds?: number; brollClipId?: string }
        | null,
      options: { styleVersion?: number } = {},
    ): boolean => {
      if (!historyEntryId || !isUuid(historyEntryId)) {
        // Defer instead of silently dropping. The historyEntryId
        // watcher useEffect below flushes the queue once it arrives.
        // This closes the worst persistence leak in the audit.
        //
        // 2026-06-04: also defer when historyEntryId is a non-UUID
        // synthetic id (offline-save fallback). The /row-asset POST
        // would 400 on the UUID regex; the IDB outbox would retry,
        // exhaust, and silently drop. Queueing here means the
        // resurrection-rebind path replays asset persists with the
        // real UUID after the offline queue drains.
        pendingPersistsRef.current.push(() => persistRowAsset(rowIndex, slot, value, options));
        console.info('[row-asset persist] deferred — historyEntryId not a real UUID yet, will replay', {
          rowIndex,
          slot,
          historyEntryId,
        });
        return true;
      }
      const handle = mutate('row-asset.set', {
        url: `/api/edit/${encodeURIComponent(historyEntryId)}/row-asset`,
        method: 'POST',
        body: {
          rowIndex,
          slot,
          value,
          styleVersion: options.styleVersion,
        },
      });
      console.info('[row-asset persist] queued', {
        intentId: handle.intentId,
        rowIndex,
        slot,
        clears: value === null,
      });
      // Re-sync useProject's local version cache after the drainer
      // has had a chance to fire. Direct POSTs used to call this
      // immediately after the await; with the outbox there's no
      // await point, so we schedule a delayed reload that catches
      // the typical happy-path drain (sub-second). On retry-heavy
      // paths the reload may run before the mutation lands, returning
      // stale version — that's fine, useProject's OCC retry handles
      // 409s.
      setTimeout(() => {
        void projectReloadRef.current().catch(() => {});
      }, 1500);
      return true;
    },
    [historyEntryId],
  );

  // Flush deferred persists once historyEntryId arrives. The pending
  // array holds closures captured at the original call sites with the
  // original arguments — replaying them re-enters persistRowAsset,
  // which now has historyEntryId and queues the mutation properly.
  useEffect(() => {
    if (historyEntryId && pendingPersistsRef.current.length > 0) {
      const pending = pendingPersistsRef.current.splice(0);
      console.info('[row-asset persist] flushing deferred', { count: pending.length });
      for (const replay of pending) {
        try {
          replay();
        } catch (err) {
          console.error('[row-asset persist] deferred replay threw', {
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }, [historyEntryId]);

  // ─── Canonical doc-shape persistence (2026-06-03) ─────────────────
  //
  // Before today, every mutation to the `doc` state called
  // `updateProductionDocEntry(historyEntryId, { doc: nextDoc })` which
  // hit the LEGACY `/api/history/[id]` PATCH route. That route shares
  // the same `user_history.payload` column with the canonical
  // `/api/edit/[id]` PATCH (`saveProjectPatch`) — different validation,
  // different size cap (256 KB vs. 10 MB), and last-write-wins between
  // the two means whichever fired last clobbered the other.
  //
  // `useProject` writes through the canonical path, but
  // `project.patch()` was never called from this page — only
  // `project.reload()` / `project.payload` were used. So every doc
  // edit went through legacy AND useProject's debounce window could
  // PATCH back stale state, producing the "wrong shots show up" /
  // "doc doesn't reflect editor changes" reports.
  //
  // `persistDoc(nextDoc)` is the single replacement: it routes EVERY
  // doc mutation through `project.patch({ doc: nextDoc })`. Same
  // semantics as the asset queue above: if `historyEntryId` isn't
  // set yet (fresh-doc creation race) OR the payload hasn't hydrated,
  // we queue and replay on hydration.
  //
  // Refs (not the project value directly) so the callback's identity
  // stays stable across renders — the existing setDoc-updater pattern
  // in this file captures persistDoc into useState updaters and we
  // don't want every render to invalidate those captures.
  const projectRef = useRef(project);
  projectRef.current = project;
  // Ref so the persistDoc callback below can read the latest
  // historyEntryId without being re-created on every change. Critical:
  // most callers wrap persistDoc in `useCallback([], …)` (existing
  // pattern in this file) which would otherwise capture a stale
  // persistDoc whose closure had historyEntryId=undefined. With the
  // ref, persistDoc is reference-stable for the whole page lifetime
  // and always reads the current historyEntryId at call time.
  const historyEntryIdRef = useRef(historyEntryId);
  historyEntryIdRef.current = historyEntryId;
  const pendingDocPatchesRef = useRef<ProductionDoc[]>([]);

  const persistDoc = useCallback((nextDoc: ProductionDoc): void => {
    const id = historyEntryIdRef.current;
    if (!id) {
      pendingDocPatchesRef.current.push(nextDoc);
      console.info('[doc-sync persist-doc] deferred — no historyEntryId yet', {
        pendingCount: pendingDocPatchesRef.current.length,
      });
      return;
    }
    if (!projectRef.current.payload) {
      pendingDocPatchesRef.current.push(nextDoc);
      console.info('[doc-sync persist-doc] deferred — payload not hydrated yet', {
        historyEntryId: id,
        pendingCount: pendingDocPatchesRef.current.length,
      });
      return;
    }
    console.info('[doc-sync persist-doc] patching', {
      historyEntryId: id,
      rowCount: nextDoc.rows.length,
    });
    projectRef.current.patch({ doc: nextDoc });
  }, []);

  // Flush deferred doc patches once historyEntryId arrives AND the
  // hook's payload is hydrated. Dual gate is intentional: historyEntryId
  // can arrive a beat before the payload GET lands (URL-driven load)
  // and patching against a null payload silently drops because
  // useProject.patch bails on null payload.
  //
  // Apply ONLY the latest pending doc — earlier entries are superseded
  // by their successors. The queue is a buffer for the race window,
  // not a transaction log.
  useEffect(() => {
    if (
      historyEntryId &&
      project.payload &&
      pendingDocPatchesRef.current.length > 0
    ) {
      const pending = pendingDocPatchesRef.current.splice(0);
      const latest = pending[pending.length - 1];
      console.info('[doc-sync replay]', {
        historyEntryId,
        total: pending.length,
        applied: 'latest-only',
        rowCount: latest.rows.length,
      });
      projectRef.current.patch({ doc: latest });
    }
    // project.payload is the trigger; projectRef carries the latest
    // patch fn so we don't need it in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntryId, project.payload]);

  const logEndRef = useRef<HTMLDivElement>(null);
  // Tracks which production doc (by runKey) was last explicitly saved via
  // the banner button. Drives the dirty indicator.
  const [lastSavedProdDocRunKey, setLastSavedProdDocRunKey] = useState<string | null>(null);

  /**
   * Section-divider thumbnail mutator. Updates the doc's `thumbnail`
   * field and patches the same change to the history entry on the
   * server so a reload restores it. Other doc fields don't have
   * server-side patch wiring yet — only thumbnail and rowImages do.
   */
  const setThumbnail = useCallback((next: VideoThumbnail | undefined) => {
    setDoc(prev => {
      if (!prev) return prev;
      const nextDoc = { ...prev, thumbnail: next };
      persistDoc(nextDoc);
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Doc-level scene-fade default toggle. `undefined` preserves the
   * historical behaviour (faded); `false` makes every shot hard-cut.
   * Per-row `scene_fade` still overrides per-row. See
   * `_plans/2026-05-17-scene-transition-controls.md`.
   */
  const setSceneFadeEnabled = useCallback((next: boolean) => {
    setDoc(prev => {
      if (!prev) return prev;
      console.info('[ui scene-fade] doc default', {
        from: prev.scene_fade_enabled,
        to: next,
      });
      const nextDoc: ProductionDoc = { ...prev, scene_fade_enabled: next };
      persistDoc(nextDoc);
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Scene-timing override mutator (per-doc). Sets `min_scene_ms` and
   * `tail_buffer_ms` on the doc; both are optional — `undefined` means
   * "fall back to the workspace default (or built-in default)". Values
   * are clamped to their bounds before write so a paste of "9999999"
   * can't bypass the protection. See the scene-min-duration plan.
   */
  const setSceneTiming = useCallback((patch: { min_scene_ms?: number | null; tail_buffer_ms?: number | null }) => {
    setDoc(prev => {
      if (!prev) return prev;
      const next: ProductionDoc = { ...prev };
      if ('min_scene_ms' in patch) {
        if (patch.min_scene_ms == null) {
          delete next.min_scene_ms;
        } else {
          next.min_scene_ms = clampSceneTiming(patch.min_scene_ms, MIN_SCENE_MS_BOUNDS);
        }
      }
      if ('tail_buffer_ms' in patch) {
        if (patch.tail_buffer_ms == null) {
          delete next.tail_buffer_ms;
        } else {
          next.tail_buffer_ms = clampSceneTiming(patch.tail_buffer_ms, TAIL_BUFFER_MS_BOUNDS);
        }
      }
      if (typeof console !== 'undefined' && console.info) {
        console.info('[render-timing] override updated', {
          min_scene_ms: next.min_scene_ms,
          tail_buffer_ms: next.tail_buffer_ms,
          patch,
        });
      }
      persistDoc(next);
      return next;
    });
  }, [historyEntryId]);

  /**
   * Patch a single production-doc row. Used by the per-row Section
   * controls. Patches the same fields to the server history entry so
   * a reload restores edits.
   */
  const updateRow = useCallback((rowIndex: number, patch: Partial<ProductionRow>) => {
    setDoc(prev => {
      if (!prev) return prev;
      const nextRows = prev.rows.map((r, i) => i === rowIndex ? { ...r, ...patch } : r);
      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * PR2 reliability (2026-06-03) — bulk Retry handler for the failure
   * banner. Walks every row, finds rows that the auto-pipeline gave
   * up on (have `last_error` AND `attempts >= RETRY_BUDGETS[class]`),
   * resets their `attempts` to 0 and clears `last_error`. The next
   * pipeline tick's plan-build picks them up again.
   *
   * One `persistDoc` call covers the whole batch — the canonical
   * write path debounces internally so multiple rapid clicks coalesce.
   *
   * Returns the count of rows reset so the caller (banner) can show
   * a toast confirming the action.
   */
  const retryAllFailedRows = useCallback((): number => {
    let resetCount = 0;
    setDoc(prev => {
      if (!prev) return prev;
      const nextRows = prev.rows.map((r) => {
        if (r.last_error && isExhausted(r.attempts, r.last_error.class)) {
          resetCount += 1;
          return { ...r, attempts: 0, last_error: null };
        }
        return r;
      });
      if (resetCount === 0) return prev;
      const nextDoc = { ...prev, rows: nextRows };
      console.info('[image-gen retry] bulk', { resetCount });
      persistDoc(nextDoc);
      return nextDoc;
    });
    return resetCount;
  }, []);

  /**
   * Count of rows currently in the "auto-pipeline gave up" state —
   * drives the bulk-retry banner's visibility + count text. Computed
   * lazily inside the render via useMemo so the page doesn't recompute
   * on every keystroke (the array walk is cheap but the doc can hit
   * 100+ rows in paint_explainer_v1).
   *
   * Defined here next to the retry handler so future maintenance sees
   * both halves of the feature in one place.
   */
  const failedRowCount = useMemo(() => {
    if (!doc) return 0;
    let count = 0;
    for (const r of doc.rows) {
      if (r.last_error && isExhausted(r.attempts, r.last_error.class)) count += 1;
    }
    return count;
  }, [doc]);

  /**
   * Phase 3.3 — Add a variant row anchored to the row at `baseIndex`.
   *
   * Behavior:
   *
   *   - If the base row doesn't already belong to a group, auto-promote
   *     it by assigning a fresh `group_id` and `variant_index = 0`.
   *   - The new variant lands immediately after the last existing
   *     row in the group (so variants stay contiguous).
   *   - `ai_image_prompt`, `visual_type`, `visual_description` are
   *     cloned from the base so the variant inherits the scene context.
   *     `script_text`, `on_screen_text`, `timecode` start empty —
   *     each variant has its own narration beat.
   *   - Caps at `MAX_VARIANTS_PER_GROUP` (4: 1 base + 3 edits). When
   *     the cap is hit, toasts and no-ops.
   *
   * Autosave fires through the same `updateProductionDocEntry` path
   * `updateRow` uses, so the new row persists immediately. `rowImages`
   * gets a parallel empty slot inserted at the same index so the
   * sidecar stays aligned with `doc.rows`.
   */
  const addVariantRow = useCallback((baseIndex: number) => {
    setDoc(prev => {
      if (!prev) return prev;
      const baseRow = prev.rows[baseIndex];
      if (!baseRow) return prev;

      // Determine the group id — reuse if already grouped, mint
      // otherwise. UUID generation prefers crypto.randomUUID (Edge +
      // modern browsers); falls back to a timestamp+random string for
      // the rare older runtime.
      const existingGroupId = baseRow.group_id;
      const groupId = existingGroupId
        ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

      const groupRows = prev.rows.filter(r => r.group_id === groupId);
      const currentSize = existingGroupId ? groupRows.length : 1; // base counts even when un-grouped before this call
      if (currentSize >= MAX_VARIANTS_PER_GROUP) {
        toast.error(`Variant group is at the cap of ${MAX_VARIANTS_PER_GROUP} rows (1 base + ${MAX_VARIANTS_PER_GROUP - 1} variants).`);
        return prev;
      }

      const nextVariantIndex = existingGroupId
        ? Math.max(...groupRows.map(r => r.variant_index ?? 0)) + 1
        : 1;

      // Promote the base if needed.
      const rowsWithBasePromoted = existingGroupId
        ? prev.rows
        : prev.rows.map((r, i) =>
            i === baseIndex
              ? { ...r, group_id: groupId, variant_index: 0 }
              : r,
          );

      // Find insertion index — right after the LAST row in the group.
      let lastGroupIndex = baseIndex;
      for (let i = baseIndex + 1; i < rowsWithBasePromoted.length; i++) {
        if (rowsWithBasePromoted[i]?.group_id === groupId) {
          lastGroupIndex = i;
        } else {
          break; // variants are contiguous; first non-group row terminates the run
        }
      }
      const insertAt = lastGroupIndex + 1;

      // Three-tier resolution for the new variant's chain mode:
      //   1. base row's group_variant_chain_default (per-group override)
      //   2. doc-level variants_chained_by_default
      //   3. else parallel (omit the field)
      // Variant 1 (no previous variant) effectively ignores chained
      // mode at gen-time (composeVariantEditRequest falls back to base)
      // but we still stamp the flag so the chip toggle starts in the
      // right state when the user opens variant 1's Inspector.
      const groupChainDefault = baseRow.group_variant_chain_default;
      let chainedDefault: boolean | undefined;
      if (groupChainDefault === 'chained') chainedDefault = true;
      else if (groupChainDefault === 'parallel') chainedDefault = false;
      else if (prev.variants_chained_by_default === true) chainedDefault = true;

      const newRow: ProductionRow = {
        timecode: '',
        script_text: '',
        // Cloned scene-context fields from the base.
        visual_type: baseRow.visual_type,
        visual_description: baseRow.visual_description,
        stock_search_terms: baseRow.stock_search_terms,
        // ai_image_prompt is intentionally left empty on the variant
        // itself — the dispatcher composes the base prompt with the
        // edit instruction. Storing the base's prompt here would
        // double-bake context if anyone reads the row directly.
        ai_image_prompt: '',
        on_screen_text: '',
        notes: '',
        group_id: groupId,
        variant_index: nextVariantIndex,
        variant_edit_prompt: '',
        ...(chainedDefault !== undefined
          ? { variant_derives_from_previous: chainedDefault }
          : {}),
      };

      const nextRows = [
        ...rowsWithBasePromoted.slice(0, insertAt),
        newRow,
        ...rowsWithBasePromoted.slice(insertAt),
      ];
      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      // Keep `rowImages` aligned with `doc.rows` by inserting a parallel
      // empty slot. Without this every row at index > insertAt would
      // look up the WRONG image until the next full reload.
      setRowImages(prev => {
        const next = [...prev];
        next.splice(insertAt, 0, { status: 'idle' });
        return next;
      });
      return nextDoc;
    });
  }, [historyEntryId]);

  // Always-fresh mirror of rowImages so writers that need to read it
  // (notably generateVariantImage, which must look up the BASE row's
  // image URL) get the current value synchronously. rowImages itself is
  // declared via useState much later in this component; the
  // setState-callback snapshot trick previously used here was
  // unreliable when React batched setState calls from concurrent
  // variant generations. The ref is hoisted here so the writer block
  // can reference it; the matching useEffect that mirrors rowImages →
  // rowImagesRef.current lives near the other render-state-hardening
  // refs further down. See `_plans/2026-05-17-render-state-hardening.md`.
  const rowImagesRef = useRef<RowImageState[]>([]);

  /**
   * Phase 3.3 — Generate the image for a variant row by POSTing the
   * composed Atlas-Edit request to the existing
   * `/api/generate/production-doc/image/edit` route.
   *
   * Routes through `composeVariantEditRequest` so the dispatcher
   * receives the base scene context + the variant's edit instruction
   * in the canonical shape (per `_plans/2026-05-25-near-static-variants.md`).
   *
   * Surfaces typed errors as toasts so the user gets actionable
   * messages instead of a generic 500:
   *
   *   BASE_NOT_GENERATED   → "Generate the base image first."
   *   MISSING_EDIT_PROMPT  → "Describe what changes from the base."
   *   NOT_A_VARIANT, BASE_NOT_FOUND → "Row isn't a valid variant."
   *
   * Atlas Edit costs $0.011/call (vs $0.04 for a base i2i generation),
   * so a 3-variant group total is ~$0.073 — surfaced inline on the
   * Generate button label.
   */
  const generateVariantImage = useCallback(async (
    variantIndex: number,
    // Optional override for the doc whose rows are read. Lets callers in
    // the auto-pipeline pass the freshly-returned doc directly, bypassing
    // this callback's React-closure-bound `doc` — which is stale during
    // the synchronous-tick window between setDoc(newDoc) and React's
    // next render. Without this, auto-pipeline variant generation would
    // see the OLD doc's rows and bail with "Row is not part of a
    // variant group" because the `variant_index` / `group_id` fields
    // weren't visible yet to this closure. Per-row button clicks (which
    // happen well after re-render) leave this undefined and use `doc`
    // as before.
    docOverride?: ProductionDoc,
  ) => {
    // Circuit breaker check — same gate as generateImageForRow. A
    // variant is also a paid Atlas Edit call; suppressing it when the
    // outbox is paused prevents money burn during outages.
    const outbox = getOutboxState();
    if (outbox.breaker === 'open') {
      const secs = outbox.breakerReopenAt
        ? Math.max(0, Math.ceil((outbox.breakerReopenAt - Date.now()) / 1000))
        : 0;
      toast.error(
        `Saving is paused — retry in ${secs}s. Variant generations are blocked until your connection clears.`,
        { duration: 5000 },
      );
      return;
    }
    const activeDoc = docOverride ?? doc;
    if (!activeDoc) return;
    const variantRow = activeDoc.rows[variantIndex];
    if (!variantRow) return;
    const groupId = variantRow.group_id;
    if (!groupId) {
      toast.error('Row is not part of a variant group.');
      return;
    }
    // Resolve the base's image URL from the rowImages sidecar — that's
    // where the editor stores generated image state. Falls back to
    // empty (which becomes BASE_NOT_GENERATED below).
    const base = getBaseRow(activeDoc, groupId);
    if (!base) {
      toast.error('Base row not found for this variant group.');
      return;
    }
    const baseRowIndex = activeDoc.rows.indexOf(base);
    // Resolve the SOURCE image for this variant: either the group's
    // base (the default — parallel variants) or the immediately
    // previous variant (when variant_derives_from_previous is true —
    // chained variants). Chained variants form additive frame-by-frame
    // sequences where each variant builds on the last. Falls back to
    // base when chaining is requested but no previous variant exists
    // (variant_index === 1 or the previous variant is missing in
    // doc.rows — defensive against mid-edit data shapes).
    let sourceRowIndex = baseRowIndex;
    let sourceLabel: 'base' | 'previous-variant' = 'base';
    const currentVariantIdx = variantRow.variant_index ?? 0;
    // Phase 1.7 R5 — three-tier chain resolution (variant own flag →
    // base's group_variant_chain_default → doc.variants_chained_by_default).
    // The per-variant flag still wins when set; otherwise the
    // per-group toggle on the base row drives dispatch. Without this,
    // the editor's per-group control (added in R5) had no effect on
    // existing variants whose own field was unset.
    const chainMode = resolveVariantChainMode(activeDoc, variantRow, base);
    if (chainMode === 'chained' && currentVariantIdx > 1) {
      const previousVariant = activeDoc.rows.find(
        (r) =>
          r.group_id === groupId &&
          (r.variant_index ?? 0) === currentVariantIdx - 1,
      );
      if (previousVariant) {
        sourceRowIndex = activeDoc.rows.indexOf(previousVariant);
        sourceLabel = 'previous-variant';
      }
    }
    // Read the source image URL from the always-fresh ref instead of a
    // setState-callback snapshot. The earlier snapshot trick was
    // unreliable when React batched multiple variant Generate clicks
    // fired in quick succession — variant 2 would see an empty source
    // because variant 1's setState batch hadn't flushed yet, and the
    // setState callback (which only runs DURING a render) wouldn't
    // fire for a no-op state update. `rowImagesRef.current` is
    // mutated by an effect immediately after every rowImages render
    // so reads here are synchronous + current.
    const sourceImageUrl = rowImagesRef.current[sourceRowIndex]?.imageUrl ?? '';
    if (!sourceImageUrl) {
      // Specific message for chained-from-previous so the user knows
      // which row to generate first (the parent variant, not the base).
      toast.error(
        sourceLabel === 'previous-variant'
          ? 'Generate the previous variant first — this one chains from it.'
          : 'Generate the base image first — variants edit it.',
      );
      return;
    }

    // Propagate the user's GPT Image 2 edit primary preference from
    // localStorage. Lazy-imported to keep the editor settings module
    // (browser-only) out of any SSR path that might pull this page.
    const { getGptImage2EditPrimary } = await import('@/lib/editor/settings');
    const editPrimary = getGptImage2EditPrimary();
    const prepared = composeVariantEditRequest(
      activeDoc,
      variantRow,
      sourceImageUrl,
      editPrimary,
    );
    if (prepared.kind === 'error') {
      toast.error(prepared.message);
      return;
    }
    // Phase 1.7 (chained variants) — log which mode the dispatcher
    // ran in so the console shows the choice per click. Useful when
    // a chained group's Atlas Edit drifts and we need to confirm the
    // dispatcher actually used the previous variant's image instead
    // of falling back to the base. Spec:
    // _plans/2026-05-28-doodle-2-chained-variants.md (R6).
    console.info('[prodoc variant-dispatch]', {
      variantIndex,
      groupId,
      variantIdx: currentVariantIdx,
      mode: sourceLabel === 'previous-variant' ? 'chained' : 'parallel',
      sourceRowIndex,
      edit_primary: editPrimary,
    });

    setRowImages(prev => {
      const next = [...prev];
      next[variantIndex] = { ...(next[variantIndex] || { status: 'idle' }), status: 'loading' };
      return next;
    });

    try {
      // Stage 5 — retry on transient failures with exponential backoff.
      // 429 (rate limit) and 5xx (server errors) are usually transient
      // and the same request will succeed on a retry; 4xx (other) means
      // the request itself is broken so retrying is just waste. The
      // 2-attempt cap (1s, 2s waits) bounds the worst case at ~5s
      // total latency for a doomed call without hammering Atlas during
      // a real outage. See `_plans/2026-05-27-doodle-explainer-2-foundation.md`.
      const MAX_VARIANT_RETRIES = 2;
      let res: Response | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_VARIANT_RETRIES; attempt++) {
        if (attempt > 0) {
          const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
          await new Promise((r) => setTimeout(r, delayMs));
          console.info('[variant-gen retry]', { variantIndex, attempt, delayMs });
        }
        try {
          res = await queueImageGen('edit', 'variant-edit', () =>
            // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (image URL)
            fetch('/api/generate/production-doc/image/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(prepared.request),
            }),
          );
          // Retry on rate-limit + transient server errors.
          const isRetryable =
            res.status === 429 || (res.status >= 500 && res.status < 600);
          if (res.status === 429) reportUpstream429('edit', 'variant-edit');
          if (isRetryable && attempt < MAX_VARIANT_RETRIES) continue;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < MAX_VARIANT_RETRIES) continue;
          res = null;
        }
      }
      if (!res) {
        // Network failure after all retries — caught below by the outer
        // try/catch via re-throw so the existing error-state setter
        // fires uniformly with HTTP-level failures.
        throw lastError instanceof Error ? lastError : new Error('Network error after retries');
      }
      const data = await res.json() as { imageUrl?: string; error?: string };
      if (res.ok && data.imageUrl) {
        setRowImages(prev => {
          const next = [...prev];
          next[variantIndex] = { status: 'done', imageUrl: data.imageUrl!, source: 'generated' };
          return next;
        });
        // Phase 3.7c — record the SOURCE image URL we generated
        // against, so the editor can detect staleness later when the
        // source is regenerated. Source = base (default) or previous
        // variant (when chained). Field name kept for back-compat.
        setDoc(prev => {
          if (!prev) return prev;
          const nextRows = prev.rows.map((r, i) =>
            i === variantIndex
              ? { ...r, variant_base_image_at_generation: sourceImageUrl }
              : r,
          );
          const nextDoc = { ...prev, rows: nextRows };
          persistDoc(nextDoc);
          return nextDoc;
        });
        toast.success(`Variant ${variantRow.variant_index} generated`);
      } else {
        setRowImages(prev => {
          const next = [...prev];
          next[variantIndex] = { status: 'error', error: data.error ?? `HTTP ${res.status}` };
          return next;
        });
        toast.error(data.error || `Generation failed (HTTP ${res.status})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      setRowImages(prev => {
        const next = [...prev];
        next[variantIndex] = { status: 'error', error: msg };
        return next;
      });
      toast.error(msg);
    }
  }, [doc, historyEntryId]);

  /**
   * Generate every variant in a group in parallel. Skips variants
   * whose image is already generated (saves the $0.011/call) and
   * variants whose variant_edit_prompt is empty (would error out).
   * Uses Promise.all — safe now that generateVariantImage reads from
   * rowImagesRef (so concurrent calls all see the same fresh base
   * image instead of racing on the setState-callback snapshot).
   *
   * Called from the "Generate all variants" button on the BASE row's
   * Inspector chip. Fires from baseRowIndex (the BASE row, not a
   * variant) so the UX matches "generate the rest of this group."
   */
  const generateAllVariantsInGroup = useCallback(async (baseRowIndex: number) => {
    if (!doc) return;
    const baseRow = doc.rows[baseRowIndex];
    if (!baseRow || !baseRow.group_id) {
      toast.error('Not a variant group base.');
      return;
    }
    const groupId = baseRow.group_id;
    // Verify the base itself has an image — variants edit it, can't
    // generate them without it.
    if (!rowImagesRef.current[baseRowIndex]?.imageUrl) {
      toast.error('Generate the base image first — variants edit it.');
      return;
    }
    // Collect every variant in the group that needs work: variant_index
    // > 0, image not already generated, variant_edit_prompt non-empty.
    // Sorted by variant_index so chained variants (where each derives
    // from the previous) get their parent's image landed before they
    // fire. For pure-parallel groups (default) the order doesn't
    // matter — sequential is a slight latency cost but eliminates the
    // need to detect chain segments and parallel-batch them, which
    // would compound complexity for marginal gain.
    const toGenerate: Array<{ docRowIndex: number; variantIndex: number }> = [];
    let skippedAlreadyGenerated = 0;
    let skippedNoPrompt = 0;
    doc.rows.forEach((r, i) => {
      if (r.group_id !== groupId) return;
      if ((r.variant_index ?? 0) === 0) return; // skip the base itself
      if (rowImagesRef.current[i]?.imageUrl) {
        skippedAlreadyGenerated += 1;
        return;
      }
      if (!r.variant_edit_prompt?.trim()) {
        skippedNoPrompt += 1;
        return;
      }
      toGenerate.push({ docRowIndex: i, variantIndex: r.variant_index ?? 0 });
    });
    if (toGenerate.length === 0) {
      if (skippedAlreadyGenerated > 0) {
        toast.info(`All ${skippedAlreadyGenerated} variants already generated.`);
      } else if (skippedNoPrompt > 0) {
        toast.error(`Skipped ${skippedNoPrompt} variants without an edit prompt — fill them in first.`);
      } else {
        toast.info('No variants to generate in this group.');
      }
      return;
    }
    toGenerate.sort((a, b) => a.variantIndex - b.variantIndex);

    // Stage 5 — cost preview before firing the batch. Each variant is
    // a flat ~$0.011 Atlas Edit call; we surface the total only when
    // it crosses the per-batch soft-warning threshold so typical small
    // groups don't get a friction prompt. Threshold hardcoded for v1;
    // a workspace setting + schema migration will land separately
    // when we have a UX home for it (per global rule 8 — cost
    // discipline is non-negotiable, but the UX shouldn't gate every
    // click).
    const COST_PER_VARIANT_USD = 0.011;
    const COST_WARN_THRESHOLD_USD = 2.0;
    const estimatedCostUsd = toGenerate.length * COST_PER_VARIANT_USD;
    if (estimatedCostUsd > COST_WARN_THRESHOLD_USD) {
      const proceed = window.confirm(
        `Generating ${toGenerate.length} variants will cost approximately $${estimatedCostUsd.toFixed(2)} (Atlas Edit at $${COST_PER_VARIANT_USD.toFixed(3)}/variant). Proceed?`,
      );
      if (!proceed) {
        toast.info('Generation cancelled.');
        return;
      }
    }

    toast.info(`Generating ${toGenerate.length} variant${toGenerate.length === 1 ? '' : 's'} in order…`);
    // Track per-batch outcome — generateVariantImage doesn't return a
    // status, so we read rowImagesRef after each await to count what
    // landed vs failed. Lets the summary toast surface real numbers
    // instead of generic "done."
    let succeeded = 0;
    let failed = 0;
    for (const item of toGenerate) {
      // Sequential await — chained variants need the parent's image
      // to land before they can fire. Per-variant toasts/errors come
      // from inside generateVariantImage.
      await generateVariantImage(item.docRowIndex);
      const outcome = rowImagesRef.current[item.docRowIndex];
      if (outcome?.status === 'done' && outcome.imageUrl) {
        succeeded += 1;
      } else {
        failed += 1;
      }
    }
    // Per-batch summary so the user sees the rollup. Per-variant
    // toasts already fired inside generateVariantImage; the summary
    // is the rollup so an attended batch finishes with one clear
    // signal instead of a stream the user might miss.
    console.info('[variant-batch] complete', {
      attempted: toGenerate.length,
      succeeded,
      failed,
      estimatedCostUsd,
    });
    if (failed === 0) {
      toast.success(`All ${succeeded} variant${succeeded === 1 ? '' : 's'} generated.`);
    } else if (succeeded === 0) {
      toast.error(`All ${failed} variant${failed === 1 ? '' : 's'} failed — see per-row error state.`);
    } else {
      toast.error(`${succeeded}/${toGenerate.length} variants generated; ${failed} failed.`);
    }
  }, [doc, generateVariantImage]);

  /**
   * Phase 3.7a — Delete a variant row from its group.
   *
   * Only operates on variant rows (variant_index > 0). Deleting the
   * BASE of a group is intentionally not supported here — that's a
   * full row-delete and should go through whatever the regular row-
   * delete affordance is. If the user wants to break up a group,
   * they delete each variant and the base becomes a standalone row
   * by virtue of being the only one left with that group_id (which
   * the renderer treats indistinguishably from a true standalone).
   *
   * After deletion, the remaining variants in the group are
   * re-indexed so variant_index stays contiguous (0, 1, 2, ...).
   * Keeps the rowImages sidecar aligned by splicing the same index.
   */
  const deleteVariantRow = useCallback((variantIndex: number) => {
    setDoc(prev => {
      if (!prev) return prev;
      const target = prev.rows[variantIndex];
      if (!target) return prev;
      const groupId = target.group_id;
      if (!groupId || (target.variant_index ?? 0) === 0) {
        toast.error('Use the regular delete for non-variant rows.');
        return prev;
      }
      // Remove the row and re-index remaining variants in the same
      // group so indices stay 0..N-1 with no gaps.
      const without = prev.rows.filter((_, i) => i !== variantIndex);
      let seen = 0;
      const reindexed = without.map(r => {
        if (r.group_id !== groupId) return r;
        if ((r.variant_index ?? 0) === 0) return r; // base stays at 0
        seen += 1;
        return { ...r, variant_index: seen };
      });
      const nextDoc = { ...prev, rows: reindexed };
      persistDoc(nextDoc);
      setRowImages(prev => {
        const next = [...prev];
        next.splice(variantIndex, 1);
        return next;
      });
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Phase 3.7b — Reorder variants within a group via move-up /
   * move-down. (Drag-to-reorder would need @dnd-kit which isn't
   * installed; these buttons cover the common case with no new dep.)
   *
   * Direction `'up'` moves the variant one slot earlier in the row
   * list AND swaps variant_index with the previous variant — so the
   * timeline order and the variant numbering stay in sync. Variants
   * can only swap with OTHER VARIANTS IN THE SAME GROUP; cannot
   * move past the base (variant_index 0) and cannot move past the
   * last variant in the group.
   */
  const moveVariantRow = useCallback((variantIndex: number, direction: 'up' | 'down') => {
    setDoc(prev => {
      if (!prev) return prev;
      const target = prev.rows[variantIndex];
      if (!target) return prev;
      const groupId = target.group_id;
      const targetVariantIdx = target.variant_index ?? 0;
      if (!groupId || targetVariantIdx === 0) {
        return prev; // base / standalone can't be reordered by this helper
      }

      // Find the sibling variant we'd swap with — the one whose
      // variant_index is targetVariantIdx ± 1 in the same group.
      const swapVariantIdx = direction === 'up' ? targetVariantIdx - 1 : targetVariantIdx + 1;
      if (swapVariantIdx < 1) return prev; // can't move past the base
      const swapRowIndex = prev.rows.findIndex(
        r => r.group_id === groupId && (r.variant_index ?? 0) === swapVariantIdx,
      );
      if (swapRowIndex < 0) return prev; // no sibling at that index — boundary

      // Swap both the row positions in `rows` and the variant_index
      // values, so both timeline order and the numbering stay
      // consistent. Doing both is important — the dispatcher reads
      // variant_index for ordering, and the editor reads the row
      // position for display.
      const nextRows = prev.rows.slice();
      const a = { ...nextRows[variantIndex], variant_index: swapVariantIdx };
      const b = { ...nextRows[swapRowIndex], variant_index: targetVariantIdx };
      nextRows[variantIndex] = b;
      nextRows[swapRowIndex] = a;

      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      // Mirror the row swap on rowImages so each row's image stays
      // bound to its (now reordered) row position.
      setRowImages(prev => {
        const next = [...prev];
        const tmp = next[variantIndex];
        next[variantIndex] = next[swapRowIndex];
        next[swapRowIndex] = tmp;
        return next;
      });
      return nextDoc;
    });
  }, [historyEntryId]);

  // Per-row "split as title card" inline form state. When non-null, the row
  // at `rowIndex` shows a title-text input + Apply/Cancel instead of the
  // one-click chip. Lets the user confirm exactly which text to extract,
  // since a `##Heading` on the same line as the body has no reliable
  // computable boundary.
  const [splittingRow, setSplittingRow] = useState<{ rowIndex: number; titleDraft: string } | null>(null);

  // Per-row "edit AI prompt" inline form state. When non-null, the row's
  // AI Prompt cell renders a textarea instead of the static span — same
  // pattern as splittingRow above.
  const [editingPromptRow, setEditingPromptRow] = useState<{ rowIndex: number; draft: string } | null>(null);

  // Per-row "edit script text" inline form state. Mirrors editingPromptRow
  // exactly — click ✎ on the script_text cell to open a textarea, ⌘/Ctrl+Enter
  // or Save commits, Escape or Cancel discards. Does NOT recompute downstream
  // timecodes; the user is editing the wording, not the timing.
  const [editingScriptRow, setEditingScriptRow] = useState<{ rowIndex: number; draft: string } | null>(null);

  // Row-filter state. Both fields default to empty / unset = no filter.
  //  - `visualTypes` is a set of `visual_type` values; row passes when its
  //    visual_type is in the set, OR when the set is empty (no filter).
  //  - `search` is a case-insensitive substring matched across script_text,
  //    visual_description, and on_screen_text; row passes when the substring
  //    appears in any of those, OR when search is empty.
  // The filter applies to both the desktop table and the mobile cards.
  const [filters, setFilters] = useState<{
    visualTypes: string[];
    search: string;
    /** When true, only rows with `shot_kind === 'motion_collage'` are
     *  visible. Independent from the visual_type chips because
     *  motion_collage rows keep `visual_type: 'Animation'` per the
     *  doodle_explainer_2 mixing_rules — without a separate chip
     *  they'd be impossible to isolate at a glance.
     *  See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */
    motionCollageOnly: boolean;
  }>({
    visualTypes: [],
    search: '',
    motionCollageOnly: false,
  });

  /**
   * Split a row at its `##` markdown heading into TWO rows: a new
   * Title Card row above (containing just the heading as on-screen
   * text, locked-as-still so no i2v garbles it), and the original
   * row with the heading stripped from its script.
   *
   * Why this exists: i2v models (Kling, Sora 2, Veo 3, all of them)
   * mangle text inside source stills. The fix is structural — title
   * text lives in a separate non-animated row, narration lives in the
   * animated row. See user discussion 2026-05-15.
   *
   * Timing: the new title card occupies ~3 s. All rows from the split
   * onward shift forward by 3 s; total_duration grows by 3 s. The
   * user can fine-tune timecodes afterwards if needed.
   */
  const splitTitleCardFromRow = useCallback(
    (rowIndex: number, heading: string) => {
      if (!doc) return;
      const sourceRow = doc.rows[rowIndex];
      if (!sourceRow) return;

      const TITLE_CARD_SECONDS = 3;
      const titleCardVisualDescription = `Title card displaying "${heading}"`;

      const shiftTimecodeStr = (tc: string): string => {
        const totalSec = Math.round((parseTimecodeToMs(tc) + TITLE_CARD_SECONDS * 1000) / 1000);
        return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
      };

      // Strip the title from the source row's script_text. Handles both the
      // legacy `## ${heading}` prefix (kept for back-compat) AND the new
      // non-`##` case where the LLM merged a missed title into the body of
      // a B-Roll row and the user types the title text to extract it.
      const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripRe = new RegExp(`^\\s*(?:##\\s*)?${escapedHeading}\\s*[\\.,:;—-]?\\s*`, 'i');
      const strippedScript = sourceRow.script_text.replace(stripRe, '').trim();
      const titleCardRow: ProductionRow = {
        timecode: sourceRow.timecode,
        script_text: '',
        visual_type: 'Title Card',
        visual_description: titleCardVisualDescription,
        stock_search_terms: '',
        ai_image_prompt: '',
        on_screen_text: heading,
        notes: 'Auto-split title card. Lock-as-still so the title text is preserved (no i2v garbling).',
      };

      setDoc(prev => {
        if (!prev) return prev;
        const shiftedRows: ProductionRow[] = prev.rows.map((r, i) => {
          if (i < rowIndex) return r;
          if (i === rowIndex) {
            return { ...r, script_text: strippedScript, timecode: shiftTimecodeStr(r.timecode) };
          }
          return { ...r, timecode: shiftTimecodeStr(r.timecode) };
        });
        const nextRows: ProductionRow[] = [
          ...shiftedRows.slice(0, rowIndex),
          titleCardRow,
          ...shiftedRows.slice(rowIndex),
        ];

        // Grow total_duration by the title card's allocated time so the
        // computed shot durations downstream stay coherent.
        const newTotalSec = Math.round((parseTimecodeToMs(prev.total_duration) + TITLE_CARD_SECONDS * 1000) / 1000);
        const newTotalDuration = `${Math.floor(newTotalSec / 60)}:${String(newTotalSec % 60).padStart(2, '0')}`;

        const nextDoc = { ...prev, rows: nextRows, total_duration: newTotalDuration };
        persistDoc(nextDoc);
        return nextDoc;
      });

      // Splice in a fresh image state for the title card row, and shift
      // every index-keyed map (clips, overlays, batch stubs) forward by
      // 1 for entries at or after the insertion point. Without this,
      // the title card would inherit the original row's image and the
      // original row would inherit nothing.
      setRowImages(prev => {
        const next = [...prev];
        next.splice(rowIndex, 0, { status: 'idle' });
        return next;
      });
      const shiftRecord = <T,>(record: Record<number, T>): Record<number, T> => {
        const next: Record<number, T> = {};
        for (const k of Object.keys(record)) {
          const idx = Number(k);
          next[idx >= rowIndex ? idx + 1 : idx] = record[idx]!;
        }
        return next;
      };
      setRowOverlays(shiftRecord);
      setRowVideoClips(shiftRecord);
      setRowBatchStubs(shiftRecord);

      // Lock the new title-card row as still — keyed by its row signature
      // (timecode + visual_description), not by index, so the lock
      // survives any future re-ordering. This is the whole point of the
      // split: stop i2v from touching the title scene. Done inline (not
      // via toggleRowLock) to keep this callback above the toggleRowLock
      // declaration without hitting the TDZ.
      const titleCardSignature = brollRowSignatureInput({
        timecode: sourceRow.timecode,
        visual_description: titleCardVisualDescription,
      });
      setRowLockSignatures((prev) => {
        const next = { ...prev, [titleCardSignature]: true as const };
        writeBrollLockMap(next);
        return next;
      });

      toast.success(`Split "${heading}" into its own title-card row (locked-as-still).`);
    },
    [doc, historyEntryId],
  );

  /**
   * Set `section_title` on every row from `startRow` to `endRow` inclusive
   * in a single setDoc call. Drives the "Apply to range" chip in
   * SectionRowControls — lets the editor mark a whole scene (e.g. rows
   * 3-7 all "The Escalation") in one action instead of retyping per row.
   */
  const applyTitleToRange = useCallback(
    (startRow: number, endRow: number, title: string) => {
      setDoc(prev => {
        if (!prev) return prev;
        const lo = Math.max(0, Math.min(startRow, endRow));
        const hi = Math.min(prev.rows.length - 1, Math.max(startRow, endRow));
        const trimmed = title.trim() || undefined;
        const nextRows = prev.rows.map((r, i) =>
          i >= lo && i <= hi ? { ...r, section_title: trimmed } : r,
        );
        const nextDoc = { ...prev, rows: nextRows };
        persistDoc(nextDoc);
        return nextDoc;
      });
      const count = endRow - startRow + 1;
      toast.success(`Applied section title to ${count} row${count === 1 ? '' : 's'}.`);
    },
    [historyEntryId],
  );

  /**
   * Promote a single row's pillarbox color to the doc-wide default. Per-row
   * overrides on other rows stay intact — the editor uses
   * `clearPillarboxOverrides` separately when they want the new default to
   * sweep across every row. Same pattern is used for the stripe layout.
   */
  const applyPillarboxColorToAll = useCallback(
    (color: string) => {
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, pillarbox_color_default: color };
        persistDoc(nextDoc);
        return nextDoc;
      });
      toast.success('Set pillarbox color as the doc default.');
    },
    [historyEntryId],
  );

  const clearPillarboxOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => r.pillarbox_color).length;
      if (before === 0) {
        toast('No per-row pillarbox overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        r.pillarbox_color ? { ...r, pillarbox_color: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      toast.success(`Cleared pillarbox overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  const applyStripeLayoutToAll = useCallback(
    (layout: 'overlay' | 'letterbox') => {
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, section_title_layout_default: layout };
        persistDoc(nextDoc);
        return nextDoc;
      });
      toast.success(`Set ${layout} as the doc-default stripe layout.`);
    },
    [historyEntryId],
  );

  const clearStripeLayoutOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => r.section_title_layout).length;
      if (before === 0) {
        toast('No per-row stripe-layout overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        r.section_title_layout ? { ...r, section_title_layout: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      toast.success(`Cleared stripe-layout overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  // OST mode setters — mirror the stripe-layout pattern. Per-row override
  // is set inline via `updateRow`; doc-level default + clear come from the
  // right-click ("apply to all") affordance on the picker. See
  // `_plans/2026-05-21-phase-5-text-mode-toggle.md`.
  const applyOstModeToAll = useCallback(
    (mode: 'overlay' | 'bake' | 'none') => {
      setDoc(prev => {
        if (!prev) return prev;
        const beforeOverrides = prev.rows.filter(r => r.on_screen_text_mode).length;
        const nextRows = beforeOverrides > 0
          ? prev.rows.map(r =>
              r.on_screen_text_mode ? { ...r, on_screen_text_mode: undefined } : r,
            )
          : prev.rows;
        const nextDoc = { ...prev, rows: nextRows, on_screen_text_mode_default: mode };
        persistDoc(nextDoc);
        return nextDoc;
      });
      toast.success(`Set ${mode} as the doc-default OST mode.`);
    },
    [historyEntryId],
  );

  const applySceneZoomToAll = useCallback(
    (zoom: number) => {
      const clamped = Math.max(50, Math.min(200, Math.round(zoom)));
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, scene_zoom_default: clamped };
        persistDoc(nextDoc);
        return nextDoc;
      });
      toast.success(`Set ${clamped}% as the doc-default zoom.`);
    },
    [historyEntryId],
  );

  /**
   * Title Card → section title propagation. Stamps the title card's text
   * (`on_screen_text || script_text`, trimmed) onto every row AFTER the
   * card, stopping at (but not including) the next Title Card row — or
   * the end of the doc if there isn't one. The title card row itself is
   * intentionally left alone (its own visual already carries the title;
   * adding the stripe on top would just duplicate it).
   */
  const applyTitleCardAsSectionTitle = useCallback(
    (titleCardRowIndex: number) => {
      setDoc(prev => {
        if (!prev) return prev;
        const sourceRow = prev.rows[titleCardRowIndex];
        if (!sourceRow || sourceRow.visual_type !== 'Title Card') {
          toast.error('Not a Title Card row.');
          return prev;
        }
        const text =
          (sourceRow.on_screen_text?.trim() || sourceRow.script_text?.trim() || '').trim();
        if (!text) {
          toast.error('Title Card has no On-Screen Text or Script Text to use.');
          return prev;
        }
        // End of section = the row JUST BEFORE the next Title Card row.
        // Walk forward from the row after this title card.
        let endIndex = prev.rows.length - 1;
        for (let i = titleCardRowIndex + 1; i < prev.rows.length; i++) {
          if (prev.rows[i]!.visual_type === 'Title Card') {
            endIndex = i - 1;
            break;
          }
        }
        if (endIndex < titleCardRowIndex + 1) {
          toast('No following rows under this title card.');
          return prev;
        }
        const nextRows = prev.rows.map((r, i) =>
          i > titleCardRowIndex && i <= endIndex ? { ...r, section_title: text } : r,
        );
        const nextDoc = { ...prev, rows: nextRows };
        persistDoc(nextDoc);
        const count = endIndex - titleCardRowIndex;
        toast.success(`Applied "${text}" as section title to ${count} row${count === 1 ? '' : 's'}.`);
        return nextDoc;
      });
    },
    [historyEntryId],
  );

  const clearSceneZoomOverrides = useCallback(() => {
    setDoc(prev => {
      if (!prev) return prev;
      const before = prev.rows.filter(r => typeof r.scene_zoom === 'number').length;
      if (before === 0) {
        toast('No per-row zoom overrides to clear.');
        return prev;
      }
      const nextRows = prev.rows.map(r =>
        typeof r.scene_zoom === 'number' ? { ...r, scene_zoom: undefined } : r,
      );
      const nextDoc = { ...prev, rows: nextRows };
      persistDoc(nextDoc);
      toast.success(`Cleared zoom overrides on ${before} row${before === 1 ? '' : 's'}.`);
      return nextDoc;
    });
  }, [historyEntryId]);

  /**
   * Promote a per-row region-zoom padding to the doc-level default
   * (`region_zoom_padding_default_pct`). Mirrors `applySceneZoomToAll`.
   * Per-row overrides are NOT cleared — they continue to win until the
   * user explicitly drags the per-row slider back onto the new default.
   * Clamped to [0, 50] to stay inside the math's safe range. See
   * `_plans/2026-05-20-render-config-drop-zoom-padding-region-import.md`.
   */
  const applyRegionZoomPaddingToAll = useCallback(
    (paddingPct: number) => {
      const clamped = Math.max(0, Math.min(50, Math.round(paddingPct)));
      setDoc(prev => {
        if (!prev) return prev;
        const nextDoc = { ...prev, region_zoom_padding_default_pct: clamped };
        persistDoc(nextDoc);
        return nextDoc;
      });
      console.info('[ui region-zoom-padding apply-to-all]', { paddingPct: clamped });
      toast.success(`Set ${clamped}% as the doc-default region padding.`);
    },
    [historyEntryId],
  );

  // — Image generation (declared before effects that reference it)
  const [rowImages, setRowImages] = useState<RowImageState[]>([]);
  const [imageProgress, setImageProgress] = useState({ done: 0, total: 0 });
  const [imagesGenerating, setImagesGenerating] = useState(false);

  // Mirror successful image URLs into `doc.row.image_url` so they survive
  // refresh / link share / new-tab visit. Runs whenever rowImages
  // changes. Reads the latest doc via setDoc's functional setter (no
  // dep on doc itself, so no infinite loop). Skips the mutation when
  // nothing changed (returns prev), so React doesn't re-render on
  // no-op updates and autosave doesn't fire spuriously.
  useEffect(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      let mutated = false;
      const nextRows = prev.rows.map((row, i) => {
        const rowImg = rowImages[i];
        const newUrl =
          rowImg?.status === 'done' && rowImg.imageUrl ? rowImg.imageUrl : null;
        if (newUrl && row.image_url !== newUrl) {
          mutated = true;
          return { ...row, image_url: newUrl };
        }
        return row;
      });
      return mutated ? { ...prev, rows: nextRows } : prev;
    });
  }, [rowImages]);

  // Hydrate rowImages from persisted `doc.row.image_url` on first doc
  // load (keyed by historyEntryId — different docs hydrate
  // independently). Only fills slots that are empty / idle so we don't
  // clobber in-session state from localStorage restore or a fresh
  // generation that landed before this effect ran. Ref-guarded so
  // subsequent edits to the doc don't trigger re-hydration that would
  // overwrite later mutations.
  const hydratedDocIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    const docKey = historyEntryId ?? 'in-memory';
    if (hydratedDocIdRef.current === docKey) return;
    hydratedDocIdRef.current = docKey;
    setRowImages((prev) => {
      return doc.rows.map((row, i) => {
        const existing = prev[i];
        // Preserve in-session state — only hydrate empty / idle slots.
        if (existing && existing.status !== 'idle' && existing.imageUrl) {
          return existing;
        }
        if (typeof row.image_url === 'string' && row.image_url.trim()) {
          return {
            status: 'done' as const,
            imageUrl: row.image_url.trim(),
            source: 'generated' as const,
          };
        }
        return existing ?? { status: 'idle' as const };
      });
    });
  }, [doc, historyEntryId]);
  // — Edit panel: which row index has its ✎ panel open (null = closed).
  //   Held at page level so opening/closing doesn't unmount the row's cell
  //   (which would tear down in-flight previews bound to that cell).
  //   `editBrushOpen` swaps the smart-edit panel for the brush mask
  //   editor while a row is being edited. `editResult` holds the
  //   candidate produced by a brush-mode apply so EditPanel can show
  //   before/after with the same Use this / Discard buttons the smart
  //   flow uses.
  const [editPanelRow, setEditPanelRow] = useState<number | null>(null);
  const [editBrushOpen, setEditBrushOpen] = useState(false);
  // 2026-05-23: Active edit option for the panel + brush. Persisted to
  // localStorage so muscle memory follows the user across sessions.
  // Initialised lazily on first read so the SSR pass returns the
  // default and the client hydrates with the persisted value on mount.
  const [editOptionId, setEditOptionIdState] = useState<string>(DEFAULT_EDIT_OPTION_ID);
  useEffect(() => {
    const persisted = getLastEditOptionId(DEFAULT_EDIT_OPTION_ID);
    if (getEditOption(persisted)) setEditOptionIdState(persisted);
  }, []);
  const editOption: EditOption =
    getEditOption(editOptionId) ?? getEditOption(DEFAULT_EDIT_OPTION_ID)!;
  const updateEditOption = useCallback((next: EditOption) => {
    setEditOptionIdState(next.id);
    setLastEditOptionId(next.id);
  }, []);
  // Drag-and-drop overlay position editor. `null` = closed; otherwise
  // the row index whose overlay is being positioned. Lives at the page
  // level (not the cell) because the editor needs the row's still image
  // URL from `rowImages` and the fetched overlay URL from `rowOverlays`,
  // both of which are page-scoped.
  const [overlayPositionRow, setOverlayPositionRow] = useState<number | null>(null);
  const [editResult, setEditResult] = useState<{ imageUrl: string; saliency: ImageSaliencyMap | null } | null>(null);

  function closeEditPanel() {
    setEditPanelRow(null);
    setEditBrushOpen(false);
    setEditResult(null);
  }
  // — Overlay fetch state, keyed by rowIndex. Sparse: entries exist only
  //   for rows where an overlay fetch has been kicked off.
  const [rowOverlays, setRowOverlays] = useState<Record<number, RowOverlayState>>({});

  // Phase 3 rethink state — rowIndex → number of rethink calls made this
  // page session. Cap is RETHINK_MAX_ATTEMPTS to prevent accidental
  // dollar-loss (each rethink costs ~$0.0075). Resets on page reload —
  // good enough for a soft cap, since the user must consciously reload
  // to refill the budget. `rethinkingRows` is the in-flight set; the
  // OverlayCell shows a spinner for any row in this set.
  const RETHINK_MAX_ATTEMPTS = 5;
  const [rethinkAttempts, setRethinkAttempts] = useState<Record<number, number>>({});
  const [rethinkingRows, setRethinkingRows] = useState<Set<number>>(() => new Set());
  // Synchronous in-flight set. The UI's disabled state lags one render
  // behind a setState; two rapid clicks both pass the React-state
  // guard before the disable lands. The ref check is set synchronously
  // BEFORE any await, so a second click in the same tick short-circuits.
  const rethinkInFlightRef = useRef<Set<number>>(new Set());

  // Phase 5 — overlay AI-edit dialog. Single-row at a time (matches
  // overlayPositionRow's pattern). Mounted from the position editor's
  // ✎ button OR the overlay cell's ✎ button; on accept, the row's
  // overlay URL is swapped to the new R2 URL returned by
  // /api/overlay/edit. The replaced URL is pushed onto the row's
  // overlay_edit_history stack (cap 3) so Undo can roll it back.
  const [overlayEditRow, setOverlayEditRow] = useState<number | null>(null);

  // Phase 5 — right-click context menu state. When set, mounts an
  // OverlayContextMenu at the cursor coords with the row's relevant
  // actions. Cleared on item-click, click-outside, or Escape.
  const [overlayContextMenu, setOverlayContextMenu] = useState<{
    rowIndex: number;
    x: number;
    y: number;
  } | null>(null);

  /** Maximum depth of the per-row edit-history stack. 3 matches the
   *  plan and keeps saved-doc payloads small — three R2 URLs is ~600
   *  bytes per row. */
  const OVERLAY_EDIT_HISTORY_CAP = 3;

  /** Phase 5 — undo the most recent AI edit on a row. Pops the last
   *  URL off `overlay_edit_history` and swaps it back into the live
   *  overlay slot. No-op when the stack is empty. */
  function undoOverlayEdit(rowIndex: number): void {
    const row = doc?.rows[rowIndex];
    const history = row?.overlay_edit_history;
    if (!row || !history || history.length === 0) {
      console.warn('[ui overlay-edit] undo skipped — no history', { rowIndex });
      return;
    }
    const previousUrl = history[history.length - 1]!;
    const nextHistory = history.slice(0, -1);
    console.info('[ui overlay-edit] undo', {
      rowIndex,
      restoredUrl: previousUrl,
      remainingHistory: nextHistory.length,
    });
    updateRow(rowIndex, { overlay_edit_history: nextHistory });
    setRowOverlays((prev) => ({
      ...prev,
      [rowIndex]: { ...prev[rowIndex], status: 'done', url: previousUrl },
    }));
  }

  // — B-roll clips per row (rowIndex → { status, videoUrl }). The BrollCell
  //   owns its own clip lifecycle and reports up via `onClipChange`; we keep
  //   the parent-level map only for the renderer wiring. Sparse — entries
  //   exist only for rows the user has generated a clip on.
  const [rowVideoClips, setRowVideoClips] = useState<Record<number, { status: string; videoUrl?: string; durationSeconds?: number; brollClipId?: string } | null>>({});
  const handleBrollClipChange = useCallback(
    (rowIndex: number, clip: { id?: string; status: BrollStatus; video_url: string | null; duration_seconds?: number | null } | null) => {
      setRowVideoClips((prev) => {
        if (!clip) {
          if (!(rowIndex in prev)) return prev;
          const next = { ...prev };
          delete next[rowIndex];
          return next;
        }
        const existing = prev[rowIndex];
        // Plumb the clip's intrinsic duration through so BRollScene can
        // fit the playback rate to the scene length. Undefined when the
        // clip's a transient stub (no model yet) or a legacy row that
        // pre-dates `broll_clips.duration_seconds`. See plan
        // `_plans/2026-05-17-clip-duration-fit.md`.
        //
        // brollClipId carries the source clip UUID so the renderer can
        // rewrite its videoUrl to the same-origin proxy
        // `/api/broll/<id>/video` — Remotion's OffthreadVideo silently
        // produces empty frames on the R2 presigned URLs (X-Amz-* query
        // params break the URL cache key), but the same bytes work
        // fine when streamed through a clean same-origin URL.
        // 2026-05-20.
        const nextEntry = {
          status: clip.status,
          videoUrl: clip.video_url ?? undefined,
          durationSeconds: clip.duration_seconds ?? undefined,
          brollClipId: clip.id,
        };
        if (
          existing &&
          existing.status === nextEntry.status &&
          existing.videoUrl === nextEntry.videoUrl &&
          existing.durationSeconds === nextEntry.durationSeconds &&
          existing.brollClipId === nextEntry.brollClipId
        ) {
          return prev;
        }
        return { ...prev, [rowIndex]: nextEntry };
      });
      // CRITICAL (2026-05-22): persist only on terminal states so we
      // don't spam the row-asset endpoint on every poll-status tick.
      // `ready` with a videoUrl is the money-spent moment that MUST
      // land on the server. Clearing (clip === null) also persists so
      // a deletion sticks across reloads.
      if (!clip) {
        void persistRowAsset(rowIndex, 'clip', null);
      } else if (clip.status === 'ready' && clip.video_url) {
        void persistRowAsset(rowIndex, 'clip', {
          status: clip.status,
          videoUrl: clip.video_url,
          durationSeconds: clip.duration_seconds ?? undefined,
          brollClipId: clip.id,
        });
      }
    },
    [persistRowAsset],
  );

  // — Per-user "Animate scenes" toggle. When OFF, B-roll cells are hidden
  //   and the Remotion render ignores any clips already generated for this
  //   doc — every shot renders as a still with Ken Burns (the pre-animation
  //   default behaviour). Stored in localStorage so the preference sticks
  //   across reloads and across docs.
  const [animateScenes, setAnimateScenes] = useState<boolean>(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('prodoc_animate_scenes_v1');
    if (stored === '0') setAnimateScenes(false);
  }, []);
  const toggleAnimateScenes = useCallback(() => {
    setAnimateScenes((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('prodoc_animate_scenes_v1', next ? '1' : '0');
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  // — Per-user "Suppress on-screen-text overlay" toggle. When ON, the
  //   Remotion renderer skips the dark lower-third band that normally
  //   appears with on_screen_text. Useful when the OST is already baked
  //   into the AI image (the LLM prompt does this when present) — a
  //   second Remotion-rendered overlay would just be a duplicate. Stored
  //   in localStorage so the preference sticks across reloads. Default
  //   is OFF (overlays shown) for backwards compatibility.
  const [suppressLowerThirds, setSuppressLowerThirds] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('prodoc_suppress_lower_thirds_v1');
    if (stored === '1') setSuppressLowerThirds(true);
  }, []);
  const toggleSuppressLowerThirds = useCallback(() => {
    setSuppressLowerThirds((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('prodoc_suppress_lower_thirds_v1', next ? '1' : '0');
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, []);

  // — Per-row "lock as still" map (rowSignature → true). When true for a
  //   row, the renderer ignores any generated clip and falls back to the
  //   still + Ken Burns path. Persisted in localStorage so locks survive
  //   reload and doc regeneration (as long as the row signature still
  //   matches — same key space as the clip map). The page also reflects
  //   this as a rowIndex-keyed boolean array for the renderer call sites.
  const [rowLockSignatures, setRowLockSignatures] = useState<Record<string, true>>({});
  useEffect(() => {
    setRowLockSignatures(readBrollLockMap());
  }, []);
  const toggleRowLock = useCallback((rowSignature: string, locked: boolean) => {
    setRowLockSignatures((prev) => {
      const next = { ...prev };
      if (locked) next[rowSignature] = true;
      else delete next[rowSignature];
      writeBrollLockMap(next);
      return next;
    });
  }, []);

  // — "Animate all" batch state. While `animatingAll` is non-null the user
  //   is mid-batch; the button shows progress and we block re-entrance.
  const [animatingAll, setAnimatingAll] = useState<{ done: number; total: number } | null>(null);
  // — "Retry failed videos" / "Retry failed images" batch state. Same shape
  //   as `animatingAll` (done/total progress) but tracked separately so the
  //   two retry buttons can run independently of each other while still
  //   blocking re-entrance on their own batch.
  const [retryingVideos, setRetryingVideos] = useState<{ done: number; total: number } | null>(null);
  const [retryingImages, setRetryingImages] = useState<{ done: number; total: number } | null>(null);
  // Stubs assigned by the batch — pushed into each BrollCell as its
  //   `initialClip` so the cell's adoption effect picks up the new task id
  //   and starts polling. Sparse, keyed by rowIndex.
  const [rowBatchStubs, setRowBatchStubs] = useState<Record<number, BrollClipRow | null>>({});
  // — User's resolved default model id (for "Animate all"'s cost preview
  //   and the model it uses on each row). Fetched once after mount; the
  //   BrollCell's own picker stays the source of truth for per-row overrides.
  const [userDefaultModelId, setUserDefaultModelId] = useState<string>(DEFAULT_BROLL_MODEL_ID);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads broll default setting
        const res = await fetch('/api/user/settings/broll-default', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { modelId?: string };
        if (cancelled || !data.modelId) return;
        if (findBrollModel(data.modelId)) setUserDefaultModelId(data.modelId);
      } catch {
        /* leave at library default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── "Animate all" batch ─────────────────────────────────────────────────
  //
  // Eligibility (recomputed every render so the button label tracks state):
  //   - row has a generated still (`rowImages[i].status === 'done'`)
  //   - row is NOT locked-as-still
  //   - row does NOT already have a generating / ready clip
  //
  // Resolved against the user's chosen default model. We honour the model's
  // `kind`: t2v rows skip the still requirement, i2v rows require it.
  type AnimateAllRow = {
    rowIndex: number;
    rowSignature: string;
    visualDescription: string;
    aiImagePrompt?: string;
    stillImageUrl?: string;
  };
  const animateAllPlan = React.useMemo<AnimateAllRow[]>(() => {
    if (!doc) return [];
    const model = findBrollModel(userDefaultModelId);
    if (!model) return [];
    const out: AnimateAllRow[] = [];
    for (let i = 0; i < doc.rows.length; i++) {
      const row = doc.rows[i]!;
      const sig = brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description });
      if (rowLockSignatures[sig]) continue;
      const existing = rowVideoClips[i];
      if (existing && (existing.status === 'generating' || existing.status === 'ready')) continue;
      const still = rowImages[i]?.status === 'done' ? rowImages[i]?.imageUrl : undefined;
      if (model.kind === 'image-to-video' && !still) continue;
      const visDesc = (row.visual_description ?? '').trim();
      const aiPrompt = (row.ai_image_prompt ?? '').trim();
      if (visDesc.length < 20 && aiPrompt.length < 20) continue;
      out.push({
        rowIndex: i,
        rowSignature: sig,
        visualDescription: visDesc,
        aiImagePrompt: aiPrompt || undefined,
        stillImageUrl: still || undefined,
      });
    }
    return out;
  }, [doc, userDefaultModelId, rowLockSignatures, rowVideoClips, rowImages]);

  const animateAllCostUsd = React.useMemo(() => {
    const model = findBrollModel(userDefaultModelId);
    if (!model) return 0;
    return animateAllPlan.length * model.priceUsd;
  }, [animateAllPlan, userDefaultModelId]);

  // Rough scene-duration estimator used to pick a B-roll tier. Uses
  // raw timecodes (no alignment, no min-scene floor) — close enough for
  // a 5s / 10s tier decision. Final timing precision is handled at
  // render time by BRollScene's playbackRate fit. See plan
  // `_plans/2026-05-17-clip-duration-fit.md`.
  const computeRowSceneDurationMs = useCallback(
    (rowIndex: number): number => {
      if (!doc?.rows?.[rowIndex]) return 0;
      const startMs = parseTimecodeToMs(doc.rows[rowIndex].timecode);
      const next = doc.rows[rowIndex + 1];
      if (next) return Math.max(parseTimecodeToMs(next.timecode) - startMs, 0);
      const totalMs = parseTimecodeToMs(doc.total_duration);
      return Math.max(totalMs - startMs, 1000);
    },
    [doc],
  );

  /**
   * Phase 3 follow-up (2026-05-25) — pre-built `EditorWriters` bundle
   * for the new multi-pane editor view (`src/components/production-doc/
   * editor/EditorView.tsx`). Nothing in this file consumes the bundle
   * today; it exists so that whoever wires `<EditorView>` to a route
   * later can drop it in as a one-liner:
   *
   *     <EditorView ... writers={editorWriters} ... />
   *
   * Without this prebuilt bundle, the routing PR would have to hunt
   * down all 23 callbacks scattered across the 9k-line page and bundle
   * them inline — easy to miss one, and easy for a missed entry to
   * silently degrade (e.g. the "Generate variant" button doing
   * nothing because `generateVariantImage` wasn't bundled in).
   *
   * Async functions (`fetchOverlayForRow` et al.) are wrapped in
   * void-returning lambdas because the EditorWriters interface
   * specifies void return for those entries — the editor view doesn't
   * await them, it just fires-and-forgets and reads progress via the
   * sidecar state (`rowImages`, `rowOverlays`).
   *
   * State setters (`setEditPanelRow`, `setOverlayPositionRow`) are
   * wrapped to match the `openXForRow` shape — the editor view
   * delegates dialog opening to page.tsx; the close path stays
   * handled by each dialog's own onClose.
   */
  const editorWriters: EditorWriters = useMemo(() => ({
    updateRow,
    applyTitleToRange,
    applyPillarboxColorToAll,
    clearPillarboxOverrides,
    applyStripeLayoutToAll,
    clearStripeLayoutOverrides,
    applySceneZoomToAll,
    clearSceneZoomOverrides,
    applyRegionZoomPaddingToAll,
    applyTitleCardAsSectionTitle,
    // Async functions declared inside the component body — stable
    // identity across renders (function declarations are hoisted +
    // bound once per render closure). Wrapped in void-returning
    // lambdas to satisfy the EditorWriters fire-and-forget contract.
    fetchOverlayForRow: (rowIndex, terms) => { void fetchOverlayForRow(rowIndex, terms); },
    generateImageForRow: (rowIndex, prompt, extra) => { void generateImageForRow(rowIndex, prompt, extra); },
    uploadImageForRow: (rowIndex, file) => { void uploadImageForRow(rowIndex, file); },
    importImageUrlForRow: (rowIndex, url) => { void importImageUrlForRow(rowIndex, url); },
    // State-setter wrappers — opening these dialogs is page-owned.
    openEditPanelForRow: (rowIndex) => setEditPanelRow(rowIndex),
    openOverlayPositionEditorForRow: (rowIndex) => setOverlayPositionRow(rowIndex),
    handleBrollClipChange,
    toggleRowLock,
    computeRowSceneDurationMs,
    // Variant-group mutators added in Phase 3.3 + 3.7.
    addVariantRow,
    generateVariantImage,
    generateAllVariantsInGroup,
    deleteVariantRow,
    moveVariantRow,
  }), [
    // useCallback identities — listed in deps so React recomputes the
    // bundle when any underlying writer's closure rebinds. The async
    // functions and state setters above are NOT in deps: function
    // declarations and useState setters are stable across renders.
    updateRow,
    applyTitleToRange,
    applyPillarboxColorToAll,
    clearPillarboxOverrides,
    applyStripeLayoutToAll,
    clearStripeLayoutOverrides,
    applySceneZoomToAll,
    clearSceneZoomOverrides,
    applyRegionZoomPaddingToAll,
    applyTitleCardAsSectionTitle,
    handleBrollClipChange,
    toggleRowLock,
    computeRowSceneDurationMs,
    addVariantRow,
    generateVariantImage,
    generateAllVariantsInGroup,
    deleteVariantRow,
    moveVariantRow,
  ]);

  // Shared batch driver: walks `plan` sequentially, kicks off a B-roll
  // generation per row, seeds the cell's adoption stub + the page's status
  // map, and reports progress through `setProgress`. Both `runAnimateAll`
  // and `runRetryFailedVideos` call this — keeps the kickoff contract in
  // one place so the two batches can't drift.
  // Sequential (not parallel): keeps the Kie rate-limiter from kicking us,
  // and gives the user a smooth progress bar.
  const processBrollPlan = useCallback(
    async (
      plan: AnimateAllRow[],
      setProgress: (p: { done: number; total: number } | null) => void,
    ) => {
      setProgress({ done: 0, total: plan.length });
      for (let n = 0; n < plan.length; n++) {
        const item = plan[n]!;
        // Auto-pick the cheap 5s tier when the row's scene fits in 5s.
        // Per-row decision so a doc with mixed scene lengths gets the
        // right tier on each row. See plan
        // `_plans/2026-05-17-clip-duration-fit.md`.
        const sceneSeconds = computeRowSceneDurationMs(item.rowIndex) / 1000;
        const tier = pickModelForScene(userDefaultModelId, sceneSeconds);
        console.info('[broll tier pick]', {
          source: 'batch',
          rowIndex: item.rowIndex,
          sceneSeconds: Number(sceneSeconds.toFixed(2)),
          userModelId: userDefaultModelId,
          pickedModelId: tier.modelId,
          downgraded: tier.downgraded,
        });
        try {
          const stub = await kickoffBrollGeneration({
            projectId: null,
            scriptId: null,
            // Tag the clip with the current production-doc instance so a
            // future page mount (same / other device) can hydrate it
            // from the DB. NULL when the doc hasn't been saved yet —
            // see plan `_plans/2026-05-17-broll-doc-id-hydration.md`.
            productionDocId: historyEntryId,
            rowIndex: item.rowIndex,
            rowSignature: item.rowSignature,
            visualDescription: item.visualDescription,
            aiImagePrompt: item.aiImagePrompt,
            styleHint: stylePreset,
            stillImageUrl: item.stillImageUrl,
            modelId: tier.modelId,
          });
          // Hand the stub down to the row's BrollCell so it adopts the new
          // clip id and starts polling. We also seed `rowVideoClips` with
          // the 'generating' state so the renderer's per-row gating sees
          // the in-flight job immediately.
          setRowBatchStubs((prev) => ({ ...prev, [item.rowIndex]: stub }));
          handleBrollClipChange(item.rowIndex, { status: 'generating', video_url: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          toast.error(`Row ${item.rowIndex + 1}: ${msg}`);
        }
        setProgress({ done: n + 1, total: plan.length });
      }
      setProgress(null);
    },
    [stylePreset, userDefaultModelId, handleBrollClipChange, historyEntryId, computeRowSceneDurationMs],
  );

  // ── "Generate stills (local)" batch ─────────────────────────────────
  //
  // Walks every row that hasn't got a still image yet and dispatches a
  // local Flux schnell generation against /api/generate/production-doc/image.
  // Sequential so ComfyUI (one prompt at a time) doesn't queue them all
  // up at once and so the user sees smooth progress.
  //
  // Only enabled when LOCAL_STUDIO=1 — cloud users see the existing
  // per-row image-gen path. Phase 6 v1 of _plans/2026-05-20-comfyui-local-broll.md.
  const [generatingStills, setGeneratingStills] = React.useState<
    { done: number; total: number } | null
  >(null);

  // Phase 7 — style-sheet generation flag. Drives the StyleSheetPanel's
  // loading state; the panel itself owns the description / protagonist
  // inputs, this page owns the dispatch + persistence. See
  // `_plans/2026-05-21-phase-7-style-sheet.md`.
  const [generatingStyleSheet, setGeneratingStyleSheet] = React.useState(false);

  const runGenerateStyleSheet = useCallback(
    async (opts: {
      hasProtagonist: boolean;
      styleDescription: string;
      protagonistDescription: string;
    }) => {
      if (!doc) return;
      if (!opts.styleDescription.trim()) {
        toast.error('Add a visual style description first.');
        return;
      }
      setGeneratingStyleSheet(true);
      console.info('[prodoc style-sheet] start', {
        has_protagonist: opts.hasProtagonist,
        style_preview: opts.styleDescription.slice(0, 80),
      });
      try {
        // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (style sheet URL)
        const res = await fetch('/api/generate/style-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stylePrompt: opts.styleDescription,
            hasProtagonist: opts.hasProtagonist,
            protagonistDescription: opts.protagonistDescription || undefined,
            model: doc.style_sheet_model ?? 'flux-schnell-local',
            docId: historyEntryId ?? undefined,
          }),
        });
        const data = (await res.json()) as {
          imageUrl?: string;
          model?: string;
          prompt?: string;
          hasProtagonist?: boolean;
          error?: string;
        };
        if (!res.ok || !data.imageUrl) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        setDoc((prev) => {
          if (!prev) return prev;
          const next = {
            ...prev,
            style_sheet_url: data.imageUrl,
            style_sheet_model: (data.model ?? 'flux-schnell-local') as
              | 'flux-schnell-local'
              | 'qwen-image-local',
            style_sheet_has_protagonist: opts.hasProtagonist,
            style_sheet_prompt: data.prompt,
            style_sheet_description: opts.styleDescription,
          };
          persistDoc(next);
          return next;
        });
        toast.success('Style sheet ready.');
        console.info('[prodoc style-sheet] done', { model: data.model });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error('[prodoc style-sheet] failed', { detail });
        toast.error(`Style sheet failed: ${detail.slice(0, 120)}`);
      } finally {
        setGeneratingStyleSheet(false);
      }
    },
    [doc, historyEntryId],
  );

  const clearStyleSheet = useCallback(() => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        style_sheet_url: undefined,
        style_sheet_model: undefined,
        style_sheet_prompt: undefined,
      };
      persistDoc(next);
      return next;
    });
    toast.success('Style sheet cleared.');
  }, [historyEntryId]);

  const setStyleSheetHasProtagonist = useCallback(
    (next: boolean) => {
      setDoc((prev) => {
        if (!prev) return prev;
        const nextDoc = { ...prev, style_sheet_has_protagonist: next };
        persistDoc(nextDoc);
        return nextDoc;
      });
    },
    [historyEntryId],
  );

  const setStyleSheetDescription = useCallback(
    (next: string) => {
      setDoc((prev) => {
        if (!prev) return prev;
        const nextDoc = { ...prev, style_sheet_description: next };
        persistDoc(nextDoc);
        return nextDoc;
      });
    },
    [historyEntryId],
  );

  // Protagonist description lives in component-local state (it's a
  // per-generation prompt input, not something we persist on the doc —
  // the appearance ends up "in" the sheet image itself). Reset to empty
  // when a new doc loads so the panel doesn't show stale text.
  const [styleSheetProtagonistDraft, setStyleSheetProtagonistDraft] = React.useState('');

  const runGenerateAllStillsLocal = useCallback(async () => {
    if (!doc) return;
    // Phase 6 v2 — pre-compute the per-row local still model so the
    // confirm dialog can show the breakdown (e.g. "12 × Flux schnell + 3
    // × Qwen-Image"). The picker resolves baked-text rows + styled docs
    // to Qwen-Image and everything else to Flux schnell. See
    // `_plans/2026-05-21-phase-6-v2-smart-local-still-batch.md`.
    const plan = doc.rows
      .map((row, i) => {
        const picked = pickLocalStillModel({ row, doc });
        return { row, i, model: picked.model, reason: picked.reason };
      })
      .filter(({ i, row }) => {
        if (rowImages[i]?.imageUrl) return false;
        const prompt = (row.ai_image_prompt ?? row.visual_description ?? '').trim();
        return prompt.length >= 20;
      });
    if (plan.length === 0) {
      toast.info('Every row already has a still — nothing to do.');
      return;
    }
    const schnellCount = plan.filter((p) => p.model === 'flux-schnell-local').length;
    const qwenCount = plan.filter((p) => p.model === 'qwen-image-local').length;
    // Rough warm-time estimates from the May 21 comparison
    // (`/local-studio/compare`): schnell ≈ 20s, qwen ≈ 174s. Cold load on
    // the first run of each model is excluded — the user sees a separate
    // "first one is slow" hint in the existing batch-progress UI.
    const estimatedSec = schnellCount * 20 + qwenCount * 174;
    const estimatedMin = Math.max(1, Math.round(estimatedSec / 60));
    const breakdown = [
      schnellCount > 0 ? `${schnellCount} × Flux schnell` : null,
      qwenCount > 0 ? `${qwenCount} × Qwen-Image` : null,
    ]
      .filter(Boolean)
      .join(', ');
    if (
      !window.confirm(
        `Generate ${plan.length} still${plan.length === 1 ? '' : 's'} locally? ${breakdown}. Estimated ~${estimatedMin} min, free.`,
      )
    ) {
      return;
    }
    setGeneratingStills({ done: 0, total: plan.length });
    for (let n = 0; n < plan.length; n++) {
      const item = plan[n]!;
      setGeneratingStills({ done: n, total: plan.length });
      setRowImages((prev) => {
        const next = [...prev];
        next[item.i] = { ...next[item.i], status: 'loading' };
        return next;
      });
      const prompt = (item.row.ai_image_prompt ?? item.row.visual_description ?? '').trim();
      console.info('[prodoc batch-stills] picked-model', {
        row_index: item.i,
        picked: item.model satisfies LocalStillModel,
        reason: item.reason,
      });
      try {
        const sheetRef = resolveSheetReference(item.row, doc);
        const res = await queueImageGen('generate', 'local-bulk-single', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (image URL + saliency)
          fetch('/api/generate/production-doc/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              model: item.model,
              onScreenText: item.row.on_screen_text,
              onScreenTextMode: item.row.on_screen_text_mode ?? doc.on_screen_text_mode_default,
              sectionTitle: item.row.section_title,
              sectionTitleLayout: item.row.section_title_layout ?? doc.section_title_layout_default,
              referenceImageUrl: sheetRef.referenceImageUrl,
              styleSheetDescription: sheetRef.styleSheetDescription,
              // Local-Flux bulk path — the route's local branch fires
              // before the v2 i2i block, so styleId is currently a
              // no-op here. Passed for completeness when local i2i
              // arrives (v3 of the May 21 plan).
              styleId: stylePreset || undefined,
            }),
          }),
        );
        if (res.status === 429) reportUpstream429('generate', 'local-bulk-single');
        const data = (await res.json()) as { imageUrl?: string; error?: string };
        if (res.ok && data.imageUrl) {
          setRowImages((prev) => {
            const next = [...prev];
            next[item.i] = { status: 'done', imageUrl: data.imageUrl!, source: 'generated' };
            return next;
          });
        } else {
          setRowImages((prev) => {
            const next = [...prev];
            next[item.i] = { status: 'error', error: data.error ?? `HTTP ${res.status}` };
            return next;
          });
        }
      } catch (err) {
        setRowImages((prev) => {
          const next = [...prev];
          next[item.i] = { status: 'error', error: err instanceof Error ? err.message : 'Failed' };
          return next;
        });
      }
    }
    setGeneratingStills(null);
    toast.success(`Batch done: ${plan.length} row${plan.length === 1 ? '' : 's'}.`);
  }, [doc, rowImages]);

  const generateAllStillsPlanCount = React.useMemo(() => {
    if (!doc) return 0;
    return doc.rows.filter((row, i) => {
      if (rowImages[i]?.imageUrl) return false;
      const prompt = (row.ai_image_prompt ?? row.visual_description ?? '').trim();
      return prompt.length >= 20;
    }).length;
  }, [doc, rowImages]);

  const runAnimateAll = useCallback(async () => {
    if (animatingAll || retryingVideos) return;
    if (animateAllPlan.length === 0) return;
    const model = findBrollModel(userDefaultModelId);
    if (!model) return;
    // Cost confirmation — the picker shows price-per-click already, so the
    // batch needs an explicit "you're about to spend $X" check before
    // firing N parallel paid generations.
    const confirmed = window.confirm(
      `Animate ${animateAllPlan.length} row${animateAllPlan.length === 1 ? '' : 's'} with ${model.label}? ` +
        `Estimated cost: $${animateAllCostUsd.toFixed(2)}.`,
    );
    if (!confirmed) return;
    await processBrollPlan(animateAllPlan, setAnimatingAll);
    toast.success('Animation batch queued — clips will appear as each one finishes.');
  }, [
    animatingAll,
    retryingVideos,
    animateAllPlan,
    animateAllCostUsd,
    userDefaultModelId,
    processBrollPlan,
  ]);

  // ── Retry-failed batches ────────────────────────────────────────────────
  //
  // `failedVideoPlan` is a strict subset of `animateAllPlan` — same
  // eligibility gates (lock-as-still, model-kind/still pairing, min
  // description length) PLUS the row's current clip status must be
  // 'failed'. So clicking "Retry failed videos" never silently retries
  // a row the regular "Animate all" plan would also skip.
  //
  // `failedImagePlan` is independent: rows whose still status is 'error'
  // and which have an AI prompt (search-only rows can't be regenerated).
  //
  // The counters (`imageStats`, `videoStats`) are always visible per the
  // user's spec — so they see "all green" at a glance even with no
  // failures, not just when something needs attention.
  const failedVideoPlan = React.useMemo<AnimateAllRow[]>(
    () => animateAllPlan.filter((item) => rowVideoClips[item.rowIndex]?.status === 'failed'),
    [animateAllPlan, rowVideoClips],
  );

  const failedImagePlan = React.useMemo<Array<{
    rowIndex: number;
    prompt: string;
    onScreenText?: string;
    onScreenTextMode?: 'bake' | 'overlay' | 'none';
    sectionTitle?: string;
    sectionTitleLayout?: 'overlay' | 'letterbox';
    referenceImageUrl?: string;
    styleSheetDescription?: string;
    overlayStockTerms?: string;
    skipOverlay?: boolean;
    characterId?: string;
    sceneId?: string;
  }>>(() => {
    if (!doc) return [];
    const docDisabled = doc.overlays_disabled === true;
    const out: Array<{
      rowIndex: number;
      prompt: string;
      onScreenText?: string;
      onScreenTextMode?: 'bake' | 'overlay' | 'none';
      sectionTitle?: string;
      sectionTitleLayout?: 'overlay' | 'letterbox';
      referenceImageUrl?: string;
      styleSheetDescription?: string;
      overlayStockTerms?: string;
      skipOverlay?: boolean;
      characterId?: string;
      sceneId?: string;
    }> = [];
    for (let i = 0; i < doc.rows.length; i++) {
      if (rowImages[i]?.status !== 'error') continue;
      const row = doc.rows[i];
      // motion_collage rows never go through the regular single/collage
      // generator — see the matching guard in emptyImagePlan. A failed
      // motion_collage row is re-generated via the per-row ↻ (routes to
      // generateMotionCollageForRow) or picked up by "Generate empty"
      // (its dedicated motion_collage queue), both of which write the
      // panel URLs the renderer needs.
      if (row?.shot_kind === 'motion_collage') continue;
      const prompt = row?.ai_image_prompt?.trim();
      if (!prompt) continue;
      // Row-level wins in both directions: `skip_overlay === false`
      // forces an overlay even in an overlays-disabled doc; `true`
      // skips the auto-fetch even when the doc allows. Undefined
      // falls back to the doc-level toggle.
      const skipOverlay = typeof row?.skip_overlay === 'boolean' ? row.skip_overlay : docDisabled;
      const sheetRef = row ? resolveSheetReference(row, doc) : { referenceImageUrl: undefined, styleSheetDescription: undefined };
      out.push({
        rowIndex: i,
        prompt,
        onScreenText: row?.on_screen_text,
        onScreenTextMode: row?.on_screen_text_mode ?? doc.on_screen_text_mode_default,
        sectionTitle: row?.section_title,
        sectionTitleLayout: row?.section_title_layout ?? doc.section_title_layout_default,
        referenceImageUrl: sheetRef.referenceImageUrl,
        styleSheetDescription: sheetRef.styleSheetDescription,
        overlayStockTerms: row?.overlay_stock_terms,
        skipOverlay,
        characterId: row?.character_id,
        sceneId: row?.scene_id,
      });
    }
    return out;
  }, [doc, rowImages]);

  const retryVideosCostUsd = React.useMemo(() => {
    const model = findBrollModel(userDefaultModelId);
    if (!model) return 0;
    return failedVideoPlan.length * model.priceUsd;
  }, [failedVideoPlan, userDefaultModelId]);

  // Phase 4 (Editor UI) — character_id / scene_id tallies surfaced in
  // the per-row chip popovers. Each entry shows the slug + the number
  // of rows already using it so the user can pick from existing
  // slugs at a glance. Computed once per doc change; the chips read
  // the memoized arrays. Spec:
  // _plans/2026-05-28-doodle-2-character-cache.md (Phase 4 — Editor UI).
  const characterSlugTally = React.useMemo(() => {
    if (!doc) return [] as Array<{ slug: string; count: number }>;
    const tally = tallyCharacterIds(doc.rows);
    return collectCharacterIds(doc.rows).map((slug) => ({ slug, count: tally[slug] ?? 0 }));
  }, [doc]);
  const sceneSlugTally = React.useMemo(() => {
    if (!doc) return [] as Array<{ slug: string; count: number }>;
    const tally = tallySceneIds(doc.rows);
    return collectSceneIds(doc.rows).map((slug) => ({ slug, count: tally[slug] ?? 0 }));
  }, [doc]);
  // Slugs that are in use on rows but have no description yet — surfaced
  // both in the per-row chip popovers (as a ⚠ badge on those entries)
  // and in the doc-level CharacterDescriptionsPanel.
  const untaggedDescriptionSlugs = React.useMemo(() => {
    if (!doc) return [] as string[];
    return findUntaggedDescriptions(doc.rows, doc.doodle_explainer_2_character_descriptions);
  }, [doc]);

  // Rows that have an AI prompt but no still yet — surfaces the
  // "Generate empty" bulk action. Distinct from `failedImagePlan` (which
  // is only 'error' state): includes 'idle' and missing entries, which
  // are the common post-refresh state after the sanitizer resets stale
  // 'loading' statuses. A row with `imageUrl` already set is skipped
  // regardless of status, since the user clearly has an image they
  // don't want re-generated by this batch.
  const emptyImagePlan = React.useMemo<Array<{
    rowIndex: number;
    prompt: string;
    onScreenText?: string;
    onScreenTextMode?: 'bake' | 'overlay' | 'none';
    sectionTitle?: string;
    sectionTitleLayout?: 'overlay' | 'letterbox';
    referenceImageUrl?: string;
    styleSheetDescription?: string;
    overlayStockTerms?: string;
    skipOverlay?: boolean;
    characterId?: string;
    sceneId?: string;
  }>>(() => {
    if (!doc) return [];
    const docDisabled = doc.overlays_disabled === true;
    const out: Array<{
      rowIndex: number;
      prompt: string;
      onScreenText?: string;
      onScreenTextMode?: 'bake' | 'overlay' | 'none';
      sectionTitle?: string;
      sectionTitleLayout?: 'overlay' | 'letterbox';
      referenceImageUrl?: string;
      styleSheetDescription?: string;
      overlayStockTerms?: string;
      skipOverlay?: boolean;
      characterId?: string;
      sceneId?: string;
    }> = [];
    for (let i = 0; i < doc.rows.length; i++) {
      const s = rowImages[i];
      // Skip rows that already have a still, are mid-generation, or
      // are the search-only path. Empty = no entry at all OR 'idle'.
      if (s?.imageUrl) continue;
      if (s?.status === 'loading' || s?.status === 'pending' || s?.status === 'search') continue;
      const row = doc.rows[i];
      // motion_collage rows are generated ONLY through the dedicated
      // /motion-collage endpoint (collected separately as
      // `motionCollageRowsToGenerate` in runGenerateEmptyImages). They
      // must never enter the regular plan: with collage_mode on (the
      // default) the batcher slices a 2×2 quadrant into image_url and
      // leaves motion_collage_panel_urls empty, so the renderer falls
      // back to that one static slice — the "collage plays the first
      // cropped frame, no motion" bug. The visual_description fallback
      // just below otherwise sweeps them in even when ai_image_prompt
      // is blank, so the guard has to live here (not rely on an empty
      // prompt). See _plans/2026-05-31-doodle-explainer-2-motion-collage.md.
      if (row?.shot_kind === 'motion_collage') continue;
      // Fall back to visual_description when ai_image_prompt is empty.
      // The LLM sometimes leaves ai_image_prompt blank on rows that
      // share a scene_id / character_id with a prior row, assuming the
      // cache will carry the content forward — but the
      // generateSceneContinuationImage path still needs a prompt to use
      // as the edit instruction. Per-shot Generate already does this
      // fallback (ImageCell onRetry inline); mirror it here so batch
      // generation doesn't silently skip these rows.
      const prompt = (row?.ai_image_prompt?.trim() || row?.visual_description?.trim()) ?? '';
      if (!prompt) continue;
      const skipOverlay = typeof row?.skip_overlay === 'boolean' ? row.skip_overlay : docDisabled;
      const sheetRef = row ? resolveSheetReference(row, doc) : { referenceImageUrl: undefined, styleSheetDescription: undefined };
      out.push({
        rowIndex: i,
        prompt,
        onScreenText: row?.on_screen_text,
        onScreenTextMode: row?.on_screen_text_mode ?? doc.on_screen_text_mode_default,
        sectionTitle: row?.section_title,
        sectionTitleLayout: row?.section_title_layout ?? doc.section_title_layout_default,
        referenceImageUrl: sheetRef.referenceImageUrl,
        styleSheetDescription: sheetRef.styleSheetDescription,
        overlayStockTerms: row?.overlay_stock_terms,
        skipOverlay,
        characterId: row?.character_id,
        sceneId: row?.scene_id,
      });
    }
    return out;
  }, [doc, rowImages]);

  const imageStats = React.useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    for (const s of rowImages) {
      if (s?.status === 'done') succeeded++;
      else if (s?.status === 'error') failed++;
    }
    return { succeeded, failed };
  }, [rowImages]);

  const videoStats = React.useMemo(() => {
    let succeeded = 0;
    let failed = 0;
    for (const k of Object.keys(rowVideoClips)) {
      const v = rowVideoClips[Number(k)];
      if (!v) continue;
      if (v.status === 'ready') succeeded++;
      else if (v.status === 'failed') failed++;
    }
    return { succeeded, failed };
  }, [rowVideoClips]);

  const runRetryFailedImages = useCallback(async () => {
    if (retryingImages || imagesGenerating) return;
    // Collect failed variant rows too — they fall through `failedImagePlan`
    // because that filter requires a non-empty ai_image_prompt (variants
    // have it cleared by design). Without this, a 'Retry failed' click
    // would only retry failed bases and leave failed variants stuck.
    const failedVariantIndices = doc?.rows
      ? doc.rows
          .map((row, idx) => ({ row, idx }))
          .filter(({ row, idx }) =>
            (row.variant_index ?? 0) > 0 && rowImages[idx]?.status === 'error',
          )
          .map(({ idx }) => idx)
      : [];
    const totalRetries = failedImagePlan.length + failedVariantIndices.length;
    if (totalRetries === 0) return;
    setRetryingImages({ done: 0, total: totalRetries });
    let cursor = 0;
    for (let n = 0; n < failedImagePlan.length; n++) {
      const item = failedImagePlan[n]!;
      await generateImageForRow(item.rowIndex, item.prompt, {
        onScreenText: item.onScreenText,
        onScreenTextMode: item.onScreenTextMode,
        sectionTitle: item.sectionTitle,
        sectionTitleLayout: item.sectionTitleLayout,
        referenceImageUrl: item.referenceImageUrl,
        styleSheetDescription: item.styleSheetDescription,
        overlayStockTerms: item.overlayStockTerms,
        skipOverlay: item.skipOverlay,
        characterId: item.characterId,
        sceneId: item.sceneId,
      });
      cursor += 1;
      setRetryingImages({ done: cursor, total: totalRetries });
    }
    for (const idx of failedVariantIndices) {
      console.info('[prodoc retry-failed variant]', {
        rowIndex: idx,
        groupId: doc?.rows[idx]?.group_id,
        variantIndex: doc?.rows[idx]?.variant_index,
      });
      await generateVariantImage(idx);
      cursor += 1;
      setRetryingImages({ done: cursor, total: totalRetries });
    }
    setRetryingImages(null);
    const variantSummary = failedVariantIndices.length > 0
      ? ` + ${failedVariantIndices.length} variant${failedVariantIndices.length === 1 ? '' : 's'}`
      : '';
    toast.success(
      `Retried ${failedImagePlan.length} image${failedImagePlan.length === 1 ? '' : 's'}${variantSummary}.`,
    );
    // `generateImageForRow` is a per-render async function (not memoised) —
    // intentionally omitted from deps to avoid recreating this callback every
    // render. The function closes over stable state setters and `imageModel`
    // at call time, which is fine for a synchronous retry loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryingImages, imagesGenerating, failedImagePlan, doc?.rows, rowImages, generateVariantImage]);

  // Bulk generate stills for every row that's currently empty (idle /
  // missing) with a usable AI prompt. Shares the same sequential
  // pipeline as the retry batch so we don't hammer Kie in parallel.
  // Confirms first because a 30-row doc could cost real money.
  //
  // When `doc.collage_mode === true`, sequential chunks of 4 shots are
  // batched into a single 2×2 collage call (+ 1 upscale), cutting Kie
  // generation cost ~70–75% per group. The chunk falls back to 4
  // single-shot calls if the collage path reports `fallback_needed`
  // (malformed output after one retry OR generation error). The tail
  // group of <4 shots always uses single-shot calls. v1 limitations:
  // no per-cell OST baking, no style-ref i2i — when those features
  // are needed, turn collage off in the doc settings.
  const runGenerateEmptyImages = useCallback(async () => {
    if (retryingImages || imagesGenerating) return;

    // motion_collage rows are partitioned off the regular plan because
    // they don't carry an ai_image_prompt — the existing emptyImagePlan
    // requires a non-empty prompt and would silently skip them.
    // Collected here so the batch button STILL generates them; processed
    // sequentially via the dedicated /motion-collage endpoint after the
    // confirmation. Plan §9 follow-up.
    const motionCollageRowsToGenerate: number[] = [];
    if (doc) {
      for (let i = 0; i < doc.rows.length; i++) {
        const r = doc.rows[i];
        if (r.shot_kind !== 'motion_collage') continue;
        if (!r.motion_collage_grid || !r.motion_collage_panel_prompts?.length) continue;
        const s = rowImages[i];
        if (s?.imageUrl) continue;
        if (s?.status === 'loading' || s?.status === 'pending') continue;
        motionCollageRowsToGenerate.push(i);
      }
    }
    if (emptyImagePlan.length === 0 && motionCollageRowsToGenerate.length === 0) return;

    // Default: ON. Only an explicit `false` (set via the settings
    // toggle) opts out. Existing docs with no `collage_mode` field
    // automatically run collage after the 2026-05-26 flip.
    const collageOn = doc?.collage_mode !== false;
    const chunkCount = collageOn ? Math.floor(emptyImagePlan.length / 4) : 0;
    const tailCount = emptyImagePlan.length - chunkCount * 4;
    const mcPart = motionCollageRowsToGenerate.length > 0
      ? ` + ${motionCollageRowsToGenerate.length} motion-collage shot${motionCollageRowsToGenerate.length === 1 ? '' : 's'}`
      : '';
    const totalCount = emptyImagePlan.length + motionCollageRowsToGenerate.length;
    const confirmMsg = collageOn
      ? `Generate stills for ${totalCount} empty row${totalCount === 1 ? '' : 's'}? Collage mode is ON — ${chunkCount} batched group${chunkCount === 1 ? '' : 's'} of 4${tailCount > 0 ? ` + ${tailCount} single shot${tailCount === 1 ? '' : 's'}` : ''}${mcPart}.`
      : `Generate stills for ${totalCount} empty row${totalCount === 1 ? '' : 's'}? This calls the image model once per row${mcPart}.`;
    const confirmed = window.confirm(confirmMsg);
    if (!confirmed) return;

    setRetryingImages({ done: 0, total: totalCount });
    let completed = 0;

    // Process motion-collage rows FIRST (sequentially — each is a
    // single heavy Atlas i2i + Recraft + slice call). The user sees
    // these populate before the regular shots, which is a sensible
    // ordering since they're the most distinctive output.
    for (const rowIdx of motionCollageRowsToGenerate) {
      await generateMotionCollageForRow(rowIdx);
      completed += 1;
      setRetryingImages({ done: completed, total: totalCount });
    }
    // Short-circuit when there's nothing else to do.
    if (emptyImagePlan.length === 0) {
      setRetryingImages(null);
      return;
    }

    if (collageOn) {
      // Group eligible shots in chunks of 4 and run 2 chunks in parallel.
      // Each chunk is 1 server token via /collage → 4 images, so a
      // 2-wide pool delivers ~8 images per cycle while still respecting
      // the throttle's 25/min generate cap (token bucket spaces the
      // chunks automatically). Per-chunk fallback (4 single-shot calls
      // when collage detection fails) stays sequential inside its own
      // worker so the inspector pills land in row order.
      // _plans/2026-05-27-image-gen-client-throttle.md — Phase 5.
      const chunkSize = 4;
      const COLLAGE_POOL_WIDTH = 2;
      const chunks: typeof emptyImagePlan[] = [];
      for (let start = 0; start + chunkSize <= emptyImagePlan.length; start += chunkSize) {
        chunks.push(emptyImagePlan.slice(start, start + chunkSize));
      }

      async function processCollageChunk(chunk: typeof emptyImagePlan): Promise<void> {
        // Mark all 4 rows loading at once so the UI doesn't show 3 idle
        // tiles while the 4th is still running.
        setRowImages((prev) => {
          const next = [...prev];
          for (const item of chunk) {
            next[item.rowIndex] = { ...next[item.rowIndex], status: 'loading' };
          }
          return next;
        });
        console.info('[prodoc collage batch] start', {
          chunk_indices: chunk.map((c) => c.rowIndex),
          model: imageModel,
        });
        let collageOk = false;
        try {
          const res = await queueImageGen('generate', 'bulk-collage', () =>
            // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response (4 image URLs)
            fetch('/api/generate/production-doc/collage', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                cells: chunk.map((c) => ({
                  prompt: c.prompt,
                  onScreenText: c.onScreenText,
                  onScreenTextMode: c.onScreenTextMode,
                  sectionTitle: c.sectionTitle,
                  sectionTitleLayout: c.sectionTitleLayout,
                  styleSheetDescription: c.styleSheetDescription,
                })),
                model: imageModel,
                // 2026-05-31 (plan §C) — refs-aware collage. The route
                // loads the style's refs server-side and routes Atlas
                // calls through i2i so every cell inherits the style.
                // Without this field the route falls back to the
                // historical t2i path (refs dropped, style drifts).
                stylePreset,
              }),
            }),
          );
          if (res.status === 429) reportUpstream429('generate', 'bulk-collage');
          const data = await safeJson(res) as {
            status?: 'success' | 'fallback_needed';
            imageUrls?: string[];
            saliencies?: (ImageSaliencyMap | null)[];
            reason?: string;
            detail?: string;
            error?: string;
          };
          if (res.ok && data.status === 'success' && Array.isArray(data.imageUrls) && data.imageUrls.length === 4) {
            setRowImages((prev) => {
              const next = [...prev];
              for (let i = 0; i < chunk.length; i++) {
                next[chunk[i].rowIndex] = {
                  status: 'done',
                  imageUrl: data.imageUrls![i],
                  source: 'generated',
                };
              }
              return next;
            });
            if (Array.isArray(data.saliencies)) {
              for (let i = 0; i < chunk.length; i++) {
                const sal = data.saliencies[i];
                if (sal) applySaliencyToRow(chunk[i].rowIndex, sal);
              }
            }
            console.info('[prodoc collage batch] success', {
              chunk_indices: chunk.map((c) => c.rowIndex),
            });
            collageOk = true;
          } else {
            console.warn('[prodoc collage batch] fallback', {
              chunk_indices: chunk.map((c) => c.rowIndex),
              reason: data.reason ?? `http_${res.status}`,
              detail: (data.detail ?? data.error ?? '').slice(0, 200),
            });
          }
        } catch (err) {
          console.warn('[prodoc collage batch] threw — falling back to single', {
            chunk_indices: chunk.map((c) => c.rowIndex),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (!collageOk) {
          // Per-shot fallback for this chunk only — sequential within
          // the chunk so pill state lands in row order.
          for (const item of chunk) {
            await generateImageForRow(item.rowIndex, item.prompt, {
              onScreenText: item.onScreenText,
              onScreenTextMode: item.onScreenTextMode,
              sectionTitle: item.sectionTitle,
              sectionTitleLayout: item.sectionTitleLayout,
              referenceImageUrl: item.referenceImageUrl,
              styleSheetDescription: item.styleSheetDescription,
              overlayStockTerms: item.overlayStockTerms,
              skipOverlay: item.skipOverlay,
            });
          }
        }
        completed += chunk.length;
        setRetryingImages({ done: completed, total: totalCount });
      }

      // Shared cursor — each worker pulls the next available chunk
      // index off the front of `chunks` until the queue drains.
      // Workers running in parallel push into `setRowImages` which is
      // React's batched setter, so the per-worker `setRowImages(prev =>
      // ...)` calls compose correctly even when interleaved.
      let nextChunkIdx = 0;
      async function chunkWorker(): Promise<void> {
        while (true) {
          const idx = nextChunkIdx++;
          if (idx >= chunks.length) return;
          await processCollageChunk(chunks[idx]!);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(COLLAGE_POOL_WIDTH, chunks.length) }, () => chunkWorker()),
      );
      // Tail of <4 shots → single-shot each.
      for (let i = chunkCount * chunkSize; i < emptyImagePlan.length; i++) {
        const item = emptyImagePlan[i]!;
        await generateImageForRow(item.rowIndex, item.prompt, {
          onScreenText: item.onScreenText,
          onScreenTextMode: item.onScreenTextMode,
          sectionTitle: item.sectionTitle,
          sectionTitleLayout: item.sectionTitleLayout,
          referenceImageUrl: item.referenceImageUrl,
          styleSheetDescription: item.styleSheetDescription,
          overlayStockTerms: item.overlayStockTerms,
          skipOverlay: item.skipOverlay,
        });
        completed++;
        setRetryingImages({ done: completed, total: totalCount });
      }
    } else {
      // Legacy per-shot path — collage mode off.
      for (let n = 0; n < emptyImagePlan.length; n++) {
        const item = emptyImagePlan[n]!;
        await generateImageForRow(item.rowIndex, item.prompt, {
          onScreenText: item.onScreenText,
          onScreenTextMode: item.onScreenTextMode,
          sectionTitle: item.sectionTitle,
          sectionTitleLayout: item.sectionTitleLayout,
          referenceImageUrl: item.referenceImageUrl,
          styleSheetDescription: item.styleSheetDescription,
          overlayStockTerms: item.overlayStockTerms,
          skipOverlay: item.skipOverlay,
        });
        completed++;
        setRetryingImages({ done: completed, total: totalCount });
      }
    }

    setRetryingImages(null);

    // After base rows finish, generate any variant rows in the doc via
    // Atlas Edit on their base's image. Variant rows have an empty
    // `ai_image_prompt` by design (the auto-grouping post-pass in
    // src/lib/auto-group-variants.ts clears it; the dispatcher composes
    // the final prompt from base.ai_image_prompt + variant_edit_prompt),
    // so they're skipped by the bulk plan above. Without this phase,
    // the user would have to click "Generate variant" on every variant
    // row by hand — defeating the purpose of auto-grouping. Done
    // sequentially because each Atlas Edit call is independent but
    // they all hit the same Kie endpoint and rate-limiting parallel
    // calls would be friction the user shouldn't have to think about.
    // Two-stage filter (mirrors the auto-pipeline variant phase):
    //   1) Skip variants that already have an image — re-generating wastes
    //      money AND would clobber any image the user edited by hand.
    //   2) Skip variants whose BASE has no image — they'd hit
    //      BASE_NOT_GENERATED and spam error toasts. Surface a single
    //      consolidated log line instead.
    let imagesSnapshot: RowImageState[] = [];
    setRowImages(prev => {
      imagesSnapshot = prev;
      return prev;
    });
    const variantRowIndices: number[] = [];
    const { orphans: orphanCount, incomplete: incompleteCount } = (() => {
      let orphans = 0;
      let incomplete = 0;
      if (!doc?.rows) return { orphans: 0, incomplete: 0 };
      for (let i = 0; i < doc.rows.length; i++) {
        const row = doc.rows[i];
        if ((row.variant_index ?? 0) <= 0) continue;
        if (imagesSnapshot[i]?.imageUrl) continue;
        const editPrompt = row.variant_edit_prompt?.trim();
        if (!editPrompt) {
          incomplete += 1;
          continue;
        }
        const groupId = row.group_id;
        if (!groupId) continue;
        const baseRowIdx = doc.rows.findIndex(
          (r) => r.group_id === groupId && (r.variant_index ?? 0) === 0,
        );
        const baseHasImage = baseRowIdx >= 0 && Boolean(imagesSnapshot[baseRowIdx]?.imageUrl);
        if (!baseHasImage) {
          orphans += 1;
          continue;
        }
        variantRowIndices.push(i);
      }
      return { orphans, incomplete };
    })();
    if (incompleteCount > 0) {
      appendLog(
        `⚠ ${incompleteCount} variant${incompleteCount === 1 ? '' : 's'} skipped — empty edit prompt. Fill in "what changes from the base" in the inspector and click Generate variant.`,
      );
    }
    if (orphanCount > 0) {
      appendLog(
        `⚠ ${orphanCount} variant${orphanCount === 1 ? '' : 's'} skipped — base image not generated. Retry the failed base${orphanCount === 1 ? '' : 's'} first.`,
      );
    }

    if (variantRowIndices.length > 0) {
      appendLog(
        `Generating ${variantRowIndices.length} variant frame${variantRowIndices.length === 1 ? '' : 's'} from base images via Atlas Edit (~$${(variantRowIndices.length * 0.011).toFixed(2)})...`,
      );
      let variantDone = 0;
      let variantFailed = 0;
      for (const idx of variantRowIndices) {
        console.info('[prodoc bulk-empty variant]', {
          rowIndex: idx,
          groupId: doc?.rows[idx]?.group_id,
          variantIndex: doc?.rows[idx]?.variant_index,
          hasEditPrompt: Boolean(doc?.rows[idx]?.variant_edit_prompt?.trim()),
        });
        await generateVariantImage(idx);
        let updated: RowImageState[] = [];
        setRowImages(prev => {
          updated = prev;
          return prev;
        });
        if (updated[idx]?.imageUrl) variantDone += 1;
        else variantFailed += 1;
      }
      appendLog(
        `✓ Variant generation finished — ${variantDone} succeeded${variantFailed > 0 ? `, ${variantFailed} failed (click Retry on the failing variant or check console)` : ''}`,
      );
    }

    const variantSummary = variantRowIndices.length > 0
      ? ` + ${variantRowIndices.length} variant${variantRowIndices.length === 1 ? '' : 's'} via Atlas Edit`
      : '';
    toast.success(
      collageOn
        ? `Generated ${emptyImagePlan.length} image${emptyImagePlan.length === 1 ? '' : 's'} (${chunkCount} collage group${chunkCount === 1 ? '' : 's'})${variantSummary}.`
        : `Generated ${emptyImagePlan.length} image${emptyImagePlan.length === 1 ? '' : 's'}${variantSummary}.`,
    );
    // Same deps justification as runRetryFailedImages above. `imageModel`
    // and `doc.collage_mode` are read inside but stable enough at the
    // batch's scope that we don't need to refire the callback when they
    // change mid-batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryingImages, imagesGenerating, emptyImagePlan, doc?.collage_mode, imageModel, doc?.rows, generateVariantImage]);

  const runRetryFailedVideos = useCallback(async () => {
    if (animatingAll || retryingVideos) return;
    if (failedVideoPlan.length === 0) return;
    const model = findBrollModel(userDefaultModelId);
    if (!model) return;
    const confirmed = window.confirm(
      `Retry ${failedVideoPlan.length} failed animation${failedVideoPlan.length === 1 ? '' : 's'} with ${model.label}? ` +
        `Estimated cost: $${retryVideosCostUsd.toFixed(2)}.`,
    );
    if (!confirmed) return;
    await processBrollPlan(failedVideoPlan, setRetryingVideos);
    toast.success(
      `Retry batch queued for ${failedVideoPlan.length} row${failedVideoPlan.length === 1 ? '' : 's'}.`,
    );
  }, [
    animatingAll,
    retryingVideos,
    failedVideoPlan,
    retryVideosCostUsd,
    userDefaultModelId,
    processBrollPlan,
  ]);

  // Revoke any outstanding screenshot blob URLs on unmount. We track the
  // latest visualRefs through a ref so the cleanup closure sees the final
  // list (not the empty array captured at mount).
  const visualRefsLatestRef = useRef<VisualRef[]>([]);
  useEffect(() => { visualRefsLatestRef.current = visualRefs; }, [visualRefs]);
  useEffect(() => () => {
    for (const r of visualRefsLatestRef.current) {
      if (r.objectUrl) URL.revokeObjectURL(r.objectUrl);
    }
  }, []);

  // Schedule-link preload: pull every relevant field off the linked item so
  // the user doesn't retype context they already captured upstream. Functional
  // setters (curr => curr || ctx.x) keep manual edits made before the async
  // resolves from being clobbered.
  useEffect(() => {
    if (!scheduleItemId || schedulePrefilled) return;
    let cancelled = false;
    (async () => {
      const item = await fetchScheduleItem(scheduleItemId);
      if (cancelled || !item) return;
      setScheduleItem(item);
      setSchedulePrefilled(true);
      const ctx = await loadFullContextForItem(item, { withVoiceoverDuration: true });
      if (cancelled) return;
      setTopic(curr => curr || ctx.topic);
      setNiche(curr => curr || ctx.niche);
      if (ctx.script) setScript(prev => prev || ctx.script!);
      // Pre-fill the "actual duration" mm:ss with the most recent recorded
      // voiceover for this item's project, so the computed-wpm readout works
      // on first paint without the user retyping the take length.
      if (ctx.voiceoverDurationSeconds && ctx.voiceoverDurationSeconds > 0) {
        const total = ctx.voiceoverDurationSeconds;
        const mm = Math.floor(total / 60);
        const ss = total % 60;
        const formatted = `${mm}:${String(ss).padStart(2, '0')}`;
        setActualDuration(curr => curr || formatted);
      }
      // Seed the creative brief with the item's accumulated narrative context
      // (notes, series part, prior published description, editor, open
      // checklist) — the prod-doc generator will weight these as scene-shaping
      // hints. User can still wipe / edit before generating.
      const briefSeed = [buildContextNotesFromItem(ctx), ctx.prevDescription]
        .filter(Boolean)
        .join('\n\n');
      if (briefSeed) setCreativeBrief(curr => curr || briefSeed);
      toast.message(`Loaded context from "${item.title || 'schedule item'}"`);
    })();
    return () => { cancelled = true; };
     
  }, [scheduleItemId, schedulePrefilled]);

  // Project-link preload: when launched from `/projects/[id]` via the
  // "Send to Production Doc" button, pull title + niche + active script
  // off the project so the user starts with the same context they'd get
  // from a schedule item, without needing a schedule item at all.
  // Functional setters keep manual edits made before the fetch resolves.
  useEffect(() => {
    if (!projectIdParam || projectPrefilled || scheduleItemId) return;
    let cancelled = false;
    (async () => {
      try {
        const [projectRes, scriptsRes] = await Promise.all([
          // eslint-disable-next-line no-restricted-syntax -- GET, loads project on mount
          fetch(`/api/projects/${projectIdParam}`),
          // eslint-disable-next-line no-restricted-syntax -- GET, loads scripts on mount
          fetch(`/api/projects/${projectIdParam}/scripts`),
        ]);
        if (cancelled) return;
        if (!projectRes.ok) return;
        const projectData = await projectRes.json();
        const project: {
          title?: string;
          topic?: string;
          niche?: string;
          youtube_description?: string | null;
        } | undefined = projectData?.project;
        if (!project) return;
        setProjectPrefilled(true);
        const title = (project.title || project.topic || '').trim();
        const projectNiche = (project.niche || '').trim();
        if (title) setTopic(curr => curr || title);
        if (projectNiche) setNiche(curr => curr || projectNiche);
        // Seed the creative brief with the published description if there
        // is one — the same role `prevDescription` plays in the schedule-
        // item handoff. The prod-doc generator weights it as a scene-
        // shaping hint; the user can wipe / edit before generating.
        const desc = (project.youtube_description || '').trim();
        if (desc) setCreativeBrief(curr => curr || desc);
        if (scriptsRes.ok) {
          const scriptsData = await scriptsRes.json();
          type ScriptRow = { id: string; content: string; is_active?: boolean };
          const scripts: ScriptRow[] = Array.isArray(scriptsData?.scripts) ? scriptsData.scripts : [];
          const active = scripts.find(s => s.is_active) ?? scripts[0];
          if (active?.content) setScript(curr => curr || active.content);
        }
        toast.message(`Loaded context from "${title || 'project'}"`);
      } catch {
        // Best-effort prefill — leave the page blank and let the user start fresh.
      }
    })();
    return () => { cancelled = true; };
  }, [projectIdParam, projectPrefilled, scheduleItemId]);

  // Wave 1 ?videoId= prefill — same shape as the ?projectId= block above
  // but talks to /api/videos/[id] (the unified endpoint that returns the
  // project + active script + channel + narrator/editor assignments in
  // one round-trip). Skips when scheduleItemId or projectIdParam is set
  // so those handoffs take precedence (they carry richer context). Also
  // skips when projectPrefilled is true to avoid clobbering a project
  // handoff that the user navigated through. Functional setters keep
  // manual edits made before the fetch resolves.
  useEffect(() => {
    if (!videoIdParam || videoPrefilled || scheduleItemId || projectIdParam) return;
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads video on mount
        const res = await fetch(`/api/videos/${videoIdParam}`);
        if (cancelled) return;
        if (!res.ok) return;
        const data = await res.json();
        const video: {
          id?: string;
          title?: string;
          niche?: string;
          topic?: string | null;
        } | undefined = data?.video;
        if (!video) return;
        setVideoPrefilled(true);
        const title = (video.title || video.topic || '').trim();
        const videoNiche = (video.niche || '').trim();
        if (title) setTopic(curr => curr || title);
        if (videoNiche) setNiche(curr => curr || videoNiche);
        // Also pull the active script via the existing projects-scripts
        // endpoint — /api/videos/[id] returns metadata only, not the
        // script body, so we mirror the ?projectId= path for the script.
        try {
          // eslint-disable-next-line no-restricted-syntax -- GET, loads scripts on mount
          const scriptsRes = await fetch(`/api/projects/${videoIdParam}/scripts`);
          if (!cancelled && scriptsRes.ok) {
            const scriptsData = await scriptsRes.json();
            type ScriptRow = { content?: string; is_active?: boolean };
            const list: ScriptRow[] = Array.isArray(scriptsData?.scripts) ? scriptsData.scripts : [];
            const active = list.find(s => s.is_active) ?? list[0];
            if (active?.content) {
              setScript(prev => prev || active.content!);
            }
          }
        } catch {
          // best-effort — leave the script blank if it can't be fetched
        }
        toast.message(`Loaded context from video "${title || 'untitled'}"`);
      } catch {
        // best-effort prefill
      }
    })();
    return () => { cancelled = true; };
  }, [videoIdParam, videoPrefilled, scheduleItemId, projectIdParam]);

  // Restore last result from localStorage after mount (useEffect so SSR is unaffected).
  //
  // A "handoff" is a navigation into the page that carries context from
  // elsewhere (schedule link, project, generator, QA). On the FIRST visit
  // of such a URL we want a fresh session — discard the previous saved
  // doc so the prefilled form doesn't sit next to an unrelated old doc.
  //
  // But on a REFRESH (same handoff URL, second mount) the user expects
  // their in-progress work — including thumbnail regions, row images,
  // and overlay fetches — to survive. We can't distinguish first-visit
  // from refresh from the URL alone, so we track which handoff key has
  // already been consumed in localStorage. If the current URL matches
  // the consumed key, treat the load as a refresh.
  useEffect(() => {
    const handoffKey = [
      scheduleItemId ? `sched:${scheduleItemId}` : '',
      projectIdParam ? `proj:${projectIdParam}` : '',
      search.get('from') ? `from:${search.get('from')}` : '',
      typeof window !== 'undefined' && window.localStorage.getItem('prodoc_prefill') ? 'prefill' : '',
    ].filter(Boolean).join('|');

    let consumedKey: string | null = null;
    try {
      consumedKey = window.localStorage.getItem('prodoc_handoff_consumed');
    } catch { /* ignore */ }

    const isFreshHandoff = handoffKey !== '' && handoffKey !== consumedKey;
    if (isFreshHandoff) {
      // First visit of this handoff URL — wipe the previous session and
      // mark this handoff as consumed so subsequent refreshes restore.
      // Also wipe the form-inputs cache: the prefill effects below will
      // populate the form from the handoff context, so a stale cache
      // here would create a confusing "old form + new handoff" mix.
      try {
        window.localStorage.removeItem('prodoc_last_result');
        window.localStorage.removeItem('prodoc_form_inputs_v1');
        window.localStorage.setItem('prodoc_handoff_consumed', handoffKey);
      } catch { /* ignore */ }
      return;
    }

    // Restore the FORM INPUTS first (script/niche/topic/etc.) so the user
    // sees the same setup they left even when they hadn't yet generated
    // a doc. The doc + row state restore follows; both come from
    // separate localStorage entries so a partial save (form filled, doc
    // not yet generated) still restores cleanly.
    try {
      const rawInputs = localStorage.getItem('prodoc_form_inputs_v1');
      if (rawInputs) {
        const savedInputs = JSON.parse(rawInputs) as {
          script?: string;
          niche?: string;
          topic?: string;
          modelId?: string;
          speakingPace?: number;
          actualDuration?: string;
          stylePreset?: string;
          creativeBrief?: string;
        };
        if (typeof savedInputs.script === 'string') setScript(savedInputs.script);
        if (typeof savedInputs.niche === 'string') setNiche(savedInputs.niche);
        if (typeof savedInputs.topic === 'string') setTopic(savedInputs.topic);
        if (typeof savedInputs.modelId === 'string') setModelId(savedInputs.modelId);
        if (typeof savedInputs.speakingPace === 'number') setSpeakingPace(savedInputs.speakingPace);
        if (typeof savedInputs.actualDuration === 'string') setActualDuration(savedInputs.actualDuration);
        if (typeof savedInputs.stylePreset === 'string') setStylePreset(savedInputs.stylePreset);
        if (typeof savedInputs.creativeBrief === 'string') setCreativeBrief(savedInputs.creativeBrief);
      }
    } catch { /* corrupt form cache — ignore */ }

    // CRITICAL (2026-05-23): when the URL carries `?h=<historyEntryId>`,
    // the user navigated here from the editor's "Doc" link expecting to
    // see THIS row's current server state. localStorage is almost always
    // stale relative to the server (the editor has been writing through
    // the row-asset endpoint and the full-payload PATCH), so restoring
    // it would silently revert the user's edits — animations disappear,
    // fade toggles undo themselves, narration/scene timing falls out of
    // sync. Skip the localStorage doc/rowImages restore when URL is
    // authoritative; the canonical hydrate effect above populates from
    // /api/edit/[id] instead.
    if (urlHistoryId) {
      console.info('[production-doc] skipping localStorage restore — url ?h= is authoritative');
      return;
    }
    try {
      const saved = localStorage.getItem('prodoc_last_result');
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        doc?: ProductionDoc;
        rowImages?: RowImageState[];
        rowOverlays?: Record<number, RowOverlayState>;
        rowVideoClips?: Record<number, { status: string; videoUrl?: string } | null>;
        historyEntryId?: string | null;
        savedAt?: number;
      };
      if (!parsed.doc?.rows?.length) return;
      setDoc(parsed.doc);
      // Restore EVERY field unconditionally so a refresh after generation
      // never silently drops state. The previous version used
      // `if (parsed.rowImages?.length)` which skipped restoration when the
      // saved array was empty — fine for that specific case but it set a
      // pattern that almost guaranteed silent skips on edge cases. With
      // arrays / records we just assign whatever was saved (empty is
      // fine — the initial useState defaults were also empty).
      // Sanitize transient statuses before restoring. `'loading' / 'pending' /
      // 'search'` all imply an in-flight fetch that died with the page
      // reload — restoring them verbatim leaves the row showing a spinner
      // forever because no actual request is in flight. Reset to `'idle'`
      // so Phase 3 entry hydration can fill from server, or the user can
      // retry the generation. Same logic for overlays.
      if (Array.isArray(parsed.rowImages)) {
        const sanitized = (parsed.rowImages as Array<RowImageState | undefined | null>).map((r) => {
          if (!r) return { status: 'idle' as const };
          if (r.status === 'loading' || r.status === 'pending' || r.status === 'search') {
            return { status: 'idle' as const };
          }
          return r;
        });
        setRowImages(sanitized);
      }
      if (parsed.rowOverlays && typeof parsed.rowOverlays === 'object') {
        const cleaned: Record<number, RowOverlayState> = {};
        for (const [k, v] of Object.entries(parsed.rowOverlays as Record<string, RowOverlayState | undefined>)) {
          if (!v) continue;
          // Skip transient overlay states — the row falls back to 'idle'
          // (no entry in the map) and re-fetches on demand.
          if (v.status === 'loading') continue;
          cleaned[Number(k)] = v;
        }
        setRowOverlays(cleaned);
      }
      if (parsed.rowVideoClips && typeof parsed.rowVideoClips === 'object') {
        // Clip clean-up: 'pending' and 'generating' clips can still be
        // alive server-side (Kie keeps tasks for ~24h), so keep them —
        // the per-cell adoption effect picks the poll back up when the
        // cell mounts. Only 'failed' without a video_url is purely
        // stale; drop those so the cell starts idle. 'ready' obviously
        // stays as-is.
        const cleanedClips: Record<number, { status: string; videoUrl?: string; durationSeconds?: number } | null> = {};
        for (const [k, v] of Object.entries(parsed.rowVideoClips as Record<string, { status: string; videoUrl?: string; durationSeconds?: number } | null>)) {
          if (!v) continue;
          if (v.status === 'failed' && !v.videoUrl) continue;
          cleanedClips[Number(k)] = v;
        }
        setRowVideoClips(cleanedClips);
      }
      if (typeof parsed.historyEntryId === 'string') {
        // Restore so the background patch-the-history-entry pipeline
        // continues writing to the same row after refresh.
        setHistoryEntryId(parsed.historyEntryId);
      }
      const ago = parsed.savedAt ? Math.round((Date.now() - parsed.savedAt) / 60000) : null;
      toast.success(`Previous session restored${ago !== null ? ` (saved ${ago < 1 ? 'just now' : `${ago}m ago`})` : ''}`, { duration: 4000 });
    } catch (err) {
      // Surface corruption so future drops are debuggable. The previous
      // catch swallowed silently and made "my data vanished" reports
      // impossible to triage from the console.
      console.warn('[production-doc] restore failed', err instanceof Error ? err.message : err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the form inputs (script/niche/topic/etc.) on every change.
  // Survives refresh AND survives a tab close — the user no longer loses
  // a half-typed script when they navigate away. Stored separately from
  // the generated doc so a partially-filled form doesn't require a
  // generated doc to round-trip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('prodoc_form_inputs_v1', JSON.stringify({
        script, niche, topic, modelId, speakingPace, actualDuration, stylePreset, creativeBrief,
      }));
    } catch { /* quota / disabled storage — best effort */ }
  }, [script, niche, topic, modelId, speakingPace, actualDuration, stylePreset, creativeBrief]);

  // "New session" — clear the form inputs, the generated doc, the row
  // images / overlays / video clips / lock state, and every related
  // localStorage entry in one go. Asks for confirmation because the
  // wipe is non-reversible (history entries are NOT touched — the
  // user can always restore a prior generation from the sidebar).
  const resetSession = useCallback(() => {
    const confirmed = window.confirm(
      'Start a new session? This clears the current form (script, niche, topic, etc.) AND the generated doc.\n\nPrevious generations are still available in the history sidebar.',
    );
    if (!confirmed) return;
    setScript('');
    setNiche('');
    setTopic('');
    setSpeakingPace(135);
    setActualDuration('');
    // Use the user's stored default style if they've set one; otherwise
    // fall back to the library default. The user's last explicit choice
    // is what shapes new sessions, not the literal hardcoded default.
    setStylePreset(userDefaultStyle || 'doodle_explainer');
    setCreativeBrief('');
    setDoc(null);
    setRowImages([]);
    setRowOverlays({});
    setRowVideoClips({});
    setRowBatchStubs({});
    setHistoryEntryId(null);
    try {
      window.localStorage.removeItem('prodoc_last_result');
      window.localStorage.removeItem('prodoc_form_inputs_v1');
      window.localStorage.removeItem('prodoc_handoff_consumed');
    } catch { /* ignore */ }
    toast.success('New session started.');
  }, [userDefaultStyle]);

  // Persist EVERYTHING that should survive a refresh into one bundle.
  // Fires whenever any of the relevant slices changes. The user's hard
  // rule is "nothing disappears until I click New Session" — so we
  // include doc, rowImages, rowOverlays, rowVideoClips, AND
  // historyEntryId in the payload. rowBatchStubs is intentionally
  // excluded (transient hand-off objects the BrollCell consumes once).
  useEffect(() => {
    if (!doc?.rows?.length) return;
    let persistFailed = false;
    // Strip `image_saliency` from doc.rows before persisting. Saliency
    // maps (60-cell busyness + dominantColors per row) are the heaviest
    // field on a generated row and account for the bulk of bundle growth
    // on long docs. They're recoverable: the FULL doc with saliency lives
    // on the server-side history entry, so a sidebar restore brings them
    // back; and any new image generation re-emits them. Until then,
    // overlay placement falls back to the LLM-picked zone (still on the
    // row) — minor visual degradation, no broken functionality. Without
    // this slim, a 30-row doc with rich prompts can push the 5MB quota.
    const slimDoc = {
      ...doc,
      rows: doc.rows.map((r) => {
        if (!r.image_saliency) return r;
        const { image_saliency: _saliency, ...slim } = r;
        return slim;
      }),
    };
    const bundle = { doc: slimDoc, rowImages, rowOverlays, rowVideoClips, historyEntryId, savedAt: Date.now() };
    try {
      localStorage.setItem('prodoc_last_result', JSON.stringify(bundle));
    } catch (err) {
      // Quota or similar storage failure. Try once more without overlays
      // (they're the heaviest field — base64-ish thumbnails / URLs). If
      // THAT also fails, drop rowVideoClips next, then doc rows last.
      // Whatever level succeeds, surface a visible toast so the user
      // knows their session may not survive a refresh. The previous
      // implementation only console.warn'd — silent data loss.
      const bundleSizeKb = Math.round(JSON.stringify(bundle).length / 1024);
      console.warn('[persist quota] full bundle failed', {
        bundleSizeKb,
        rowCount: doc.rows.length,
        imageCount: rowImages.filter((r) => r?.imageUrl).length,
        clipCount: Object.keys(rowVideoClips).length,
        overlayCount: Object.keys(rowOverlays).length,
        err: err instanceof Error ? err.message : err,
      });
      try {
        localStorage.setItem('prodoc_last_result', JSON.stringify({
          doc: slimDoc, rowImages, rowVideoClips, historyEntryId, savedAt: Date.now(),
        }));
      } catch {
        try {
          localStorage.setItem('prodoc_last_result', JSON.stringify({
            doc: slimDoc, rowImages, historyEntryId, savedAt: Date.now(),
          }));
          persistFailed = true; // partial — clips + overlays not in bundle
        } catch {
          persistFailed = true; // total failure
        }
      }
      if (!quotaWarnedRef.current) {
        quotaWarnedRef.current = true;
        toast.warning(
          `Browser storage is full (${Math.round(JSON.stringify(bundle).length / 1024)} KB doc). ` +
          'Click your doc in the history sidebar to reload it from the server. ' +
          'Or start a New Session to free space from older docs.',
          { duration: 14000 },
        );
      }
    }
    if (persistFailed) {
      console.info('[persist quota] partial bundle saved without overlays/clips', {
        rowImagesCount: rowImages.length,
        overlayCount: Object.keys(rowOverlays).length,
        clipCount: Object.keys(rowVideoClips).length,
      });
    }
    // Also patch the current history entry so EVERY generated asset
    // survives on restore — images, overlays, AND clip ids. Previously
    // only `rowImages` was persisted here; overlays + clips were lost
    // the moment the user clicked the entry from the sidebar (the
    // sidebar restore zeroed both maps). See plan
    // `_plans/2026-05-17-render-state-hardening.md`.
    if (historyEntryId && doc?.rows?.length) {
      const imgMap: Record<number, string> = {};
      rowImages.forEach((r, i) => { if (r?.imageUrl) imgMap[i] = r.imageUrl; });

      // Overlays: persist the whole resolved state ({status, url}) per
      // row index. Only rows whose status is meaningful get an entry
      // (skip pure 'idle' rows — they round-trip as missing).
      const overlayMap: Record<number, { status: string; url?: string }> = {};
      Object.entries(rowOverlays).forEach(([k, v]) => {
        const i = Number(k);
        if (!Number.isFinite(i) || !v) return;
        overlayMap[i] = { status: v.status, url: v.url };
      });

      // Clips: persist only the clip id per row. The actual videoUrl is
      // re-fetched on restore from `/api/broll/{id}` via BrollCell's
      // mount-hydration. Storing the id (not the url) keeps the entry
      // small AND auto-refreshes the url if it ever rotates server-side.
      // We need the id from BrollCell's localStorage map, not from
      // `rowVideoClips` (which only has status+videoUrl). Rebuild the
      // (rowIndex → clipId) map from rowSignature lookups.
      const clipMap: Record<number, string> = {};
      const sigToClipId = readBrollLsMap();
      doc.rows.forEach((row, i) => {
        const sig = brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        });
        const clipId = sigToClipId[sig];
        if (clipId && rowVideoClips[i]?.status === 'ready') {
          clipMap[i] = clipId;
        }
      });

      const patch: Partial<import('@/lib/history').ProductionDocHistoryEntry> = {};
      if (Object.keys(imgMap).length > 0) patch.rowImages = imgMap;
      if (Object.keys(overlayMap).length > 0) patch.rowOverlays = overlayMap;
      if (Object.keys(clipMap).length > 0) patch.rowVideoClips = clipMap;
      if (Object.keys(patch).length > 0) {
        // 2026-06-04: cache-only. The canonical save path
        // (persistRowAsset → /api/edit/[id]/row-asset for assets;
        // persistDoc → /api/edit/[id] for everything else) is the
        // server source of truth. Routing this through the legacy
        // /api/history/[id] PATCH would do `UPDATE payload = ${...
        // cache[idx], ...patch}` and any stale fields in the cached
        // entry (older doc snapshot, missing paint_explainer_v1
        // settings, missing flags) would clobber the canonical row.
        // That was the silent wipe behind the "I clicked Open in
        // editor and my doc came back empty" report.
        updateProductionDocEntryCacheOnly(historyEntryId, patch).catch(() => {});
      }
    }
  }, [doc, rowImages, rowOverlays, rowVideoClips, historyEntryId]);

  // Auto-scroll log to bottom when new entries are added
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [generationLog.length]);

  // — Autocomplete hints
  const [nicheHints, setNicheHints] = useState<string[]>([]);
  const [topicHints, setTopicHints] = useState<string[]>([]);

  // — Google Sheets export
  const [sheetsExporting, setSheetsExporting] = useState(false);
  const [sheetsUrl, setSheetsUrl] = useState<string | null>(null);

  // — Video preview & render
  const [showVideoPreview, setShowVideoPreview] = useState(false);
  const [voiceoverUrl, setVoiceoverUrl] = useState('');
  // Legacy localStorage-driven quick-tweak bar — kept so existing
  // workspace-wide brand presets still work. New channel kit + per-doc
  // override take precedence as base; this state spreads on top for
  // last-mile tweaks via VideoPreviewBrandBar.
  const [brandKit, setBrandKit] = useState<Partial<BrandKit>>(DEFAULT_BRAND);
  // — Channel-level visual brand kit (fonts, colors, logo, channel name).
  //   Fetched once on mount when an active channel is pinned; null
  //   otherwise (no channel → renderer falls through to DEFAULT_BRAND_KIT).
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [channelVisualKit, setChannelVisualKit] = useState<ChannelVisualBrandKit | null>(null);
  // — Per-doc override: persists on the production_doc history entry so
  //   it follows the doc across devices and restores cleanly. Default is
  //   the empty kit { v: 1 } — every field falls through to channel.
  const [visualKitOverride, setVisualKitOverride] = useState<ChannelVisualBrandKit>({ v: 1 });
  const [renderId, setRenderId] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  // The "Download MP4" URL — a presigned R2/S3 URL with `response-
  // content-disposition: attachment` baked in so the browser streams
  // direct from storage (no /api/download-proxy hop → no 300s Vercel
  // function cap on multi-GB downloads).
  const [renderDownloadUrl, setRenderDownloadUrl] = useState<string | null>(null);
  // Phase 0 telemetry: a one-time post-render survey asking whether
  // the creator plans to finish in CapCut / Premiere / elsewhere, or
  // stay in this app. Drives the shot-graph editor build decision
  // (see _plans/2026-05-18-shot-graph-editor.md). Resets when a new
  // render starts so a fresh `done` shows the survey again.
  const [renderSurveyDismissed, setRenderSurveyDismissed] = useState(false);
  // "Open in editor" navigation guard. The button awaits a `project.flush()`
  // before pushing /edit/[id] so the editor's server-side `loadProject`
  // can't race a pending debounced save. Without this, the user reported
  // editor opening 404 / empty + the production-doc round-tripping to a
  // wiped state. See useProject.beforeunload — its 64 KB keepalive cap
  // can't carry full paint_explainer_v1 payloads.
  const [openingEditor, setOpeningEditor] = useState(false);
  // Server-save failure banner (2026-06-04). Driven by:
  //   - HistorySaveError thrown from saveProductionDocEntry — no_session /
  //     unauthorized / rejected. Banner is persistent (no auto-dismiss);
  //     blocks "Open in editor" because there's no historyEntryId.
  //   - 'queued_offline' kind — server returned 5xx (or network blip),
  //     entry queued in __history_pending__. Softer copy because drain
  //     on next list fetch resurrects to a real UUID.
  // Never null on a real save failure — the design contract is "fail
  // visibly, never silently degrade". See _plans/2026-06-04-prevent-
  // production-doc-silent-loss.md.
  const [saveFailure, setSaveFailure] = useState<
    | {
        kind:
          | 'no_session'
          | 'unauthorized'
          | 'rejected'
          | 'queued_offline'
          | 'mid_session_error';
        message: string;
        retrying: boolean;
      }
    | null
  >(null);
  // Holds the most-recent saveProductionDocEntry payload so the banner's
  // Retry button can re-issue the exact same save without rebuilding
  // it from current page state (which may have diverged since the
  // failed attempt — banner retry should ship what the user thought
  // they saved, not a moving target).
  const pendingSavePayloadRef = useRef<Parameters<typeof saveProductionDocEntry>[0] | null>(null);

  // Mid-session canonical-save watchdog (2026-06-04). useProject's
  // saveStatus pill is easy to miss. When the auto-save PATCH errors
  // and stays errored for 5+ seconds (transient flickers like a
  // network blip that resolves under a second don't qualify), promote
  // it to the persistent banner so the user can't keep editing into a
  // void.
  //
  // Why 5s: useProject debounces saves at 800 ms; a typical failure
  // resolves in <2 s once the network comes back. 5 s is long enough
  // to skip the flickers AND short enough that a real outage shows
  // immediately in editing-speed terms.
  //
  // Initial-save failures (no_session / unauthorized / rejected /
  // queued_offline) take priority over mid-session errors — we don't
  // want to overwrite a "you must sign in" banner with a generic
  // "save failed" while the underlying problem is the auth.
  useEffect(() => {
    // Initial-save failures (no_session / unauthorized / rejected /
    // queued_offline) take priority over mid-session errors — we
    // don't want to overwrite a "you must sign in" banner with a
    // generic "save failed" while the underlying problem is the auth.
    const initialFailureActive =
      saveFailure !== null && saveFailure.kind !== 'mid_session_error';
    if (initialFailureActive) return;

    if (project.saveStatus.kind === 'error') {
      const reason = project.saveStatus.message || 'Network error';
      const timer = setTimeout(() => {
        console.warn('[doc-save mid-session] escalating to banner', { reason });
        setSaveFailure({
          kind: 'mid_session_error',
          message: `Your recent edits couldn't reach the server: ${reason}. Click Retry to flush the pending save, or fix your connection and the auto-save will resume.`,
          retrying: false,
        });
      }, 5000);
      return () => clearTimeout(timer);
    }

    if (project.saveStatus.kind === 'saved' || project.saveStatus.kind === 'idle') {
      // Auto-clear the mid-session banner once a save lands cleanly.
      // Conflict banners stay until the user explicitly Reloads or
      // Continues — different recovery semantics.
      if (saveFailure?.kind === 'mid_session_error') {
        console.info('[doc-save mid-session] cleared by successful save');
        setSaveFailure(null);
      }
    }
  }, [project.saveStatus, saveFailure]);

  // Banner's primary action. Behavior splits by failure kind:
  //   - Initial-save kinds (no_session / unauthorized / rejected /
  //     queued_offline) — reissue saveProductionDocEntry with the
  //     cached payload from the failed attempt.
  //   - mid_session_error — flush the useProject autosave timer to
  //     retry the most-recent canonical PATCH now (vs. waiting for
  //     the 800 ms debounce + next user keystroke).
  // mid_session_conflict is handled by the existing yellow conflict
  // banner driven by `project.saveStatus.kind === 'conflict'` below.
  const retryProductionDocSave = useCallback(async (): Promise<void> => {
    const currentFailure = saveFailureRef.current;
    if (!currentFailure) return;

    setSaveFailure((prev) => (prev ? { ...prev, retrying: true } : prev));

    if (currentFailure.kind === 'mid_session_error') {
      console.info('[doc-save retry] flushing canonical save');
      try {
        const result = await projectRef.current.flush();
        console.info('[doc-save retry] flush result', { kind: result.kind });
        if (result.kind === 'saved' || result.kind === 'no_op') {
          setSaveFailure(null);
          toast.success('Saved to server.');
        } else if (result.kind === 'error') {
          setSaveFailure({
            kind: 'mid_session_error',
            message: `Still couldn't reach the server: ${result.message}. Check your connection and retry.`,
            retrying: false,
          });
        } else if (result.kind === 'conflict') {
          // Hand off to the existing conflict banner — useProject's
          // saveStatus is already 'conflict'.
          setSaveFailure(null);
        } else if (result.kind === 'gone') {
          setSaveFailure({
            kind: 'rejected',
            message: 'The server says this project was deleted. Your work is still in memory; generate a fresh doc to restart.',
            retrying: false,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setSaveFailure({ kind: 'mid_session_error', message: msg, retrying: false });
      }
      return;
    }

    // Initial-save retry path.
    const payload = pendingSavePayloadRef.current;
    if (!payload) {
      setSaveFailure(null);
      return;
    }
    console.info('[doc-save retry] reissuing initial save');
    try {
      const entry = await saveProductionDocEntry(payload);
      if (isUuid(entry.id)) {
        setHistoryEntryId(entry.id);
        setHistoryItems((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)]);
        setSaveFailure(null);
        toast.success('Saved to server.');
        console.info('[doc-save retry] committed', { id: entry.id });
      } else {
        setSaveFailure({
          kind: 'queued_offline',
          message:
            "Still couldn't reach the server. Your work stays queued; click Retry to try once more, or reload the page to drain the queue.",
          retrying: false,
        });
        setHistoryItems((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)]);
        console.warn('[doc-save retry] still queued', { syntheticId: entry.id });
      }
    } catch (err) {
      if (err instanceof HistorySaveError) {
        setSaveFailure({ kind: err.kind, message: err.message, retrying: false });
        console.warn('[doc-save retry] failed', { kind: err.kind, status: err.httpStatus });
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setSaveFailure({ kind: 'rejected', message: msg, retrying: false });
        console.warn('[doc-save retry] threw', { msg });
      }
    }
  }, []);

  // Stable ref to saveFailure for the retry callback (which has []
  // deps so it doesn't recreate per render and lose its event listeners).
  const saveFailureRef = useRef(saveFailure);
  saveFailureRef.current = saveFailure;
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // One-shot guard: surface the localStorage-quota toast at most once per
  // session so a tight render-typing-render loop doesn't spam the user.
  // The flag resets on hard reload, which is the natural moment to
  // re-warn if the problem persists. See plan
  // `_plans/2026-05-17-render-state-hardening.md`.
  const quotaWarnedRef = useRef(false);
  // Mirror of the three asset-state slices the renderer reads from.
  // `executeRender` is a stable function reference (declared once per
  // render) but may be CALLED later — from the missing-clips modal,
  // after the user reloads — at which point the closure-captured state
  // is stale relative to the fresh state from `handleBrollClipChange`.
  // Reading through these refs guarantees we send the freshest values
  // to the server. See `_plans/2026-05-17-render-state-hardening.md`.
  const rowVideoClipsRef = useRef<Record<number, { status: string; videoUrl?: string } | null>>({});
  // `rowImagesRef` is declared earlier in this component (before the
  // generateVariantImage writer block) so that callback can read the
  // freshest rowImages without the setState-callback snapshot trick
  // (which is unreliable when React batches multiple variant Generate
  // clicks fired in quick succession — variant 2 would see an empty
  // base because variant 1's setState batch hadn't flushed yet).
  const rowOverlaysRef = useRef<Record<number, RowOverlayState>>({});

  // — Voiceover-aligned scene timing (per _plans/2026-05-13-voiceover-aligned-scene-timing.md)
  // Mirrors the four-state pill near the Render button: idle → syncing →
  // ready (success) | stale (drift > 20% after a prior alignment) |
  // failed (server returned a reason) | unsupported (voiceover URL isn't
  // a same-origin proxy path).
  type AlignmentPillStatus = 'idle' | 'syncing' | 'ready' | 'stale' | 'failed' | 'unsupported';
  const [alignmentStatus, setAlignmentStatus] = useState<AlignmentPillStatus>('idle');
  const [alignmentDetail, setAlignmentDetail] = useState<string | null>(null);
  // The actual word-level alignment payload from ElevenLabs. Stored
  // here so the in-browser preview (VideoPlayerMemo) can pass it into
  // `productionDocToVideoConfig` — without this, the preview falls back
  // to estimated timecodes and the narration drifts against the frames.
  // The render route gets the alignment via a different code path
  // (server-side cache lookup, see `body.voiceoverAlignment`), but the
  // preview is a pure-client build, so it needs the data in state.
  // See `_plans/2026-05-17-render-state-hardening.md`.
  const [voiceoverAlignment, setVoiceoverAlignment] =
    useState<import('@/lib/elevenlabs').ForcedAlignmentResponse | null>(null);
  // `alignedAtScript` is the canonical script frozen at the moment of
  // the last successful alignment. The drift check compares it against
  // the current script to decide whether soft re-align is enough or a
  // fresh API call is needed.
  const [alignedAtScript, setAlignedAtScript] = useState<string | null>(null);
  const alignmentReqRef = useRef(0);

  // ─── Canonical payload autosave (Phase 2 parity refactor) ────────
  //
  // Mirrors every canonical field — including the ones the legacy
  // autosave above never wrote (voiceoverUrl, voiceoverAlignment,
  // brandKitOverride, channelId, all four flags) — into
  // `project.patch`. The hook handles debouncing, optimistic version
  // check, and conflict surfacing internally.
  //
  // Deps list is exhaustive: every canonical source-of-truth field
  // the editor needs to receive. Adding a new persisted field?
  // Add it to the ProjectPayload type, the patch body below, and
  // this deps list.
  // Cache the two project fields we read so the effect's deps list
  // doesn't reference the whole `project` object. `useProject` returns
  // a fresh object literal every render; depending on `project` would
  // fire this effect every render and continuously reset the hook's
  // 800 ms debounce timer, so saves would never land. `patch` is a
  // stable useCallback inside the hook (verified — empty deps), and
  // `payload` updates only on real state changes.
  const projectPatch = project.patch;
  const projectPayload = project.payload;
  // 2026-05-20: keep projectPayload OUT of the mirroring effect's
  // dep array (otherwise calling projectPatch inside the effect
  // changes payload identity, which re-fires the effect, which
  // calls projectPatch again — Maximum update depth exceeded). Read
  // fallback values through a ref instead so the effect responds
  // ONLY to real UI state changes.
  const projectPayloadRef = useRef(projectPayload);
  projectPayloadRef.current = projectPayload;
  useEffect(() => {
    if (!historyEntryId) return;
    // Wait until the hook's initial GET has resolved. Patching before
    // the hook knows the row's current version triggers a no-op
    // (the hook bails when payload is null), but checking here keeps
    // the [project payload save] client log honest about when we
    // actually start writing.
    const currentPayload = projectPayloadRef.current;
    if (!currentPayload) return;

    // rowImages: legacy autosave wrote `rowImages` as `RowImageState[]`
    // — the canonical shape is `Record<number, string>`. Build the
    // index-keyed map from the array form so the editor gets a clean
    // payload regardless of which client wrote last.
    const rowImagesMap: Record<number, string> = {};
    rowImages.forEach((r, i) => {
      if (r?.imageUrl) rowImagesMap[i] = r.imageUrl;
    });

    // rowOverlays: trim transient UI state (`loading`, `idle`) — the
    // editor only renders entries whose status is `done` or `skipped`,
    // and persisting in-flight states would resurrect them across
    // page reloads.
    const rowOverlaysMap: Record<number, { status: string; url?: string }> = {};
    Object.entries(rowOverlays).forEach(([k, v]) => {
      if (!v) return;
      const i = Number(k);
      if (!Number.isFinite(i)) return;
      if (v.status === 'loading' || v.status === 'idle') return;
      rowOverlaysMap[i] = { status: v.status, url: v.url };
    });

    // rowVideoClips: persist the canonical {status, videoUrl, durationSeconds}
    // shape directly. The legacy autosave writes a clip-id-only map
    // through updateProductionDocEntry; this effect writes the richer
    // shape so the editor can play the clip without rehydrating from
    // /api/broll/{id}.
    const rowVideoClipsMap: Record<number, RowVideoClipState> = {};
    Object.entries(rowVideoClips).forEach(([k, v]) => {
      if (!v) return;
      const i = Number(k);
      if (!Number.isFinite(i)) return;
      rowVideoClipsMap[i] = {
        status: v.status,
        videoUrl: v.videoUrl,
        durationSeconds: v.durationSeconds,
      };
    });

    // rowLockedAsStill: legacy state is keyed by row signature; the
    // canonical shape is index-keyed. Walk the doc to remap.
    const rowLockedAsStill: Record<number, boolean> = {};
    if (doc?.rows) {
      doc.rows.forEach((row, i) => {
        const sig = brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        });
        if (rowLockSignatures[sig]) rowLockedAsStill[i] = true;
      });
    }

    // Batch A of parity-batches: fill the linked-id fields the editor's
    // voiceover picker needs for auto-match. `linkedProjectId` is the
    // `projects.id` (NOT the user_history.id), resolved either from the
    // URL handoff or from the schedule item the doc was generated from.
    // `linkedScheduleItemId` is the strongest match signal — narrator
    // assignments cross-reference it via `schedule_items.custom_fields`.
    const linkedProjectId = projectIdParam || scheduleItem?.project_id || undefined;
    const linkedScheduleItemId = scheduleItemId || scheduleItem?.id || undefined;

    // Only persist visualKitOverride when the user has actually
    // customized something; the default state is `{ v: 1 }` with no
    // override fields set, and writing that as the canonical
    // override would confuse the editor's "is overridden?" checks.
    const visualKitOverrideKeys = Object.keys(visualKitOverride).filter(
      (k) => k !== 'v' && (visualKitOverride as unknown as Record<string, unknown>)[k] !== undefined,
    );
    const visualKitOverrideToSave = visualKitOverrideKeys.length > 0 ? visualKitOverride : undefined;

    projectPatch({
      title: doc?.title || currentPayload.title,
      doc: doc ?? currentPayload.doc,
      rowImages: rowImagesMap,
      rowOverlays: rowOverlaysMap,
      rowVideoClips: rowVideoClipsMap,
      voiceoverUrl: voiceoverUrl || undefined,
      voiceoverAlignment: voiceoverAlignment ?? undefined,
      channelId: activeChannelId ?? undefined,
      linkedProjectId,
      linkedScheduleItemId,
      visualKitOverride: visualKitOverrideToSave,
      flags: {
        animateScenes,
        suppressLowerThirds,
        overlaysDisabled: doc?.overlays_disabled === true,
        rowLockedAsStill,
      },
    });
    // projectPayload deliberately NOT in the deps — read via
    // projectPayloadRef above. Including it would close the
    // setState → re-render → effect → setState loop that produced
    // "Maximum update depth exceeded" earlier today. 2026-05-20.
  }, [
    historyEntryId,
    projectPatch,
    doc,
    rowImages,
    rowOverlays,
    rowVideoClips,
    voiceoverUrl,
    voiceoverAlignment,
    activeChannelId,
    animateScenes,
    suppressLowerThirds,
    rowLockSignatures,
    projectIdParam,
    scheduleItemId,
    scheduleItem,
    visualKitOverride,
  ]);

  // Load brand kit from localStorage on client only. The voiceover URL is
  // handled by <VoiceoverPicker>, which fetches the library, picks the best
  // match for this video (schedule item → title → most recent), and yields
  // a URL through onChange. Centralising that logic in the picker keeps the
  // page free of stale "latest" prefills when the doc is actually for a
  // different video.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('video_brand_kit') || '{}') as Partial<BrandKit>;
      if (stored.primaryColor) setBrandKit(b => ({ ...b, ...stored }));
    } catch { /* ignore */ }
  }, []);

  // ── Lazy draft-project creation for voiceover upload / save-to-library ─
  //
  // The Video Preview & Render voiceover picker needs a `projects.id` to
  // scope `media_assets`. When the user opens a fresh production-doc that
  // isn't linked to a project yet, this callback creates one on demand —
  // triggered by the picker's `onRequireProject` prop — so the upload
  // path is never blocked by a "save first" wall. Title falls back through
  // `doc.title → topic → niche → 'Untitled production doc'` so the create
  // works in every realistic state. URL is updated via `router.replace`
  // so a reload preserves the linkage. See
  // `_plans/2026-05-27-voiceover-upload-without-saved-project.md`.
  const ensureProjectForVoiceover = useCallback(async (): Promise<string | null> => {
    const existing = scheduleItem?.project_id ?? projectIdParam;
    if (existing) return existing;
    const title = (doc?.title || topic || niche || 'Untitled production doc').trim();
    try {
      // eslint-disable-next-line no-restricted-syntax -- awaited POST that returns the new project — RPC, not fire-and-forget
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, niche, topic }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error ? String(data.error) : `Create failed (${res.status})`;
        toast.error(`Could not create a project for this voiceover: ${msg}`);
        return null;
      }
      const { project } = (await res.json()) as { project?: { id?: string } };
      if (!project?.id) {
        toast.error('Could not create a project for this voiceover');
        return null;
      }
      const params = new URLSearchParams(search.toString());
      params.set('projectId', project.id);
      router.replace(`/production-doc?${params.toString()}`);
      toast.success('Created a draft project for this doc');
      return project.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      toast.error(`Could not create a project for this voiceover: ${msg}`);
      return null;
    }
  }, [scheduleItem?.project_id, projectIdParam, doc?.title, topic, niche, search, router]);

  // ── Fetch the active channel + its visual brand kit on mount ───────────
  //
  // Two hops: GET /api/user/settings/active-channel → channel id, then
  // GET /api/channels/[id]/visual-brand-kit → kit. Both are silently
  // ignored on failure (default kit applies). The kit is read-only here;
  // changes happen on the channel settings page.
  useEffect(() => {
    let cancelled = false;
    async function loadChannelKit() {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, loads active-channel
        const acRes = await fetch('/api/user/settings/active-channel');
        if (!acRes.ok) return;
        const ac = (await acRes.json()) as { active_channel_id: string | null };
        if (cancelled || !ac.active_channel_id) return;
        setActiveChannelId(ac.active_channel_id);
        // eslint-disable-next-line no-restricted-syntax -- GET, loads brand kit
        const kitRes = await fetch(`/api/channels/${ac.active_channel_id}/visual-brand-kit`);
        if (cancelled || !kitRes.ok) return;
        const { visual_brand_kit } = (await kitRes.json()) as {
          visual_brand_kit: ChannelVisualBrandKit;
        };
        setChannelVisualKit(visual_brand_kit);
      } catch { /* ignore — falls through to DEFAULT_BRAND_KIT */ }
    }
    void loadChannelKit();
    return () => { cancelled = true; };
  }, []);

  // ── Persist the per-doc override onto the legacy history-entry cache
  //    whenever it changes. Cache-only — server persistence runs through
  //    the canonical path in `handleVisualKitOverrideChange` below, fired
  //    only on real user mutations. NEVER PATCHes the server here; the
  //    legacy /api/history/[id] PATCH would do `UPDATE payload = {...
  //    cache[idx], ...patch}` and any stale cache field (older doc,
  //    missing flags) would clobber the canonical row.
  useEffect(() => {
    if (!historyEntryId) return;
    updateProductionDocEntryCacheOnly(historyEntryId, {
      visualBrandKitOverride: visualKitOverride,
    }).catch(() => { /* ignore */ });
  }, [historyEntryId, visualKitOverride]);

  // Wraps `setVisualKitOverride` for the brand-kit panel's `onChange`.
  // Routes the canonical save through `project.patch` so /edit/[projectId]
  // reads the latest override on reload. Keeping this on the user-action
  // path (instead of the [visualKitOverride] effect above) avoids the
  // hydration setVisualKitOverride from triggering a redundant server
  // save — the hydration path doesn't need a save round-trip because
  // the server already has the value we just read.
  const handleVisualKitOverrideChange = useCallback(
    (next: ChannelVisualBrandKit): void => {
      setVisualKitOverride(next);
      if (projectRef.current.payload) {
        projectRef.current.patch({ visualKitOverride: next });
      }
    },
    [],
  );

  // ── Compute the merged BrandKit for every render-time consumer.
  //    Order: DEFAULT_BRAND_KIT ← channel ← override ← legacy bar.
  //    The legacy bar (VideoPreviewBrandBar's localStorage state) stays
  //    on top so users who only ever used the quick-tweak still see
  //    their colors take effect.
  const effectiveBrandKit = React.useMemo<Partial<BrandKit>>(
    () => ({
      ...resolveBrandKitForRender(channelVisualKit, visualKitOverride),
      ...brandKit,
    }),
    [channelVisualKit, visualKitOverride, brandKit],
  );

  // Load prefill from generator / QA pages. Functional setters so a
  // schedule-link prefill that resolved first isn't clobbered by stale
  // localStorage from an earlier handoff.
  //
  // Niche hints are seeded from BOTH recent-history (localStorage) and
  // the workspace's configured Settings → Niches list. A user-facing
  // gap (raised 2026-05-26) was that the autocomplete only showed
  // recently-typed niches, never the deliberate list set up in
  // /settings — so configured niches were invisible here. Pulling
  // /api/niches deduplicates against the recent set.
  useEffect(() => {
    const recent = getRecentNiches();
    setNicheHints(recent);
    setTopicHints(getRecentTopics());
    // Augment with workspace-configured niches. Best-effort: failures
    // leave the recent-history list as-is. The deduplication preserves
    // recent ordering (recent first) and appends any configured niches
    // not already present.
    // eslint-disable-next-line no-restricted-syntax -- GET .then, loads niches list
    fetch('/api/niches')
      .then(r => (r.ok ? r.json() : null))
      .then((data: { niches?: Array<{ name?: string; is_active?: boolean }> } | null) => {
        if (!data || !Array.isArray(data.niches)) return;
        const configured = data.niches
          .filter(n => n.is_active !== false)
          .map(n => (n.name ?? '').trim())
          .filter(n => n.length > 0);
        if (configured.length === 0) return;
        const seen = new Set(recent.map(n => n.toLowerCase()));
        const additions = configured.filter(n => !seen.has(n.toLowerCase()));
        if (additions.length > 0) {
          setNicheHints([...recent, ...additions]);
        }
      })
      .catch(() => { /* best-effort */ });
    try {
      const raw = localStorage.getItem('prodoc_prefill');
      if (raw) {
        localStorage.removeItem('prodoc_prefill');
        const data = JSON.parse(raw);
        if (data.script) setScript(curr => curr || data.script);
        if (data.niche)  setNiche(curr => curr || data.niche);
        if (data.topic)  setTopic(curr => curr || data.topic);
      }
    } catch { /* ignore */ }
  }, []);

  // ── YouTube reference helpers

  async function analyzeYouTubeStyle(url: string, idx: number) {
    setVisualRefs(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], analyzing: true };
      return next;
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- analyze RPC: awaits and uses response
      const res = await fetch('/api/analyze/youtube-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ youtubeUrl: url }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Analysis failed');
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          analyzing: false,
          title: (data.title as string) || undefined,
          channelTitle: (data.channelTitle as string) || undefined,
          analyzedStyle: data.styleDescription as string,
        };
        return next;
      });
      if (data.styleDescription) {
        setCreativeBrief(prev => {
          const label = (data.title as string) || url;
          const tag = `[YouTube ref "${label}": ${data.styleDescription}]`;
          return prev ? `${prev}\n\n${tag}` : tag;
        });
        toast.success('Visual style extracted from YouTube video');
      }
    } catch (err) {
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analysisFailed: true };
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'YouTube style analysis failed');
    }
  }

  function addYtRef() {
    const id = extractYouTubeId(ytRefInput);
    if (!id) { toast.error('Invalid YouTube URL'); return; }
    const canonical = `https://www.youtube.com/watch?v=${id}`;
    if (visualRefs.some(r => r.type === 'youtube' && r.url === canonical)) { toast.error('Already added'); return; }
    // Capture index before state update — safe because we only ever append
    const newIdx = visualRefs.length;
    setVisualRefs(prev => [...prev, { type: 'youtube' as const, url: canonical }]);
    setYtRefInput('');
    // Analyze outside the state updater to avoid side-effects in a pure function
    analyzeYouTubeStyle(canonical, newIdx);
  }

  // Takes the base64 + mediaType directly so the bytes never have to be
  // retained in component state. Caller has them transiently from the
  // FileReader; once this call resolves they're gone.
  async function analyzeScreenshot(base64: string, mediaType: string, idx: number) {
    setVisualRefs(prev => {
      if (!prev[idx]) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], analyzing: true };
      return next;
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- analyze RPC: awaits and uses response
      const res = await fetch('/api/analyze/image-style', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mediaType }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || 'Analysis failed');
      setVisualRefs(prev => {
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analyzedStyle: data.description as string };
        return next;
      });
      // Append to creative brief
      if (data.description) {
        setCreativeBrief(prev => {
          const tag = `[Screenshot style: ${data.description}]`;
          return prev ? `${prev}\n\n${tag}` : tag;
        });
        toast.success('Style extracted from screenshot and added to creative brief');
      }
    } catch (err) {
      setVisualRefs(prev => {
        if (!prev[idx]) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], analyzing: false, analysisFailed: true };
        return next;
      });
      toast.error(err instanceof Error ? err.message : 'Style analysis failed');
    }
  }

  function handleScreenshotUpload(files: FileList | null) {
    if (!files) return;
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) { toast.error('Only image files are supported'); return; }
      if (file.size > 5 * 1024 * 1024) { toast.error('Image must be under 5 MB'); return; }
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target?.result as string;
        const base64 = dataUrl?.split(',')[1];
        if (!base64) { toast.error('Failed to read image'); return; }
        // `objectUrl` is the small string we store for display. The base64
        // we just extracted stays in this closure only — we hand it to the
        // analyze API and then it falls out of scope.
        const objectUrl = URL.createObjectURL(file);
        const newRef: VisualRef = {
          type: 'screenshot',
          objectUrl,
          mediaType: file.type,
          name: file.name,
        };
        // Capture the index inside the updater so concurrent uploads
        // don't all collide on a stale `visualRefs.length` snapshot.
        // queueMicrotask defers the analyze call until after React's
        // commit so we don't kick off a side effect during render.
        setVisualRefs(prev => {
          const newIdx = prev.length;
          queueMicrotask(() => { void analyzeScreenshot(base64, file.type, newIdx); });
          return [...prev, newRef];
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Per-row image generation

  /**
   * Cache a saliency map on a row and re-resolve overlay placement against
   * it. The renderer prefers `*_resolved` over the LLM's blind picks, so
   * applying saliency after image generation / upload / edit lets overlays
   * land on empty pixels instead of focal content.
   *
   * Best-effort — if there's no saliency, `*_resolved` stays untouched
   * and the renderer falls back to the LLM zone. Single place to update
   * the doc state so generate / upload / edit all converge on one path.
   */
  function applySaliencyToRow(rowIndex: number, saliency: ImageSaliencyMap) {
    setDoc(prev => {
      if (!prev) return prev;
      const nextRows = [...prev.rows];
      const row = nextRows[rowIndex];
      if (!row) return prev;
      let zoneResolved = row.overlay_zone_resolved;
      let sizeResolved = row.overlay_size_resolved;
      if (row.overlay_zone && row.overlay_size) {
        const stripeOverlapsScene =
          Boolean(row.section_title?.trim()) &&
          (row.section_title_layout ?? 'letterbox') === 'overlay';
        const placement = resolveOverlayPlacement({
          llmZone: row.overlay_zone,
          llmSize: row.overlay_size,
          saliency,
          hasSectionTitle: Boolean(row.section_title?.trim()),
          stripeOverlapsScene,
        });
        console.info('[overlay placement] resolved', {
          rowIndex,
          llmZone: row.overlay_zone,
          finalZone: placement.zone,
          llmSize: row.overlay_size,
          finalSize: placement.size,
          reason: placement.reason,
        });
        zoneResolved = placement.zone;
        sizeResolved = placement.size;
      }
      nextRows[rowIndex] = {
        ...row,
        image_saliency: saliency,
        overlay_zone_resolved: zoneResolved,
        overlay_size_resolved: sizeResolved,
      };
      return { ...prev, rows: nextRows };
    });
  }

  /**
   * Compute saliency for an image URL by calling the saliency endpoint.
   * Silent on failure — overlay placement falls back to the LLM zone.
   * Used by upload + URL import paths where the generator route didn't
   * already return a saliency map alongside the image.
   */
  async function runSaliencyForRow(rowIndex: number, imageUrl: string) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- saliency RPC: awaits and uses response
      const res = await fetch('/api/images/saliency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl }),
      });
      if (!res.ok) return;
      const data = await res.json() as { saliency?: ImageSaliencyMap | null };
      if (data.saliency) applySaliencyToRow(rowIndex, data.saliency);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Attach a locally-selected image to a row. Goes browser → R2 via a
   * presigned PUT to bypass Vercel's 4.5 MB API body cap. On success the
   * row's image state flips to `done` with `source: 'upload'`, and
   * saliency is fetched in the background so overlay placement stays
   * sane.
   */
  async function uploadImageForRow(rowIndex: number, file: File): Promise<boolean> {
    if (!file.type.startsWith('image/')) {
      toast.error('Only image files are supported');
      return false;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be under 10 MB');
      return false;
    }
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'uploading' };
      return next;
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- presign RPC: awaits and uses response (upload URL)
      const presignRes = await fetch('/api/uploads/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }),
      });
      if (!presignRes.ok) {
        const errBody = await presignRes.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error || `Presign failed (${presignRes.status})`);
      }
      const { uploadUrl, downloadUrl } = await presignRes.json();
      // eslint-disable-next-line no-restricted-syntax -- PUT directly to presigned R2 URL — file upload, no app-level retry needed
      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`R2 upload failed (${putRes.status})`);
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: downloadUrl, source: 'upload' };
        return next;
      });
      void runSaliencyForRow(rowIndex, downloadUrl);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      toast.error(msg);
      // Drop back to idle on upload failure rather than 'error' — the
      // toast already carries the message, and idle restores the
      // three-button row so the user can pick a different recovery
      // path (try again, generate, paste a URL). The 'error' state's
      // Retry button calls onRetry which goes to GENERATE — not what
      // the user meant by retrying an upload.
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'idle' };
        return next;
      });
      return false;
    }
  }

  /**
   * Mirror an externally-hosted image into R2 (so the row's URL is stable
   * and CDN-served). The server-side fetch is DNS-rebinding-pinned via
   * `resolveAndPinSafeUrl` — see `/api/uploads/image-from-url`.
   */
  async function importImageUrlForRow(rowIndex: number, externalUrl: string): Promise<boolean> {
    const trimmed = externalUrl.trim();
    if (!trimmed) return false;
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'uploading' };
      return next;
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- upload-from-url RPC: awaits and uses response (mirror URL)
      const res = await fetch('/api/uploads/image-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: trimmed }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error((data.error as string) || `Failed (${res.status})`);
      const downloadUrl = data.imageUrl as string;
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'done', imageUrl: downloadUrl, source: 'url' };
        return next;
      });
      void runSaliencyForRow(rowIndex, downloadUrl);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'URL import failed';
      toast.error(msg);
      // Same reasoning as uploadImageForRow's catch — fall back to
      // idle so the user can pick a recovery path. The toast surfaces
      // the failure detail; the 'error' state's Retry would launch
      // generation, not retry the import.
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'idle' };
        return next;
      });
      return false;
    }
  }

  /**
   * Generate an edited image for a row without mutating its current image.
   * Returns the candidate URL + saliency on success so the caller (the
   * edit panel) can show before/after before the user commits.
   *
   * The `optionId` picks one row from the catalog in
   * `src/lib/image-edit-pricing.ts`. Mask-capable options need a
   * `maskUrl`; prompt-only options ignore it. `intent: 'erase'` lets the
   * route force its default Erase backend + server-generated prompt.
   *
   * The row's `RowImageState` is untouched here. Only `acceptEditForRow`
   * (called by the panel's "Use this" button) writes the result onto the
   * row.
   */
  async function editImageForRow(
    rowIndex: number,
    originalImageUrl: string,
    prompt: string,
    opts: { optionId?: string; maskUrl?: string; intent?: 'erase' } = {},
  ): Promise<{ ok: true; imageUrl: string; saliency: ImageSaliencyMap | null } | { ok: false; error: string }> {
    try {
      const res = await queueImageGen('edit', 'editor-edit', () =>
        // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
        fetch('/api/generate/production-doc/image/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalImageUrl,
            prompt,
            optionId: opts.optionId,
            mask: opts.maskUrl ? { url: opts.maskUrl } : undefined,
            intent: opts.intent,
          }),
        }),
      );
      if (res.status === 429) reportUpstream429('edit', 'editor-edit');
      const data = await safeJson(res);
      if (!res.ok) {
        return { ok: false, error: (data.error as string) || `Failed (${res.status})` };
      }
      console.info('[prodoc image-edit] success', {
        rowIndex,
        optionId: opts.optionId ?? 'default',
        intent: opts.intent ?? 'edit',
      });
      return {
        ok: true,
        imageUrl: data.imageUrl as string,
        saliency: (data.saliency ?? null) as ImageSaliencyMap | null,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Edit failed' };
    }
  }

  /**
   * Commit an edited image to a row. Called by the edit panel's "Use this"
   * button. Sets the row state + applies saliency the same way generate /
   * upload do, so the renderer picks up the new image immediately.
   */
  function acceptEditForRow(rowIndex: number, imageUrl: string, saliency: ImageSaliencyMap | null) {
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { status: 'done', imageUrl, source: 'edit' };
      return next;
    });
    if (saliency) applySaliencyToRow(rowIndex, saliency);
  }

  // Callers MUST pass `meta` from a source they already own (the `rows`
  // array driving the batch, or the row in JSX scope). We deliberately
  // do NOT fall back to reading `doc?.rows[rowIndex]` here: the auto
  // pipeline calls `setDoc(result)` and then `generateImages(result.rows)`
  // in the same synchronous tick, so React hasn't re-rendered and the
  // `doc` captured in this closure is still the previous value (often
  // null after the reset on `generate()`). Reading from `doc` here was
  // the source of "OST not baked / overlay not fetched" on every fresh
  // batch — see the bug fix commit for the full diagnosis.
  async function generateImageForRow(
    rowIndex: number,
    prompt: string,
    meta: {
      onScreenText?: string;
      /** Resolved OST mode (caller folds in doc-level default). When
       *  `'bake'`, the route bakes OST into the diffusion prompt; when
       *  `'overlay'` or `'none'`, the route generates the image clean
       *  and the LowerThird (or nothing) renders the text at composition
       *  time. See `_plans/2026-05-21-phase-5-text-mode-toggle.md`. */
      onScreenTextMode?: 'bake' | 'overlay' | 'none';
      sectionTitle?: string;
      /** Resolved layout for the row's section-title stripe (caller must
       *  fold in the doc-level default before calling). Drives the image
       *  canvas: 'letterbox' shrinks height to fit below the stripe;
       *  'overlay' keeps full 1920×1080. See
       *  `_plans/2026-05-21-resolution-aware-generation.md`. */
      sectionTitleLayout?: 'overlay' | 'letterbox';
      /** Phase 7 — when set, the local route fetches this URL and uploads
       *  it to ComfyUI as the i2i reference; the cloud route appends the
       *  `styleSheetDescription` to the prompt. Callers resolve via
       *  `resolveSheetReference(row, doc)` from `src/lib/style-sheet.ts`. */
      referenceImageUrl?: string;
      styleSheetDescription?: string;
      overlayStockTerms?: string;
      /** True when the doc-level "Auto-generate overlays" toggle is OFF
       *  OR this row has `skip_overlay: true`. Suppresses the post-
       *  image auto-fetch of the overlay PNG. Existing fetched overlays
       *  remain untouched; this only gates the trigger. Callers must
       *  resolve doc-level vs row-level in their own scope (the comment
       *  on the function explains why we can't read `doc` here). */
      skipOverlay?: boolean;
      /** v2 (2026-05-21): ids of ref images to drop from the dispatched
       *  call. Set when the user clicks "Regenerate without rejected
       *  refs" on the toast that fires after a 409 REFERENCE_REJECTED.
       *  The route's i2i dispatcher loads style refs server-side and
       *  excludes these ids before submitting to Kie / ComfyUI. */
      excludeRefIds?: string[];
      /** Phase 1.6 (Bug D): the row's `character_id` slug for the
       *  doodle_explainer_2 character cache. When the active style is
       *  doodle_explainer_2 AND this is set AND the doc already has a
       *  cached base image for this slug, the row is dispatched through
       *  Atlas Edit on the cached base ($0.011) instead of fresh i2i
       *  ($0.04). On miss-with-characterId, the successful i2i result
       *  is written into the cache as the canonical base for this
       *  character. See:
       *  _plans/2026-05-28-doodle-2-phase-1-6-completion.md (R-D). */
      characterId?: string;
      /** Phase 3 (scene cache): the row's `scene_id` slug — same
       *  dispatch shape as characterId but anchors a recurring
       *  LOCATION. When BOTH characterId and sceneId are set AND
       *  both have cache entries, the character path wins
       *  (precedence rule — see comment at the resolution site
       *  upstream). See:
       *  _plans/2026-05-28-doodle-2-scene-cache.md. */
      sceneId?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Circuit breaker check — when the persistence outbox is paused
    // (repeated drain failures), refuse new paid generations. The
    // image would render in the UI but its persist call would queue
    // into a broken pipe; better to surface the outage clearly than
    // burn provider credits on a write that can't land.
    const outbox = getOutboxState();
    if (outbox.breaker === 'open') {
      const secs = outbox.breakerReopenAt
        ? Math.max(0, Math.ceil((outbox.breakerReopenAt - Date.now()) / 1000))
        : 0;
      toast.error(
        `Saving is paused — retry in ${secs}s. New generations are blocked until your connection clears.`,
        { duration: 5000 },
      );
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'error', error: 'Saving paused (network outage)' };
        return next;
      });
      return false;
    }
    setRowImages(prev => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'loading' };
      return next;
    });
    const onScreenText = meta.onScreenText?.trim() || undefined;
    const onScreenTextMode = meta.onScreenTextMode;
    const sectionTitle = meta.sectionTitle?.trim() || undefined;
    const sectionTitleLayout = meta.sectionTitleLayout;
    const referenceImageUrl = meta.referenceImageUrl?.trim() || undefined;
    const styleSheetDescription = meta.styleSheetDescription?.trim() || undefined;
    const overlayTerms = meta.overlayStockTerms?.trim() || undefined;
    // Phase 1.6 (Bug D) — character-cache pre-check.
    //
    // When the active style is doodle_explainer_2 AND the row has a
    // character_id AND the doc has a cached base image for that slug,
    // dispatch through the existing Atlas Edit route (the same route
    // used by variant rows) with the cached base + a wrapped
    // continuation prompt. Cost ~$0.011 vs ~$0.04 for fresh i2i AND
    // character identity stays consistent across non-consecutive shots.
    //
    // Bulk-generate race: when several character-bearing rows kick off
    // in the same tick, all of them may read the cache as empty for the
    // first occurrence — they'll each run a fresh i2i and the second
    // write loses to `writeCharacterToCache`'s first-occurrence-wins
    // semantics. Result: one extra fresh i2i per concurrent burst, but
    // the cache settles correctly and subsequent rows hit. Acceptable
    // for V1 (plan open question #2).
    const characterId = meta.characterId?.trim() || undefined;
    const sceneId = meta.sceneId?.trim() || undefined;
    const isDoodleExplainer2 = stylePreset === 'doodle_explainer_2';
    const cachedBaseUrl = characterId
      ? getCachedCharacterBase(doc?.doodle_explainer_2_character_cache, characterId)
      : undefined;
    const useCharacterCache = isDoodleExplainer2 && Boolean(characterId) && Boolean(cachedBaseUrl);
    // Phase 3 (scene cache) — only consult the scene cache when the
    // character cache wouldn't fire on this row. Precedence rule: when
    // both are set AND both are cached, character wins because Atlas
    // Edit can preserve only one source-image's content per call and
    // character identity is the higher-stakes anchor (face / hair /
    // clothing drift is more visible than a slightly-different house).
    // Spec: _plans/2026-05-28-doodle-2-scene-cache.md.
    const cachedSceneBaseUrl =
      isDoodleExplainer2 && !useCharacterCache && sceneId
        ? getCachedSceneBase(doc?.doodle_explainer_2_scene_cache, sceneId)
        : undefined;
    const useSceneCache = isDoodleExplainer2 && Boolean(sceneId) && Boolean(cachedSceneBaseUrl) && !useCharacterCache;
    console.info('[prodoc image-gen] start', {
      rowIndex,
      hasOst: Boolean(onScreenText),
      onScreenTextMode: onScreenTextMode ?? null,
      hasSectionTitle: Boolean(sectionTitle),
      sectionTitleLayout: sectionTitleLayout ?? null,
      chainedToSheet: Boolean(referenceImageUrl),
      hasOverlayTerms: Boolean(overlayTerms),
      characterId: characterId ?? null,
      sceneId: sceneId ?? null,
      useCharacterCache,
      useSceneCache,
    });
    if (useCharacterCache) {
      console.info('[manual-editor character-cache] hit-and-edit', {
        rowIndex,
        characterId,
        cachedBaseUrl,
      });
      // Phase 2 (Character Bible) — wrap the scene body in the
      // character-continuation prompt, then prepend the bible so
      // non-anchored characters (Jennie + kids when George is the
      // anchor) render with consistent reference language even on
      // the cache-hit Atlas Edit path.
      const editPrompt = prependCharacterBible(
        buildCharacterContinuationEditPrompt(prompt),
        doc?.doodle_explainer_2_character_descriptions,
      );
      try {
        const res = await queueImageGen('edit', 'character-cache-hit', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC (abortable): awaits and uses response
          fetch('/api/generate/production-doc/image/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              originalImageUrl: cachedBaseUrl,
              prompt: editPrompt,
              optionId: 'gpt-image-2-atlas-edit',
            }),
          }),
        );
        if (res.status === 429) reportUpstream429('edit', 'character-cache-hit');
        const data = (await safeJson(res)) as {
          imageUrl?: string;
          saliency?: ImageSaliencyMap | null;
          error?: string;
        };
        if (res.ok && typeof data.imageUrl === 'string') {
          setRowImages((prev) => {
            const next = [...prev];
            next[rowIndex] = {
              status: 'done',
              imageUrl: data.imageUrl!,
              source: 'generated',
            };
            return next;
          });
          void persistRowAsset(rowIndex, 'image', data.imageUrl);
          if (data.saliency) applySaliencyToRow(rowIndex, data.saliency);
          if (overlayTerms && !meta.skipOverlay) {
            console.info('[prodoc image-gen] overlay queued', { rowIndex, overlayTerms });
            void fetchOverlayForRow(rowIndex, overlayTerms);
          }
          return true;
        }
        // Edit failed — drop through to the i2i path so the row still
        // ships. Matches the auto-pipeline's fallback behavior
        // (stage-handler logs `hit but edit failed, falling back to i2i`).
        console.warn('[manual-editor character-cache] edit-failed-fallback-to-i2i', {
          rowIndex,
          characterId,
          status: res.status,
          error: data.error,
        });
      } catch (err) {
        console.warn('[manual-editor character-cache] edit-failed-fallback-to-i2i (exception)', {
          rowIndex,
          characterId,
          message: err instanceof Error ? err.message : String(err),
        });
        // Drop through to i2i.
      }
    }
    if (useSceneCache && cachedSceneBaseUrl) {
      // Phase 3 — scene-cache hit path. Mirrors the character-cache
      // branch above but uses the scene-continuation prompt that
      // preserves location architecture / palette instead of
      // character face / hair. The cachedSceneBaseUrl resolution
      // upstream already enforces the character > scene precedence
      // rule so this branch only runs when character didn't fire.
      console.info('[manual-editor scene-cache] hit-and-edit', {
        rowIndex,
        sceneId,
        cachedSceneBaseUrl,
      });
      // Phase 2 (Character Bible) — prepend the bible on the
      // scene-cache hit path too, so the character reference language
      // is available for any recurring characters that appear in the
      // scene (the location is the anchor, characters draw from the
      // bible).
      const editPrompt = prependCharacterBible(
        buildSceneContinuationEditPrompt(prompt),
        doc?.doodle_explainer_2_character_descriptions,
      );
      try {
        const res = await queueImageGen('edit', 'scene-cache-hit', () =>
          // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC (abortable): awaits and uses response
          fetch('/api/generate/production-doc/image/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              originalImageUrl: cachedSceneBaseUrl,
              prompt: editPrompt,
              optionId: 'gpt-image-2-atlas-edit',
            }),
          }),
        );
        if (res.status === 429) reportUpstream429('edit', 'scene-cache-hit');
        const data = (await safeJson(res)) as {
          imageUrl?: string;
          saliency?: ImageSaliencyMap | null;
          error?: string;
        };
        if (res.ok && typeof data.imageUrl === 'string') {
          setRowImages((prev) => {
            const next = [...prev];
            next[rowIndex] = {
              status: 'done',
              imageUrl: data.imageUrl!,
              source: 'generated',
            };
            return next;
          });
          void persistRowAsset(rowIndex, 'image', data.imageUrl);
          if (data.saliency) applySaliencyToRow(rowIndex, data.saliency);
          if (overlayTerms && !meta.skipOverlay) {
            console.info('[prodoc image-gen] overlay queued', { rowIndex, overlayTerms });
            void fetchOverlayForRow(rowIndex, overlayTerms);
          }
          return true;
        }
        console.warn('[manual-editor scene-cache] edit-failed-fallback-to-i2i', {
          rowIndex,
          sceneId,
          status: res.status,
          error: data.error,
        });
      } catch (err) {
        console.warn('[manual-editor scene-cache] edit-failed-fallback-to-i2i (exception)', {
          rowIndex,
          sceneId,
          message: err instanceof Error ? err.message : String(err),
        });
        // Drop through to i2i.
      }
    }
    try {
      const res = await queueImageGen('generate', 'single-regen', () =>
        // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC (abortable): awaits and uses response
        fetch('/api/generate/production-doc/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            prompt,
            model: imageModel,
            onScreenText,
            onScreenTextMode,
            sectionTitle,
            sectionTitleLayout,
            referenceImageUrl,
            styleSheetDescription,
            // v2 (2026-05-21): when the active style is a saved private
            // style with attached refs, this routes the call through
            // the i2i dispatcher (NanoBanana Pro by default). When it's
            // a built-in like 'doodle_explainer', the route's
            // resolveStyle returns origin='built-in' and falls back to
            // the legacy T2I path unchanged.
            styleId: stylePreset || undefined,
            // v2: drop these refs from the dispatched call. Set when the
            // user clicks "Regenerate without rejected refs" after a 409.
            excludeRefIds: meta.excludeRefIds,
            // Phase 2 (Character Bible) — pass the doc-level
            // character descriptions through so the augmenter can
            // prepend the reference block to the prompt. Empty /
            // missing → no-op on non-doodle_explainer_2 docs and on
            // docs predating the LLM teaching update.
            characterDescriptions: doc?.doodle_explainer_2_character_descriptions,
          }),
        }),
      );
      if (res.status === 429) reportUpstream429('generate', 'single-regen');
      const data = await safeJson(res) as {
        imageUrl?: string;
        saliency?: ImageSaliencyMap | null;
        modelUsed?: string;
        styleVersion?: number;
        refsSent?: number;
        durationMs?: number;
        error?: string;
        code?: string;
        rejectedRefIds?: string[];
      };
      // v2: provider-rejection handling. When Kie / ComfyUI refuses
      // one or more refs, the route returns 409 with the offending
      // ref ids and `suggestRegenerate: true`. The server has already
      // marked the refs as rejected — show a toast with a one-click
      // "Regenerate without rejected refs" action that re-fires this
      // function with `excludeRefIds` set so the retry skips them.
      if (res.status === 409 && (data as { code?: string }).code === 'REFERENCE_REJECTED') {
        const rejectedIds = ((data as { rejectedRefIds?: string[] }).rejectedRefIds ?? []);
        const accumulatedExcludes = [...(meta.excludeRefIds ?? []), ...rejectedIds];
        // Terminal state: if the accumulated exclude list is now >= 8
        // (the system cap on refs per style), regenerating again
        // would dispatch with zero refs, silently fall back to
        // text-to-image and lose the user's intent. Surface a
        // clearer error and DON'T offer Regenerate.
        const allRefsRejected = accumulatedExcludes.length >= 8;
        const n = rejectedIds.length;
        setRowImages(prev => {
          const next = [...prev];
          next[rowIndex] = {
            status: 'error',
            error: allRefsRejected
              ? 'All reference images on this style were rejected by the provider. Edit the style to clear rejections or upload different refs before retrying.'
              : `${n || 'One or more'} reference image${n === 1 ? '' : 's'} rejected by the provider — click Regenerate to retry without them.`,
          };
          return next;
        });
        toast.error(
          allRefsRejected
            ? 'All reference images rejected — edit the style before retrying.'
            : `${n || 'One or more'} reference image${n === 1 ? ' was' : 's were'} rejected by the provider.`,
          {
            duration: 10000,
            action: (allRefsRejected || rejectedIds.length === 0)
              ? undefined
              : {
                  label: 'Regenerate',
                  onClick: () => {
                    void generateImageForRow(
                      rowIndex,
                      prompt,
                      { ...meta, excludeRefIds: accumulatedExcludes },
                      signal,
                    );
                  },
                },
          },
        );
        return false;
      }
      if (res.status === 429) {
        // Rare with the client-side throttle in place (25/min cap under the
        // server's 30/min), but a race across tabs or a tightened server
        // cap can still produce one. Show a calm pacing message instead
        // of the generic "Failed" pill. The throttle's reportUpstream429
        // call above already stalled the bucket so the next click waits.
        throw new Error('Pacing — too many image generations in the last minute. Try again in a moment.');
      }
      if (!res.ok) throw new Error((data.error as string) || 'Failed');
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = {
          status: 'done',
          imageUrl: data.imageUrl as string,
          source: 'generated',
          // Pin to the style version that produced this image so
          // future edits to the style can detect drift on this row.
          styleVersion: data.styleVersion,
        };
        return next;
      });
      // CRITICAL (2026-05-22): persist the imageUrl to the server
      // immediately via the atomic row-asset endpoint. Without this
      // we depend on the debounced parity-bridge effect, which has
      // dropped real money-spent generations in the past. Fire-and-
      // forget — the helper surfaces its own error toast and the
      // optimistic UI above already updated.
      void persistRowAsset(rowIndex, 'image', data.imageUrl as string, {
        styleVersion: typeof data.styleVersion === 'number' ? data.styleVersion : undefined,
      });
      // Phase 1.6 (Bug D, fix-up) — character-cache miss-and-store.
      //
      // First i2i for a character_id slug: stash the result as the
      // canonical base for every subsequent row showing the same
      // character. `writeCharacterToCache` is first-occurrence-wins so
      // racing writes during a bulk-gen burst are safe (the second
      // write is a no-op).
      //
      // BOTH local state AND the server must be updated atomically.
      // The first cut of Bug D only called setDoc and depended on the
      // debounced parity-bridge effect to persist — that bridge has
      // the known silent-drop modes documented above persistRowAsset,
      // so QA on Sodder doc c64b4fb4 showed `character_cache: NULL`
      // even though 7 rows had emitted `character_id`. Fix: pair the
      // setDoc with the same `updateProductionDocEntry` call every
      // other doc-mutation site in this file uses, so the cache
      // survives a tab close before the next debounce tick.
      if (isDoodleExplainer2 && characterId && !cachedBaseUrl && typeof data.imageUrl === 'string' && doc) {
        console.info('[manual-editor character-cache] miss-and-store', {
          rowIndex,
          characterId,
        });
        const nextCache = writeCharacterToCache(
          doc.doodle_explainer_2_character_cache,
          characterId,
          data.imageUrl as string,
          rowIndex,
        );
        // Phase 1.6 hot-fix 2 (post-c64b4fb4 regression): explicitly
        // carry style_preset onto the saved doc. The page's style-sync
        // useEffect (lines ~2140-2150) lifts the page's stylePreset
        // state onto the doc, but if our save fires inside the same
        // synchronous tick as the fresh-generation setDoc — before
        // React commits and the sync effect has run — the doc closed
        // over here still has style_preset undefined. Persisting that
        // null overwrites whatever the sync effect would have written.
        // Confirmed on Sodder doc c64b4fb4 where style_preset landed
        // as NULL but `payload.doc.style_preset` on the prior post-1.6
        // doc b7f7e637 was correct. Falling back to the page-state
        // stylePreset when the doc field is unset is the surgical fix.
        const resolvedStylePreset = doc.style_preset || stylePreset || undefined;
        const nextDoc = {
          ...doc,
          style_preset: resolvedStylePreset,
          doodle_explainer_2_character_cache: nextCache,
        };
        setDoc(nextDoc);
        persistDoc(nextDoc);
      }
      // Phase 3 — scene-cache miss-and-store. Same atomic-persist
      // pattern as the character-cache write above so the cache
      // survives a tab close. Independent of the character-cache
      // write: a single row can stash BOTH a character base (if it's
      // the first occurrence of character_id) AND a scene base (if
      // it's the first occurrence of scene_id) in the same i2i
      // result. The cache is first-occurrence-wins per
      // `writeSceneToCache`, so racing writes are safe.
      if (isDoodleExplainer2 && sceneId && !cachedSceneBaseUrl && typeof data.imageUrl === 'string' && doc) {
        console.info('[manual-editor scene-cache] miss-and-store', {
          rowIndex,
          sceneId,
        });
        // Read the latest doc reference (may have been mutated by the
        // character-cache write above) to avoid clobbering that update.
        // setDoc + updateProductionDocEntry atomicity matters here.
        setDoc((prev) => {
          if (!prev) return prev;
          const nextSceneCache = writeSceneToCache(
            prev.doodle_explainer_2_scene_cache,
            sceneId,
            data.imageUrl as string,
            rowIndex,
          );
          const resolvedStylePreset = prev.style_preset || stylePreset || undefined;
          const nextDoc = {
            ...prev,
            style_preset: resolvedStylePreset,
            doodle_explainer_2_scene_cache: nextSceneCache,
          };
          persistDoc(nextDoc);
          return nextDoc;
        });
      }
      const saliency = data.saliency;
      if (saliency) applySaliencyToRow(rowIndex, saliency);
      // Fire-and-forget the overlay fetch in parallel with the next row's
      // image gen. Only triggers when the LLM planned an overlay for this
      // row AND the user hasn't opted out of overlay auto-fetch (either
      // doc-wide via the `overlays_disabled` toggle, or per-row via
      // `skip_overlay`). Idempotent — the route's R2 cache short-circuits
      // repeats when the user later opts back in.
      if (overlayTerms && !meta.skipOverlay) {
        console.info('[prodoc image-gen] overlay queued', { rowIndex, overlayTerms });
        void fetchOverlayForRow(rowIndex, overlayTerms);
      } else if (overlayTerms && meta.skipOverlay) {
        console.info('[prodoc image-gen] overlay auto-fetch skipped per user setting', { rowIndex });
      }
      return true;
    } catch (err) {
      setRowImages(prev => {
        const next = [...prev];
        next[rowIndex] = { status: 'error', error: err instanceof Error ? err.message : 'Failed' };
        return next;
      });
      return false;
    }
  }

  /**
   * Auto-fill a motion_collage row's per-panel keyframe prompts from its
   * narration beat — the fix for "Convert to motion collage just hands me
   * empty boxes." Hits /api/generate/production-doc/motion-collage/panels
   * (one cheap LLM call, no image gen).
   *
   * Race-free by design: the caller passes the grid + content + existing
   * panels EXPLICITLY (no stale `doc` reads), so it works the same whether
   * invoked from the convert handler (content captured before the row is
   * cleared), the editor's grid-expand branch (onChange payload), or the
   * "✨ Auto-fill panels" button (current row state).
   *
   * Merge policy = "keep existing, fill blanks": a panel the user already
   * wrote is never overwritten, even if the model returns text for it.
   * Changing the panels invalidates any rendered collage, so we clear
   * image_url + motion_collage_*url so the next Generate re-runs.
   *
   * See `_plans/2026-06-01-motion-collage-panel-autofill.md`.
   */
  async function autoFillMotionCollagePanels(
    rowIndex: number,
    payload: {
      grid: { cols: number; rows: number };
      scriptText: string;
      visualDescription?: string;
      baseImagePrompt?: string;
      existingPanels: readonly string[];
    },
  ): Promise<void> {
    // In-flight guard — drop overlapping triggers for the same row.
    if (autoFillingRows.has(rowIndex)) return;

    const hasContent = [payload.scriptText, payload.visualDescription, payload.baseImagePrompt]
      .some((s) => typeof s === 'string' && s.trim().length > 0);
    if (!hasContent) {
      toast.error('Add some narration or a visual description to this row first.');
      return;
    }

    // Nothing to fill — every panel already has text. Skip the (wasted)
    // LLM call and point the user at the regenerate path. Convert +
    // grid-expand always pass at least one blank, so this only guards a
    // pointless press of the "Auto-fill panels" button.
    const N = payload.grid.cols * payload.grid.rows;
    const blanks = Array.from({ length: N }, (_, i) => (payload.existingPanels[i] ?? '').trim()).filter((p) => !p);
    if (blanks.length === 0) {
      toast('All panels are filled — clear a panel and re-run to regenerate it.');
      return;
    }

    setAutoFillingRows((prev) => new Set(prev).add(rowIndex));
    console.info('[prodoc motion-collage panels] start', {
      row_index: rowIndex,
      grid: payload.grid,
    });
    try {
      // eslint-disable-next-line no-restricted-syntax -- LLM RPC: awaits and uses response
      const res = await fetch('/api/generate/production-doc/motion-collage/panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid: payload.grid,
          scriptText: payload.scriptText,
          visualDescription: payload.visualDescription,
          baseImagePrompt: payload.baseImagePrompt,
          existingPanels: payload.existingPanels,
          stylePreset,
          characterDescriptions: doc?.doodle_explainer_2_character_descriptions,
        }),
      });
      const data = (await res.json()) as { panelPrompts?: string[]; error?: string };
      if (!res.ok || !Array.isArray(data.panelPrompts)) {
        toast.error(data.error ?? `Auto-fill failed (HTTP ${res.status})`);
        console.warn('[prodoc motion-collage panels] failed', { row_index: rowIndex, status: res.status, error: data.error });
        return;
      }

      // Merge: keep any existing non-empty panel, fill blanks from the
      // response. Length follows the grid.
      const generated = data.panelPrompts;
      const merged = Array.from({ length: N }, (_, i) => {
        const cur = (payload.existingPanels[i] ?? '').trim();
        return cur || (generated[i] ?? '').trim();
      });

      updateRow(rowIndex, {
        motion_collage_grid: payload.grid,
        motion_collage_panel_prompts: merged,
        image_url: undefined,
        motion_collage_image_url: undefined,
        motion_collage_panel_urls: undefined,
      });
      const filled = merged.filter((p) => p.trim()).length;
      console.info('[prodoc motion-collage panels] success', { row_index: rowIndex, filled, total: N });
      toast.success(`Filled ${filled} panel${filled === 1 ? '' : 's'} — edit any of them before generating.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Auto-fill failed');
    } finally {
      setAutoFillingRows((prev) => {
        const next = new Set(prev);
        next.delete(rowIndex);
        return next;
      });
    }
  }

  /**
   * Per-row trigger for the doodle_explainer_2 motion_collage shot kind.
   * Called when ImageCell's Generate button fires on a row whose
   * `shot_kind === 'motion_collage'` — the regular generateImageForRow
   * builds its prompt from ai_image_prompt (empty on these rows), so
   * we route to the dedicated /api/generate/production-doc/motion-collage
   * endpoint which wraps generateMotionCollage server-side.
   *
   * Mirrors the loading / done / error state machine of
   * generateImageForRow so the inspector pill, the panels-grid preview
   * in ImageCell, and the retry affordances all behave consistently
   * across regular and motion_collage rows.
   *
   * See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`
   * Phase 9 (editor wire-up) — added as a follow-up after smoke-testing
   * showed the manual path was unwired.
   */
  async function generateMotionCollageForRow(rowIndex: number): Promise<boolean> {
    const row = doc?.rows[rowIndex];
    if (!row || row.shot_kind !== 'motion_collage') return false;
    if (!row.motion_collage_grid || !row.motion_collage_panel_prompts?.length) {
      toast.error('Set a grid + panel prompts before generating.');
      return false;
    }
    setRowImages((prev) => {
      const next = [...prev];
      next[rowIndex] = { ...next[rowIndex], status: 'loading' };
      return next;
    });
    console.info('[prodoc motion-collage manual] start', {
      row_index: rowIndex,
      grid: row.motion_collage_grid,
      panel_count: row.motion_collage_panel_prompts.length,
    });
    try {
      const res = await queueImageGen('generate', 'motion-collage', () =>
        // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC: awaits and uses response
        fetch('/api/generate/production-doc/motion-collage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grid: row.motion_collage_grid,
            panelPrompts: row.motion_collage_panel_prompts,
            stylePreset,
            motionCollageSettings:
              doc?.doodle_explainer_2_motion_collage_settings ?? pendingMotionCollageSettings,
            characterDescriptions: doc?.doodle_explainer_2_character_descriptions,
          }),
        }),
      );
      if (res.status === 429) reportUpstream429('generate', 'motion-collage');
      const data = (await res.json()) as {
        imageUrl?: string;
        panelUrls?: string[];
        collageImageUrl?: string;
        error?: string;
        costUsd?: number;
      };
      if (res.ok && data.imageUrl && data.panelUrls?.length) {
        // Write the per-row image state (panel 0 mirrored into image_url)
        // AND persist the panel URLs onto the doc so a refresh / save /
        // re-render of the page picks them up.
        setRowImages((prev) => {
          const next = [...prev];
          next[rowIndex] = { status: 'done', imageUrl: data.imageUrl!, source: 'generated' };
          return next;
        });
        setDoc((prev) => {
          if (!prev) return prev;
          const nextRows = [...prev.rows];
          nextRows[rowIndex] = {
            ...nextRows[rowIndex],
            image_url: data.imageUrl,
            motion_collage_image_url: data.collageImageUrl,
            motion_collage_panel_urls: data.panelUrls,
          };
          return { ...prev, rows: nextRows };
        });
        console.info('[prodoc motion-collage manual] success', {
          row_index: rowIndex,
          panel_count: data.panelUrls.length,
          cost_usd: data.costUsd,
        });
        return true;
      }
      setRowImages((prev) => {
        const next = [...prev];
        next[rowIndex] = { status: 'error', error: data.error ?? `HTTP ${res.status}` };
        return next;
      });
      console.warn('[prodoc motion-collage manual] failed', {
        row_index: rowIndex,
        status: res.status,
        error: data.error,
      });
      return false;
    } catch (err) {
      setRowImages((prev) => {
        const next = [...prev];
        next[rowIndex] = { status: 'error', error: err instanceof Error ? err.message : 'Failed' };
        return next;
      });
      return false;
    }
  }

  // ── Per-row overlay fetch
  //
  // Hits /api/overlay/fetch which sources a real-world asset (logo,
  // screenshot, photo) for the row's `overlay_stock_terms`, strips its
  // background via Replicate RMBG, and stores it on R2. We persist the
  // resulting URL on `rowOverlays[rowIndex]` and the Remotion renderer
  // composites it onto the still at the LLM-planned `overlay_zone`.
  //
  // The route degrades gracefully (no result / search down / RMBG down all
  // return 200 with `overlayUrl: null` + a `reason`), so a missing key or
  // a flaky source never breaks the row — the still alone is rendered.
  /**
   * Clear every overlay-related field on a row in one shot. Wraps the
   * destructive cascade so the hover-✕, the right-click context menu,
   * and (potentially) future surfaces all behave identically. Callers
   * are responsible for the user-facing confirm dialog.
   */
  function removeOverlayFromRow(rowIndex: number): void {
    setRowOverlays((prev) => {
      const next = { ...prev };
      delete next[rowIndex];
      return next;
    });
    updateRow(rowIndex, {
      overlay_stock_terms: undefined,
      overlay_zone: undefined,
      overlay_size: undefined,
      overlay_zone_resolved: undefined,
      overlay_size_resolved: undefined,
      overlay_position: undefined,
      overlay_size_pct: undefined,
      overlay_stretched_height_pct: undefined,
      overlay_placement_reason: undefined,
      overlay_placement_model: undefined,
      overlay_rmbg_kept: undefined,
      overlay_edit_history: undefined,
    });
  }

  async function fetchOverlayForRow(rowIndex: number, overlayStockTerms: string): Promise<void> {
    setRowOverlays((prev) => ({ ...prev, [rowIndex]: { status: 'loading' } }));
    try {
      // Phase 2 smart placement: when both the row's scene image AND its
      // saliency map are ready, send them through so the route can ask
      // a vision LLM where this overlay belongs. The route is tolerant
      // of either being absent — a row whose still hasn't generated yet
      // still gets the overlay, just without smart placement.
      const row = doc?.rows[rowIndex];
      const sceneImageUrl = rowImages[rowIndex]?.imageUrl;
      const saliencyMap = row?.image_saliency;
      const saliencyCells = saliencyMap
        ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
            row: Math.floor(idx / saliencyMap.cols),
            col: idx % saliencyMap.cols,
            score: saliencyMap.busyness[idx] ?? 0,
          }))
        : undefined;
      // eslint-disable-next-line no-restricted-syntax -- overlay RPC: awaits and uses response (overlay URL)
      const res = await fetch('/api/overlay/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overlayStockTerms,
          sceneImageUrl,
          saliencyCells,
        }),
      });
      const data = (await safeJson(res)) as {
        overlayUrl?: string | null;
        sourceUrl?: string;
        reason?: string;
        error?: string;
        placement?: {
          model: string;
          sizePct: number;
          mode: 'zone' | 'custom';
          zone?: ProductionRow['overlay_zone'];
          customXPct?: number;
          customYPct?: number;
          reason: string;
        };
        /** Phase 4 — true when RMBG was used, false when reverted. */
        rmbgKept?: boolean;
      };
      if (!res.ok) {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'error', error: data.error || `Failed (${res.status})` },
        }));
        return;
      }
      if (data.overlayUrl) {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'done', url: data.overlayUrl!, sourceUrl: data.sourceUrl },
        }));
        // CRITICAL (2026-05-22): persist the overlay URL server-side
        // immediately. Same rationale as the row-image persist above
        // — the debounced parity bridge has dropped overlay attaches
        // in the same race-condition windows.
        void persistRowAsset(rowIndex, 'overlay', { status: 'done', url: data.overlayUrl! });
        // Phase 4 — persist the RMBG-gate outcome on the row. Separate
        // updateRow so it lands even when no Phase-2 placement was
        // returned (e.g. sceneImageUrl wasn't provided this call).
        if (typeof data.rmbgKept === 'boolean') {
          console.info('[ui overlay-rmbg] gate outcome', {
            rowIndex,
            rmbgKept: data.rmbgKept,
          });
          updateRow(rowIndex, { overlay_rmbg_kept: data.rmbgKept });
        }
        // Phase 2: when the route returned a smart placement, write the
        // decision onto the row. Only write fields the AI actually
        // produced — `mode: 'zone'` leaves customX/Y null; `mode:
        // 'custom'` leaves zone null. The renderer's resolution order
        // (custom > zone > LLM-default) makes either combination work.
        const p = data.placement;
        if (p) {
          console.info('[ui overlay-placement] applied', {
            rowIndex,
            model: p.model,
            sizePct: p.sizePct,
            mode: p.mode,
            zone: p.zone,
            reason: p.reason,
          });
          updateRow(rowIndex, {
            overlay_size_pct: p.sizePct,
            overlay_position:
              p.mode === 'custom' &&
              typeof p.customXPct === 'number' &&
              typeof p.customYPct === 'number'
                ? { x_pct: p.customXPct, y_pct: p.customYPct }
                : undefined,
            // When the AI picked a zone, also clear any prior manual
            // position so the zone wins at render time.
            ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
            overlay_placement_reason: p.reason || undefined,
            overlay_placement_model: p.model,
          });
        }
      } else {
        setRowOverlays((prev) => ({
          ...prev,
          [rowIndex]: { status: 'skipped', error: data.reason || 'No usable image found' },
        }));
      }
    } catch (err) {
      setRowOverlays((prev) => ({
        ...prev,
        [rowIndex]: { status: 'error', error: err instanceof Error ? err.message : 'Failed' },
      }));
    }
  }

  /**
   * Phase 3 — Rethink button. Re-runs the vision placement on a row's
   * existing overlay without touching Brave or RMBG. The route's
   * `mode: 'placement-only'` branch handles the cheap path. We also
   * forward the row's current placement as `previousDecision` so the
   * prompt explicitly asks for a different answer; without that hint
   * Gemini tends to return the same pick twice.
   *
   * Bounded by RETHINK_MAX_ATTEMPTS per row per page session. Hitting
   * the cap surfaces an alert; reload refills the budget.
   *
   * Telemetry: emits `overlay_rethink` with the before/after placement
   * and the attempt count so the Phase 0 drag-rate dashboard can also
   * track "how often did the user need to rethink before accepting?"
   */
  async function rethinkOverlayPlacement(rowIndex: number): Promise<void> {
    // Synchronous in-flight guard — returns immediately if a request
    // is already running for this row. setRethinkingRows below would
    // also gate the button via React state, but state batching means
    // two rapid clicks can both pass the React check before the disable
    // takes effect. The ref check runs in the same synchronous tick.
    if (rethinkInFlightRef.current.has(rowIndex)) {
      console.warn('[ui overlay-rethink] already in flight — ignoring duplicate click', {
        rowIndex,
      });
      return;
    }
    const overlayState = rowOverlays[rowIndex];
    if (overlayState?.status !== 'done' || !overlayState.url) {
      console.warn('[ui overlay-rethink] no overlay to rethink', { rowIndex, status: overlayState?.status });
      return;
    }
    const attempts = rethinkAttempts[rowIndex] ?? 0;
    if (attempts >= RETHINK_MAX_ATTEMPTS) {
      alert(`AI rethink limit reached for this overlay (${RETHINK_MAX_ATTEMPTS}/session). Reload the page to reset.`);
      return;
    }
    const row = doc?.rows[rowIndex];
    if (!row) return;

    const sceneImageUrl = rowImages[rowIndex]?.imageUrl;
    if (!sceneImageUrl) {
      alert('Generate the row image first — the AI needs to see the scene before it can rethink the overlay placement.');
      return;
    }
    const saliencyMap = row.image_saliency;
    const saliencyCells = saliencyMap
      ? Array.from({ length: saliencyMap.cols * saliencyMap.rows }, (_, idx) => ({
          row: Math.floor(idx / saliencyMap.cols),
          col: idx % saliencyMap.cols,
          score: saliencyMap.busyness[idx] ?? 0,
        }))
      : undefined;

    // Snapshot the row's current placement so we can forward it as the
    // anti-repeat hint AND log the before/after delta in telemetry.
    const prevMode: 'zone' | 'custom' =
      row.overlay_position &&
      typeof row.overlay_position.x_pct === 'number' &&
      typeof row.overlay_position.y_pct === 'number'
        ? 'custom'
        : 'zone';
    const previousDecision = {
      sizePct:
        typeof row.overlay_size_pct === 'number'
          ? row.overlay_size_pct
          : row.overlay_size === 'small'
            ? 12
            : row.overlay_size === 'large'
              ? 25
              : 18,
      mode: prevMode,
      zone: row.overlay_zone_resolved ?? row.overlay_zone,
      customXPct: row.overlay_position?.x_pct,
      customYPct: row.overlay_position?.y_pct,
      reason: row.overlay_placement_reason ?? '',
    };

    console.info('[ui overlay-rethink] request', {
      rowIndex,
      attempt: attempts + 1,
      previousMode: prevMode,
      previousZone: previousDecision.zone,
      previousSize: previousDecision.sizePct,
    });

    rethinkInFlightRef.current.add(rowIndex);
    setRethinkingRows((prev) => {
      const next = new Set(prev);
      next.add(rowIndex);
      return next;
    });

    try {
      // eslint-disable-next-line no-restricted-syntax -- overlay RPC: awaits and uses response
      const res = await fetch('/api/overlay/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'placement-only',
          existingOverlayUrl: overlayState.url,
          sceneImageUrl,
          saliencyCells,
          previousDecision,
        }),
      });
      const data = (await safeJson(res)) as {
        placement?: {
          model: string;
          sizePct: number;
          mode: 'zone' | 'custom';
          zone?: ProductionRow['overlay_zone'];
          customXPct?: number;
          customYPct?: number;
          reason: string;
        };
        error?: string;
        reason?: string;
      };
      if (!res.ok) {
        alert(`Rethink failed: ${data.error || `HTTP ${res.status}`}`);
        console.warn('[ui overlay-rethink] non-OK', { rowIndex, status: res.status, body: data });
        return;
      }
      if (!data.placement) {
        alert('AI couldn\'t produce a new placement — the previous pick stays. Try again or drag manually.');
        console.warn('[ui overlay-rethink] no placement returned', { rowIndex, reason: data.reason });
        return;
      }
      const p = data.placement;
      console.info('[ui overlay-rethink] applied', {
        rowIndex,
        attempt: attempts + 1,
        model: p.model,
        sizePct: p.sizePct,
        mode: p.mode,
        zone: p.zone,
        reason: p.reason,
      });

      // Persist new placement — same shape as Phase 2's fetch path.
      updateRow(rowIndex, {
        overlay_size_pct: p.sizePct,
        overlay_position:
          p.mode === 'custom' &&
          typeof p.customXPct === 'number' &&
          typeof p.customYPct === 'number'
            ? { x_pct: p.customXPct, y_pct: p.customYPct }
            : undefined,
        ...(p.mode === 'zone' && p.zone ? { overlay_zone: p.zone } : {}),
        overlay_placement_reason: p.reason || undefined,
        overlay_placement_model: p.model,
      });

      // Increment the per-row counter so the cap eventually bites.
      setRethinkAttempts((prev) => ({ ...prev, [rowIndex]: attempts + 1 }));

      // Telemetry — before/after delta.
      recordEditorTelemetry('overlay_rethink', {
        payload: {
          row_index: rowIndex,
          placement_model: p.model,
          attempt: attempts + 1,
          prev_zone: previousDecision.zone ?? null,
          new_zone: p.zone ?? null,
          prev_size_pct: previousDecision.sizePct,
          new_size_pct: Number(p.sizePct.toFixed(2)),
          prev_mode: previousDecision.mode,
          new_mode: p.mode,
        },
      });
    } catch (err) {
      console.warn('[ui overlay-rethink] threw', {
        rowIndex,
        detail: err instanceof Error ? err.message : String(err),
      });
      alert('Rethink failed — see console for details.');
    } finally {
      rethinkInFlightRef.current.delete(rowIndex);
      setRethinkingRows((prev) => {
        const next = new Set(prev);
        next.delete(rowIndex);
        return next;
      });
    }
  }

  async function generateImages(
    rows: ProductionRow[],
    signal?: AbortSignal,
    /** Doc-level "Auto-generate overlays" toggle, captured by the caller
     *  from the freshly-returned doc. We accept it as a parameter rather
     *  than reading `doc?.overlays_disabled` here because the auto-
     *  pipeline calls `setDoc(result)` and then `generateImages(result.rows)`
     *  in the same synchronous tick (see comment on generateImageForRow). */
    docOverlaysDisabled?: boolean,
  ) {
    // 2026-06-04 hard gate. Image generation costs real money per call.
    // Without a real UUID historyEntryId, every generated image's
    // persistRowAsset POST 400s server-side (UUID regex), the URL
    // never lands on the row, and the user pays for output that
    // vanishes on reload. Refuse rather than burn the budget.
    // The save-failure banner above is the user-visible signal —
    // this gate is the actual enforcement.
    if (!historyEntryId || !isUuid(historyEntryId)) {
      const reason = saveFailure
        ? 'Resolve the server-save banner above before generating images — the URLs would be lost.'
        : 'Save the doc to the server before generating images.';
      toast.error(reason);
      console.warn('[image gen] refused — no UUID historyEntryId', { historyEntryId });
      return;
    }
    const aiRows = rows
      .map((r, i) => ({ row: r, idx: i }))
      // Exclude motion_collage rows: their image is the N panels produced
      // by the dedicated auto-fire block further down (the /motion-collage
      // endpoint), NOT a single regular/collage still. Running them through
      // generateImageForRow here would write a one-off still into image_url
      // with no motion_collage_panel_urls, which the renderer then plays as
      // a single static frame (the "no motion" bug) until the auto-fire
      // happens to overwrite it. Skipping keeps generation single-sourced.
      .filter(({ row }) => row.shot_kind !== 'motion_collage' && row.ai_image_prompt?.trim());

    // Initialise all row states immediately. Variant rows (variant_index
    // > 0) intentionally carry an empty `ai_image_prompt` — their image
    // is derived from the base via the per-row "Generate variant" button
    // through Atlas Edit, NOT via stock search. Without this carve-out,
    // every variant row would falsely surface a "Search Images" button
    // in the image column alongside its real "Generate variant" CTA,
    // which the user reported as confusing. Variants get 'pending' (the
    // `•••` waiting indicator) so the Generate variant button is the
    // unambiguous next action.
    const initialStates: RowImageState[] = rows.map(r => {
      const rBag = r as unknown as Record<string, unknown>;
      const variantIndex = typeof rBag.variant_index === 'number'
        ? (rBag.variant_index as number)
        : -1;
      const isDerivedVariant = variantIndex > 0;
      if (!r.ai_image_prompt?.trim() && !isDerivedVariant) {
        const q = r.stock_search_terms || r.visual_description || r.visual_type;
        return {
          status: 'search',
          searchUrl: `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`,
        };
      }
      return { status: 'pending' };
    });
    setRowImages(initialStates);
    setImageProgress({ done: 0, total: aiRows.length });
    if (aiRows.length === 0) return;

    setImagesGenerating(true);
    appendLog(`Starting AI image generation for ${aiRows.length} shots (2 at a time)...`);
    let doneCount = 0;
    const CONCURRENCY = 2;

    try {
      for (let i = 0; i < aiRows.length; i += CONCURRENCY) {
        if (signal?.aborted) break;
        const batch = aiRows.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async ({ row, idx }) => {
            if (signal?.aborted) return;
            // Read meta from the `rows` argument, not React `doc` state — see
            // generateImageForRow header for why.
            const skipOverlay = typeof row.skip_overlay === 'boolean'
              ? row.skip_overlay
              : (docOverlaysDisabled === true);
            const sheetRef = doc ? resolveSheetReference(row, doc) : { referenceImageUrl: undefined, styleSheetDescription: undefined };
            await generateImageForRow(
              idx,
              row.ai_image_prompt,
              {
                onScreenText: row.on_screen_text,
                onScreenTextMode: row.on_screen_text_mode ?? doc?.on_screen_text_mode_default,
                sectionTitle: row.section_title,
                sectionTitleLayout: row.section_title_layout ?? doc?.section_title_layout_default,
                referenceImageUrl: sheetRef.referenceImageUrl,
                styleSheetDescription: sheetRef.styleSheetDescription,
                overlayStockTerms: row.overlay_stock_terms,
                skipOverlay,
                characterId: row.character_id,
                sceneId: row.scene_id,
              },
              signal,
            );
            // Don't tick progress for rows that aborted mid-fetch — the
            // fetch rejects with AbortError, generateImageForRow marks the
            // row 'error', but we shouldn't count it as "done" or log
            // "Image N/M shot K" past the user's cancel.
            if (signal?.aborted) return;
            doneCount++;
            setImageProgress({ done: doneCount, total: aiRows.length });
            appendLog(`Image ${doneCount}/${aiRows.length} — shot ${idx + 1} (${row.visual_type})`);
          }),
        );
      }

      if (signal?.aborted) {
        appendLog(`⊘ Image generation cancelled at ${doneCount}/${aiRows.length}`);
        toast.info(`Image generation cancelled (${doneCount}/${aiRows.length} done)`);
      } else {
        appendLog(`✓ All ${aiRows.length} base images complete`);
      }

      // After all base rows finish, generate any variant rows via Atlas
      // Edit on their base's image. Variants carry an empty
      // `ai_image_prompt` by design (auto-grouping post-pass clears it
      // so the dispatcher composes the final prompt from
      // base.ai_image_prompt + variant_edit_prompt). Without this phase
      // they'd never auto-generate on a fresh doc; the user would see
      // bases-with-images alongside variants-with-no-images and have to
      // click "Generate variant" on each by hand. Same logic as the
      // "Generate empty images" button's variant phase but threaded
      // into the auto-pipeline. Sequential because Atlas Edit hits the
      // same Kie endpoint and parallel calls would just add rate-limit
      // friction.
      const variantIndices = rows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => {
          const vidx = (row as unknown as Record<string, unknown>).variant_index;
          return typeof vidx === 'number' && vidx > 0;
        })
        .map(({ idx }) => idx);

      if (!signal?.aborted && variantIndices.length > 0) {
        // Two-stage filter:
        //   (1) Skip variants whose image already generated successfully in
        //       a prior run — re-generating wastes ~$0.011 each AND would
        //       clobber a possibly-user-edited image.
        //   (2) Skip variants whose BASE has no image — generateVariantImage
        //       would hit composeVariantEditRequest's BASE_NOT_GENERATED
        //       branch, surfacing a toast.error per row. In a 130-row doc
        //       with 35 orphan variants that's 35 error toasts — solid
        //       UX failure. Quietly log them instead and let the user
        //       fix the failed base before retrying variants.
        let imagesSnapshot: RowImageState[] = [];
        setRowImages(prev => {
          imagesSnapshot = prev;
          return prev;
        });
        const pendingVariantIndices: number[] = [];
        const orphanVariantIndices: number[] = [];
        const incompleteVariantIndices: number[] = [];
        for (const idx of variantIndices) {
          const ownImage = imagesSnapshot[idx]?.imageUrl;
          if (ownImage) continue; // already generated
          const editPrompt = rows[idx]?.variant_edit_prompt?.trim();
          if (!editPrompt) {
            // Manually-added variant with no edit prompt yet — generating
            // would hit MISSING_EDIT_PROMPT and spam toasts. Skip quietly;
            // the per-row inspector\'s edit-prompt field is the place to
            // fill it in.
            incompleteVariantIndices.push(idx);
            continue;
          }
          const groupId = rows[idx]?.group_id;
          if (!groupId) continue;
          const baseRowIdx = rows.findIndex(
            (r) => r.group_id === groupId && (r.variant_index ?? 0) === 0,
          );
          const baseHasImage = baseRowIdx >= 0 && Boolean(imagesSnapshot[baseRowIdx]?.imageUrl);
          if (!baseHasImage) {
            orphanVariantIndices.push(idx);
            continue;
          }
          pendingVariantIndices.push(idx);
        }
        const skipped =
          variantIndices.length -
          pendingVariantIndices.length -
          orphanVariantIndices.length -
          incompleteVariantIndices.length;
        if (incompleteVariantIndices.length > 0) {
          appendLog(
            `⚠ ${incompleteVariantIndices.length} variant${incompleteVariantIndices.length === 1 ? '' : 's'} skipped — empty edit prompt. Fill in "what changes from the base" in the inspector and click Generate variant.`,
          );
        }
        if (orphanVariantIndices.length > 0) {
          appendLog(
            `⚠ ${orphanVariantIndices.length} variant${orphanVariantIndices.length === 1 ? '' : 's'} can't generate — base image didn't generate. Retry the failed base${orphanVariantIndices.length === 1 ? '' : 's'} first.`,
          );
        }
        appendLog(
          `Generating ${pendingVariantIndices.length} variant frame${pendingVariantIndices.length === 1 ? '' : 's'} from base images via Atlas Edit (~$${(pendingVariantIndices.length * 0.011).toFixed(2)})${skipped > 0 ? ` — skipping ${skipped} already generated` : ''}...`,
        );
        // CRITICAL — pass the freshly-returned `rows` as an explicit
        // doc override. `generateVariantImage`'s React-closure-bound
        // `doc` is STALE during the synchronous-tick window between
        // setDoc(result) and React's next render — and we're inside
        // that window here (the auto-pipeline kicks off variant
        // generation immediately after the bases finish, before any
        // user interaction triggers a re-render). Without the
        // override, every variant call would bail with "Row is not
        // part of a variant group" because the auto-grouping's
        // `variant_index` / `group_id` stampings exist only on these
        // fresh rows, not on the stale-closure doc.
        const docForVariants = { rows } as ProductionDoc;
        let variantDone = 0;
        let variantFailed = 0;
        for (const idx of pendingVariantIndices) {
          if (signal?.aborted) break;
          console.info('[prodoc auto-pipeline variant]', {
            rowIndex: idx,
            groupId: rows[idx]?.group_id,
            variantIndex: rows[idx]?.variant_index,
            hasEditPrompt: Boolean(rows[idx]?.variant_edit_prompt?.trim()),
          });
          await generateVariantImage(idx, docForVariants);
          // Read updated state to count outcomes — a diagnostic so the
          // user (and future debugger) can see how many variants
          // succeeded vs failed without trawling the toast history.
          let updated: RowImageState[] = [];
          setRowImages(prev => {
            updated = prev;
            return prev;
          });
          if (updated[idx]?.imageUrl) variantDone += 1;
          else variantFailed += 1;
        }
        if (!signal?.aborted) {
          appendLog(
            `✓ Variant generation finished — ${variantDone} succeeded${variantFailed > 0 ? `, ${variantFailed} failed (click Retry on the failing variant or check console)` : ''}`,
          );
        }
      }

      if (!signal?.aborted) {
        const variantSummary = variantIndices.length > 0
          ? ` + ${variantIndices.length} variant${variantIndices.length === 1 ? '' : 's'} via Atlas Edit`
          : '';
        toast.success(`${aiRows.length} image${aiRows.length === 1 ? '' : 's'} generated${variantSummary}`);
      }
    } finally {
      setImagesGenerating(false);
      // Now that no more in-flight work is bound to this controller, clear
      // it so the next generate() run starts fresh. (generate()'s own
      // finally deliberately no longer nulls — see comment there.)
      abortControllerRef.current = null;
    }
  }

  // ── Main generation

  const appendLog = useCallback((msg: string) => {
    if (!mountedRef.current) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    // Cap the log so a long-running session with image generation, retries
    // and chunked runs can't grow it without bound. 200 lines is plenty to
    // diagnose a single run; older lines drop off the front.
    const MAX_LOG_LINES = 200;
    setGenerationLog(prev => {
      const entry = `${ts}  ${msg}`;
      if (prev.length < MAX_LOG_LINES) return [...prev, entry];
      // Slice from the tail to keep the most recent (MAX-1) plus the new entry.
      return [...prev.slice(prev.length - (MAX_LOG_LINES - 1)), entry];
    });
  }, []);

  function cancelGeneration() {
    const controller = abortControllerRef.current;
    console.info('[prodoc cancel] Stop clicked', {
      hasController: Boolean(controller),
      alreadyAborted: controller?.signal.aborted ?? null,
      generating,
      imagesGenerating,
      imageProgress,
    });
    if (!controller) {
      // Pre-fix this branch was the silent failure: generate()'s finally
      // nulled the ref while generateImages kept running fire-and-forget,
      // so Stop became a no-op once the doc had returned. Kept as a
      // defensive log in case a future code path re-introduces it.
      appendLog('⚠ Stop pressed but no in-flight generation is registered');
      return;
    }
    controller.abort();
    appendLog('⊘ Stop requested — cancelling in-flight work…');
  }

  async function generate() {
    if (!script.trim() || !niche.trim()) {
      toast.error('Script and niche are required');
      return;
    }

    // Cancel any in-progress generation before starting a new one
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setGenerating(true);
    setDoc(null);
    setRowImages([]);
    setRowOverlays({});
    try { localStorage.removeItem('prodoc_last_result'); } catch {};
    setImageProgress({ done: 0, total: 0 });
    setImagesGenerating(false);
    setGenerationLog([]);

    try {
      // Build creative brief from analyzed visual refs (not raw URLs — the model can't click them)
      let fullBrief = creativeBrief.trim();

      const analyzedRefs = visualRefs.filter(r => r.analyzedStyle);
      if (analyzedRefs.length > 0) {
        const refLines = analyzedRefs.map(r => {
          if (r.type === 'youtube') {
            const label = r.title ? `"${r.title}"` : r.url || 'YouTube';
            return `• YouTube ref ${label}: ${r.analyzedStyle}`;
          }
          return `• Screenshot${r.name ? ` "${r.name}"` : ''}: ${r.analyzedStyle}`;
        }).join('\n');
        fullBrief += (fullBrief ? '\n\n' : '') + `Visual Style References (match these exactly):\n${refLines}`;
      }

      // Refs that failed analysis — re-attempt them now and wait up to 12 s
      const failedRefs = visualRefs.filter(r => r.type === 'youtube' && r.url && r.analysisFailed && !r.analyzedStyle);
      if (failedRefs.length > 0) {
        appendLog(`↻ Retrying style analysis for ${failedRefs.length} YouTube ref(s)...`);
        await Promise.all(
          failedRefs.map((r, fi) => {
            const idx = visualRefs.findIndex(v => v === r);
            if (idx === -1 || !r.url) return;
            // Clear failed flag before retry
            setVisualRefs(prev => {
              const next = [...prev];
              next[idx] = { ...next[idx], analysisFailed: false };
              return next;
            });
            return Promise.race([
              analyzeYouTubeStyle(r.url, idx),
              new Promise(res => setTimeout(res, 12000)), // 12 s max wait
            ]);
          }),
        );
      }

      // Refs still without a style after retry (genuinely failed or still analyzing)
      const stillPending = visualRefs.filter(r => r.type === 'youtube' && r.url && !r.analyzedStyle);
      if (stillPending.length > 0) {
        const analyzing = stillPending.filter(r => r.analyzing).length;
        const failed = stillPending.filter(r => !r.analyzing).length;
        if (analyzing > 0) appendLog(`⚠ ${analyzing} YouTube ref(s) still analyzing — their style won't be in this generation`);
        if (failed > 0) appendLog(`⚠ ${failed} YouTube ref(s) could not be analyzed (thumbnail unavailable) — their style won't be included`);
      }

      const analyzedCount = analyzedRefs.length;
      const totalWords = script.trim().split(/\s+/).length;
      appendLog(`Script: ${totalWords} words · Style: ${stylePreset}${analyzedCount > 0 ? ` · ${analyzedCount} visual ref(s) analyzed` : ''}`);

      // ── Chunked generation — split long scripts to avoid 504 timeouts ──────────
      // 300 words ≈ 15–22 rows per chunk. Two prior caps (700, then 450)
      // both hit the model's output token ceiling on verbose-suffix
      // styles like doodle_explainer_2: each row carries the full style
      // suffix in `ai_image_prompt`, so output tokens scale with rows ×
      // suffix length rather than input words. At 300 words, even the
      // chunkiest doodle prompt produces ~6-8k output tokens, sitting
      // safely under GPT-mini-class models' 16k cap. Tradeoff: ~4-5
      // requests for a 1.2k-word script (vs 2-3 at 450w).
      const MAX_CHUNK_WORDS = 300;
      const chunks = splitScriptIntoChunks(script.trim(), MAX_CHUNK_WORDS);
      const isMultiChunk = chunks.length > 1;
      if (isMultiChunk) {
        appendLog(`Long script — splitting into ${chunks.length} chunks to avoid timeout...`);
      } else {
        appendLog('Sending to AI model...');
      }

      let allRows: ProductionRow[] = [];
      let firstResult: ProductionDoc | null = null;
      let timecodeOffsetSeconds = 0;

      // Send one chunk to the API. Retries once on transient upstream failures
      // (502/503/504 + network errors) — Kie's gateway has occasional blips
      // and a single retry recovers most of them. Aborts and 4xx responses
      // are non-retryable.
      const sendChunk = async (chunkIdx: number): Promise<Response> => {
        // eslint-disable-next-line no-restricted-syntax -- script-gen RPC (long-running): awaits and uses response (doc payload)
        const doFetch = () => fetch('/api/generate/production-doc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            modelId, niche, topic,
            script: chunks[chunkIdx],
            speakingPaceWpm: effectiveWpm,
            stylePreset,
            creativeBrief: fullBrief || undefined,
            startTimecodeSeconds: timecodeOffsetSeconds,
            isChunk: isMultiChunk && chunkIdx > 0,
            overlaysDisabled: overlaysDisabledPref,
            // doodle_explainer_2 motion-collage pre-generation tuning.
            // Doc-level value wins when an existing doc is being
            // regenerated; falls back to the pre-doc pending state when
            // generating fresh. The route ignores the field for any
            // style other than doodle_explainer_2.
            motionCollageSettings:
              doc?.doodle_explainer_2_motion_collage_settings ?? pendingMotionCollageSettings,
            // Pacing profile chosen pre-generation in the PacingProfilePanel.
            // Doc-level value wins on regenerate; pending state wins on
            // fresh gen; route falls back to 'fast' when the field is
            // missing or unrecognized.
            pacingProfile:
              doc?.pacing_profile ?? pendingPacingProfile ?? 'fast',
            // Pre-flight title overrides — only meaningful for chunk 0,
            // since continuation chunks suppress Title Cards in the
            // prompt anyway. When the user never opened the review
            // panel, `reviewedTitles` is null and we omit the field
            // (server falls back to its auto-extractor).
            ...(chunkIdx === 0 && reviewedTitles !== null
              ? { userTitles: reviewedTitles }
              : {}),
          }),
        });
        let attempts = 0;
        while (true) {
          let res: Response | null = null;
          let networkErr: unknown = null;
          try {
            res = await doFetch();
          } catch (err) {
            if ((err as { name?: string }).name === 'AbortError') throw err;
            networkErr = err;
          }
          const transient = networkErr !== null
            || (res !== null && (res.status === 502 || res.status === 503 || res.status === 504));
          if (transient && attempts < 1) {
            attempts++;
            const reason = networkErr !== null
              ? 'network error'
              : `HTTP ${res!.status}`;
            appendLog(`↻ Chunk ${chunkIdx + 1} ${reason} — retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (networkErr) throw networkErr;
          return res!;
        }
      };

      for (let ci = 0; ci < chunks.length; ci++) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (isMultiChunk) appendLog(`Generating chunk ${ci + 1} of ${chunks.length}...`);

        const res = await sendChunk(ci);
        const data = await safeJson(res);
        if (!res.ok) throw new Error((data.error as string) || `Chunk ${ci + 1} generation failed`);

        const chunkResult = data.result as ProductionDoc;
        if (!chunkResult?.rows?.length) {
          throw new Error(`Chunk ${ci + 1} returned empty — try again`);
        }

        // Surface server-side `generation_warnings` (overlong-row splits,
        // missing/extra title cards, sentinel leakage, extractor caps) so
        // the user sees what we couldn't fix automatically and can recover
        // with the Promote / Split row actions if needed.
        if (Array.isArray(data.generation_warnings)) {
          for (const w of data.generation_warnings as string[]) {
            appendLog(`⚠ ${w}`);
          }
        }

        if (ci === 0) firstResult = chunkResult;
        allRows = allRows.concat(chunkResult.rows);

        // Advance timecode offset by the actual words spoken (not just chunk length)
        const chunkWords = chunks[ci].trim().split(/\s+/).length;
        timecodeOffsetSeconds += Math.round((chunkWords / effectiveWpm) * 60);
      }

      // Merge chunk results into a single ProductionDoc
      const totalDurationSecs = timecodeOffsetSeconds;
      const totalMins = Math.floor(totalDurationSecs / 60);
      const totalSecs = totalDurationSecs % 60;
      const result: ProductionDoc = {
        ...(firstResult as ProductionDoc),
        total_duration: `${totalMins}:${String(totalSecs).padStart(2, '0')}`,
        total_words: totalWords,
        rows: allRows,
        // Stamp the gen-time image model so the editor opens with the
        // user's choice already populated as the doc-level default
        // (rule 10 — lazy user). Per-shot Regenerate in the inspector
        // resolves: row.image_model > doc.image_model_default >
        // server-side DEFAULT_IMAGE_MODEL.
        image_model_default: imageModel,
        // Seed `overlays_disabled` from the user's input-panel preference
        // so the doc carries the user's intent forward. The post-doc
        // toggle near the rows table can override per-doc afterwards.
        ...(overlaysDisabledPref ? { overlays_disabled: true as const } : {}),
        // doodle_explainer_2 motion-collage settings the user dialed in
        // pre-generation flow into the new doc so the post-doc panel
        // mounts with the same values. Skipped for any other style and
        // when the user never touched the panel (state stays undefined).
        ...(stylePreset === 'doodle_explainer_2' && pendingMotionCollageSettings
          ? { doodle_explainer_2_motion_collage_settings: pendingMotionCollageSettings }
          : {}),
        // Pre-generation pacing pick lands on the new doc so the panel
        // shows the user's choice as the active pill after generation
        // (otherwise it would fall back to the visual default and look
        // like the pick was lost). Server-side `applyPacingPostProcess`
        // also stamps `pacing_profile` based on the request, so this is
        // a redundancy that survives older route revisions.
        ...(pendingPacingProfile
          ? { pacing_profile: pendingPacingProfile }
          : {}),
      };

      appendLog(`Response received — parsing production doc...`);
      if (!result?.rows?.length) {
        throw new Error('Production doc returned empty — the AI may have failed to parse the script. Try again.');
      }

      setDoc(result);

      // 2026-05-31 (plan §C follow-up) — Auto-fire motion_collage
      // generation for every row the LLM emitted with motion_collage_*
      // fields. The user explicitly asked for the LLM to "decide which
      // collage it needs and just generate without me clicking" — this
      // closes the loop. Fire-and-forget: doesn't block the rest of the
      // doc-gen completion path (history save, OST seeding, etc.) — the
      // motion_collage calls run on a microtask after the rest of this
      // function settles, and individual generations are sequential
      // because each is heavy (~60-90s Atlas i2i + Recraft + slice).
      //
      // Gated by `allow_motion_collage` setting and stylePreset so this
      // is a no-op for non-doodle_explainer_2 docs or when the user
      // turned the feature off in the panel.
      const mcSettings =
        result.doodle_explainer_2_motion_collage_settings ?? pendingMotionCollageSettings;
      const autoMcAllowed =
        stylePreset === 'doodle_explainer_2'
        && (mcSettings?.allow_motion_collage !== false);
      if (autoMcAllowed) {
        type McRow = { idx: number; grid: { cols: number; rows: number }; panelPrompts: string[] };
        const motionCollageRows: McRow[] = [];
        for (let i = 0; i < result.rows.length; i++) {
          const r = result.rows[i];
          if (r.shot_kind !== 'motion_collage') continue;
          if (!r.motion_collage_grid || !r.motion_collage_panel_prompts?.length) continue;
          motionCollageRows.push({
            idx: i,
            grid: r.motion_collage_grid,
            panelPrompts: r.motion_collage_panel_prompts,
          });
        }
        if (motionCollageRows.length > 0) {
          appendLog(
            `↯ Auto-generating ${motionCollageRows.length} motion-collage shot${motionCollageRows.length === 1 ? '' : 's'} in the background...`,
          );
          // Sequential queue runs on a microtask so the rest of doc-gen
          // completion finishes first. We DON'T go through
          // generateMotionCollageForRow here because it reads from React
          // state (`doc?.rows[idx]`), which is stale at this point —
          // setDoc(result) was just dispatched but React hasn't flushed
          // yet. Instead the inline POST writes back into both
          // rowImages and the doc directly.
          const characterDescriptions = result.doodle_explainer_2_character_descriptions;
          void (async () => {
            for (const mc of motionCollageRows) {
              setRowImages((prev) => {
                const next = [...prev];
                next[mc.idx] = { ...next[mc.idx], status: 'loading' };
                return next;
              });
              try {
                const res = await queueImageGen('generate', 'motion-collage-auto', () =>
                  // eslint-disable-next-line no-restricted-syntax -- paid-gen RPC
                  fetch('/api/generate/production-doc/motion-collage', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      grid: mc.grid,
                      panelPrompts: mc.panelPrompts,
                      stylePreset,
                      motionCollageSettings: mcSettings,
                      characterDescriptions,
                    }),
                  }),
                );
                const data = (await res.json()) as {
                  imageUrl?: string;
                  panelUrls?: string[];
                  collageImageUrl?: string;
                  error?: string;
                };
                if (res.ok && data.imageUrl && data.panelUrls?.length) {
                  setRowImages((prev) => {
                    const next = [...prev];
                    next[mc.idx] = { status: 'done', imageUrl: data.imageUrl!, source: 'generated' };
                    return next;
                  });
                  setDoc((prev) => {
                    if (!prev) return prev;
                    const nextRows = [...prev.rows];
                    nextRows[mc.idx] = {
                      ...nextRows[mc.idx],
                      image_url: data.imageUrl,
                      motion_collage_image_url: data.collageImageUrl,
                      motion_collage_panel_urls: data.panelUrls,
                    };
                    return { ...prev, rows: nextRows };
                  });
                  console.info('[prodoc auto motion-collage] row done', {
                    row_index: mc.idx,
                    panel_count: data.panelUrls.length,
                  });
                } else {
                  setRowImages((prev) => {
                    const next = [...prev];
                    next[mc.idx] = { status: 'error', error: data.error ?? `HTTP ${res.status}` };
                    return next;
                  });
                  console.warn('[prodoc auto motion-collage] row failed', {
                    row_index: mc.idx,
                    status: res.status,
                    error: data.error,
                  });
                }
              } catch (err) {
                setRowImages((prev) => {
                  const next = [...prev];
                  next[mc.idx] = {
                    status: 'error',
                    error: err instanceof Error ? err.message : 'Failed',
                  };
                  return next;
                });
              }
            }
            console.info('[prodoc auto motion-collage] all done', {
              count: motionCollageRows.length,
            });
          })();
        }
      }

      // Build the save payload once and stash it on a ref so the
      // banner's Retry button can reissue the same save without
      // rebuilding from current page state (which may have diverged
      // since the failed attempt — retry should ship what the user
      // thought they saved, not a moving target).
      const savePayload: Parameters<typeof saveProductionDocEntry>[0] = {
        title: result.title || topic || niche,
        niche: result.niche || niche,
        topic,
        modelId,
        shotCount: result.rows.length,
        totalDuration: result.total_duration,
        totalWords: result.total_words,
        stylePreset,
        doc: result,
        script: script.trim() || undefined,
        videoTitle: scheduleItem?.title?.trim() || topic.trim() || undefined,
        scheduleItemId: scheduleItemId || undefined,
        // Persist the voiceover URL on the saved entry so the
        // shot-graph editor (/edit/[projectId]) can replay audio in
        // its preview without re-fetching from a separate source.
        // Empty string means "no VO yet" — saved as undefined so
        // older entries' "voiceoverUrl missing" path stays distinct
        // from "explicitly cleared."
        voiceoverUrl: voiceoverUrl || undefined,
      };
      pendingSavePayloadRef.current = savePayload;

      // 2026-06-04: tri-state save handling. The 2026-06-04 silent-loss
      // post-mortem (see _plans/2026-06-04-prevent-production-doc-silent-
      // loss.md) drove the change: a failed initial save MUST surface a
      // banner, and the page MUST refuse to set `historyEntryId` to a
      // non-UUID synthetic id (which silently breaks every downstream
      // save).
      let savedEntry: ProductionDocHistoryEntry | null = null;
      try {
        savedEntry = await saveProductionDocEntry(savePayload);
      } catch (err) {
        if (err instanceof HistorySaveError) {
          console.warn('[doc-save initial] failed', { kind: err.kind, status: err.httpStatus });
          setSaveFailure({ kind: err.kind, message: err.message, retrying: false });
          appendLog(`✗ Couldn't save to server: ${err.message}`);
          toast.error(err.message, { duration: 12000 });
          // Don't rethrow — the user's doc IS in memory. The banner
          // gives them the retry path. Falling through to image gen
          // would attach images to a non-existent server row, so
          // skip the post-save side-effects entirely.
          appendLog(`⚠ Doc kept in memory only — fix sign-in / connection and click Retry on the red banner.`);
          // Surface to the outer finally → setGenerating(false).
          return;
        }
        throw err;
      }

      if (savedEntry) {
        if (isUuid(savedEntry.id)) {
          // Happy path: real server UUID. Bind historyEntryId.
          setHistoryEntryId(savedEntry.id);
          setHistoryItems((prev) => [savedEntry!, ...prev.filter((p) => p.id !== savedEntry!.id)]);
          setSaveFailure(null);
        } else {
          // Synthetic id from the queue-and-retry fallback (server
          // returned 5xx with valid auth scope). The entry IS in
          // `__history_pending__` and `drainPending` will rebind on
          // the next list fetch. Until then, refuse to set
          // historyEntryId — every downstream save path 400s on a
          // non-UUID id.
          console.warn('[doc-save initial] queued offline — historyEntryId NOT set', {
            syntheticId: savedEntry.id,
          });
          setSaveFailure({
            kind: 'queued_offline',
            message: 'Server save deferred (transient error). Your work is in memory + offline queue; click Retry to sync now, or it will sync on the next page reload.',
            retrying: false,
          });
          setHistoryItems((prev) => [savedEntry!, ...prev]);
          appendLog(`⚠ Doc kept in memory + offline queue — click Retry on the banner to sync now.`);
        }
      }
      appendLog(`✓ ${result.rows.length} shots generated`);
      toast.success(`Production doc ready — ${result.rows.length} shots`);

      // Schedule writeback now goes through the saver registration:
      //   - <ScheduleSaverRegistration autoStamp={...}> silently stamps the
      //     `latest_production_doc` fingerprint as soon as the doc is parsed.
      //   - The banner's "Save production doc" button re-pushes the same
      //     metadata with a confirmation toast and offers an optional
      //     advance to "Recording".
      setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);

      // Fire-and-forget image generation — passes the same abort signal so Stop also cancels images.
      // Pass the freshly-returned doc's overlays_disabled flag explicitly
      // because React state hasn't re-rendered yet (see generateImages signature).
      generateImages(result.rows, controller.signal, result.overlays_disabled === true).catch(err => {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.error('Image generation error:', err);
        }
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        appendLog('⊘ Cancelled');
        toast.info('Generation cancelled');
      } else {
        const msg = err instanceof Error ? err.message : 'Generation failed';
        appendLog(`✗ ${msg}`);
        toast.error(msg);
      }
    } finally {
      setGenerating(false);
      // Do NOT null abortControllerRef here. generateImages above is
      // fire-and-forget and may still be running for the next ~30–60 s ×
      // (rows / concurrency). The image-progress UI still exposes a Stop
      // button bound to the same controller, so the ref must stay live
      // until generateImages finishes (it clears the ref itself on exit).
      // Nulling here previously made Stop a silent no-op during image gen.
    }
  }

  // ── Google Sheets export

  async function exportToSheets() {
    if (!doc) return;
    setSheetsExporting(true);
    setSheetsUrl(null);
    try {
      const exportData = {
        title: doc.title || topic || niche,
        niche: doc.niche,
        totalDuration: doc.total_duration,
        totalWords: doc.total_words,
        speakingPaceWpm: doc.speaking_pace_wpm,
        rows: doc.rows.map((r, i) => ({
          timecode: r.timecode || '',
          script_text: r.script_text || '',
          visual_type: r.visual_type || '',
          visual_description: r.visual_description || '',
          stock_search_terms: r.stock_search_terms || '',
          overlay_stock_terms: r.overlay_stock_terms || '',
          ai_image_prompt: r.ai_image_prompt || '',
          on_screen_text: r.on_screen_text || '',
          notes: r.notes || '',
          imageUrl: rowImages[i]?.imageUrl,
          searchUrl: rowImages[i]?.searchUrl,
        })),
      };
      // eslint-disable-next-line no-restricted-syntax -- export RPC: awaits and uses response (sheet URL)
      const res = await fetch('/api/production-doc/export-sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportData }),
      });
      const data = await safeJson(res);
      if (!res.ok) {
        if ((data.error as string) === 'NEEDS_GOOGLE_AUTH') {
          toast.error(
            (data.message as string) || 'Connect your Google account in Settings to export to Sheets.',
            { duration: 8000 },
          );
          return;
        }
        if ((data.error as string) === 'NEEDS_REAUTH') {
          toast.error(
            (data.message as string) ||
            'Google Sheets access not granted — reconnect in Settings → Google Account',
            { duration: 8000 },
          );
          return;
        }
        throw new Error((data.error as string) || 'Export failed');
      }
      const url = data.sheetUrl as string;
      setSheetsUrl(url);
      window.open(url, '_blank', 'noopener,noreferrer');
      toast.success('Exported to Google Sheets!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setSheetsExporting(false);
    }
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const estDuration = wordCount > 0
    ? `~${Math.floor(wordCount / speakingPace)}:${String(Math.round(((wordCount / speakingPace) % 1) * 60)).padStart(2, '0')}`
    : null;
  // Parse "mm:ss" actual voiceover duration → derive real WPM for timecode accuracy
  const actualDurationSecs = (() => {
    const parts = actualDuration.trim().split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s) && s < 60) return m * 60 + s;
    }
    return 0;
  })();
  const effectiveWpm = actualDurationSecs > 0 && wordCount > 0
    ? Math.round(wordCount / (actualDurationSecs / 60))
    : speakingPace;

  // ── Voiceover-aligned scene timing ───────────────────────────────────────────

  /**
   * Canonical script seen by the alignment cache. Memoised so the
   * drift-check effect doesn't recompute on every render, and so the
   * dependency comparison (string equality) is cheap.
   */
  const canonicalScript = React.useMemo(() => {
    if (!doc) return '';
    return buildCanonicalScript(doc.rows.map((r) => stripProductionMarkers(r.script_text)));
  }, [doc]);

  /**
   * Trigger an alignment request. Tracked by an incrementing request
   * id so a slow in-flight response can't clobber a newer one if the
   * user clicks "Re-align" twice in a row.
   */
  const runAlignment = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (!doc || !voiceoverUrl) return;
    if (!VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)) return;
    if (!canonicalScript.trim()) return;

    const reqId = ++alignmentReqRef.current;
    setAlignmentStatus('syncing');
    setAlignmentDetail(null);

    try {
      // eslint-disable-next-line no-restricted-syntax -- alignment RPC: awaits and uses response (timing data)
      const res = await fetch('/api/voiceovers/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath: voiceoverUrl,
          rowScripts: doc.rows.map((r) => r.script_text),
          forceRefresh: opts?.forceRefresh ?? false,
        }),
      });
      if (reqId !== alignmentReqRef.current) return;
      const data = (await safeJson(res)) as {
        status?: string;
        reason?: string;
        alignment?: import('@/lib/elevenlabs').ForcedAlignmentResponse;
      };
      if (!res.ok) {
        setAlignmentStatus('failed');
        setAlignmentDetail(typeof data.reason === 'string' ? data.reason : 'Alignment request failed.');
        return;
      }
      if (data.status === 'ready') {
        setAlignmentStatus('ready');
        setAlignmentDetail(null);
        setAlignedAtScript(canonicalScript);
        // Capture the alignment payload so the preview can apply it.
        // The render route fetches the same alignment server-side (via
        // the body.voiceoverAlignment hint), so the two paths stay in
        // sync. Falsy `alignment` = older response shape; we keep
        // status='ready' but the preview will fall back to estimated
        // timing for THIS session until a re-align happens.
        if (data.alignment) {
          setVoiceoverAlignment(data.alignment);
          console.info('[alignment captured]', {
            wordCount: data.alignment.words?.length ?? 0,
          });
        }
      } else {
        setAlignmentStatus('failed');
        setAlignmentDetail(typeof data.reason === 'string' ? data.reason : 'Alignment failed.');
      }
    } catch (err) {
      if (reqId !== alignmentReqRef.current) return;
      setAlignmentStatus('failed');
      setAlignmentDetail(err instanceof Error ? err.message : 'Alignment request errored.');
    }
  }, [doc, voiceoverUrl, canonicalScript]);

  /**
   * Re-alignment policy (see plan section 'Re-alignment policy'):
   *   - no prior alignment      → run after a 600ms settle delay
   *   - drift ≤ 5%              → soft re-align, cursor walk absorbs it
   *   - 5% < drift ≤ 20%        → background re-align after 1s debounce
   *   - drift > 20%             → 'stale' pill, manual re-align or
   *                               re-record needed
   *
   * Voiceover-change handling is folded in via `lastVoiceoverUrlRef`
   * so a single effect reset gets the new audio's anchor cleared
   * atomically — splitting that into a second effect would flash
   * "Synced to voiceover" for one render against the OLD audio
   * before the clear propagated.
   */
  const lastVoiceoverUrlRef = useRef<string>(voiceoverUrl);
  useEffect(() => {
    // Voiceover changed → clear the anchor and exit. The state update
    // triggers another effect run with the cleared anchor, which then
    // proceeds through the normal "no prior alignment" branch below.
    if (lastVoiceoverUrlRef.current !== voiceoverUrl) {
      lastVoiceoverUrlRef.current = voiceoverUrl;
      if (alignedAtScript !== null) {
        setAlignedAtScript(null);
        setAlignmentStatus('idle');
        setAlignmentDetail(null);
        // Stale alignment vs new voiceover URL — drop the cached payload
        // too. Letting the preview keep using the old timestamps against
        // the new audio would create the exact narration-frame drift
        // bug 2 is fixing.
        setVoiceoverAlignment(null);
        return;
      }
    }

    if (!doc || !voiceoverUrl) {
      setAlignmentStatus('idle');
      setAlignmentDetail(null);
      setVoiceoverAlignment(null);
      return;
    }
    if (!VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)) {
      setAlignmentStatus('unsupported');
      setAlignmentDetail('Save this voiceover to the workspace library to enable scene sync.');
      return;
    }
    if (!canonicalScript.trim()) {
      setAlignmentStatus('idle');
      return;
    }

    if (!alignedAtScript) {
      const timer = setTimeout(() => { void runAlignment(); }, 600);
      return () => clearTimeout(timer);
    }

    const drift = scriptDriftRatio(alignedAtScript, canonicalScript);
    if (drift <= 0.05) {
      setAlignmentStatus('ready');
      setAlignmentDetail(null);
      return;
    }
    if (drift > 0.20) {
      setAlignmentStatus('stale');
      setAlignmentDetail(`Script drifted ~${Math.round(drift * 100)}% since the last alignment.`);
      return;
    }
    const timer = setTimeout(() => { void runAlignment(); }, 1000);
    return () => clearTimeout(timer);
  }, [doc, voiceoverUrl, canonicalScript, alignedAtScript, runAlignment]);

  // ── Video render ─────────────────────────────────────────────────────────────

  /**
   * Walk every row and find clips that EXIST in the per-cell localStorage
   * signature map but DIDN'T make it back into `rowVideoClips` state
   * (typically because `prodoc_last_result` was cleared / quota-exceeded
   * / history-sidebar restored without bringing them, etc).
   *
   * Returns a per-row missing list. Used as a pre-render gate: if any
   * row has a generated clip the renderer would silently ignore, we
   * stop and ask the user to reload them before kicking off the render
   * — otherwise they'd ship a stills-only MP4 and pay again for the
   * animations they already generated. See plan
   * `_plans/2026-05-17-render-state-hardening.md`.
   */
  type MissingClip = { rowIndex: number; clipId: string; signature: string };
  const findMissingClipsForRender = useCallback((): MissingClip[] => {
    if (!doc?.rows) return [];
    const sigMap = readBrollLsMap();
    const liveClips = rowVideoClipsRef.current;
    const missing: MissingClip[] = [];
    doc.rows.forEach((row, i) => {
      const sig = brollRowSignatureInput({
        timecode: row.timecode,
        visual_description: row.visual_description,
      });
      const clipId = sigMap[sig];
      if (!clipId) return;
      const current = liveClips[i];
      if (current?.status === 'ready' && current.videoUrl) return;
      missing.push({ rowIndex: i, clipId, signature: sig });
    });
    return missing;
  }, [doc]);

  /**
   * Reload a batch of missing clips by id. Hits the SAME `/api/broll/{id}`
   * endpoint BrollCell uses on mount, then dispatches each result
   * through `handleBrollClipChange` so the parent's `rowVideoClips`
   * actually updates. Errors per-clip are isolated — we still try the
   * rest. Returns the list of clips that failed to reload (so the
   * modal can keep them visible).
   */
  const reloadMissingClips = useCallback(async (missing: MissingClip[]): Promise<MissingClip[]> => {
    const stillMissing: MissingClip[] = [];
    for (const m of missing) {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, polls broll clip status
        const res = await fetch(`/api/broll/${m.clipId}`, { cache: 'no-store' });
        if (!res.ok) {
          console.warn('[render preflight] reload failed', { rowIndex: m.rowIndex, clipId: m.clipId, status: res.status });
          stillMissing.push(m);
          continue;
        }
        const data = (await res.json()) as {
          clip?: { id: string; status: BrollStatus; video_url: string | null; duration_seconds?: number | null };
        };
        if (data.clip && data.clip.status === 'ready' && data.clip.video_url) {
          handleBrollClipChange(m.rowIndex, {
            id: data.clip.id,
            status: data.clip.status,
            video_url: data.clip.video_url,
            duration_seconds: data.clip.duration_seconds,
          });
        } else {
          stillMissing.push(m);
        }
      } catch (err) {
        console.warn('[render preflight] reload threw', { rowIndex: m.rowIndex, clipId: m.clipId, err: err instanceof Error ? err.message : String(err) });
        stillMissing.push(m);
      }
    }
    return stillMissing;
  }, [handleBrollClipChange]);

  // Modal state: non-null = modal open with these missing clips.
  // `reloading` flips while the Reload button is in flight.
  const [missingClipsModal, setMissingClipsModal] = useState<{
    missing: MissingClip[];
    reloading: boolean;
  } | null>(null);

  // Keep the asset-state refs in sync with the live state on every
  // commit. Tiny effect; the cost is one assignment per render and
  // it eliminates the stale-closure class of bug in `executeRender`.
  useEffect(() => { rowVideoClipsRef.current = rowVideoClips; }, [rowVideoClips]);
  useEffect(() => { rowImagesRef.current = rowImages; }, [rowImages]);
  useEffect(() => { rowOverlaysRef.current = rowOverlays; }, [rowOverlays]);

  // Shared dependency for the two mount-time hydration effects below
  // (Phase 3 + Phase 2). Reading `doc?.rows?.length` directly inside the
  // dep array would re-fire on every keystroke that mutates a row; using
  // the row COUNT alone keeps the effects scoped to "doc identity
  // changed" without churning on row edits.
  const docRowsLength = doc?.rows?.length ?? 0;

  // ── Entry hydration of images + overlays (Phase 3) ─────────────────────────
  //
  // Mount-time recovery for stills + overlays from the canonical history
  // entry. Phase 1 made the entry the durable record; this effect is
  // what reads it back on refresh when the localStorage bundle came
  // home short (quota-trimmed save). Clips are handled by Phase 2's
  // DB hydration instead — they don't have URLs on the entry, only ids.
  //
  // Merge policy: only fill in rows where the current state is missing
  // or 'idle'. Don't overwrite 'loading' (live generation), 'done' (the
  // user already has it), or 'error' (their explicit "retry" state). The
  // effect is idempotent — once everything's hydrated, subsequent runs
  // are no-ops via the `changed` flag inside the functional setStates.
  // See plan `_plans/2026-05-17-image-overlay-entry-hydration.md`.
  useEffect(() => {
    if (!historyEntryId || !doc?.rows?.length || historyItems.length === 0) return;
    const entry = historyItems.find((e) => e.id === historyEntryId);
    if (!entry) return;

    let imagesApplied = 0;
    let overlaysApplied = 0;

    if (entry.rowImages && Object.keys(entry.rowImages).length > 0) {
      setRowImages((prev) => {
        const next = prev.length >= doc.rows.length
          ? [...prev]
          : [...prev, ...new Array(doc.rows.length - prev.length).fill({ status: 'idle' })];
        let changed = false;
        doc.rows.forEach((_row, i) => {
          const entryUrl = entry.rowImages?.[i];
          if (!entryUrl) return;
          const cur = next[i];
          // Respect every non-idle state: 'loading' is an in-flight
          // generation we mustn't clobber; 'done' is what we'd be
          // restoring TO; 'error' is the user's signal that they want
          // to retry that specific row. Only 'idle' / missing fills.
          if (!cur || cur.status === 'idle') {
            next[i] = { status: 'done', imageUrl: entryUrl };
            imagesApplied++;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }

    if (entry.rowOverlays && Object.keys(entry.rowOverlays).length > 0) {
      setRowOverlays((prev) => {
        const next: Record<number, RowOverlayState> = { ...prev };
        let changed = false;
        Object.entries(entry.rowOverlays!).forEach(([k, v]) => {
          const i = Number(k);
          if (!Number.isFinite(i) || !v) return;
          const cur = next[i];
          // Same merge policy as images: only fill empty / idle slots.
          if (!cur || cur.status === 'idle') {
            next[i] = v as RowOverlayState;
            overlaysApplied++;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }

    console.info('[entry hydrate]', {
      historyEntryId,
      imagesFromEntry: entry.rowImages ? Object.keys(entry.rowImages).length : 0,
      imagesApplied,
      overlaysFromEntry: entry.rowOverlays ? Object.keys(entry.rowOverlays).length : 0,
      overlaysApplied,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntryId, docRowsLength, historyItems]);

  // ── DB hydration of B-roll clips (Phase 2) ──────────────────────────────────
  //
  // When the doc is associated with a saved history entry, sweep
  // `broll_clips` for every clip tagged with that doc's id and bridge
  // them into state. Closes the cross-device / cleared-localStorage gap
  // Phase 1's per-cell mount-hydration couldn't cover. Runs once per
  // (historyEntryId, doc.rows-length) combination — once per page mount
  // for typical usage, plus once more if the user clicks a different
  // history entry.
  //
  // Idempotent with Phase 1's per-cell hydration: `handleBrollClipChange`
  // no-ops when the new entry equals the existing one. See plan
  // `_plans/2026-05-17-broll-doc-id-hydration.md`.
  useEffect(() => {
    if (!historyEntryId || !doc?.rows?.length) return;
    let cancelled = false;
    (async () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- GET, lists broll clips
        const res = await fetch(
          `/api/broll?productionDocId=${encodeURIComponent(historyEntryId)}&limit=200`,
          { cache: 'no-store' },
        );
        if (!res.ok) {
          console.warn('[broll db-hydrate] list failed', { status: res.status, historyEntryId });
          return;
        }
        const data = (await res.json()) as { clips?: import('@/lib/broll-types').BrollClipRow[] };
        if (cancelled || !data.clips?.length) {
          console.info('[broll db-hydrate]', { historyEntryId, fetched: 0, applied: 0, skipped: 0 });
          return;
        }

        // Build a signature → rowIndex lookup for the CURRENT doc. Clips
        // whose stored row_signature doesn't match (e.g. user edited the
        // visual_description after generation) are skipped; they remain
        // in the workspace clip library but aren't auto-attached.
        const sigToIndex = new Map<string, number>();
        doc.rows.forEach((row, i) => {
          const sig = brollRowSignatureInput({
            timecode: row.timecode,
            visual_description: row.visual_description,
          });
          sigToIndex.set(sig, i);
        });

        // The DB query returns rows ordered by created_at DESC, so the
        // first clip we see for any signature is the freshest. Skip
        // duplicates to avoid clobbering with an older replay.
        const seen = new Set<string>();
        const lsMap = readBrollLsMap();
        const stubAdditions: Record<number, import('@/lib/broll-types').BrollClipRow> = {};
        let applied = 0;
        let skippedNoSig = 0;
        let skippedSigMismatch = 0;

        for (const clip of data.clips) {
          if (!clip.row_signature) { skippedNoSig++; continue; }
          if (seen.has(clip.row_signature)) continue;
          seen.add(clip.row_signature);
          const idx = sigToIndex.get(clip.row_signature);
          if (idx === undefined) { skippedSigMismatch++; continue; }

          // Bridge to parent state — drives the renderer.
          handleBrollClipChange(idx, {
            id: clip.id,
            status: clip.status,
            video_url: clip.video_url,
            duration_seconds: clip.duration_seconds,
          });
          // Hand to the cell as initialClip so its own UI reflects the
          // clip immediately (avoids the cell briefly showing 'idle'
          // after a successful hydration).
          stubAdditions[idx] = clip;
          // Seed the per-cell localStorage map so the next page mount
          // can take the faster per-cell path even without re-querying.
          lsMap[clip.row_signature] = clip.id;
          applied++;
        }

        if (cancelled) return;
        if (Object.keys(stubAdditions).length > 0) {
          setRowBatchStubs((prev) => ({ ...prev, ...stubAdditions }));
        }
        writeBrollLsMap(lsMap);
        console.info('[broll db-hydrate]', {
          historyEntryId,
          fetched: data.clips.length,
          applied,
          skippedNoSig,
          skippedSigMismatch,
        });
      } catch (err) {
        console.warn('[broll db-hydrate] threw', err instanceof Error ? err.message : err);
      }
    })();
    return () => { cancelled = true; };
    // We deliberately only re-run when the doc identity (historyEntryId)
    // or its row count changes — NOT on every row edit. Editing a row's
    // text shouldn't re-sweep the DB; the per-cell localStorage map and
    // existing state already track the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyEntryId, docRowsLength]);

  /**
   * Phase 0 telemetry probe (shot-graph editor plan + overlay-system
   * overhaul plan). Fire-and-forget POST to /api/editor-telemetry; never
   * blocks the caller, never throws into the UI. A failed insert is a
   * logged warning server-side — the calling flow continues regardless.
   */
  async function recordEditorTelemetry(
    event:
      | 'render_clicked'
      | 'external_edit_intent'
      | 'stayed_here'
      | 'overlay_drag'
      | 'overlay_resize'
      | 'overlay_accept'
      | 'overlay_reset'
      | 'overlay_rethink',
    extra: { payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      console.info('[editor telemetry] post', { event, projectId: historyEntryId });
      // Phase 3.2: route through the durable outbox so a tab close
      // mid-flight doesn't lose the metric. Telemetry is the classic
      // fire-and-forget use case mutate() was designed for.
      mutate('editor.telemetry', {
        url: '/api/editor-telemetry',
        method: 'POST',
        body: {
          event,
          project_id: historyEntryId,
          payload: extra.payload ?? null,
        },
      });
    } catch (err) {
      console.warn('[editor telemetry] post failed', {
        event,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Entry point for the Render button. Runs the missing-clips
   * preflight: if any row has a generated clip in localStorage but
   * NOT in state, opens `MissingClipsModal` and aborts. The modal
   * either reloads the clips (then continues) or asks for explicit
   * confirmation to render anyway. When nothing's missing, falls
   * straight through to `executeRender`.
   */
  async function startVideoRender() {
    if (!doc) return;
    // 2026-06-04 hard gate: refuse to render against a non-UUID
    // historyEntryId. Render submits the project id to Lambda which
    // POSTs back row-asset URLs keyed to that id. A synthetic local-
    // only id silently fails server-side and burns Lambda minutes for
    // nothing. The banner above already tells the user to resolve
    // the save failure first; this is the defense-in-depth gate.
    if (!historyEntryId || !isUuid(historyEntryId)) {
      const reason = saveFailure
        ? 'Resolve the server-save banner above before rendering.'
        : 'Save the doc to the server before rendering (the doc needs a real server id).';
      toast.error(reason);
      console.warn('[render preflight] refused — no UUID historyEntryId', { historyEntryId });
      return;
    }
    // Phase 0: record render-click intent regardless of whether the
    // missing-clips preflight short-circuits. Captures the moment
    // the creator commits to rendering — the survey on `done` then
    // tells us whether they plan to finish here or elsewhere.
    setRenderSurveyDismissed(false);
    void recordEditorTelemetry('render_clicked', {
      payload: {
        shot_count: doc.rows.length,
        has_voiceover: Boolean(voiceoverUrl),
        has_overlays: Object.values(rowOverlays).some(Boolean),
        animate_scenes: animateScenes,
      },
    });
    const missing = findMissingClipsForRender();
    console.info('[render preflight]', {
      missingClipCount: missing.length,
      rowIndexes: missing.map(m => m.rowIndex),
    });
    if (missing.length > 0) {
      setMissingClipsModal({ missing, reloading: false });
      return;
    }
    await executeRender();
  }

  /**
   * The actual render submission. Extracted from `startVideoRender` so
   * the missing-clips gate can call it after the user reloads or
   * explicitly bypasses the warning. Reads the LATEST `rowVideoClips` /
   * `rowImages` / `rowOverlays` from state at call time (closure over
   * the most recent render), so a reload that just bridged clips into
   * state lands in the config we send to the server.
   */
  async function executeRender() {
    if (!doc) return;
    // Read asset state through refs so a post-reload call (after the
    // missing-clips modal bridged fresh clips into state) sees the
    // committed values instead of the closure's stale snapshot. See
    // `_plans/2026-05-17-render-state-hardening.md`.
    const liveRowVideoClips = rowVideoClipsRef.current;
    const liveRowImages = rowImagesRef.current;
    const liveRowOverlays = rowOverlaysRef.current;
    const rowClipsArr = doc.rows.map((_, i) => liveRowVideoClips[i] ?? null);
    const rowLockedArr = doc.rows.map((row) =>
      Boolean(
        rowLockSignatures[
          brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
        ],
      ),
    );
    const config = productionDocToVideoConfig(doc, liveRowImages, {
      voiceoverUrl: voiceoverUrl || undefined,
      brand: effectiveBrandKit,
      rowVideoClips: rowClipsArr,
      rowLockedAsStill: rowLockedArr,
      animateScenes,
      rowOverlays: liveRowOverlays,
      suppressLowerThirds,
      effectiveStyleSlug,
      // Server-side Remotion renderer needs the proxy URL (clean URL
      // with no R2 presign query string) — see the proxy route at
      // `/api/broll/[id]/video`. In-browser preview keeps using the
      // direct R2 URL via VideoPlayerMemo (which omits this flag) to
      // avoid funneling preview scrub bytes through Vercel.
      useBrollProxy: true,
    });
    // One-shot diagnostic so a post-mortem can see exactly what the
    // server received. Lists per-row presence of imageUrl + videoUrl so
    // the "rendered MP4 had no animations" mystery is debuggable.
    //
    // Uses console.warn (yellow) so it stands out against the green
    // ambient `[render-timing] config built` noise during normal
    // typing. Stashes the full config on `window.__lastRenderConfig`
    // so a creator can paste the line below into DevTools and copy
    // the JSON without expanding chevrons:
    //   `copy(JSON.stringify(window.__lastRenderConfig, null, 2))`
    const rowsSummary = config.shots.map((s, i) => ({
      i,
      hasImage: Boolean(s.imageUrl),
      hasVideo: Boolean(s.videoUrl),
      sceneType: s.sceneType,
      hasOst: Boolean(s.onScreenText),
      hasSectionTitle: Boolean(s.sectionTitle),
      sceneFade: s.sceneFade,
      transitionIn: s.transitionInId,
    }));
    const counts = {
      rows: rowsSummary.length,
      withImage: rowsSummary.filter(r => r.hasImage).length,
      withVideo: rowsSummary.filter(r => r.hasVideo).length,
      withOst: rowsSummary.filter(r => r.hasOst).length,
      withSectionTitle: rowsSummary.filter(r => r.hasSectionTitle).length,
      sceneTypes: rowsSummary.reduce<Record<string, number>>((acc, r) => {
        acc[r.sceneType] = (acc[r.sceneType] ?? 0) + 1;
        return acc;
      }, {}),
    };
    console.warn('[render config built] ⬇ Click to expand. Top-level flags + per-row video presence.', {
      counts,
      flags: {
        voiceoverUrlPresent: Boolean(config.voiceoverUrl),
        animateScenes,
        suppressLowerThirds: config.suppressLowerThirds,
        sceneFadeEnabled: config.sceneFadeEnabled,
        stripeHeightFraction: config.thumbnail?.stripeHeightFraction,
      },
      rowsWithoutVideo: rowsSummary.filter(r => !r.hasVideo).map(r => r.i),
      rows: rowsSummary,
    });
    if (typeof window !== 'undefined') {
      (window as unknown as { __lastRenderConfig?: unknown }).__lastRenderConfig = config;
    }
    setRenderStatus('rendering');
    setRenderProgress(0);
    setRenderDownloadUrl(null);

    // Pass the alignment hint when the cache is warm AND the URL is a
    // proxy path the server-side route accepts. Falsy `voiceoverUrl`,
    // ElevenLabs-direct Blob URLs, and any non-ready alignment state
    // make the server fall back to estimated timing — same as today.
    //
    // `title` is cosmetic — only used to build the Download filename.
    // Falls back to the renderId server-side when missing.
    const body: Record<string, unknown> = { config, title: doc.title || null };
    if (
      alignmentStatus === 'ready' &&
      voiceoverUrl &&
      VOICEOVER_PROXY_PATH_RE.test(voiceoverUrl)
    ) {
      body.voiceoverAlignment = {
        audioPath: voiceoverUrl,
        rowScripts: doc.rows.map((r) => r.script_text),
      };
    } else if (alignmentStatus === 'syncing' || alignmentStatus === 'stale') {
      toast.warning('Rendering with estimated timing — voiceover alignment not ready.');
    }

    try {
      // eslint-disable-next-line no-restricted-syntax -- render RPC: awaits and uses response (render id)
      const res = await fetch('/api/render/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { renderId?: string; error?: string };
      if (!res.ok || !data.renderId) throw new Error(data.error || 'Failed to start render');

      setRenderId(data.renderId);

      // Poll for progress
      renderPollRef.current = setInterval(async () => {
        try {
          // eslint-disable-next-line no-restricted-syntax -- GET, polls render status
          const statusRes = await fetch(`/api/render/video?renderId=${data.renderId}`);
          const statusData = await statusRes.json() as {
            status: string; progress: number; downloadUrl?: string | null; error?: string;
            probeResults?: unknown | null;
          };

          setRenderProgress(statusData.progress ?? 0);

          // 2026-05-20: surface the server-side videoUrl probe results
          // ONCE per render so the creator can see whether the Vercel
          // server can actually reach the per-shot R2 URLs. Stashed on
          // window so it's also accessible from DevTools across polls.
          if (statusData.probeResults && !(window as unknown as { __renderProbeSeen?: string }).__renderProbeSeen?.startsWith(data.renderId!)) {
            (window as unknown as { __renderProbeSeen?: string }).__renderProbeSeen = data.renderId!;
            (window as unknown as { __lastRenderProbe?: unknown }).__lastRenderProbe = statusData.probeResults;
            console.warn('[render] videoUrl probe (from server)', statusData.probeResults);
          }

          if (statusData.status === 'done') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('done');
            setRenderDownloadUrl(statusData.downloadUrl ?? null);
            toast.success('Video rendered! Ready to download.');
          } else if (statusData.status === 'error') {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            setRenderStatus('error');
            toast.error(`Render failed: ${statusData.error || 'Unknown error'}`);
          }
        } catch { /* polling error — keep trying */ }
      }, 2000);
    } catch (err) {
      setRenderStatus('error');
      toast.error(err instanceof Error ? err.message : 'Render failed');
    }
  }

  // Cleanup render polling on unmount
  useEffect(() => {
    return () => { if (renderPollRef.current) clearInterval(renderPollRef.current); };
  }, []);

  // ── Saver registration ────────────────────────────────────────────────────
  // Production doc's primary artifact is a row-list (`doc.rows`) with timing
  // metadata. Schedule-side we only stamp the fingerprint — the full doc
  // lives in localStorage history (linked via `history_entry_id`).
  const prodDocReady = !!doc && (doc.rows?.length ?? 0) > 0;
  const prodDocRunKey = doc && historyEntryId
    ? `${historyEntryId}:${doc.rows?.length ?? 0}`
    : null;

  return (
    <ScheduleLinkProvider item={scheduleItem}>
      <ImageGenThrottleToast />
      {/* ─── Stacked top-of-viewport banners (2026-06-03) ──────────
          Single fixed container so PR1's remote-update banner and
          PR2's bulk-retry banner can coexist without overlap. Each
          banner self-conditionalises so the container collapses to
          nothing when neither is active. */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 90,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'none', // child banners restore via inline style
        }}
      >
        {/* Remote-update banner (PR1 doc-sync).
            Surfaces `saveStatus.kind === 'conflict'` from `useProject`.
            The polling effect flips to 'conflict' when an external
            write (pipeline tick, second tab) bumps the row version
            while the user has dirty local edits.
              - Reload: confirm dialog, clear local doc, re-hydrate.
                Discards uncommitted edits.
              - Continue editing: dismisses via acknowledgeConflict().
                Next save lands via last-write-wins. */}
        {project.saveStatus.kind === 'conflict' && (
          <div
            role="alert"
            aria-live="polite"
            style={{
              pointerEvents: 'auto',
              background: '#f59e0b',
              color: '#111',
              padding: '10px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 13,
              lineHeight: 1.4,
              boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <strong>This doc changed elsewhere.</strong>
              <span style={{ marginLeft: 8, opacity: 0.9 }}>
                The pipeline or another tab updated it while you were editing. Reload to see the latest, or continue to overwrite on next save.
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
              <button
                type="button"
                onClick={() => project.acknowledgeConflict()}
                style={{
                  background: 'transparent',
                  color: '#111',
                  border: '1px solid rgba(0,0,0,0.35)',
                  padding: '5px 12px',
                  borderRadius: 4,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Continue editing
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!window.confirm('Reload this doc? Any local edits you have not saved will be discarded.')) return;
                  console.info('[doc-sync banner]', { reason: 'user-reload', historyEntryId });
                  // Force-rehydrate flag bypasses both gates in the
                  // hydration effect (ref-already-matched +
                  // doc-already-set). Avoids the previous setDoc(null)
                  // which crashes unguarded render branches that
                  // assume doc is non-null.
                  hydratedForHistoryIdRef.current = null;
                  forceRehydrateRef.current = true;
                  void project.reload();
                }}
                style={{
                  background: '#111',
                  color: '#fff',
                  border: 'none',
                  padding: '5px 12px',
                  borderRadius: 4,
                  fontSize: 13,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                Reload
              </button>
            </div>
          </div>
        )}

        {/* Bulk failed-row banner (PR2 reliability).
            Shows when `failedRowCount > 0` — rows whose
            auto-pipeline attempts exhausted the per-class retry
            budget. Click Retry all → resets `attempts` + `last_error`
            on every failed row in one `persistDoc`. Next pipeline
            tick re-attempts them. */}
        {failedRowCount > 0 && (
          <div
            role="alert"
            aria-live="polite"
            style={{
              pointerEvents: 'auto',
              background: '#7f1d1d',
              color: '#fff',
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 13,
              lineHeight: 1.4,
              boxShadow: '0 2px 12px rgba(0,0,0,0.35)',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0, flex: '1 1 auto' }}>
              <strong>
                {failedRowCount} {failedRowCount === 1 ? 'shot' : 'shots'} failed to generate.
              </strong>
              <span style={{ marginLeft: 8, opacity: 0.9 }}>
                Each row shows its specific error. Click Retry all to re-queue them, or use the inline Retry button on the row.
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                const n = retryAllFailedRows();
                if (n > 0) {
                  toast.success(`Re-queued ${n} ${n === 1 ? 'shot' : 'shots'} for image generation.`);
                }
              }}
              style={{
                flex: '0 0 auto',
                background: '#fff',
                color: '#7f1d1d',
                border: 'none',
                padding: '5px 12px',
                borderRadius: 4,
                fontSize: 13,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              Retry all
            </button>
          </div>
        )}
      </div>
      <ScheduleSaverRegistration
        handle={{
          artifactLabel: 'production doc',
          isReady: prodDocReady,
          isDirty: prodDocReady && prodDocRunKey !== lastSavedProdDocRunKey,
          notReadyReason: 'Generate a production doc first',
          // Production doc → recording is a clean pipeline transition: once
          // the shot list exists, the user can start filming.
          nextStatus: { key: 'recording', label: 'Recording' },
          buildPatch: () => ({
            patch: {},
            customFieldsMerge: {
              latest_production_doc: {
                history_entry_id: historyEntryId,
                shot_count: doc!.rows?.length ?? 0,
                total_duration: doc!.total_duration,
                style_preset: stylePreset,
                generated_at: new Date().toISOString(),
                model_id: modelId,
              },
            },
          }),
          describeSaved: () => doc
            ? `${doc.rows?.length ?? 0} shots${doc.total_duration ? ` · ${doc.total_duration}` : ''}`
            : '',
          onSaved: () => setLastSavedProdDocRunKey(prodDocRunKey),
        }}
        autoStamp={{
          key: 'latest_production_doc',
          value: () => doc ? {
            history_entry_id: historyEntryId,
            shot_count: doc.rows?.length ?? 0,
            total_duration: doc.total_duration,
            style_preset: stylePreset,
            generated_at: new Date().toISOString(),
            model_id: modelId,
          } : null,
          runKey: prodDocRunKey,
        }}
      />
    <div className="p-6 max-w-full">
      {scheduleItem && <ScheduleLinkBanner item={scheduleItem} feature="Production Doc" />}

      {/* 2026-06-04 server-save failure banner. Persistent on purpose
          (no auto-dismiss) — the user MUST see this, because every
          downstream consumer (Open in editor, image gen, render,
          renderer's row-asset writes) silently breaks when the doc
          isn't on the server. See _plans/2026-06-04-prevent-production-
          doc-silent-loss.md for the post-mortem. */}
      {saveFailure && (() => {
        const isAmber = saveFailure.kind === 'queued_offline';
        const accent = isAmber ? '#fbbf24' : '#f87171';
        const bg = isAmber ? 'rgba(251, 191, 36, 0.08)' : 'rgba(239, 68, 68, 0.08)';
        const border = isAmber ? 'rgba(251, 191, 36, 0.55)' : 'rgba(239, 68, 68, 0.55)';
        const headline =
          saveFailure.kind === 'no_session'
            ? 'Not signed in — your work is NOT saved to the server'
            : saveFailure.kind === 'unauthorized'
              ? 'Your session expired — your work is NOT saved to the server'
              : saveFailure.kind === 'rejected'
                ? 'Server rejected the save — your work is NOT saved'
                : saveFailure.kind === 'queued_offline'
                  ? 'Server save deferred — work queued locally'
                  : 'Recent edits aren\'t reaching the server'; // mid_session_error
        return (
          <div
            role="alert"
            className="mb-4 rounded-md border p-3 flex items-start gap-3"
            style={{ background: bg, borderColor: border }}
          >
            <div className="text-sm font-semibold mt-0.5" style={{ color: accent }}>
              {isAmber ? '⏳' : '⚠'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: accent }}>
                {headline}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                {saveFailure.message}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                Your doc is in memory + browser cache. Image generation, Open in editor, and Render are disabled until the save succeeds.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void retryProductionDocSave()}
              disabled={saveFailure.retrying}
              className="px-3 py-1.5 rounded text-xs font-semibold border disabled:opacity-50 disabled:cursor-progress shrink-0"
              style={{ borderColor: border, color: accent }}
            >
              {saveFailure.retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        );
      })()}

      {/* ── Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Production Document
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Generate a shot-by-shot breakdown with timecodes, visuals, auto-generated AI images, and Google Images links
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Phase 3 follow-up — opt-in toggle for the new multi-pane
              editor view. Hidden until a doc is loaded (the editor
              view needs a doc to render anything meaningful). The
              `editorWriters` bundle, EditorView component, and full
              variant Inspector are all in git already; this button is
              what actually mounts them in front of the user. */}
          {doc && (
            <button
              type="button"
              onClick={() => setEditorViewMode((m) => (m === 'editor' ? 'grid' : 'editor'))}
              className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
              style={{
                background: editorViewMode === 'editor'
                  ? 'rgba(124,58,237,0.18)'
                  : 'rgba(124,58,237,0.06)',
                color: 'var(--accent-purple-bright)',
                border: '1px solid rgba(124,58,237,0.35)',
                cursor: 'pointer',
              }}
              title={
                editorViewMode === 'editor'
                  ? 'Switch back to the grid view (default).'
                  : 'Try the new multi-pane editor view as a fullscreen overlay. The grid view stays untouched underneath.'
              }
            >
              {editorViewMode === 'editor' ? '← Back to grid' : '🎬 Try new editor view'}
            </button>
          )}
          {/* New session — explicit, confirmation-gated. The form inputs
              (script, niche, topic, etc.) and the generated doc otherwise
              persist across refreshes; this button is how the user opts
              into a clean slate instead of getting one by accident. */}
          <button
            type="button"
            onClick={resetSession}
            className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
            style={{
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              border: '1px solid rgba(255,255,255,0.10)',
              cursor: 'pointer',
            }}
            title="Clear the current form and generated doc to start fresh. Previous generations stay in the history sidebar."
          >
            🆕 New session
          </button>
        </div>
      </div>

      {/* ── Input Panel */}
      <div className="glass rounded-xl p-5 mb-6 space-y-5">

        {/* Row: niche / topic / pace */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Niche *</label>
            <NichePicker
              value={niche}
              onChange={setNiche}
              suggestions={nicheHints}
              placeholder="e.g. Cybersecurity & Antivirus"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Video Topic</label>
            <AutocompleteInput
              value={topic}
              onChange={setTopic}
              suggestions={topicHints}
              placeholder="e.g. Top 5 Antivirus Mistakes"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Speaking Pace (wpm)
              {actualDurationSecs > 0 && wordCount > 0 ? (
                <span className="ml-2 font-normal" style={{ color: '#34d399' }}>
                  → {actualDuration} actual · {Math.round(wordCount / (actualDurationSecs / 60))} wpm computed
                </span>
              ) : estDuration && (
                <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                  → est. {estDuration} video
                </span>
              )}
            </label>
            <div className="flex gap-2">
              <select
                value={speakingPace}
                onChange={e => setSpeakingPace(Number(e.target.value))}
                className="input-field flex-1"
                disabled={actualDurationSecs > 0}
                style={{ opacity: actualDurationSecs > 0 ? 0.4 : 1 }}
              >
                <option value={110}>Slow — 110 wpm</option>
                <option value={125}>Moderate — 125 wpm</option>
                <option value={135}>Standard — 135 wpm</option>
                <option value={150}>Fast — 150 wpm</option>
                <option value={165}>Very Fast — 165 wpm</option>
              </select>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <input
                  type="text"
                  value={actualDuration}
                  onChange={e => setActualDuration(e.target.value.replace(/[^0-9:]/g, ''))}
                  placeholder="actual mm:ss"
                  className="input-field"
                  style={{ width: 120, paddingRight: actualDurationSecs > 0 ? 28 : undefined }}
                  title="Enter your actual voiceover recording length (e.g. 16:05) to compute exact timecodes"
                />
                {actualDurationSecs > 0 && (
                  <button
                    onClick={() => setActualDuration('')}
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', lineHeight: 1 }}
                    title="Clear"
                  >×</button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Creative Direction card */}
        <div
          className="rounded-lg p-4 space-y-4"
          style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.15)' }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent-purple-bright)' }}>
            Creative Direction
          </h3>

          {/* Style preset buttons */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                Visual Style
              </label>
              <button
                onClick={() => setStyleManagerOpen(true)}
                className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded"
                style={{ background: 'rgba(124,58,237,0.12)', color: 'var(--accent-purple-bright)', border: '1px solid rgba(124,58,237,0.3)' }}
                title="Create, edit, and delete saved styles"
              >
                Manage styles
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {availableStyles.map(p => {
                const active = stylePreset === p.id;
                const isSaved = p.origin === 'saved';
                const supportsOverlay = p.allow_overlay_stock;
                // ⭐ is filled when this style is the user's persistent
                // default for new sessions. Clicking the star toggles it
                // — clicking the empty star promotes that style; clicking
                // the filled star clears the default (back to library).
                const isUserDefault = userDefaultStyle === p.id;
                return (
                  <div key={p.id} className="inline-flex items-stretch">
                    <button
                      onClick={() => setStylePreset(p.id)}
                      className="px-3 py-1.5 rounded-l-lg text-xs font-medium transition-all flex items-center gap-1.5"
                      style={{
                        background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                        color: active ? '#a78bfa' : 'var(--text-secondary)',
                        border: active ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                        borderRight: 'none',
                      }}
                      title={p.description || (isSaved ? 'Saved style' : 'Built-in style')}
                    >
                      <span>{p.label}</span>
                      {isSaved && (
                        <span
                          className="text-[9px] px-1 rounded"
                          style={{ background: 'rgba(34,211,238,0.15)', color: '#22d3ee' }}
                          title="Workspace-saved style"
                        >
                          Saved
                        </span>
                      )}
                      {supportsOverlay && (
                        <span
                          className="text-[9px] px-1 rounded"
                          style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                          title="Mixes AI visuals with real-image overlays"
                        >
                          Mixed
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isUserDefault) {
                          // Clear → library fallback
                          setStyleAsDefault('');
                          setUserDefaultStyle('');
                        } else {
                          setStyleAsDefault(p.id);
                        }
                      }}
                      className="px-2 py-1.5 rounded-r-lg text-xs flex items-center"
                      style={{
                        background: active ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.05)',
                        color: isUserDefault ? '#fbbf24' : 'var(--text-muted)',
                        border: active ? '1px solid rgba(124,58,237,0.4)' : '1px solid var(--border)',
                      }}
                      title={
                        isUserDefault
                          ? 'This is your default style for new sessions. Click to clear.'
                          : 'Make this your default style for new sessions.'
                      }
                      aria-label={isUserDefault ? 'Clear default style' : 'Set as default style'}
                    >
                      {isUserDefault ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            </div>
            {/* v2 (2026-05-22) — cost preview for the active style.
                Rule 8: paid actions show their cost up-front. Reads
                from the i2i registry, falls through silently when
                the style has no preferred model (built-ins, refless
                saved styles). Inline + small so it doesn't crowd the
                picker on first impression. */}
            {(() => {
              const activeStyle = availableStyles.find(s => s.id === stylePreset);
              const activeModel = activeStyle?.preferred_cloud_model;
              if (!activeModel) return null;
              const costStr = formatI2ICostHint(activeModel);
              if (!costStr) return null;
              return (
                <div className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                  Per generated image: <strong>{costStr}</strong>
                </div>
              );
            })()}
          </div>

          {/* paint_explainer_v1 settings panel — mounts only when the
              active style is paint_explainer_v1 AND a doc exists. The
              first time a user picks this style, the panel appears
              after Generate so they can tweak the 8 motion knobs and
              see the renderer reflect the change in the preview.
              Pre-doc, the renderer hasn't run yet, so there's nothing
              to preview against; the inputs panel still cleanly
              communicates "pick style → generate → tune settings."
              See §14 of the architecture plan. */}
          {/* Doc-level pacing-profile picker. Mounts on EVERY render —
              pre-doc edits land in `pendingPacingProfile` and flow into
              the doc-gen API body so the LLM honours the user's chosen
              pace on the first run; post-doc edits land directly on
              `doc.pacing_profile`. Mirrors the same pre/post pattern the
              doodle motion-collage panel uses below. Pacing is a
              doc-level concern, not a style-specific one, so this panel
              is unconditional on style. */}
          <PacingProfilePanel
            value={doc?.pacing_profile ?? pendingPacingProfile}
            onChange={(next) => {
              if (doc) {
                setDoc((prev) => {
                  if (!prev) return prev;
                  const nextDoc = { ...prev, pacing_profile: next };
                  persistDoc(nextDoc);
                  return nextDoc;
                });
              } else {
                setPendingPacingProfile(next);
              }
            }}
          />


          {doc && stylePreset === 'paint_explainer_v1' && (
            <PaintExplainerV1SettingsPanel
              value={doc.paint_explainer_v1_settings}
              onChange={(next) => {
                setDoc((prev) => {
                  if (!prev) return prev;
                  const nextDoc = { ...prev, paint_explainer_v1_settings: next };
                  // PR3 QA pass (2026-06-03): pre-PR1 this onChange was
                  // local-only — settings tweaks lived in React state
                  // but never reached the server, so a refresh restored
                  // them from localStorage but a different device saw
                  // nothing. persistDoc routes through useProject.patch
                  // so the change syncs cross-tab + survives device
                  // switch. Mirrors the same fix in the pacing panel
                  // above and the Doodle settings panel below.
                  persistDoc(nextDoc);
                  return nextDoc;
                });
              }}
            />
          )}

          {/* doodle_explainer_2 motion-collage settings panel — mounts
              whenever the active style is doodle_explainer_2, regardless
              of whether a doc has been generated yet. Pre-generation
              edits land in `pendingMotionCollageSettings` and flow into
              the doc-gen API body so the LLM honours them on the first
              run; post-generation edits land directly in
              `doc.doodle_explainer_2_motion_collage_settings`. See
              `_plans/2026-05-31-doodle-explainer-2-motion-collage.md` (A). */}
          {stylePreset === 'doodle_explainer_2' && (
            <DoodleExplainer2MotionCollageSettingsPanel
              value={
                doc?.doodle_explainer_2_motion_collage_settings ?? pendingMotionCollageSettings
              }
              onChange={(next) => {
                if (doc) {
                  setDoc((prev) => {
                    if (!prev) return prev;
                    const nextDoc = {
                      ...prev,
                      doodle_explainer_2_motion_collage_settings: next,
                    };
                    // PR3 QA fix — same as Paint above. Server-side
                    // sync via persistDoc.
                    persistDoc(nextDoc);
                    return nextDoc;
                  });
                } else {
                  setPendingMotionCollageSettings(next);
                }
              }}
            />
          )}

          {/* Creative brief */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Creative Brief
            </label>
            <textarea
              value={creativeBrief}
              onChange={e => setCreativeBrief(e.target.value)}
              placeholder="Describe the mood, color palette, tone, or any specific visual direction… e.g. Dark cyberpunk aesthetic, neon blues and purples, futuristic UI overlays"
              className="input-field text-xs"
              style={{ minHeight: 68, resize: 'vertical' }}
            />
          </div>

          {/* Visual References — YouTube URLs or uploaded screenshots */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Visual References
            </label>
            <div className="flex gap-2 mb-2 flex-wrap">
              <input
                value={ytRefInput}
                onChange={e => setYtRefInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addYtRef(); } }}
                placeholder="Paste a YouTube URL and press Enter"
                className="input-field flex-1 text-xs"
                style={{ minWidth: 180 }}
              />
              <button onClick={addYtRef} className="btn-secondary text-xs px-3 shrink-0">
                + YouTube
              </button>
              <button
                onClick={() => screenshotInputRef.current?.click()}
                className="btn-secondary text-xs px-3 shrink-0"
              >
                + Screenshot
              </button>
              <input
                ref={screenshotInputRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={e => handleScreenshotUpload(e.target.files)}
              />
            </div>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
              Add YouTube videos or upload screenshots — AI will analyze the style and auto-fill the creative brief
            </p>
            {visualRefs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {visualRefs.map((ref, idx) => (
                  <div key={idx} className="relative group">
                    {ref.type === 'youtube' && ref.url ? (
                      <div style={{ position: 'relative' }}>
                        <a href={ref.url} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://img.youtube.com/vi/${extractYouTubeId(ref.url)}/mqdefault.jpg`}
                            alt="YouTube reference"
                            title={ref.analyzedStyle || ref.title || ref.url}
                            style={{ width: 100, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
                          />
                        </a>
                        {ref.analyzing && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-md" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
                            <div className="spinner" style={{ width: 16, height: 16 }} />
                          </div>
                        )}
                        {ref.analyzedStyle && !ref.analyzing && (
                          <div className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center" style={{ background: 'rgba(16,185,129,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}>
                            ✓ Style analyzed
                          </div>
                        )}
                        {ref.analysisFailed && !ref.analyzing && !ref.analyzedStyle && (
                          <button
                            onClick={() => analyzeYouTubeStyle(ref.url!, idx)}
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(239,68,68,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                            title="Analysis failed — click to retry"
                          >
                            ✗ Failed · retry
                          </button>
                        )}
                      </div>
                    ) : ref.type === 'screenshot' && ref.objectUrl ? (
                      <div style={{ position: 'relative' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={ref.objectUrl}
                          alt={ref.name || 'Screenshot'}
                          title={ref.analyzedStyle || ref.name}
                          style={{ width: 100, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
                        />
                        {ref.analyzing && (
                          <div
                            className="absolute inset-0 flex items-center justify-center rounded-md"
                            style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
                          >
                            <div className="spinner" style={{ width: 16, height: 16 }} />
                          </div>
                        )}
                        {ref.analyzedStyle && !ref.analyzing && (
                          <div
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(16,185,129,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                          >
                            ✓ Style analyzed
                          </div>
                        )}
                        {ref.analysisFailed && !ref.analyzing && !ref.analyzedStyle && (
                          <div
                            className="absolute bottom-0 left-0 right-0 rounded-b-md px-1 py-0.5 text-center"
                            style={{ background: 'rgba(239,68,68,0.85)', fontSize: '0.55rem', color: 'white', lineHeight: 1.2 }}
                            title="Style analysis failed"
                          >
                            ✗ Failed
                          </div>
                        )}
                      </div>
                    ) : null}
                    <button
                      onClick={() => setVisualRefs(prev => {
                        const removed = prev[idx];
                        if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
                        return prev.filter((_, i) => i !== idx);
                      })}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{ background: '#ef4444', color: 'white', lineHeight: 1 }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Script textarea */}
        <div>
          <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
            <label className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Script *</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!hasScriptSelection}
                onClick={() => {
                  // Snap the selection to its surrounding line boundaries
                  // (so a mid-word selection still becomes a clean line) and
                  // either prepend `## ` to mark each affected line as a
                  // section title, or strip the marker if every affected
                  // line already has one (toggle behavior). The Outsider
                  // council voice was emphatic: never wrap mid-word.
                  const ta = scriptTextareaRef.current;
                  if (!ta) return;
                  const start = ta.selectionStart;
                  const end = ta.selectionEnd;
                  if (start === end) return;
                  const text = script;
                  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
                  const lineEndIdx = text.indexOf('\n', end);
                  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
                  const block = text.slice(lineStart, lineEnd);
                  const lines = block.split('\n');
                  const allMarked = lines.every(l => /^##(?!#)\s/.test(l));
                  const newLines = lines.map(l => {
                    if (allMarked) return l.replace(/^##(?!#)\s+/, '');
                    if (/^##(?!#)\s/.test(l)) return l;
                    return `## ${l.trim()}`;
                  });
                  const replacement = newLines.join('\n');
                  const next = text.slice(0, lineStart) + replacement + text.slice(lineEnd);
                  setScript(next);
                  console.info('[production-doc mark-as-title]', {
                    affectedLineCount: lines.length,
                    toggleOff: allMarked,
                    newBlockChars: replacement.length,
                  });
                  // Restore focus + select the new block so the user can see
                  // what was changed and undo via Ctrl+Z if needed.
                  requestAnimationFrame(() => {
                    ta.focus();
                    ta.setSelectionRange(lineStart, lineStart + replacement.length);
                  });
                }}
                title={
                  hasScriptSelection
                    ? 'Wrap the selected line(s) as section titles (## Title). Click again to remove.'
                    : 'Select the title text first.'
                }
                className="text-xs px-2 py-1 rounded border transition-colors"
                style={{
                  borderColor: 'var(--border)',
                  color: hasScriptSelection ? 'var(--text-primary)' : 'var(--text-muted)',
                  background: hasScriptSelection ? 'var(--surface-hover)' : 'transparent',
                  cursor: hasScriptSelection ? 'pointer' : 'not-allowed',
                  opacity: hasScriptSelection ? 1 : 0.5,
                }}
              >
                Mark as title
              </button>
              {script.trim().length > 0 && (
                <>
                  <CopyForElevenLabs script={script} version="v2" />
                  <CopyForElevenLabs script={script} version="v3" />
                </>
              )}
              {wordCount > 0 && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {wordCount.toLocaleString()} words
                </span>
              )}
            </div>
          </div>
          <textarea
            ref={scriptTextareaRef}
            value={script}
            onChange={e => setScript(e.target.value)}
            onSelect={e => {
              const t = e.currentTarget;
              setHasScriptSelection(t.selectionStart !== t.selectionEnd);
            }}
            onBlur={() => setHasScriptSelection(false)}
            placeholder="Paste your finished script here..."
            className="input-field font-mono text-xs leading-relaxed"
            style={{ minHeight: 200, resize: 'vertical' }}
          />
        </div>

        {/* Image model — used for per-shot AI images */}
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            Image Model
          </label>
          <select
            value={imageModel}
            onChange={e => setImageModel(e.target.value)}
            className="input-field w-full text-sm"
          >
            {IMAGE_MODELS
              .filter(m => localStudioEnabled || m.provider !== 'comfyui-local')
              .map(m => (
                <option key={m.value} value={m.value}>
                  {m.label}
                  {m.hint ? ` — ${m.hint}` : ''}
                </option>
              ))}
          </select>
        </div>

        {/* Overlay default — applies only to NEW generations. Existing docs
            carry their own `overlays_disabled` flag (toggled inline near the
            rows table). When unchecked, the doc-gen LLM is told to skip
            overlay_stock_terms on every row and instead bake brand mentions
            (Microsoft, iPhone, Tesla, etc.) directly into ai_image_prompt
            so the still renders the brand natively. */}
        <label
          className="flex items-center gap-2 text-xs cursor-pointer self-start"
          style={{ color: 'var(--text-secondary)' }}
          title="When off, no real-image overlay PNGs are fetched on new docs. Brand mentions get baked directly into the AI image prompt so the still renders logos natively. Your preference is remembered."
        >
          <input
            type="checkbox"
            checked={!overlaysDisabledPref}
            onChange={(e) => setOverlaysDisabledPref(!e.target.checked)}
            style={{ accentColor: '#a855f7' }}
          />
          <span>Auto-generate real-image overlays on new docs</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {overlaysDisabledPref ? '— off' : '— on'}
          </span>
        </label>

        {/* Pre-flight title review. The panel is collapsed by default —
            users who skip it get the same behavior as before (server-side
            auto-extraction). Users who open it can correct the detected
            list before generation runs. See
            `_plans/2026-05-31-preflight-title-review.md`. */}
        <TitleReviewPanel
          script={script}
          disabled={generating}
          onChange={setReviewedTitles}
        />

        {/* Model + Generate */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ModelSelector value={modelId} onChange={setModelId} label="" />
          </div>
          <button
            onClick={generate}
            disabled={generating || !script.trim() || !niche.trim()}
            className="btn-primary px-6 shrink-0"
          >
            {generating ? (
              <><div className="spinner" style={{ width: 14, height: 14 }} /> Generating...</>
            ) : (
              'Generate Production Doc'
            )}
          </button>
        </div>

        {(generating || generationLog.length > 0) && (
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(124,58,237,0.2)' }}
          >
            <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid rgba(124,58,237,0.15)', background: 'rgba(124,58,237,0.08)' }}>
              <div className="flex items-center gap-2">
                {generating && <div className="spinner" style={{ width: 10, height: 10 }} />}
                <span className="text-xs font-medium" style={{ color: 'var(--accent-purple-bright)' }}>
                  {generating ? 'Generating…' : 'Done'}
                </span>
              </div>
              {generating && (
                <button
                  onClick={cancelGeneration}
                  className="text-xs px-2 py-0.5 rounded transition-colors"
                  style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
                >
                  ✕ Stop
                </button>
              )}
            </div>
            <div className="px-3 py-2 font-mono text-xs space-y-0.5 max-h-40 overflow-y-auto" style={{ color: 'var(--text-secondary)' }}>
              {generationLog.map((line, i) => (
                <div key={i} style={{ color: line.includes('✓') ? '#34d399' : line.includes('✗') || line.includes('⊘') ? '#f87171' : line.includes('⚠') ? '#fbbf24' : 'var(--text-secondary)' }}>
                  {line}
                </div>
              ))}
              {generating && <div style={{ color: 'var(--text-muted)' }}>▌</div>}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* ── Image Generation Progress */}
      {(imagesGenerating || (imageProgress.total > 0 && imageProgress.done < imageProgress.total)) && (
        <div className="glass rounded-xl p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Generating AI images with {getImageModelSpec(imageModel)?.label ?? 'the selected model'}…
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {imageProgress.done} / {imageProgress.total}
              </span>
              {/* Stop — same AbortController also cancels in-flight image fetches */}
              <button
                onClick={cancelGeneration}
                className="text-xs px-2 py-0.5 rounded transition-colors"
                style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
                title="Cancel remaining image generations"
              >
                ✕ Stop
              </button>
            </div>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
            <div
              className="h-1.5 rounded-full transition-all duration-700"
              style={{
                width: `${imageProgress.total ? (imageProgress.done / imageProgress.total) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #7c3aed, #06b6d4)',
              }}
            />
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Each image takes ~30–60 s. They appear inline as they complete — non-AI rows already have Google Image search links.
          </p>
        </div>
      )}

      {/* ── Results */}
      {doc && (() => {
        // The Overlay column / pill only appear when at least one row in
        // this doc carries an `overlay_stock_terms` value. Pure-doodle and
        // pure-cinematic docs render exactly as they did before.
        const showOverlayColumn = doc.rows.some((r) => r.overlay_stock_terms?.trim());
        return (
        <div ref={tableRef}>
          {/* Doc header */}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {doc.title || topic || niche}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {doc.rows?.length} shots · {doc.total_duration} · {doc.total_words?.toLocaleString()} words · {doc.speaking_pace_wpm} wpm
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => exportToCsv(doc, rowImages)} className="btn-primary text-sm px-4">
                ⬇ Export CSV
              </button>
              <button
                onClick={exportToSheets}
                disabled={sheetsExporting}
                className="btn-secondary text-sm px-4 flex items-center gap-1.5"
                title="Export to Google Sheets"
              >
                {sheetsExporting ? (
                  <><div className="spinner" style={{ width: 12, height: 12 }} /> Exporting…</>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.85 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="8" y1="13" x2="16" y2="13" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                    </svg>
                    Export to Sheets
                  </>
                )}
              </button>
              {sheetsUrl && (
                <a
                  href={sheetsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs flex items-center gap-1 underline"
                  style={{ color: '#34d399' }}
                >
                  ↗ Open Sheet
                </a>
              )}
              <button onClick={generate} disabled={generating} className="btn-secondary text-sm px-4">
                ↺ Regenerate
              </button>
            </div>
          </div>

          {/* Scene timing — per-doc override for minimum scene duration
              and tail buffer after narration. Defaults are the workspace's
              if set, otherwise the system defaults. See
              `_plans/2026-05-17-scene-min-duration-and-tail-buffer.md`. */}
          <SceneTimingControl
            minSceneMs={doc.min_scene_ms}
            tailBufferMs={doc.tail_buffer_ms}
            onChange={setSceneTiming}
          />

          {/* Doc-level overlay toggle. When unchecked, the auto-fetch
              pipeline (Brave → RMBG → smart placement) is skipped for
              every row in this doc. Brand mentions and logos rely on
              being baked into ai_image_prompt at doc-gen time instead
              (see prompts.ts → productionDocPrompt). Per-row
              `skip_overlay` overrides this in either direction. */}
          <div
            className="flex items-center gap-2 mb-4 px-3 py-2 rounded text-xs"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <label className="flex items-center gap-2 cursor-pointer" title="When off, no real-image overlays are auto-fetched. Mention brands directly in ai_image_prompt so they render natively in the still.">
              <input
                type="checkbox"
                checked={doc.overlays_disabled !== true}
                onChange={(e) => {
                  const next: ProductionDoc = { ...doc };
                  if (e.target.checked) {
                    delete next.overlays_disabled;
                  } else {
                    next.overlays_disabled = true;
                  }
                  console.info('[overlay-skip] doc-level toggle', { overlays_disabled: next.overlays_disabled === true });
                  setDoc(next);
                  persistDoc(next);
                }}
                style={{ accentColor: '#a855f7' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>
                Auto-generate real-image overlays
              </span>
            </label>
            <span style={{ color: 'var(--text-muted)' }}>
              {doc.overlays_disabled === true
                ? '— off: brands & logos must be in the image prompt itself'
                : '— on: stock PNG overlays composited on top of stills'}
            </span>
          </div>

          {/* Collage tester debug panel — hidden behind the public flag
              `NEXT_PUBLIC_COLLAGE_TESTER`. Backed by /api/dev/collage-test
              which has its own server-side flag (defence in depth). */}
          {COLLAGE_TESTER_PUBLIC && <CollageTesterPanel />}

          {/* Collage batch mode — when on (default), "Generate empty"
              groups 4 consecutive shots into a single 2×2 collage call
              + 1 upscale (~75% cheaper than 4 single calls). Per-cell
              OST baking, safe-top, and sheet description are applied
              per cell — behaviour matches single-shot mode. Per-shot
              Regenerate stays single-image regardless. Falls back to
              single shots automatically on per-chunk failure or
              ineligible groups (mixed model, i2i, <4 shots). Default
              flipped to ON 2026-05-26 with augmentation parity. */}
          <div
            className="flex items-center gap-2 mb-4 px-3 py-2 rounded text-xs"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <label
              className="flex items-center gap-2 cursor-pointer"
              title='Group every 4 shots into a single 2×2 collage call. The server upscales the collage once and crops it into 4 per-shot images. ~75% cheaper than 4 single calls, with byte-identical per-cell OST/safe-top/sheet-description augmentation. Default: ON. Per-shot Regenerate always stays single-image.'
            >
              <input
                type="checkbox"
                checked={doc.collage_mode !== false}
                onChange={(e) => {
                  const next: ProductionDoc = { ...doc };
                  if (e.target.checked) {
                    // Default is ON — clearing the field reverts to the
                    // default. Storing `true` explicitly would also work
                    // but `delete` keeps the persisted doc smaller for
                    // the common case.
                    delete next.collage_mode;
                  } else {
                    // Explicit `false` is required to override the
                    // default-on behaviour; `undefined` and `true` both
                    // mean "collage on" after the 2026-05-26 flip.
                    next.collage_mode = false;
                  }
                  console.info('[collage-mode] doc-level toggle', { collage_mode: next.collage_mode !== false });
                  setDoc(next);
                  persistDoc(next);
                }}
                style={{ accentColor: '#a855f7' }}
              />
              <span style={{ color: 'var(--text-secondary)' }}>
                Generate 4 shots at once (collage mode)
              </span>
            </label>
            <span style={{ color: 'var(--text-muted)' }}>
              {doc.collage_mode !== false
                ? 'on (default): ~75% cheaper, per-cell text baking matches single-shot'
                : 'off: each shot is its own generation call'}
            </span>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-2 mb-4 items-center">
            {Object.entries(VISUAL_TYPE_COLORS).map(([type, { bg, color }]) => (
              <span key={type} className="text-xs px-2 py-0.5 rounded-full" style={{ background: bg, color }}>
                {type}
              </span>
            ))}
            {(() => {
              const overlayCount = doc.rows.filter((r) => r.overlay_stock_terms?.trim()).length;
              if (overlayCount === 0) return null;
              return (
                <span
                  className="text-xs px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}
                  title={`${overlayCount} row(s) flagged for editor-composited real-image overlays`}
                >
                  ✦ {overlayCount} overlay{overlayCount === 1 ? '' : 's'}
                </span>
              );
            })()}
          </div>

          {/* Section-divider thumbnail — composite image referenced by per-row "Zoom to" picks. */}
          <div className="mb-4">
            <SectionThumbnailCard value={doc.thumbnail} onChange={setThumbnail} />
          </div>

          {/* Media status bar — always-visible succeeded/failed counters for
              this doc's still images and B-roll animations, plus one-click
              "Retry failed" buttons that batch the failed rows sequentially.
              Image retries use the user's selected image model; video retries
              use the user's current default B-roll model (same as Animate all).
              Both retry buttons are disabled when nothing has failed. */}
          <div className="mb-4 flex flex-wrap items-stretch gap-3">
            {/* Images cell */}
            <div
              className="flex-1 min-w-[260px] flex items-center gap-3 px-3 py-2 rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <span className="text-base" aria-hidden>📷</span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  Images
                </span>
                <div className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: '#4ade80' }} title="Stills generated successfully">
                    {imageStats.succeeded}✓
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span
                    style={{ color: imageStats.failed > 0 ? '#f87171' : 'var(--text-muted)' }}
                    title="Stills that failed to generate"
                  >
                    {imageStats.failed}✗
                  </span>
                </div>
              </div>
              {retryingImages ? (
                <div className="flex items-center gap-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Generating {retryingImages.done}/{retryingImages.total}…
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {/* Generate-empty: covers the common after-refresh case
                      where the sanitizer reset rows to idle. Sequential
                      pipeline shared with the failed-retry batch. */}
                  <button
                    type="button"
                    onClick={runGenerateEmptyImages}
                    disabled={emptyImagePlan.length === 0 || imagesGenerating}
                    className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                    style={{
                      background: emptyImagePlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                      color: emptyImagePlan.length === 0 ? 'var(--text-muted)' : '#c084fc',
                      border: '1px solid ' + (emptyImagePlan.length === 0 ? 'transparent' : 'rgba(168,85,247,0.45)'),
                      cursor: emptyImagePlan.length === 0 || imagesGenerating ? 'not-allowed' : 'pointer',
                    }}
                    title={
                      emptyImagePlan.length === 0
                        ? 'No empty rows with prompts to fill.'
                        : imagesGenerating
                          ? 'Initial image batch is still running — wait for it to finish.'
                          : `Generate stills for ${emptyImagePlan.length} empty row${emptyImagePlan.length === 1 ? '' : 's'} sequentially.`
                    }
                  >
                    ＋ Generate empty
                    {emptyImagePlan.length > 0 && (
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {emptyImagePlan.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={runRetryFailedImages}
                    disabled={failedImagePlan.length === 0 || imagesGenerating}
                    className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                    style={{
                      background: failedImagePlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(6,182,212,0.18)',
                      color: failedImagePlan.length === 0 ? 'var(--text-muted)' : '#22d3ee',
                      border: '1px solid ' + (failedImagePlan.length === 0 ? 'transparent' : 'rgba(6,182,212,0.45)'),
                      cursor: failedImagePlan.length === 0 || imagesGenerating ? 'not-allowed' : 'pointer',
                    }}
                    title={
                      failedImagePlan.length === 0
                        ? 'No failed images to retry.'
                        : imagesGenerating
                          ? 'Initial image batch is still running — wait for it to finish.'
                          : `Re-run ${failedImagePlan.length} failed image generation${failedImagePlan.length === 1 ? '' : 's'} one by one.`
                    }
                  >
                    ↻ Retry failed
                    {failedImagePlan.length > 0 && (
                      <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        {failedImagePlan.length}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* Videos cell */}
            <div
              className="flex-1 min-w-[260px] flex items-center gap-3 px-3 py-2 rounded-lg"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              <span className="text-base" aria-hidden>🎬</span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  Animations
                </span>
                <div className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: '#4ade80' }} title="Animations generated successfully">
                    {videoStats.succeeded}✓
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>·</span>
                  <span
                    style={{ color: videoStats.failed > 0 ? '#f87171' : 'var(--text-muted)' }}
                    title="Animations that failed to generate"
                  >
                    {videoStats.failed}✗
                  </span>
                </div>
              </div>
              {retryingVideos ? (
                <div className="flex items-center gap-2 text-xs whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Retrying {retryingVideos.done}/{retryingVideos.total}…
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runRetryFailedVideos}
                  disabled={failedVideoPlan.length === 0 || !animateScenes || Boolean(animatingAll)}
                  className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                  style={{
                    background: failedVideoPlan.length === 0 || !animateScenes ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                    color: failedVideoPlan.length === 0 || !animateScenes ? 'var(--text-muted)' : '#c084fc',
                    border: '1px solid ' + (failedVideoPlan.length === 0 || !animateScenes ? 'transparent' : 'rgba(168,85,247,0.45)'),
                    cursor: failedVideoPlan.length === 0 || !animateScenes || animatingAll ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    !animateScenes
                      ? 'Animations are disabled — turn on "Animate scenes" first.'
                      : failedVideoPlan.length === 0
                        ? 'No failed animations to retry.'
                        : animatingAll
                          ? 'Animate-all batch is in flight — wait for it to finish.'
                          : `Re-run ${failedVideoPlan.length} failed animation${failedVideoPlan.length === 1 ? '' : 's'} for ~$${retryVideosCostUsd.toFixed(2)}.`
                  }
                >
                  ↻ Retry failed
                  {failedVideoPlan.length > 0 && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {failedVideoPlan.length} · ~${retryVideosCostUsd.toFixed(2)}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Lower-third suppression toggle. Off by default (overlay
              shown); flip ON when the OST is already baked into the AI
              image and the Remotion overlay would duplicate it. */}
          <div className="mb-3 flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={toggleSuppressLowerThirds}
              role="switch"
              aria-checked={suppressLowerThirds}
              className="relative inline-flex items-center rounded-full transition-colors"
              style={{
                width: 36,
                height: 20,
                background: suppressLowerThirds ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
              }}
              title={
                suppressLowerThirds
                  ? 'On-screen text overlay is hidden — the image carries its own baked text.'
                  : 'On-screen text overlay shown — click to hide it (use when OST is already in the image).'
              }
            >
              <span
                className="inline-block rounded-full bg-white transition-transform"
                style={{
                  width: 14,
                  height: 14,
                  transform: `translateX(${suppressLowerThirds ? 18 : 4}px)`,
                }}
              />
            </button>
            <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Hide on-screen text overlay
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {suppressLowerThirds
                  ? 'Renderer skips the lower-third band — only the image’s baked text appears.'
                  : 'Renderer adds a lower-third band with the row’s on_screen_text on top of the image.'}
              </span>
            </div>
          </div>

          {/* Doc-level default for new variants' chain mode. When ON,
              every variant added to this doc (via "+ Add variant" or
              the script-gen auto-grouper, when it eventually respects
              this) starts with `variant_derives_from_previous = true`
              — chained, additive frame-by-frame. When OFF (default),
              new variants edit the group's base independently
              (parallel). Per-group default + per-variant override
              still win. Existing variants are NOT mutated. */}
          {doc && (
            <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => setDoc((prev) => prev ? { ...prev, variants_chained_by_default: !prev.variants_chained_by_default } : prev)}
                role="switch"
                aria-checked={doc.variants_chained_by_default === true}
                className="relative inline-flex items-center rounded-full transition-colors"
                style={{
                  width: 36,
                  height: 20,
                  background: doc.variants_chained_by_default ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
                }}
                title={doc.variants_chained_by_default
                  ? 'Chained variants are the doc default — new variants build on the previous one. Click to switch new variants to parallel.'
                  : 'Parallel variants are the doc default — new variants edit the base independently. Click to switch new variants to chained (additive frame-by-frame).'}
              >
                <span
                  className="inline-block rounded-full bg-white transition-transform"
                  style={{
                    width: 14,
                    height: 14,
                    transform: `translateX(${doc.variants_chained_by_default ? 18 : 4}px)`,
                  }}
                />
              </button>
              <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Chained variants by default
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {doc.variants_chained_by_default
                    ? 'New variants build on the previous variant (additive frame-by-frame). Per-group + per-variant toggles still override.'
                    : 'New variants edit the group base independently. Flip ON for additive frame-by-frame sequences. Existing variants are unchanged.'}
                </span>
              </div>
            </div>
          )}

          {/* Phase 4 (Editor UI) — doc-level character descriptions panel.
              Gated on doodle_explainer_2 since the bible mechanism that
              consumes the descriptions is style-specific. Renders one row
              per character_id slug used in the doc; lets the user edit
              the description (or add one for missing slugs). Spec:
              _plans/2026-05-28-doodle-2-character-cache.md (Phase 4). */}
          {doc && stylePreset === 'doodle_explainer_2' && characterSlugTally.length > 0 && (
            <div className="mb-4 px-4 py-3 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                Character descriptions
              </div>
              <CharacterDescriptionsPanel
                usedSlugs={characterSlugTally.map((e) => e.slug)}
                descriptions={doc.doodle_explainer_2_character_descriptions}
                onChange={(next) => {
                  setDoc((prev) => {
                    if (!prev) return prev;
                    const nextDoc = {
                      ...prev,
                      doodle_explainer_2_character_descriptions: next,
                    };
                    persistDoc(nextDoc);
                    return nextDoc;
                  });
                }}
              />
            </div>
          )}

          {/* Animate-scenes master toggle. When OFF, B-roll buttons are
              hidden on every row and the renderer falls back to stills with
              Ken Burns motion (today's pre-animation behaviour). Adjacent
              "Animate all" button drives a sequential batch over every
              eligible row (has still, not locked, not already in flight). */}
          <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={toggleAnimateScenes}
              role="switch"
              aria-checked={animateScenes}
              className="relative inline-flex items-center rounded-full transition-colors"
              style={{
                width: 36,
                height: 20,
                background: animateScenes ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
              }}
              title={animateScenes ? 'Animations enabled — click to use stills only' : 'Stills only — click to enable animations'}
            >
              <span
                className="inline-block rounded-full bg-white transition-transform"
                style={{
                  width: 14,
                  height: 14,
                  transform: `translateX(${animateScenes ? 18 : 4}px)`,
                }}
              />
            </button>
            <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Animate scenes
              </span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {animateScenes
                  ? 'Per-row B-roll buttons are visible; rendered video uses any generated clips.'
                  : 'B-roll generation is hidden and the rendered video uses stills with Ken Burns motion (pre-animation behaviour).'}
              </span>
            </div>
            {/* Generate-all-stills (local) — Phase 6 v1. Only renders
                when LOCAL_STUDIO=1 is wired up in this env. Sits next
                to Animate all because both are batch operations. */}
            {localStudioEnabled && (
              generatingStills ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Generating {generatingStills.done}/{generatingStills.total}…
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runGenerateAllStillsLocal}
                  disabled={generateAllStillsPlanCount === 0}
                  className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                  style={{
                    background: generateAllStillsPlanCount === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(16,185,129,0.18)',
                    color: generateAllStillsPlanCount === 0 ? 'var(--text-muted)' : '#34d399',
                    border: '1px solid ' + (generateAllStillsPlanCount === 0 ? 'transparent' : 'rgba(16,185,129,0.45)'),
                    cursor: generateAllStillsPlanCount === 0 ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    generateAllStillsPlanCount === 0
                      ? 'Every row already has a still or has no usable prompt.'
                      : `Generate ${generateAllStillsPlanCount} still${generateAllStillsPlanCount === 1 ? '' : 's'} locally. Each row picks Flux schnell or Qwen-Image automatically — baked-text rows and rows on styled docs use Qwen for quality; everything else uses Flux schnell for speed. Free either way.`
                  }
                >
                  ⚡ Stills (local)
                  {generateAllStillsPlanCount > 0 && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {generateAllStillsPlanCount} row{generateAllStillsPlanCount === 1 ? '' : 's'} · free
                    </span>
                  )}
                </button>
              )
            )}
            {animateScenes && (
              animatingAll ? (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Animating {animatingAll.done}/{animatingAll.total}…
                </div>
              ) : (
                <button
                  type="button"
                  onClick={runAnimateAll}
                  disabled={animateAllPlan.length === 0}
                  className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                  style={{
                    background: animateAllPlan.length === 0 ? 'rgba(120,120,120,0.10)' : 'rgba(168,85,247,0.18)',
                    color: animateAllPlan.length === 0 ? 'var(--text-muted)' : '#c084fc',
                    border: '1px solid ' + (animateAllPlan.length === 0 ? 'transparent' : 'rgba(168,85,247,0.45)'),
                    cursor: animateAllPlan.length === 0 ? 'not-allowed' : 'pointer',
                  }}
                  title={
                    animateAllPlan.length === 0
                      ? 'No eligible rows: every row is locked, already generating, already ready, or has no still image yet.'
                      : `Animate ${animateAllPlan.length} row${animateAllPlan.length === 1 ? '' : 's'} for ~$${animateAllCostUsd.toFixed(2)}`
                  }
                >
                  ▶ Animate all
                  {animateAllPlan.length > 0 && (
                    <span className="ml-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {animateAllPlan.length} row{animateAllPlan.length === 1 ? '' : 's'} · ~${animateAllCostUsd.toFixed(2)}
                    </span>
                  )}
                </button>
              )
            )}
          </div>

          {/* Doc-level scene-fade toggle. On = the historical cross-fade
              between every shot (and the opening fade-in / closing fade-out
              on the first/last shot). Off = hard cut everywhere. Per-row
              pills in the Section column can override individual rows.
              See _plans/2026-05-17-scene-transition-controls.md. */}
          {(() => {
            const fadeOn = doc.scene_fade_enabled !== false;
            return (
              <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setSceneFadeEnabled(!fadeOn)}
                  role="switch"
                  aria-checked={fadeOn}
                  className="relative inline-flex items-center rounded-full transition-colors"
                  style={{
                    width: 36,
                    height: 20,
                    background: fadeOn ? 'rgba(168,85,247,0.45)' : 'rgba(120,120,120,0.35)',
                  }}
                  title={
                    fadeOn
                      ? 'Cross-fade is on. Click to make every shot hard-cut instead.'
                      : 'Hard cuts are on. Click to restore the cross-fade between shots.'
                  }
                >
                  <span
                    className="inline-block rounded-full bg-white transition-transform"
                    style={{
                      width: 14,
                      height: 14,
                      transform: `translateX(${fadeOn ? 18 : 4}px)`,
                    }}
                  />
                </button>
                <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    Scene fade between shots
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {fadeOn
                      ? 'Smooth fade in/out wraps every shot — and the very first frame fades in from black, the last fades out.'
                      : 'Hard cut between shots — the video starts and ends on its first/last frame with no fade-to-black.'}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Doc-level animation model — applies to every B-roll cell
              on this doc as the default. Tier priority: row-level lock
              (user clicked a specific row's picker) > doc-level > user-
              level default. Persisted on doc.broll_model_id so it
              survives refresh and cross-device. Empty value falls back
              to the user-level default. Hidden when no doc rendered. */}
          {doc.rows && doc.rows.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 px-4 py-2.5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
              <div className="flex flex-col leading-tight flex-1 min-w-[220px]">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Animation model for all shots
                </span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {doc.broll_model_id
                    ? `Every row’s B-roll cell defaults to this model. Click a single row’s picker (☆) to override one shot.`
                    : 'No doc-level override — each row uses your global default. Pick a model to apply it to every shot in this doc.'}
                </span>
              </div>
              <select
                value={doc.broll_model_id ?? ''}
                onChange={(e) => {
                  const next = e.target.value || undefined;
                  setDoc((prev) => (prev ? { ...prev, broll_model_id: next } : prev));
                }}
                className="input-field text-sm"
                style={{ minWidth: 280 }}
                aria-label="Animation model for every B-roll cell on this doc"
              >
                <option value="">— Use my default —</option>
                {/* Only i2v models — t2v needs no still and the user's
                    asking about animating their existing stills. Local
                    models hidden in prod (same gate as Image Model). */}
                {BROLL_MODELS
                  .filter((m) => m.kind === 'image-to-video')
                  .filter((m) => localStudioEnabled || m.provider !== 'comfyui-local')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.priceUsdLabel}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* ── Row filter bar — visible above both desktop table and mobile cards.
              Visual-type pills are derived from the visual_types actually present
              in the doc (so a Talking-Head-only doc doesn't show a B-Roll pill).
              Filtering uses the doc-index `i` to render `null` for filtered-out
              rows, so every row action keeps pointing at the right row. */}
          {(() => {
            const rows = doc.rows ?? [];
            const typeCounts = rows.reduce<Record<string, number>>((acc, r) => {
              acc[r.visual_type] = (acc[r.visual_type] ?? 0) + 1;
              return acc;
            }, {});
            const distinctTypes = Object.keys(typeCounts).sort();
            const motionCollageCount = rows.filter((r) => r.shot_kind === 'motion_collage').length;
            const hasAnyFilter =
              filters.visualTypes.length > 0
              || filters.search.trim().length > 0
              || filters.motionCollageOnly;
            const search = filters.search.trim().toLowerCase();
            const visibleCount = rows.filter(r => {
              if (filters.visualTypes.length > 0 && !filters.visualTypes.includes(r.visual_type)) return false;
              if (filters.motionCollageOnly && r.shot_kind !== 'motion_collage') return false;
              if (search.length > 0) {
                const hay = `${r.script_text ?? ''}\n${r.visual_description ?? ''}\n${r.on_screen_text ?? ''}`.toLowerCase();
                if (!hay.includes(search)) return false;
              }
              return true;
            }).length;
            return (
              <div className="glass rounded-xl p-3 flex flex-wrap items-center gap-2 mb-3" style={{ rowGap: 8 }}>
                <input
                  type="search"
                  value={filters.search}
                  onChange={(e) => {
                    const next = { ...filters, search: e.target.value };
                    setFilters(next);
                    console.info('[production-doc filter-change]', next);
                  }}
                  placeholder="Search script, visual, on-screen…"
                  className="text-xs px-2 py-1 rounded"
                  style={{
                    background: 'rgba(0,0,0,0.20)',
                    color: 'var(--text)',
                    border: '1px solid rgba(255,255,255,0.10)',
                    outline: 'none',
                    minWidth: 220,
                    flex: '0 1 280px',
                  }}
                />
                <div className="flex flex-wrap items-center gap-1">
                  {distinctTypes.map(type => {
                    const active = filters.visualTypes.includes(type);
                    const color = VISUAL_TYPE_COLORS[type] || VISUAL_TYPE_COLORS['B-Roll'];
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          const nextTypes = active
                            ? filters.visualTypes.filter(t => t !== type)
                            : [...filters.visualTypes, type];
                          const next = { ...filters, visualTypes: nextTypes };
                          setFilters(next);
                          console.info('[production-doc filter-change]', next);
                        }}
                        className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                        style={{
                          background: active ? color.bg : 'transparent',
                          color: active ? color.color : 'var(--text-muted)',
                          border: `1px solid ${active ? color.color : 'rgba(255,255,255,0.15)'}`,
                          cursor: 'pointer',
                          opacity: active ? 1 : 0.75,
                        }}
                        title={active ? `Click to remove "${type}" from filter` : `Click to show only "${type}" rows`}
                      >
                        {type} · {typeCounts[type]}
                      </button>
                    );
                  })}
                  {/* Motion-collage chip — separate from visual_type chips
                      because motion_collage rows keep `visual_type:
                      "Animation"`. Without this, motion_collage rows are
                      invisible against the rest of the Animation cluster.
                      Mounts only when at least one motion_collage row exists
                      in the doc, mirroring the visual_type chips' "hide chip
                      when count = 0" discipline. Purple to match the
                      doc-level settings panel + the Convert button.
                      See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */}
                  {motionCollageCount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = {
                          ...filters,
                          motionCollageOnly: !filters.motionCollageOnly,
                        };
                        setFilters(next);
                        console.info('[production-doc filter-change]', next);
                      }}
                      className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                      style={{
                        background: filters.motionCollageOnly ? 'rgba(124,58,237,0.25)' : 'transparent',
                        color: filters.motionCollageOnly ? '#a78bfa' : 'var(--text-muted)',
                        border: filters.motionCollageOnly
                          ? '1px solid rgba(124,58,237,0.55)'
                          : '1px solid rgba(255,255,255,0.15)',
                        cursor: 'pointer',
                        opacity: filters.motionCollageOnly ? 1 : 0.75,
                      }}
                      title={
                        filters.motionCollageOnly
                          ? 'Click to remove the motion-collage filter'
                          : 'Click to show only motion-collage rows'
                      }
                    >
                      ↯ Motion Collage · {motionCollageCount}
                    </button>
                  )}
                </div>
                {hasAnyFilter && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = { visualTypes: [], search: '', motionCollageOnly: false };
                      setFilters(next);
                      console.info('[production-doc filter-change]', next);
                    }}
                    className="text-[11px] px-2 py-0.5 rounded"
                    style={{
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      border: '1px solid rgba(255,255,255,0.15)',
                      cursor: 'pointer',
                    }}
                  >
                    Clear filters
                  </button>
                )}
                <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                  {hasAnyFilter
                    ? `Showing ${visibleCount} of ${rows.length} rows`
                    : `${rows.length} rows`}
                </span>
              </div>
            );
          })()}

          {/* ── Desktop table */}
          <div className="glass rounded-xl overflow-hidden">
            <div className="overflow-x-auto hidden md:block">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-card)', borderBottom: '1px solid var(--border)' }}>
                    {(() => {
                      const headerList = ['#', 'Time', 'Script Text', 'Visual Type', 'Visual Description', 'Stock Terms', 'Image', 'B-roll', 'AI Prompt'];
                      if (showOverlayColumn) headerList.push('Overlay');
                      headerList.push('On-Screen Text', 'Notes');
                      // 'Section' column now always renders — hosts the
                      // scene-fade pill even when there's no thumbnail.
                      headerList.push('Section');
                      return headerList;
                    })().map(h => (
                      <th key={h} style={{
                        padding: '10px 12px', textAlign: 'left', fontWeight: 600,
                        color: 'var(--text-secondary)', whiteSpace: 'nowrap',
                        borderRight: '1px solid var(--border)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.rows?.map((row, i) => {
                    // Filter check — return null so the row index `i` stays
                    // tied to the doc index for every handler that follows.
                    if (filters.visualTypes.length > 0 && !filters.visualTypes.includes(row.visual_type)) return null;
                    if (filters.motionCollageOnly && row.shot_kind !== 'motion_collage') return null;
                    if (filters.search.trim().length > 0) {
                      const q = filters.search.trim().toLowerCase();
                      const hay = `${row.script_text ?? ''}\n${row.visual_description ?? ''}\n${row.on_screen_text ?? ''}`.toLowerCase();
                      if (!hay.includes(q)) return null;
                    }
                    const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                    const imgState = rowImages[i] || { status: 'idle' };
                    // Phase 3.3 — variant-group awareness for this row.
                    // `isInGroup` covers BOTH the base (variant_index=0) and
                    // variants (>0); `isVariant` is true for variants only.
                    // Used to drive the row's left-border accent and the
                    // "+ Add variant" vs "Generate variant" affordance.
                    const isInGroup = isVariantRow(row);
                    const isVariant = isInGroup && (row.variant_index ?? 0) > 0;
                    const groupSize = isInGroup && row.group_id
                      ? getVariantGroup(doc, row.group_id).length
                      : 1;
                    const canAddVariant = groupSize < MAX_VARIANTS_PER_GROUP && !isVariant;
                    // Phase 3.7c — staleness check. A variant is stale when
                    // the base's CURRENT image_url no longer matches the
                    // snapshot taken when the variant was last generated.
                    // Requires three things to be true: the row is a
                    // variant, it has a snapshot (otherwise it was never
                    // generated), and the current base image differs.
                    // Reading the base's image URL from rowImages keeps the
                    // check live as the base is regenerated.
                    let isVariantStale = false;
                    if (isVariant && row.variant_base_image_at_generation && row.group_id) {
                      const baseRow = getBaseRow(doc, row.group_id);
                      const baseIdx = baseRow ? doc.rows.indexOf(baseRow) : -1;
                      const currentBaseImageUrl = baseIdx >= 0 ? rowImages[baseIdx]?.imageUrl : undefined;
                      if (currentBaseImageUrl && currentBaseImageUrl !== row.variant_base_image_at_generation) {
                        isVariantStale = true;
                      }
                    }
                    return (
                      <tr
                        key={i}
                        style={{
                          borderBottom: '1px solid var(--border)',
                          background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                          // Phase 3.3 — left-border accent indicates a row
                          // is part of a variant group. Base rows get a
                          // solid accent, variants get a softer one so the
                          // base reads as "the anchor".
                          ...(isInGroup ? {
                            borderLeft: isVariant
                              ? '3px solid rgba(34,211,238,0.45)'
                              : '3px solid rgba(34,211,238,0.85)',
                          } : {}),
                        }}
                      >
                        {/* # */}
                        <td style={{ padding: '8px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          {i + 1}
                        </td>
                        {/* Timecode */}
                        <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', whiteSpace: 'nowrap', fontWeight: 600, borderRight: '1px solid var(--border)' }}>
                          {row.timecode}
                        </td>
                        {/* Script text — when a leading `##` is present
                            we offer an inline "split as title card" form.
                            The user confirms the exact title text (since a
                            heading on the same line as the body has no
                            reliable computable end) and we extract that
                            into a new locked-as-still row. */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-primary)', maxWidth: 200, lineHeight: 1.5, borderRight: '1px solid var(--border)' }}>
                          {(() => {
                            // Two row-recovery affordances live here, both
                            // hidden on rows that are already Title Cards:
                            //
                            //  1. "Make this a title card" — promotes the
                            //     whole row to Title Card, wiping the
                            //     visual fields. Used when the LLM missed
                            //     a `##` heading and folded the title text
                            //     into a B-Roll row on its own.
                            //
                            //  2. "Split as title card…" — extracts a
                            //     leading title fragment into its own
                            //     Title Card row above. Originally only
                            //     visible on rows whose script_text still
                            //     starts with `##`; now visible on any
                            //     non-Title-Card row, since the Phase 1
                            //     deterministic pre-pass strips `##` from
                            //     the script before the LLM sees it.
                            const hasHeadingMarker = /^\s*##/.test(row.script_text);
                            const isTitleCard = row.visual_type === 'Title Card';
                            const guessMatch = hasHeadingMarker
                              ? row.script_text.match(/^\s*##\s*(\S+(?:\s+\S+){0,1})/)
                              : row.script_text.match(/^\s*(\S+(?:\s+\S+){0,1})/);
                            const guess = guessMatch?.[1]?.trim() || '';
                            const isEditingThisRow = splittingRow?.rowIndex === i;

                            // Live preview for the split: shows what the
                            // two resulting rows will hold so the user
                            // can verify before clicking Apply. Strips a
                            // matching prefix (with or without `##`) and
                            // trims trailing punctuation.
                            const previewSplit = (draft: string): { title: string; remainder: string } | null => {
                              const t = draft.trim();
                              if (!t) return null;
                              const re = new RegExp(`^\\s*(?:##\\s*)?${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[\\.,:;—-]?\\s*`, 'i');
                              const m = row.script_text.match(re);
                              if (!m) {
                                return { title: t, remainder: row.script_text };
                              }
                              return { title: t, remainder: row.script_text.slice(m[0].length).trim() };
                            };

                            const isEditingScript = editingScriptRow?.rowIndex === i;
                            return (
                              <>
                                {isEditingScript ? (
                                  <div className="flex flex-col gap-1">
                                    <textarea
                                      autoFocus
                                      value={editingScriptRow.draft}
                                      onChange={(e) => setEditingScriptRow({ rowIndex: i, draft: e.target.value })}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') setEditingScriptRow(null);
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                          const next = editingScriptRow.draft;
                                          console.info('[production-doc script-edit]', {
                                            rowIndex: i,
                                            charsBefore: row.script_text.length,
                                            charsAfter: next.length,
                                          });
                                          updateRow(i, { script_text: next });
                                          setEditingScriptRow(null);
                                        }
                                      }}
                                      rows={4}
                                      style={{
                                        fontSize: 12,
                                        padding: '6px 8px',
                                        borderRadius: 4,
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'var(--text)',
                                        border: '1px solid rgba(34,211,238,0.35)',
                                        outline: 'none',
                                        width: '100%',
                                        boxSizing: 'border-box',
                                        resize: 'vertical',
                                        lineHeight: 1.4,
                                      }}
                                    />
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const next = editingScriptRow.draft;
                                          console.info('[production-doc script-edit]', {
                                            rowIndex: i,
                                            charsBefore: row.script_text.length,
                                            charsAfter: next.length,
                                          });
                                          updateRow(i, { script_text: next });
                                          setEditingScriptRow(null);
                                        }}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(34,211,238,0.20)',
                                          color: '#22d3ee',
                                          border: '1px solid rgba(34,211,238,0.45)',
                                          cursor: 'pointer',
                                          fontWeight: 600,
                                        }}
                                      >
                                        Save
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingScriptRow(null)}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'transparent',
                                          color: 'var(--text-muted)',
                                          border: '1px solid rgba(255,255,255,0.10)',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        Cancel
                                      </button>
                                      <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                        ⌘/Ctrl+Enter to save · Esc to cancel
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-start gap-1">
                                    <span style={{ flex: 1 }}>{row.script_text}</span>
                                    <button
                                      type="button"
                                      onClick={() => setEditingScriptRow({ rowIndex: i, draft: row.script_text })}
                                      className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                                      style={{
                                        background: 'rgba(34,211,238,0.10)',
                                        color: '#22d3ee',
                                        border: '1px solid rgba(34,211,238,0.30)',
                                        cursor: 'pointer',
                                        lineHeight: 1.1,
                                      }}
                                      title="Edit script text"
                                    >
                                      ✎
                                    </button>
                                  </div>
                                )}
                                {isEditingThisRow ? (
                                  <div
                                    className="mt-1.5 flex flex-col gap-1.5 p-2 rounded"
                                    style={{
                                      background: 'rgba(34,211,238,0.08)',
                                      border: '1px solid rgba(34,211,238,0.35)',
                                    }}
                                  >
                                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                      Pick the title text to extract:
                                    </span>
                                    <input
                                      type="text"
                                      autoFocus
                                      value={splittingRow.titleDraft}
                                      onChange={(e) => setSplittingRow({ rowIndex: i, titleDraft: e.target.value })}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          const t = splittingRow.titleDraft.trim();
                                          if (t) { splitTitleCardFromRow(i, t); setSplittingRow(null); }
                                        }
                                        if (e.key === 'Escape') setSplittingRow(null);
                                      }}
                                      placeholder="Title text"
                                      style={{
                                        fontSize: 11,
                                        padding: '4px 6px',
                                        borderRadius: 4,
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'var(--text)',
                                        border: '1px solid rgba(255,255,255,0.10)',
                                        outline: 'none',
                                      }}
                                    />
                                    {(() => {
                                      const preview = previewSplit(splittingRow.titleDraft);
                                      if (!preview) return null;
                                      return (
                                        <div
                                          className="text-[10px] flex flex-col gap-0.5 px-2 py-1.5 rounded"
                                          style={{
                                            background: 'rgba(0,0,0,0.25)',
                                            color: 'var(--text-secondary)',
                                            border: '1px dashed rgba(255,255,255,0.10)',
                                          }}
                                        >
                                          <div>
                                            <span style={{ color: '#22d3ee', fontWeight: 600 }}>Title card:</span>{' '}
                                            &quot;{preview.title}&quot;
                                          </div>
                                          <div style={{ color: 'var(--text-muted)' }}>
                                            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>This row keeps:</span>{' '}
                                            {preview.remainder || <em style={{ opacity: 0.6 }}>(empty — the row will only have the title)</em>}
                                          </div>
                                        </div>
                                      );
                                    })()}
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const t = splittingRow.titleDraft.trim();
                                          if (!t) return;
                                          console.info('[production-doc row-split]', {
                                            rowIndex: i,
                                            titleLen: t.length,
                                            scriptCharsBefore: row.script_text.length,
                                          });
                                          splitTitleCardFromRow(i, t);
                                          setSplittingRow(null);
                                        }}
                                        disabled={!splittingRow.titleDraft.trim()}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(34,211,238,0.20)',
                                          color: '#22d3ee',
                                          border: '1px solid rgba(34,211,238,0.45)',
                                          cursor: splittingRow.titleDraft.trim() ? 'pointer' : 'not-allowed',
                                          fontWeight: 600,
                                        }}
                                      >
                                        Apply
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setSplittingRow(null)}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'transparent',
                                          color: 'var(--text-muted)',
                                          border: '1px solid rgba(255,255,255,0.10)',
                                          cursor: 'pointer',
                                        }}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </div>
                                ) : !isTitleCard ? (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (row.ai_image_prompt && row.ai_image_prompt.trim().length > 0) {
                                          const ok = confirm(
                                            `Replace the image prompt and visual fields?\n\nThe current AI image prompt will be saved to row notes so you can paste it back if needed.`,
                                          );
                                          if (!ok) return;
                                        }
                                        const backup = row.ai_image_prompt && row.ai_image_prompt.trim().length > 0
                                          ? `\n[backup-from-promote] ai_image_prompt was: ${row.ai_image_prompt}`
                                          : '';
                                        const titleText = row.script_text.trim();
                                        console.info('[production-doc row-promote]', {
                                          rowIndex: i,
                                          prevType: row.visual_type,
                                          titleChars: titleText.length,
                                          hadAiPrompt: Boolean(row.ai_image_prompt && row.ai_image_prompt.trim().length > 0),
                                        });
                                        updateRow(i, {
                                          visual_type: 'Title Card',
                                          ai_image_prompt: '',
                                          on_screen_text: titleText,
                                          stock_search_terms: '',
                                          visual_description: `Title card displaying "${titleText}"`,
                                          notes: `${(row.notes ?? '').trim()}${backup ? `\n${backup}`.trimStart() : ''}`.trim() ||
                                            'Title card scene — rendered as crisp typography without an image.',
                                        });
                                      }}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(168,85,247,0.12)',
                                        color: '#c084fc',
                                        border: '1px solid rgba(168,85,247,0.35)',
                                        cursor: 'pointer',
                                      }}
                                      title="Convert this whole row into a Title Card. The AI image prompt and stock terms will be cleared; the current prompt is backed up to row notes."
                                    >
                                      ⬚ Make this a title card
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSplittingRow({ rowIndex: i, titleDraft: guess })}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(34,211,238,0.12)',
                                        color: '#22d3ee',
                                        border: '1px solid rgba(34,211,238,0.35)',
                                        cursor: 'pointer',
                                      }}
                                      title={
                                        hasHeadingMarker
                                          ? 'Extract a title-card row from this script. You’ll confirm the exact title text.'
                                          : 'Split this row in two: a title card with the text you pick, plus a content row with what remains.'
                                      }
                                    >
                                      ✂ Split as title card…
                                    </button>
                                  </div>
                                ) : null}
                                {/* "Convert to motion collage" affordance —
                                    only meaningful on doodle_explainer_2,
                                    only on non-title-card rows, only when
                                    the row isn't already a motion_collage
                                    row. One click flips the shot_kind +
                                    seeds an empty 2×2 grid; the cell's AI
                                    Prompt column then renders the dedicated
                                    motion-collage editor. See
                                    `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */}
                                {stylePreset === 'doodle_explainer_2'
                                  && row.visual_type !== 'Title Card'
                                  && row.shot_kind !== 'motion_collage' && (
                                  <div className="mt-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        // Capture the scene content BEFORE the
                                        // convert clears ai_image_prompt — the
                                        // auto-fill needs it to decompose the
                                        // beat into keyframes.
                                        const grid = { cols: 2, rows: 2 };
                                        const captured = {
                                          grid,
                                          scriptText: row.script_text ?? '',
                                          visualDescription: row.visual_description,
                                          baseImagePrompt: row.ai_image_prompt,
                                          existingPanels: ['', '', '', ''] as string[],
                                        };
                                        updateRow(i, {
                                          shot_kind: 'motion_collage',
                                          motion_collage_grid: grid,
                                          motion_collage_panel_prompts: ['', '', '', ''],
                                          // Clear the regular prompt and any
                                          // existing image so the row reads
                                          // unambiguously as motion_collage
                                          // and the next gen runs the new path.
                                          ai_image_prompt: '',
                                          image_url: undefined,
                                          motion_collage_image_url: undefined,
                                          motion_collage_panel_urls: undefined,
                                        });
                                        // Immediately auto-fill the four panels
                                        // from the captured content. Fire and
                                        // forget — the editor shows a spinner
                                        // via autoFillingRows.
                                        void autoFillMotionCollagePanels(i, captured);
                                      }}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(124,58,237,0.12)',
                                        color: '#a78bfa',
                                        border: '1px solid rgba(124,58,237,0.35)',
                                        cursor: 'pointer',
                                      }}
                                      title="Convert this row to a motion collage: one image with N keyframes that play hard-cut over the row's duration. Best for real motion (running, falling, transforming)."
                                    >
                                      ↯ Convert to motion collage
                                    </button>
                                  </div>
                                )}
                                {/* Delete-row button — confirms before
                                    removing the row from the doc. Always
                                    available so the user can clean up
                                    LLM mis-tags (e.g. SFX/VISUAL CUE
                                    notes that got promoted to Title
                                    Card by mistake). The handler also
                                    removes the matching rowImages entry
                                    so the state machine stays aligned
                                    with the doc shape. Variant rows
                                    have their own per-group delete
                                    button elsewhere; this is for the
                                    base-row case only — variant rows
                                    would corrupt their group's
                                    indexing if deleted via this path,
                                    so the button hides when variant_index > 0. */}
                                {(row.variant_index ?? 0) === 0 && (
                                  <div className="mt-1.5">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const preview = (row.script_text ?? '').trim().slice(0, 50);
                                        const confirmed = window.confirm(
                                          `Delete row ${i + 1}${preview ? ` ("${preview}${preview.length === 50 ? '…' : ''}")` : ''}?\n\nThis cannot be undone.`,
                                        );
                                        if (!confirmed) return;
                                        setDoc((prev) =>
                                          prev
                                            ? { ...prev, rows: prev.rows.filter((_, idx) => idx !== i) }
                                            : prev,
                                        );
                                        setRowImages((prev) => {
                                          const next = [...prev];
                                          next.splice(i, 1);
                                          return next;
                                        });
                                        toast.success(`Row ${i + 1} deleted.`);
                                      }}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(239,68,68,0.10)',
                                        color: '#fca5a5',
                                        border: '1px solid rgba(239,68,68,0.35)',
                                        cursor: 'pointer',
                                      }}
                                      title="Delete this row from the doc. Cannot be undone."
                                    >
                                      🗑 Delete row
                                    </button>
                                  </div>
                                )}
                                {/* Phase 4 (Editor UI) — per-row character_id
                                    + scene_id chips. Gated on doodle_explainer_2
                                    since the cache mechanisms that consume
                                    these slugs are style-specific. The chips
                                    appear on every row regardless of variant
                                    group state, since LLM mis-tagging can
                                    happen on any row. Spec:
                                    _plans/2026-05-28-doodle-2-character-cache.md
                                    (Phase 4 — Editor UI). */}
                                {stylePreset === 'doodle_explainer_2' && (
                                  <div className="mt-1.5" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <SlugChip
                                      kind="character"
                                      value={row.character_id}
                                      availableSlugs={characterSlugTally}
                                      untaggedDescriptionSlugs={untaggedDescriptionSlugs}
                                      onChange={(next) => updateRow(i, { character_id: next })}
                                    />
                                    <SlugChip
                                      kind="scene"
                                      value={row.scene_id}
                                      availableSlugs={sceneSlugTally}
                                      onChange={(next) => updateRow(i, { scene_id: next })}
                                    />
                                  </div>
                                )}
                                {/* Phase 3.3 — variant-group controls. See
                                    _plans/2026-05-25-near-static-variants.md.
                                    Three branches:
                                      1. Variant row (variant_index > 0): show
                                         the "variant N of M" chip, the
                                         edit-prompt input, the Generate
                                         button ($0.011 Atlas Edit), and
                                         a small Delete affordance.
                                      2. Base row (variant_index === 0):
                                         show a "base — N variants" chip
                                         and the "+ Add variant" button.
                                      3. Standalone row (no group): show
                                         only "+ Add variant" so the user
                                         can promote the row into a group.
                                    The button is hidden when the group is
                                    at MAX_VARIANTS_PER_GROUP. */}
                                {isVariant ? (
                                  <div className="mt-1.5" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                    {/* Phase 3.7c — stale-on-base-change banner.
                                        Shown only when this variant has a
                                        snapshot of an OLDER base image. The
                                        banner directs the user to regenerate;
                                        clicking the Generate button below
                                        replaces the snapshot in the same flow. */}
                                    {isVariantStale && (
                                      <div
                                        className="text-[10px] px-2 py-1 rounded"
                                        style={{
                                          background: 'rgba(245,158,11,0.12)',
                                          color: '#fbbf24',
                                          border: '1px solid rgba(245,158,11,0.35)',
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 6,
                                        }}
                                        title="The base image was regenerated after this variant was created. The variant is still valid as bytes but is derived from an older base. Click Generate variant to redo it against the current base."
                                      >
                                        ⚠ Base changed — regenerate to match current base
                                      </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                      <span
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(34,211,238,0.12)',
                                          color: '#22d3ee',
                                          border: '1px solid rgba(34,211,238,0.35)',
                                          fontWeight: 600,
                                        }}
                                        title={`Variant ${row.variant_index} of ${groupSize - 1}. Image is derived from the base row's image via Atlas GPT Image 2 Edit ($0.011/call).`}
                                      >
                                        ⟜ variant {row.variant_index}/{groupSize - 1}
                                      </span>
                                      {/* Phase 3.7b — move up / move down within the
                                          group. Disabled at boundaries. */}
                                      <button
                                        type="button"
                                        onClick={() => moveVariantRow(i, 'up')}
                                        disabled={(row.variant_index ?? 0) <= 1}
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(255,255,255,0.04)',
                                          color: 'var(--text-secondary)',
                                          border: '1px solid var(--border)',
                                          cursor: (row.variant_index ?? 0) <= 1 ? 'not-allowed' : 'pointer',
                                          opacity: (row.variant_index ?? 0) <= 1 ? 0.4 : 1,
                                        }}
                                        title="Move this variant earlier in the sequence"
                                      >
                                        ↑
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => moveVariantRow(i, 'down')}
                                        disabled={(row.variant_index ?? 0) >= groupSize - 1}
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(255,255,255,0.04)',
                                          color: 'var(--text-secondary)',
                                          border: '1px solid var(--border)',
                                          cursor: (row.variant_index ?? 0) >= groupSize - 1 ? 'not-allowed' : 'pointer',
                                          opacity: (row.variant_index ?? 0) >= groupSize - 1 ? 0.4 : 1,
                                        }}
                                        title="Move this variant later in the sequence"
                                      >
                                        ↓
                                      </button>
                                      {/* Phase 3.7a — delete this variant. Confirms
                                          before destroying. */}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (window.confirm(`Delete variant ${row.variant_index}?`)) {
                                            deleteVariantRow(i);
                                          }
                                        }}
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(239,68,68,0.08)',
                                          color: '#f87171',
                                          border: '1px solid rgba(239,68,68,0.3)',
                                          cursor: 'pointer',
                                        }}
                                        title="Delete this variant. Remaining variants in the group renumber automatically."
                                      >
                                        🗑
                                      </button>
                                    </div>
                                    <textarea
                                      value={row.variant_edit_prompt ?? ''}
                                      onChange={(e) => updateRow(i, { variant_edit_prompt: e.target.value })}
                                      placeholder="What changes from the base? e.g. raise the right eyebrow"
                                      className="text-[10px] w-full"
                                      style={{
                                        minHeight: 38,
                                        resize: 'vertical',
                                        background: 'var(--bg-tertiary)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 4,
                                        padding: '4px 6px',
                                      }}
                                      maxLength={400}
                                    />
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      <button
                                        type="button"
                                        onClick={() => generateVariantImage(i)}
                                        disabled={imgState.status === 'loading' || !row.variant_edit_prompt?.trim()}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(124,58,237,0.15)',
                                          color: 'var(--accent-purple-bright)',
                                          border: '1px solid rgba(124,58,237,0.35)',
                                          cursor: imgState.status === 'loading' || !row.variant_edit_prompt?.trim() ? 'not-allowed' : 'pointer',
                                          opacity: imgState.status === 'loading' || !row.variant_edit_prompt?.trim() ? 0.5 : 1,
                                        }}
                                        title="Generate this variant by editing the base image with your prompt. ~$0.011 via Atlas GPT Image 2 Edit."
                                      >
                                        {imgState.status === 'loading' ? 'Generating…' : '✨ Generate variant (~$0.011)'}
                                      </button>
                                    </div>
                                  </div>
                                ) : isInGroup ? (
                                  <div className="mt-1.5" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(34,211,238,0.18)',
                                        color: '#22d3ee',
                                        border: '1px solid rgba(34,211,238,0.4)',
                                        fontWeight: 600,
                                      }}
                                      title="This is the BASE of a variant group. Generate this row's image normally; variants are derived from it."
                                    >
                                      ⏺ base · {groupSize - 1} variant{groupSize - 1 === 1 ? '' : 's'}
                                    </span>
                                    {/* Phase 1.7 (chained variants) R5 — per-group
                                        chain mode toggle. 3-state cycle:
                                          auto (inherits doc default)
                                          → parallel (siblings — V_n edits base)
                                          → chained (additive — V_n edits V_n-1)
                                          → auto
                                        Sets `group_variant_chain_default` on this
                                        base row. The setting governs (a) the
                                        default value of `variant_derives_from_previous`
                                        for new variants added via "+ Add variant"
                                        and (b) the dispatch routing for existing
                                        variants whose own field is unset. Per-
                                        variant chip toggle on individual variants
                                        always wins. Spec:
                                        _plans/2026-05-28-doodle-2-chained-variants.md (R5). */}
                                    {(() => {
                                      const groupMode = row.group_variant_chain_default;
                                      const cycleTo: 'parallel' | 'chained' | undefined =
                                        groupMode === undefined ? 'parallel'
                                        : groupMode === 'parallel' ? 'chained'
                                        : undefined;
                                      const label =
                                        groupMode === 'chained' ? '⛓ chained'
                                        : groupMode === 'parallel' ? '∥ parallel'
                                        : '∿ auto';
                                      const bg =
                                        groupMode === 'chained' ? 'rgba(168,85,247,0.18)'
                                        : groupMode === 'parallel' ? 'rgba(255,255,255,0.04)'
                                        : 'rgba(120,120,120,0.10)';
                                      const fg =
                                        groupMode === 'chained' ? 'var(--accent-purple-bright)'
                                        : groupMode === 'parallel' ? 'var(--text-secondary)'
                                        : 'var(--text-muted)';
                                      const border =
                                        groupMode === 'chained' ? '1px solid rgba(168,85,247,0.45)'
                                        : groupMode === 'parallel' ? '1px solid var(--border)'
                                        : '1px dashed var(--border)';
                                      const title =
                                        groupMode === 'chained'
                                          ? 'Group default: CHAINED. New variants in this group start as `variant_derives_from_previous: true` (additive frame-by-frame). Click to switch to AUTO (inherit doc default).'
                                          : groupMode === 'parallel'
                                          ? 'Group default: PARALLEL. New variants edit this base independently (siblings). Click to switch to CHAINED.'
                                          : 'Group default: AUTO. Inherits the doc-level "Chained variants by default" toggle. Click to override to PARALLEL.';
                                      return (
                                        <button
                                          type="button"
                                          onClick={() => updateRow(i, { group_variant_chain_default: cycleTo })}
                                          className="text-[10px] px-1.5 py-0.5 rounded"
                                          style={{ background: bg, color: fg, border, cursor: 'pointer' }}
                                          title={title}
                                        >
                                          {label}
                                        </button>
                                      );
                                    })()}
                                    {canAddVariant && (
                                      <button
                                        type="button"
                                        onClick={() => addVariantRow(i)}
                                        className="text-[10px] px-2 py-0.5 rounded"
                                        style={{
                                          background: 'rgba(34,211,238,0.12)',
                                          color: '#22d3ee',
                                          border: '1px solid rgba(34,211,238,0.35)',
                                          cursor: 'pointer',
                                        }}
                                        title={`Add another variant of this row. Max ${MAX_VARIANTS_PER_GROUP} per group (1 base + ${MAX_VARIANTS_PER_GROUP - 1} variants).`}
                                      >
                                        + Add variant
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <div className="mt-1.5">
                                    <button
                                      type="button"
                                      onClick={() => addVariantRow(i)}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(34,211,238,0.08)',
                                        color: '#22d3ee',
                                        border: '1px dashed rgba(34,211,238,0.4)',
                                        cursor: 'pointer',
                                      }}
                                      title="Promote this row into a variant group and add the first variant. Variants share the same composition; each one is a small edit of the base image (Atlas GPT Image 2 Edit, ~$0.011/call)."
                                    >
                                      + Add variant
                                    </button>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </td>
                        {/* Visual type — editable dropdown (2026-05-22).
                            Native <select> so we get keyboard + mobile +
                            screen-reader support for free; styled to match
                            the prior read-only pill, with the browser caret
                            doubling as the affordance that says "click me".
                            Switching to Title Card does NOT auto-rewrite
                            script_text or on_screen_text — the user is
                            taking explicit responsibility for the
                            classification; the renderer uses whatever the
                            row already holds. */}
                        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', borderRight: '1px solid var(--border)' }}>
                          <select
                            value={row.visual_type}
                            onChange={(e) => updateRow(i, { visual_type: e.target.value })}
                            className="px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
                            style={{
                              background: vt.bg,
                              color: vt.color,
                              border: '1px solid transparent',
                              outline: 'none',
                            }}
                            title="Change visual type for this shot"
                          >
                            {Object.keys(VISUAL_TYPE_COLORS).map((type) => (
                              <option key={type} value={type} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                                {type}
                              </option>
                            ))}
                          </select>
                        </td>
                        {/* Visual description */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', maxWidth: 180, lineHeight: 1.5, borderRight: '1px solid var(--border)' }}>
                          {row.visual_description}
                        </td>
                        {/* Stock terms */}
                        <td style={{ padding: '8px 12px', maxWidth: 130, borderRight: '1px solid var(--border)' }}>
                          <div className="flex flex-wrap gap-1">
                            {row.stock_search_terms.split(',').map((t, ti) => (
                              <span key={ti} className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                {t.trim()}
                              </span>
                            ))}
                          </div>
                        </td>
                        {/* Image */}
                        <td style={{ padding: '8px 10px', width: 100, borderRight: '1px solid var(--border)', verticalAlign: 'middle' }}>
                          <ImageCell
                            state={imgState}
                            // 2026-05-28 (Bug "Search Images stuck"): when the LLM
                            // omitted ai_image_prompt for a row but visual_description
                            // is present, fall back to visual_description so the
                            // user can still click "Generate AI image" instead of
                            // having to manually click "+ Add prompt" and retype
                            // the same description (rule 10 — lazy user).
                            canGenerate={
                              // motion_collage rows can be generated as
                              // long as they carry panel_prompts — they
                              // intentionally leave ai_image_prompt empty.
                              row.shot_kind === 'motion_collage'
                                ? Boolean(row.motion_collage_panel_prompts?.length)
                                : Boolean(row.ai_image_prompt?.trim() || row.visual_description?.trim())
                            }
                            motionCollagePanelUrls={row.motion_collage_panel_urls}
                            motionCollageGrid={row.motion_collage_grid}
                            onRetry={() => {
                              // doodle_explainer_2 motion_collage rows
                              // bypass the regular prompt-based path —
                              // their content lives on motion_collage_*
                              // fields and goes through the dedicated
                              // /motion-collage endpoint. See plan §9.
                              if (row.shot_kind === 'motion_collage') {
                                return generateMotionCollageForRow(i);
                              }
                              const promptSource = row.ai_image_prompt?.trim() || row.visual_description?.trim();
                              if (!promptSource) return;
                              // Persist the visual_description fallback into
                              // ai_image_prompt so the user can see / edit it,
                              // and so subsequent regenerations reuse it.
                              if (!row.ai_image_prompt?.trim()) {
                                updateRow(i, { ai_image_prompt: promptSource });
                              }
                              const sheetRef = doc ? resolveSheetReference(row, doc) : { referenceImageUrl: undefined, styleSheetDescription: undefined };
                              generateImageForRow(i, promptSource, {
                                onScreenText: row.on_screen_text,
                                onScreenTextMode: row.on_screen_text_mode ?? doc?.on_screen_text_mode_default,
                                sectionTitle: row.section_title,
                                sectionTitleLayout: row.section_title_layout ?? doc?.section_title_layout_default,
                                referenceImageUrl: sheetRef.referenceImageUrl,
                                styleSheetDescription: sheetRef.styleSheetDescription,
                                overlayStockTerms: row.overlay_stock_terms,
                                skipOverlay: typeof row.skip_overlay === 'boolean'
                                  ? row.skip_overlay
                                  : doc?.overlays_disabled === true,
                                characterId: row.character_id,
                                sceneId: row.scene_id,
                              });
                            }}
                            onUpload={(file) => { void uploadImageForRow(i, file); }}
                            onUrlImport={(url) => { void importImageUrlForRow(i, url); }}
                            onEdit={() => setEditPanelRow(i)}
                            pipelineError={row.last_error ?? null}
                            pipelineErrorExhausted={Boolean(
                              row.last_error && isExhausted(row.attempts, row.last_error.class),
                            )}
                            onPipelineErrorRetry={() => updateRow(i, { attempts: 0, last_error: null })}
                          />
                        </td>
                        {/* B-roll (animation pipeline — Kling 2.5 turbo i2v by default) */}
                        <td style={{ padding: '8px 10px', width: 140, borderRight: '1px solid var(--border)', verticalAlign: 'middle', position: 'relative' }}>
                          {animateScenes ? (() => {
                            const sig = brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            });
                            return (
                              <BrollCell
                                rowIndex={i}
                                rowSignature={sig}
                                productionDocId={historyEntryId}
                                sceneDurationMs={computeRowSceneDurationMs(i)}
                                visualDescription={row.visual_description}
                                aiImagePrompt={row.ai_image_prompt}
                                styleHint={stylePreset}
                                stillImageUrl={imgState.status === 'done' ? imgState.imageUrl : undefined}
                                initialClip={rowBatchStubs[i] ?? undefined}
                                lockedAsStill={Boolean(rowLockSignatures[sig])}
                                onToggleLockedAsStill={(locked) => toggleRowLock(sig, locked)}
                                docBrollModelId={doc.broll_model_id as BrollModelId | undefined}
                                onClipChange={(clip) =>
                                  handleBrollClipChange(
                                    i,
                                    clip ? { id: clip.id, status: clip.status, video_url: clip.video_url, duration_seconds: clip.duration_seconds } : null,
                                  )
                                }
                              />
                            );
                          })() : (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              Animation off
                            </span>
                          )}
                        </td>
                        {/* AI prompt — click ✎ to edit inline. The textarea
                            commits to the row on Save; image regeneration
                            uses the new prompt next time the user clicks
                            the row's Image Retry / re-generate button.

                            Motion-collage rows take over the cell with a
                            dedicated editor (grid picker + N panel
                            textareas) instead of the regular prompt textarea.
                            See `_plans/2026-05-31-doodle-explainer-2-motion-collage.md`. */}
                        <td style={{ padding: '8px 12px', maxWidth: 240, borderRight: '1px solid var(--border)' }}>
                          {row.shot_kind === 'motion_collage' ? (
                            <MotionCollageRowEditor
                              grid={row.motion_collage_grid}
                              panelPrompts={row.motion_collage_panel_prompts ?? []}
                              onChange={(next) => {
                                // Any grid / prompt change invalidates the
                                // currently-rendered panels — clear image_url
                                // so the next Generate pass triggers a fresh
                                // collage run. The motion_collage_* fields
                                // carry the new state forward.
                                const prevPanels = row.motion_collage_panel_prompts ?? [];
                                updateRow(i, {
                                  motion_collage_grid: next.grid,
                                  motion_collage_panel_prompts: next.panelPrompts,
                                  image_url: undefined,
                                  motion_collage_image_url: undefined,
                                  motion_collage_panel_urls: undefined,
                                });
                                // Grid EXPANSION (e.g. 2×2 → 3×2) on a row that
                                // already has at least one written panel: auto-
                                // fill ONLY the newly-added blanks, keeping the
                                // existing panels (the user's grid-change choice).
                                // Skip on prompt edits and on shrink/equal grids.
                                if (next.reason === 'grid') {
                                  const grew = next.panelPrompts.length > prevPanels.length;
                                  const hasContent = next.panelPrompts.some((p) => p.trim());
                                  const hasBlanks = next.panelPrompts.some((p) => !p.trim());
                                  if (grew && hasContent && hasBlanks) {
                                    void autoFillMotionCollagePanels(i, {
                                      grid: next.grid,
                                      scriptText: row.script_text ?? '',
                                      visualDescription: row.visual_description,
                                      baseImagePrompt: row.ai_image_prompt,
                                      existingPanels: next.panelPrompts,
                                    });
                                  }
                                }
                              }}
                              onRevertToRegular={() => {
                                updateRow(i, {
                                  shot_kind: undefined,
                                  motion_collage_grid: undefined,
                                  motion_collage_panel_prompts: undefined,
                                  motion_collage_image_url: undefined,
                                  motion_collage_panel_urls: undefined,
                                  image_url: undefined,
                                });
                              }}
                              onAutoFill={() => {
                                void autoFillMotionCollagePanels(i, {
                                  grid: row.motion_collage_grid ?? { cols: 2, rows: 2 },
                                  scriptText: row.script_text ?? '',
                                  visualDescription: row.visual_description,
                                  baseImagePrompt: row.ai_image_prompt,
                                  existingPanels: row.motion_collage_panel_prompts ?? [],
                                });
                              }}
                              autoFilling={autoFillingRows.has(i)}
                            />
                          ) : editingPromptRow?.rowIndex === i ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                autoFocus
                                value={editingPromptRow.draft}
                                onChange={(e) => setEditingPromptRow({ rowIndex: i, draft: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') setEditingPromptRow(null);
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    updateRow(i, { ai_image_prompt: editingPromptRow.draft });
                                    setEditingPromptRow(null);
                                  }
                                }}
                                rows={6}
                                style={{
                                  fontSize: 11,
                                  padding: '6px 8px',
                                  borderRadius: 4,
                                  background: 'rgba(0,0,0,0.25)',
                                  color: 'var(--text)',
                                  border: '1px solid rgba(34,211,238,0.35)',
                                  outline: 'none',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  resize: 'vertical',
                                  lineHeight: 1.4,
                                }}
                              />
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    updateRow(i, { ai_image_prompt: editingPromptRow.draft });
                                    setEditingPromptRow(null);
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.20)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.45)',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingPromptRow(null)}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'transparent',
                                    color: 'var(--text-muted)',
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Cancel
                                </button>
                                <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                                  ⌘/Ctrl+Enter to save
                                </span>
                              </div>
                            </div>
                          ) : row.ai_image_prompt ? (
                            <div className="flex items-start gap-1">
                              <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', lineHeight: 1.5, flex: 1 }}>
                                {row.ai_image_prompt}
                              </span>
                              <div className="flex flex-col gap-0.5">
                                <CopyButton text={row.ai_image_prompt} />
                                <button
                                  type="button"
                                  onClick={() => setEditingPromptRow({ rowIndex: i, draft: row.ai_image_prompt })}
                                  className="text-[10px] px-1.5 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.10)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.30)',
                                    cursor: 'pointer',
                                  }}
                                  title="Edit this prompt"
                                  aria-label="Edit AI prompt"
                                >
                                  ✎
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingPromptRow({ rowIndex: i, draft: '' })}
                              className="text-[10px] px-2 py-0.5 rounded"
                              style={{
                                background: 'rgba(34,211,238,0.10)',
                                color: '#22d3ee',
                                border: '1px solid rgba(34,211,238,0.30)',
                                cursor: 'pointer',
                              }}
                            >
                              + Add prompt
                            </button>
                          )}
                        </td>
                        {/* Overlay (real-image composite) — shows the LLM's
                            planned terms plus the auto-fetch status pill.
                            The fetch fires alongside the row's image gen and
                            its result is composited at render time. */}
                        {showOverlayColumn && (
                          <td style={{ padding: '8px 12px', maxWidth: 160, borderRight: '1px solid var(--border)' }}>
                            {row.overlay_stock_terms?.trim() ? (
                              <OverlayCell
                                terms={row.overlay_stock_terms}
                                zone={row.overlay_zone}
                                size={row.overlay_size}
                                state={rowOverlays[i]}
                                onRetry={() => fetchOverlayForRow(i, row.overlay_stock_terms!.trim())}
                                onOpenPositionEditor={() => setOverlayPositionRow(i)}
                                hasManualPosition={Boolean(row.overlay_position)}
                                onRethink={() => { void rethinkOverlayPlacement(i); }}
                                isRethinking={rethinkingRows.has(i)}
                                rethinkExhausted={(rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS}
                                onEditImage={() => setOverlayEditRow(i)}
                                onUndoEdit={() => undoOverlayEdit(i)}
                                editHistoryDepth={row.overlay_edit_history?.length ?? 0}
                                onShowContextMenu={(x, y) =>
                                  setOverlayContextMenu({ rowIndex: i, x, y })
                                }
                                onRemove={() => removeOverlayFromRow(i)}
                              />
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                            )}
                          </td>
                        )}
                        {/* On-screen text + per-row OST mode picker.
                            Mode picker mounts only when the row has text —
                            otherwise there's nothing to bake or overlay
                            and the controls would be confusing. */}
                        <td style={{ padding: '8px 12px', borderRight: '1px solid var(--border)' }}>
                          {row.on_screen_text ? (
                            <>
                              <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>
                                {row.on_screen_text}
                              </span>
                              <OstModeControl
                                value={row.on_screen_text_mode}
                                docDefault={doc.on_screen_text_mode_default}
                                onChange={(next: OstMode) => updateRow(i, { on_screen_text_mode: next })}
                                onApplyToAll={applyOstModeToAll}
                              />
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>—</span>
                          )}
                        </td>
                        {/* Notes */}
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)', maxWidth: 130, fontSize: '0.7rem', lineHeight: 1.5 }}>
                          {row.notes || '—'}
                        </td>
                        {/* Section column — always rendered now. Hosts the
                            thumbnail-zoom controls (only when a thumbnail
                            exists) AND the per-row scene-fade pill (always),
                            so every row stays controllable. */}
                        <td style={{ padding: '8px 10px', width: 170, verticalAlign: 'top' }}>
                          <SectionRowControls
                            rowIndex={i}
                            totalRows={doc.rows.length}
                            thumbnail={doc.thumbnail}
                            zoomTo={row.thumbnail_zoom_to}
                            sectionTitle={row.section_title}
                            sectionTitleLayout={row.section_title_layout}
                            sectionTitleLayoutDefault={doc.section_title_layout_default}
                            pillarboxColor={row.pillarbox_color}
                            pillarboxColorDefault={doc.pillarbox_color_default}
                            sceneZoom={row.scene_zoom}
                            sceneZoomDefault={doc.scene_zoom_default}
                            regionZoomPaddingPct={row.region_zoom_padding_pct}
                            regionZoomPaddingDefaultPct={doc.region_zoom_padding_default_pct}
                            transition={row.thumbnail_transition}
                            defaultTransition={doc.thumbnail?.defaultTransition}
                            sceneFade={row.scene_fade}
                            sceneFadeDefault={doc.scene_fade_enabled}
                            onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                            onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                            onChangeSectionTitleLayout={(l) => updateRow(i, { section_title_layout: l })}
                            onChangePillarboxColor={(c) => updateRow(i, { pillarbox_color: c })}
                            onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            onChangeSceneFade={(next) => updateRow(i, { scene_fade: next })}
                            onApplyTitleToRange={applyTitleToRange}
                            onApplyPillarboxColorToAll={applyPillarboxColorToAll}
                            onClearPillarboxOverrides={clearPillarboxOverrides}
                            onApplyStripeLayoutToAll={applyStripeLayoutToAll}
                            onClearStripeLayoutOverrides={clearStripeLayoutOverrides}
                            onChangeSceneZoom={(z) => updateRow(i, { scene_zoom: z })}
                            onApplySceneZoomToAll={applySceneZoomToAll}
                            onClearSceneZoomOverrides={clearSceneZoomOverrides}
                            onChangeRegionZoomPadding={(p) => updateRow(i, { region_zoom_padding_pct: p })}
                            onApplyRegionZoomPaddingToAll={applyRegionZoomPaddingToAll}
                            visualType={row.visual_type}
                            titleCardSourceText={(row.on_screen_text || row.script_text || '').trim()}
                            onApplyTitleCardAsSectionTitle={() => applyTitleCardAsSectionTitle(i)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Mobile cards */}
            <div className="md:hidden divide-y" style={{ borderColor: 'var(--border)' }}>
              {doc.rows?.map((row, i) => {
                if (filters.visualTypes.length > 0 && !filters.visualTypes.includes(row.visual_type)) return null;
                if (filters.motionCollageOnly && row.shot_kind !== 'motion_collage') return null;
                if (filters.search.trim().length > 0) {
                  const q = filters.search.trim().toLowerCase();
                  const hay = `${row.script_text ?? ''}\n${row.visual_description ?? ''}\n${row.on_screen_text ?? ''}`.toLowerCase();
                  if (!hay.includes(q)) return null;
                }
                const vt = VISUAL_TYPE_COLORS[row.visual_type] || VISUAL_TYPE_COLORS['B-Roll'];
                const imgState = rowImages[i] || { status: 'idle' };
                const isOpen = expandedRow === i;
                return (
                  <div key={i} className="p-4">
                    <button
                      className="w-full flex items-center gap-3 text-left"
                      onClick={() => setExpandedRow(isOpen ? null : i)}
                    >
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', width: 16 }}>{i + 1}</span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan-bright)', fontWeight: 700, fontSize: '0.8rem' }}>{row.timecode}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: vt.bg, color: vt.color }}>{row.visual_type}</span>
                      <span className="flex-1 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{row.script_text}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', color: 'var(--text-muted)', flexShrink: 0 }}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {isOpen && (
                      <div className="mt-3 space-y-2.5 pl-4">
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Script</p>
                          {editingScriptRow?.rowIndex === i ? (
                            <div className="flex flex-col gap-1">
                              <textarea
                                autoFocus
                                value={editingScriptRow.draft}
                                onChange={(e) => setEditingScriptRow({ rowIndex: i, draft: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') setEditingScriptRow(null);
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    const next = editingScriptRow.draft;
                                    console.info('[production-doc script-edit]', {
                                      rowIndex: i,
                                      charsBefore: row.script_text.length,
                                      charsAfter: next.length,
                                    });
                                    updateRow(i, { script_text: next });
                                    setEditingScriptRow(null);
                                  }
                                }}
                                rows={5}
                                style={{
                                  fontSize: 12,
                                  padding: '6px 8px',
                                  borderRadius: 4,
                                  background: 'rgba(0,0,0,0.25)',
                                  color: 'var(--text)',
                                  border: '1px solid rgba(34,211,238,0.35)',
                                  outline: 'none',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  resize: 'vertical',
                                  lineHeight: 1.4,
                                }}
                              />
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = editingScriptRow.draft;
                                    console.info('[production-doc script-edit]', {
                                      rowIndex: i,
                                      charsBefore: row.script_text.length,
                                      charsAfter: next.length,
                                    });
                                    updateRow(i, { script_text: next });
                                    setEditingScriptRow(null);
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.20)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.45)',
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                  }}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingScriptRow(null)}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'transparent',
                                    color: 'var(--text-muted)',
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-1">
                              <p className="text-xs flex-1" style={{ color: 'var(--text-primary)' }}>{row.script_text}</p>
                              <button
                                type="button"
                                onClick={() => setEditingScriptRow({ rowIndex: i, draft: row.script_text })}
                                className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                                style={{
                                  background: 'rgba(34,211,238,0.10)',
                                  color: '#22d3ee',
                                  border: '1px solid rgba(34,211,238,0.30)',
                                  cursor: 'pointer',
                                  lineHeight: 1.1,
                                }}
                                title="Edit script text"
                              >
                                ✎
                              </button>
                            </div>
                          )}
                          {(() => {
                            const hasHeadingMarker = /^\s*##/.test(row.script_text);
                            const isTitleCard = row.visual_type === 'Title Card';
                            const guessMatch = hasHeadingMarker
                              ? row.script_text.match(/^\s*##\s*(\S+(?:\s+\S+){0,1})/)
                              : row.script_text.match(/^\s*(\S+(?:\s+\S+){0,1})/);
                            const guess = guessMatch?.[1]?.trim() || '';
                            const isEditingThisRow = splittingRow?.rowIndex === i;
                            if (isEditingThisRow) {
                              return (
                                <div
                                  className="mt-1.5 flex flex-col gap-1.5 p-2 rounded"
                                  style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.35)' }}
                                >
                                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                    Pick the title text to extract:
                                  </span>
                                  <input
                                    type="text"
                                    autoFocus
                                    value={splittingRow.titleDraft}
                                    onChange={(e) => setSplittingRow({ rowIndex: i, titleDraft: e.target.value })}
                                    placeholder="Title text"
                                    style={{
                                      fontSize: 11,
                                      padding: '4px 6px',
                                      borderRadius: 4,
                                      background: 'rgba(0,0,0,0.25)',
                                      color: 'var(--text)',
                                      border: '1px solid rgba(255,255,255,0.10)',
                                      outline: 'none',
                                    }}
                                  />
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const t = splittingRow.titleDraft.trim();
                                        if (!t) return;
                                        console.info('[production-doc row-split]', { rowIndex: i, titleLen: t.length });
                                        splitTitleCardFromRow(i, t);
                                        setSplittingRow(null);
                                      }}
                                      disabled={!splittingRow.titleDraft.trim()}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'rgba(34,211,238,0.20)',
                                        color: '#22d3ee',
                                        border: '1px solid rgba(34,211,238,0.45)',
                                        cursor: splittingRow.titleDraft.trim() ? 'pointer' : 'not-allowed',
                                        fontWeight: 600,
                                      }}
                                    >
                                      Apply
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setSplittingRow(null)}
                                      className="text-[10px] px-2 py-0.5 rounded"
                                      style={{
                                        background: 'transparent',
                                        color: 'var(--text-muted)',
                                        border: '1px solid rgba(255,255,255,0.10)',
                                        cursor: 'pointer',
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            if (isTitleCard) return null;
                            return (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (row.ai_image_prompt && row.ai_image_prompt.trim().length > 0) {
                                      const ok = confirm(
                                        `Replace the image prompt and visual fields?\n\nThe current AI image prompt will be saved to row notes so you can paste it back if needed.`,
                                      );
                                      if (!ok) return;
                                    }
                                    const backup = row.ai_image_prompt && row.ai_image_prompt.trim().length > 0
                                      ? `[backup-from-promote] ai_image_prompt was: ${row.ai_image_prompt}`
                                      : '';
                                    const titleText = row.script_text.trim();
                                    console.info('[production-doc row-promote]', {
                                      rowIndex: i,
                                      prevType: row.visual_type,
                                      titleChars: titleText.length,
                                    });
                                    updateRow(i, {
                                      visual_type: 'Title Card',
                                      ai_image_prompt: '',
                                      on_screen_text: titleText,
                                      stock_search_terms: '',
                                      visual_description: `Title card displaying "${titleText}"`,
                                      notes: `${(row.notes ?? '').trim()}${backup ? `\n${backup}` : ''}`.trim() ||
                                        'Title card scene — rendered as crisp typography without an image.',
                                    });
                                  }}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(168,85,247,0.12)',
                                    color: '#c084fc',
                                    border: '1px solid rgba(168,85,247,0.35)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  ⬚ Make this a title card
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSplittingRow({ rowIndex: i, titleDraft: guess })}
                                  className="text-[10px] px-2 py-0.5 rounded"
                                  style={{
                                    background: 'rgba(34,211,238,0.12)',
                                    color: '#22d3ee',
                                    border: '1px solid rgba(34,211,238,0.35)',
                                    cursor: 'pointer',
                                  }}
                                >
                                  ✂ Split as title card…
                                </button>
                              </div>
                            );
                          })()}
                        </div>
                        {/* Mobile: editable visual type. The collapsed
                            header keeps the read-only pill — putting a
                            <select> inside the toggle <button> would
                            hijack the click to expand/collapse. */}
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Visual type</p>
                          <select
                            value={row.visual_type}
                            onChange={(e) => updateRow(i, { visual_type: e.target.value })}
                            className="px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer"
                            style={{
                              background: vt.bg,
                              color: vt.color,
                              border: '1px solid transparent',
                              outline: 'none',
                            }}
                          >
                            {Object.keys(VISUAL_TYPE_COLORS).map((type) => (
                              <option key={type} value={type} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>
                                {type}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Visual</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.visual_description}</p>
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Image</p>
                          <ImageCell
                            state={imgState}
                            // Same fallback as the wide-view ImageCell above:
                            // visual_description backstops a missing
                            // ai_image_prompt so the user can generate without
                            // re-typing what's already in the doc.
                            canGenerate={
                              // motion_collage rows can be generated as
                              // long as they carry panel_prompts — they
                              // intentionally leave ai_image_prompt empty.
                              row.shot_kind === 'motion_collage'
                                ? Boolean(row.motion_collage_panel_prompts?.length)
                                : Boolean(row.ai_image_prompt?.trim() || row.visual_description?.trim())
                            }
                            motionCollagePanelUrls={row.motion_collage_panel_urls}
                            motionCollageGrid={row.motion_collage_grid}
                            onRetry={() => {
                              // Mirrors the wide-view branch above:
                              // motion_collage rows route to their own
                              // endpoint via generateMotionCollageForRow.
                              if (row.shot_kind === 'motion_collage') {
                                return generateMotionCollageForRow(i);
                              }
                              const promptSource = row.ai_image_prompt?.trim() || row.visual_description?.trim();
                              if (!promptSource) return;
                              if (!row.ai_image_prompt?.trim()) {
                                updateRow(i, { ai_image_prompt: promptSource });
                              }
                              const sheetRef = doc ? resolveSheetReference(row, doc) : { referenceImageUrl: undefined, styleSheetDescription: undefined };
                              return generateImageForRow(i, promptSource, {
                                onScreenText: row.on_screen_text,
                                onScreenTextMode: row.on_screen_text_mode ?? doc?.on_screen_text_mode_default,
                                sectionTitle: row.section_title,
                                sectionTitleLayout: row.section_title_layout ?? doc?.section_title_layout_default,
                                referenceImageUrl: sheetRef.referenceImageUrl,
                                styleSheetDescription: sheetRef.styleSheetDescription,
                                overlayStockTerms: row.overlay_stock_terms,
                                skipOverlay: typeof row.skip_overlay === 'boolean'
                                  ? row.skip_overlay
                                  : doc?.overlays_disabled === true,
                                characterId: row.character_id,
                                sceneId: row.scene_id,
                              });
                            }}
                            onUpload={(file) => { void uploadImageForRow(i, file); }}
                            onUrlImport={(url) => { void importImageUrlForRow(i, url); }}
                            onEdit={() => setEditPanelRow(i)}
                            pipelineError={row.last_error ?? null}
                            pipelineErrorExhausted={Boolean(
                              row.last_error && isExhausted(row.attempts, row.last_error.class),
                            )}
                            onPipelineErrorRetry={() => updateRow(i, { attempts: 0, last_error: null })}
                          />
                        </div>
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>B-roll</p>
                          {animateScenes ? (() => {
                            const sig = brollRowSignatureInput({
                              timecode: row.timecode,
                              visual_description: row.visual_description,
                            });
                            return (
                              <BrollCell
                                rowIndex={i}
                                rowSignature={sig}
                                productionDocId={historyEntryId}
                                sceneDurationMs={computeRowSceneDurationMs(i)}
                                visualDescription={row.visual_description}
                                aiImagePrompt={row.ai_image_prompt}
                                styleHint={stylePreset}
                                stillImageUrl={imgState.status === 'done' ? imgState.imageUrl : undefined}
                                initialClip={rowBatchStubs[i] ?? undefined}
                                lockedAsStill={Boolean(rowLockSignatures[sig])}
                                onToggleLockedAsStill={(locked) => toggleRowLock(sig, locked)}
                                docBrollModelId={doc.broll_model_id as BrollModelId | undefined}
                                onClipChange={(clip) =>
                                  handleBrollClipChange(
                                    i,
                                    clip ? { id: clip.id, status: clip.status, video_url: clip.video_url, duration_seconds: clip.duration_seconds } : null,
                                  )
                                }
                              />
                            );
                          })() : (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              Animation off (stills only)
                            </span>
                          )}
                        </div>
                        {row.ai_image_prompt && (
                          <div>
                            <div className="flex items-center justify-between mb-0.5">
                              <p className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>AI Prompt</p>
                              <CopyButton text={row.ai_image_prompt} />
                            </div>
                            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.ai_image_prompt}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Stock Terms</p>
                          <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{row.stock_search_terms}</p>
                        </div>
                        {row.overlay_stock_terms?.trim() && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: '#fbbf24' }}>✦ Real-image overlay</p>
                            <OverlayCell
                              terms={row.overlay_stock_terms}
                              zone={row.overlay_zone}
                              size={row.overlay_size}
                              state={rowOverlays[i]}
                              onRetry={() => fetchOverlayForRow(i, row.overlay_stock_terms!.trim())}
                              onOpenPositionEditor={() => setOverlayPositionRow(i)}
                              hasManualPosition={Boolean(row.overlay_position)}
                              onRethink={() => { void rethinkOverlayPlacement(i); }}
                              isRethinking={rethinkingRows.has(i)}
                              rethinkExhausted={(rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS}
                              onEditImage={() => setOverlayEditRow(i)}
                              onUndoEdit={() => undoOverlayEdit(i)}
                              editHistoryDepth={row.overlay_edit_history?.length ?? 0}
                              onShowContextMenu={(x, y) =>
                                setOverlayContextMenu({ rowIndex: i, x, y })
                              }
                              onRemove={() => removeOverlayFromRow(i)}
                            />
                          </div>
                        )}
                        {row.on_screen_text && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>On-Screen Text</p>
                            <p className="text-xs" style={{ color: '#fbbf24' }}>{row.on_screen_text}</p>
                            <OstModeControl
                              value={row.on_screen_text_mode}
                              docDefault={doc.on_screen_text_mode_default}
                              onChange={(next: OstMode) => updateRow(i, { on_screen_text_mode: next })}
                              onApplyToAll={applyOstModeToAll}
                            />
                          </div>
                        )}
                        {row.notes && (
                          <div>
                            <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-muted)' }}>Notes</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{row.notes}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>Section</p>
                          <SectionRowControls
                            rowIndex={i}
                            totalRows={doc.rows.length}
                            thumbnail={doc.thumbnail}
                            zoomTo={row.thumbnail_zoom_to}
                            sectionTitle={row.section_title}
                            sectionTitleLayout={row.section_title_layout}
                            sectionTitleLayoutDefault={doc.section_title_layout_default}
                            pillarboxColor={row.pillarbox_color}
                            pillarboxColorDefault={doc.pillarbox_color_default}
                            sceneZoom={row.scene_zoom}
                            sceneZoomDefault={doc.scene_zoom_default}
                            regionZoomPaddingPct={row.region_zoom_padding_pct}
                            regionZoomPaddingDefaultPct={doc.region_zoom_padding_default_pct}
                            transition={row.thumbnail_transition}
                            defaultTransition={doc.thumbnail?.defaultTransition}
                            sceneFade={row.scene_fade}
                            sceneFadeDefault={doc.scene_fade_enabled}
                            onChangeZoomTo={(id) => updateRow(i, { thumbnail_zoom_to: id })}
                            onChangeSectionTitle={(t) => updateRow(i, { section_title: t })}
                            onChangeSectionTitleLayout={(l) => updateRow(i, { section_title_layout: l })}
                            onChangePillarboxColor={(c) => updateRow(i, { pillarbox_color: c })}
                            onChangeTransition={(t) => updateRow(i, { thumbnail_transition: t })}
                            onChangeSceneFade={(next) => updateRow(i, { scene_fade: next })}
                            onApplyTitleToRange={applyTitleToRange}
                            onApplyPillarboxColorToAll={applyPillarboxColorToAll}
                            onClearPillarboxOverrides={clearPillarboxOverrides}
                            onApplyStripeLayoutToAll={applyStripeLayoutToAll}
                            onClearStripeLayoutOverrides={clearStripeLayoutOverrides}
                            onChangeSceneZoom={(z) => updateRow(i, { scene_zoom: z })}
                            onApplySceneZoomToAll={applySceneZoomToAll}
                            onClearSceneZoomOverrides={clearSceneZoomOverrides}
                            onChangeRegionZoomPadding={(p) => updateRow(i, { region_zoom_padding_pct: p })}
                            onApplyRegionZoomPaddingToAll={applyRegionZoomPaddingToAll}
                            visualType={row.visual_type}
                            titleCardSourceText={(row.on_screen_text || row.script_text || '').trim()}
                            onApplyTitleCardAsSectionTitle={() => applyTitleCardAsSectionTitle(i)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Video Preview & Render ─────────────────────────────────────── */}
          <div className="mt-6 glass rounded-xl overflow-hidden">
            {/* Header — toggle */}
            <button
              className="w-full flex items-center justify-between px-5 py-4"
              onClick={() => setShowVideoPreview(v => !v)}
            >
              <div className="flex items-center gap-3">
                {/* Film icon */}
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.15)' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                    <line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" />
                    <line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" />
                    <line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" />
                    <line x1="17" y1="7" x2="22" y2="7" />
                  </svg>
                </div>
                <div className="text-left">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    Video Preview & Render
                  </span>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Assemble your shots into a real animated video powered by Remotion
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* Shot/image count badges */}
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
                  {doc.rows.length} shots
                </span>
                {rowImages.filter(r => r?.status === 'done').length > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(16,185,129,0.1)', color: '#34d399' }}>
                    {rowImages.filter(r => r?.status === 'done').length} images ready
                  </span>
                )}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ transform: showVideoPreview ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', color: 'var(--text-muted)' }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
            </button>

            {showVideoPreview && (
              <div className="px-5 pb-5 space-y-4" style={{ borderTop: '1px solid var(--border)' }}>
                {/* Voiceover picker — pulls from the workspace library and
                    auto-matches by schedule item / video title when possible. */}
                <div className="pt-4">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    Voiceover
                    <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>
                      (optional, auto-matched from your Voiceover library when we know which video this is)
                    </span>
                  </label>
                  <VoiceoverPicker
                    value={voiceoverUrl}
                    onChange={(url) => setVoiceoverUrl(url)}
                    scheduleItemId={scheduleItemId}
                    projectId={scheduleItem?.project_id ?? projectIdParam}
                    titleCandidates={[scheduleItem?.title, doc?.title, topic]}
                    onRequireProject={ensureProjectForVoiceover}
                  />
                  {/* Voiceover-aligned scene timing pill. Sits directly
                      under the picker — same visual locus as the data
                      it talks about, so a lazy user sees both at once. */}
                  {voiceoverUrl && (
                    <AlignmentPill
                      status={alignmentStatus}
                      detail={alignmentDetail}
                      onRealign={() => { void runAlignment({ forceRefresh: true }); }}
                    />
                  )}
                </div>

                {/* Per-video visual brand kit override (channel kit ← override ← bar below). */}
                <VisualBrandKitOverridePanel
                  channelId={activeChannelId}
                  channelKit={channelVisualKit}
                  override={visualKitOverride}
                  onChange={handleVisualKitOverrideChange}
                />

                {/* Phase 7 — per-doc style sheet for cross-shot visual consistency.
                    Generated once; every per-row image chains against it via
                    i2i at denoise 0.7 (local) or as a textual hint (cloud Kie).
                    See `_plans/2026-05-21-phase-7-style-sheet.md`. */}
                <div className="mt-2">
                  <StyleSheetPanel
                    sheetUrl={doc.style_sheet_url}
                    hasProtagonist={doc.style_sheet_has_protagonist ?? true}
                    styleDescription={doc.style_sheet_description ?? ''}
                    protagonistDescription={styleSheetProtagonistDraft}
                    sheetModel={doc.style_sheet_model}
                    onGenerate={runGenerateStyleSheet}
                    onChangeHasProtagonist={setStyleSheetHasProtagonist}
                    onChangeStyleDescription={setStyleSheetDescription}
                    onChangeProtagonistDescription={setStyleSheetProtagonistDraft}
                    onClear={clearStyleSheet}
                    generating={generatingStyleSheet}
                    localStudioEnabled={localStudioEnabled}
                  />
                </div>

                {/* Brand kit quick-config (legacy local tweak, sits on top of channel + override). */}
                <VideoPreviewBrandBar
                  onBrandChange={(brand) => setBrandKit(b => ({ ...b, ...brand }))}
                />

                {/* The actual player */}
                <VideoPlayerMemo
                  doc={doc}
                  docId={historyEntryId}
                  rowImages={rowImages}
                  rowVideoClips={rowVideoClips}
                  rowOverlays={rowOverlays}
                  rowLockedAsStill={doc.rows.map((row) =>
                    Boolean(
                      rowLockSignatures[
                        brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
                      ],
                    ),
                  )}
                  animateScenes={animateScenes}
                  suppressLowerThirds={suppressLowerThirds}
                  voiceoverUrl={voiceoverUrl}
                  voiceoverAlignment={voiceoverAlignment}
                  brandKit={effectiveBrandKit}
                  effectiveStyleSlug={effectiveStyleSlug}
                  onRender={startVideoRender}
                  isRendering={renderStatus === 'rendering'}
                  renderProgress={renderProgress}
                  downloadUrl={renderDownloadUrl}
                />

                {/* Open in the shot-graph editor (/edit/[projectId]).
                    The route gates on EDITOR_V1_ENABLED server-side
                    and 404s when off — we mirror with the client-side
                    NEXT_PUBLIC_EDITOR_V1_ENABLED so the button is
                    hidden too. Disabled until the doc has been saved
                    once (we need a historyEntryId to route against). */}
                {EDITOR_V1_PUBLIC && (
                  historyEntryId && !saveFailure ? (
                    <button
                      type="button"
                      disabled={openingEditor}
                      onClick={async () => {
                        if (openingEditor) return;
                        setOpeningEditor(true);
                        console.info('[production-doc open-editor] flush before navigate', {
                          historyEntryId,
                          isDirty: project.isDirty,
                          saveStatus: project.saveStatus.kind,
                        });
                        try {
                          // Flush any pending debounced save. useProject's
                          // beforeunload keepalive PATCH normally covers this,
                          // but it skips at >64 KB AND races the editor's
                          // server-side loadProject GET — both confirmed
                          // failure modes that opened the editor against stale
                          // / missing data, which then round-tripped a wipe
                          // back into production-doc. Awaiting flush here
                          // closes the race for any payload up to the
                          // canonical 10 MB cap.
                          const result = await project.flush();
                          console.info('[production-doc open-editor] flush result', {
                            historyEntryId,
                            kind: result.kind,
                          });
                        } catch (err) {
                          console.warn('[production-doc open-editor] flush threw', {
                            historyEntryId,
                            detail: err instanceof Error ? err.message : String(err),
                          });
                        }
                        router.push(`/edit/${encodeURIComponent(historyEntryId)}`);
                      }}
                      className="w-full text-xs px-3 py-2 rounded border hover:bg-white/5 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60 disabled:cursor-progress"
                      style={{ borderColor: 'var(--accent-purple-bright, #a78bfa)', color: 'var(--accent-purple-bright, #a78bfa)' }}
                      title="Open the shot-graph editor for this production doc"
                    >
                      {openingEditor ? 'Saving…' : 'Open in editor →'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="w-full text-xs px-3 py-2 rounded border opacity-40 cursor-not-allowed"
                      style={{ borderColor: 'var(--card-border)' }}
                      title={
                        saveFailure
                          ? 'Resolve the server-save banner above before opening the editor — your doc isn\'t on the server yet.'
                          : 'Save the production doc first to open it in the editor'
                      }
                    >
                      Open in editor →
                    </button>
                  )
                )}

                {/* Dev-only: send to local Video Studio for advanced editing */}
                {process.env.NODE_ENV !== 'production' && (
                  <button
                    onClick={() => {
                      const rowClipsArr = doc.rows.map((_, i) => rowVideoClips[i] ?? null);
                      const rowLockedArr = doc.rows.map((row) =>
                        Boolean(
                          rowLockSignatures[
                            brollRowSignatureInput({ timecode: row.timecode, visual_description: row.visual_description })
                          ],
                        ),
                      );
                      const config = productionDocToVideoConfig(doc, rowImages, {
                        voiceoverUrl: voiceoverUrl || undefined,
                        brand: effectiveBrandKit,
                        rowVideoClips: rowClipsArr,
                        rowLockedAsStill: rowLockedArr,
                        animateScenes,
                        rowOverlays,
                        suppressLowerThirds,
                        effectiveStyleSlug,
                      });
                      sessionStorage.setItem('video-studio:bridge', JSON.stringify({
                        config,
                        brief: `Production doc: ${doc.title} (niche: ${doc.niche})`,
                      }));
                      window.location.href = '/video-studio';
                    }}
                    className="w-full text-xs px-3 py-2 rounded border border-purple-500/40 hover:bg-purple-500/10 transition-colors"
                    style={{ color: 'var(--accent-purple-bright)' }}
                  >
                    → Send to Video Studio (local editor)
                  </button>
                )}

                {renderStatus === 'error' && (
                  <p className="text-xs" style={{ color: '#f87171' }}>
                    Render failed. Check server logs for details — the toast above carries the reason.
                  </p>
                )}

                {/* Phase 0 telemetry: post-render finish-flow survey.
                    Drives the shot-graph editor build decision — see
                    _plans/2026-05-18-shot-graph-editor.md. One-tap,
                    dismissable, no nagging. */}
                {renderStatus === 'done' && !renderSurveyDismissed && (
                  <div
                    className="mt-3 p-3 rounded-lg border text-xs space-y-2"
                    style={{ borderColor: 'var(--card-border)', background: 'var(--card-bg)' }}
                  >
                    <p style={{ color: 'var(--fg)' }}>
                      Where will you finish this video?
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {([
                        { id: 'capcut',   label: 'CapCut' },
                        { id: 'premiere', label: 'Premiere' },
                        { id: 'other',    label: 'Other editor' },
                      ] as const).map(opt => (
                        <button
                          key={opt.id}
                          className="px-2.5 py-1 rounded border text-xs hover:bg-white/5 transition-colors"
                          style={{ borderColor: 'var(--card-border)', color: 'var(--fg-muted)' }}
                          onClick={() => {
                            void recordEditorTelemetry('external_edit_intent', {
                              payload: { destination: opt.id },
                            });
                            setRenderSurveyDismissed(true);
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                      <button
                        className="px-2.5 py-1 rounded border text-xs hover:bg-white/5 transition-colors"
                        style={{ borderColor: 'var(--card-border)', color: 'var(--accent-purple-bright)' }}
                        onClick={() => {
                          void recordEditorTelemetry('stayed_here');
                          setRenderSurveyDismissed(true);
                        }}
                      >
                        Finishing here
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom export */}
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button onClick={() => exportToCsv(doc, rowImages)} className="btn-primary text-sm px-6">
              ⬇ Export CSV
            </button>
            <button
              onClick={exportToSheets}
              disabled={sheetsExporting}
              className="btn-secondary text-sm px-6 flex items-center gap-1.5"
              title="Export to Google Sheets"
            >
              {sheetsExporting ? (
                <><div className="spinner" style={{ width: 12, height: 12 }} /> Exporting…</>
              ) : 'Export to Sheets'}
            </button>
          </div>
        </div>
        );
      })()}

      <HistoryPanel
        title="Production Doc History"
        icon="🎬"
        items={historyItems.map(e => {
          // 2026-06-04: read top-level fields first (legacy entries
          // saved before the canonical refactor have them populated),
          // but fall back to nested `doc.*` so canonical entries —
          // which carry the title/rows/niche under `doc` — render
          // accurately instead of "Untitled project · undefined shots
          // · undefined". That misleading display masked the user's
          // real docs in today's silent-loss incident; see
          // _plans/2026-06-04-prevent-production-doc-silent-loss.md.
          const nested = e.doc as Partial<ProductionDoc> | undefined;
          const label = e.videoTitle || e.title || nested?.title || '(no title)';
          const niche = e.niche || nested?.niche || '';
          const shotCount = e.shotCount || nested?.rows?.length || 0;
          const totalDuration = e.totalDuration || nested?.total_duration || '';
          const stylePreset =
            e.stylePreset || (nested as { style_preset?: string } | undefined)?.style_preset || '';
          return {
            id: e.id,
            timestamp: e.timestamp,
            label,
            sublabel: `${niche} · ${shotCount} shots · ${totalDuration} · ${stylePreset}`,
          };
        })}
        onRestore={(id) => {
          const entry = historyItems.find(e => e.id === id);
          if (!entry) return;
          if (doc && typeof window !== 'undefined' &&
              !confirm('Replace the current production doc with this restored entry?')) {
            return;
          }
          setNiche(entry.niche);
          setTopic(entry.topic);
          if (entry.modelId) setModelId(entry.modelId);
          // v2 (2026-05-22) — prefer the doc-persisted `style_preset`
          // over the legacy entry-level `stylePreset` when both are
          // present. Older entries only carry the entry-level field;
          // v2 entries also carry it on the doc payload itself so the
          // shot-graph editor can read it without duplicating the
          // entry shape. Picking doc first keeps the active style in
          // sync with what the editor will see when the user clicks
          // through. See `_plans/2026-05-21-user-defined-styles-with-reference-images.md`.
          const restoredStylePreset =
            (entry.doc as { style_preset?: string } | undefined)?.style_preset
            ?? entry.stylePreset;
          if (restoredStylePreset) setStylePreset(restoredStylePreset);
          if (entry.script) setScript(entry.script);
          if (entry.doc) {
            const restoredDoc = entry.doc as ProductionDoc;
            setDoc(restoredDoc);
            // Rebuild rowImages from the saved map
            if (entry.rowImages && restoredDoc.rows?.length) {
              const restoredImages: RowImageState[] = restoredDoc.rows.map((_row, i) => {
                const url = entry.rowImages?.[i];
                return url ? { status: 'done', imageUrl: url } : { status: 'idle' };
              });
              setRowImages(restoredImages);
            } else {
              setRowImages([]);
            }
            // Restore overlays + B-roll clip state if the entry carries
            // them. Older entries pre-date these fields — they fall back
            // to `{}` and the per-cell mount-hydration in BrollCell /
            // OverlayCell can rebuild from each cell's own localStorage
            // map. The earlier code unconditionally wiped both maps,
            // which dropped every generated asset the moment the user
            // clicked an entry in the sidebar. See plan
            // _plans/2026-05-17-render-state-hardening.md.
            const restoredOverlays = entry.rowOverlays && typeof entry.rowOverlays === 'object'
              ? entry.rowOverlays as Record<number, RowOverlayState>
              : {};
            setRowOverlays(restoredOverlays);
            // rowVideoClips is stored as { rowIndex → clipId }. We can't
            // restore the videoUrl directly (the entry doesn't carry it),
            // but seeding the cell with the clip id is enough — BrollCell's
            // mount-hydration will fetch `/api/broll/{id}`, see status:'ready',
            // and bridge to the parent via the now-fixed updateClip path.
            // For 'ready'-status rows the renderer also needs the videoUrl
            // up front, so we leave the per-row entries empty here and
            // rely on the hydrate-on-mount round trip. The pre-render
            // verification (see plan) will block render if any clip id
            // from the entry didn't land in state by the time the user
            // clicks Render.
            setRowVideoClips({});
            console.info('[history restore]', {
              entryId: entry.id,
              hadImages: Boolean(entry.rowImages),
              hadOverlays: Boolean(entry.rowOverlays),
              hadClips: Boolean(entry.rowVideoClips),
              clipCount: entry.rowVideoClips ? Object.keys(entry.rowVideoClips).length : 0,
            });
            setHistoryEntryId(entry.id);
            // Restore the per-video visual brand kit override if the
            // entry carried one. parseVisualBrandKit drops anything
            // unexpected, so a corrupt payload silently falls back to
            // an empty override.
            setVisualKitOverride(parseVisualBrandKit(entry.visualBrandKitOverride));
            toast.success(`Restored — ${entry.shotCount} shots, ${entry.totalDuration}`);
          } else {
            setDoc(null);
            setRowImages([]);
            setRowOverlays({});
            setHistoryEntryId(null);
            setVisualKitOverride({ v: 1 });
            toast.info('Older entry — only metadata was saved. Re-generate to produce the doc.');
          }
        }}
        onDelete={(id) => {
          setHistoryItems((prev) => prev.filter((e) => e.id !== id));
          deleteProductionDocEntry(id).catch(() => {});
        }}
        onClearAll={() => {
          setHistoryItems([]);
          clearProductionDocHistory().catch(() => {});
        }}
      />

      {styleManagerOpen && (
        <StyleManagerDialog
          styles={availableStyles}
          onChanged={() => { void loadStyles(); }}
          onClose={() => setStyleManagerOpen(false)}
        />
      )}

      {/* Pre-render verification gate. Mounted only when a render
          attempt found B-roll clips in localStorage that weren't in
          state. The modal handles its own reload pipeline; on full
          success it triggers `executeRender` directly, otherwise the
          user can explicitly accept a stills-only render or cancel.
          See `_plans/2026-05-17-render-state-hardening.md`. */}
      {overlayPositionRow !== null && doc?.rows[overlayPositionRow] && rowOverlays[overlayPositionRow]?.status === 'done' && rowOverlays[overlayPositionRow]?.url && (
        <OverlayPositionEditor
          stillImageUrl={rowImages[overlayPositionRow]?.imageUrl}
          overlayUrl={rowOverlays[overlayPositionRow]!.url!}
          position={doc.rows[overlayPositionRow]!.overlay_position}
          sizePct={doc.rows[overlayPositionRow]!.overlay_size_pct}
          stretchedHeightPct={doc.rows[overlayPositionRow]!.overlay_stretched_height_pct}
          termsLabel={doc.rows[overlayPositionRow]!.overlay_stock_terms || ''}
          placementReason={doc.rows[overlayPositionRow]!.overlay_placement_reason}
          placementModel={doc.rows[overlayPositionRow]!.overlay_placement_model}
          onRethink={() => { void rethinkOverlayPlacement(overlayPositionRow); }}
          isRethinking={rethinkingRows.has(overlayPositionRow)}
          rethinkExhausted={(rethinkAttempts[overlayPositionRow] ?? 0) >= RETHINK_MAX_ATTEMPTS}
          onEditImage={() => setOverlayEditRow(overlayPositionRow)}
          onSave={(pos, size, stretchedH) => {
            console.info('[ui overlay-position] saved', {
              rowIndex: overlayPositionRow,
              pos,
              size,
              stretchedH,
            });
            // Baseline telemetry — see plan-2026-05-18-overlay-system-overhaul.
            // Position changes fire `overlay_drag`; size/stretch changes fire
            // `overlay_resize`. Both may fire on the same save when the user
            // dragged and resized in the same session. placement_model is
            // hardcoded to 'doc-gen-blind' until Phase 2 introduces vision-
            // aware placement that writes a different model id onto the row.
            const prev = doc?.rows[overlayPositionRow]?.overlay_position;
            const prevSize = doc?.rows[overlayPositionRow]?.overlay_size_pct;
            const prevStretchedH = doc?.rows[overlayPositionRow]?.overlay_stretched_height_pct;
            const positionChanged =
              !prev || prev.x_pct !== pos.x_pct || prev.y_pct !== pos.y_pct;
            const sizeChanged = prevSize !== size;
            const stretchChanged = (prevStretchedH ?? null) !== stretchedH;
            const dx = prev ? pos.x_pct - prev.x_pct : 0;
            const dy = prev ? pos.y_pct - prev.y_pct : 0;
            const dragDistancePct = Math.sqrt(dx * dx + dy * dy);
            if (positionChanged) {
              recordEditorTelemetry('overlay_drag', {
                payload: {
                  row_index: overlayPositionRow,
                  placement_model: 'doc-gen-blind',
                  prev_x_pct: prev?.x_pct ?? null,
                  prev_y_pct: prev?.y_pct ?? null,
                  prev_size_pct: prevSize ?? null,
                  new_x_pct: Number(pos.x_pct.toFixed(2)),
                  new_y_pct: Number(pos.y_pct.toFixed(2)),
                  new_size_pct: Number(size.toFixed(2)),
                  drag_distance_pct: Number(dragDistancePct.toFixed(2)),
                },
              });
            }
            if (sizeChanged || stretchChanged) {
              recordEditorTelemetry('overlay_resize', {
                payload: {
                  row_index: overlayPositionRow,
                  placement_model: 'doc-gen-blind',
                  prev_size_pct: prevSize ?? null,
                  new_size_pct: Number(size.toFixed(2)),
                  prev_stretched_height_pct: prevStretchedH ?? null,
                  new_stretched_height_pct:
                    stretchedH !== null ? Number(stretchedH.toFixed(2)) : null,
                  free_aspect_used: stretchedH !== null,
                },
              });
            }
            updateRow(overlayPositionRow, {
              overlay_position: pos,
              overlay_size_pct: size,
              overlay_stretched_height_pct: stretchedH ?? undefined,
            });
          }}
          onReset={() => {
            console.info('[ui overlay-position] reset', { rowIndex: overlayPositionRow });
            recordEditorTelemetry('overlay_reset', {
              payload: {
                row_index: overlayPositionRow,
                placement_model: 'doc-gen-blind',
              },
            });
            updateRow(overlayPositionRow, {
              overlay_position: undefined,
              overlay_size_pct: undefined,
              overlay_stretched_height_pct: undefined,
            });
          }}
          onClose={() => setOverlayPositionRow(null)}
        />
      )}

      {/* Phase 5 — AI image-edit dialog. Mounts on top of the position
          editor when the user clicks ✎ Edit image. On accept the
          row's overlay URL is swapped to the new R2 URL; the renderer's
          Phase 0 onLoad reads the natural aspect of the edited image
          and reshapes the container accordingly, so a square edit of a
          wide wordmark "just works" without any aspect tracking here. */}
      {overlayEditRow !== null &&
        doc?.rows[overlayEditRow] &&
        rowOverlays[overlayEditRow]?.status === 'done' &&
        rowOverlays[overlayEditRow]?.url && (
          <OverlayEditDialog
            overlayUrl={rowOverlays[overlayEditRow]!.url!}
            termsLabel={doc.rows[overlayEditRow]!.overlay_stock_terms || ''}
            onAccept={(newOverlayUrl, mode, replacedUrl) => {
              // `replacedUrl` is the URL the user OPENED the dialog
              // with — snapshot at mount, race-free vs a concurrent
              // Replace from the context menu. Push it onto the row's
              // edit history so Undo restores what the user actually
              // saw + edited. Cap at 3 — oldest shifts off the front.
              const prevHistory = doc?.rows[overlayEditRow]?.overlay_edit_history ?? [];
              const nextHistory = replacedUrl
                ? [...prevHistory, replacedUrl].slice(-OVERLAY_EDIT_HISTORY_CAP)
                : prevHistory;
              console.info('[ui overlay-edit] accepted', {
                rowIndex: overlayEditRow,
                mode,
                newOverlayUrl,
                replacedUrl,
                historyDepthAfter: nextHistory.length,
              });
              updateRow(overlayEditRow, { overlay_edit_history: nextHistory });
              setRowOverlays((prev) => ({
                ...prev,
                [overlayEditRow]: {
                  ...prev[overlayEditRow],
                  status: 'done',
                  url: newOverlayUrl,
                },
              }));
            }}
            onClose={() => setOverlayEditRow(null)}
          />
        )}

      {/* Phase 5 — right-click context menu on the overlay cell. Items
          are computed against the live row so e.g. "Undo last edit"
          only appears when there's something to undo. Click on an
          item fires the same handler the inline button would. */}
      {overlayContextMenu &&
        doc?.rows[overlayContextMenu.rowIndex] &&
        (() => {
          const i = overlayContextMenu.rowIndex;
          const row = doc.rows[i]!;
          const overlayState = rowOverlays[i];
          const canUndo = (row.overlay_edit_history?.length ?? 0) > 0;
          return (
            <OverlayContextMenu
              x={overlayContextMenu.x}
              y={overlayContextMenu.y}
              onClose={() => setOverlayContextMenu(null)}
              items={[
                {
                  label: '✎ Edit image',
                  onClick: () => setOverlayEditRow(i),
                  disabled: overlayState?.status !== 'done',
                  title: 'Open the AI image-edit dialog (Smart edit or Brush mask)',
                },
                {
                  label: '↻ Rethink placement',
                  onClick: () => { void rethinkOverlayPlacement(i); },
                  disabled:
                    overlayState?.status !== 'done' ||
                    rethinkingRows.has(i) ||
                    (rethinkAttempts[i] ?? 0) >= RETHINK_MAX_ATTEMPTS,
                  title: 'Ask the AI for a new size + position on this overlay',
                },
                {
                  label: '🔁 Replace overlay (re-search)',
                  onClick: () => {
                    const terms = row.overlay_stock_terms?.trim();
                    if (terms) void fetchOverlayForRow(i, terms);
                  },
                  disabled: !row.overlay_stock_terms?.trim(),
                  title: 'Re-run Brave search + RMBG with the same stock terms (replaces the current overlay)',
                },
                {
                  label: '↶ Undo last edit',
                  onClick: () => undoOverlayEdit(i),
                  disabled: !canUndo,
                  separatorAbove: true,
                  title: canUndo
                    ? 'Restore the overlay state from before the most recent AI edit'
                    : 'No edits to undo yet',
                },
                {
                  label: '↺ Reset to AI placement',
                  onClick: () => {
                    console.info('[ui overlay-position] reset (via context menu)', { rowIndex: i });
                    recordEditorTelemetry('overlay_reset', {
                      payload: {
                        row_index: i,
                        placement_model: row.overlay_placement_model ?? 'doc-gen-blind',
                      },
                    });
                    updateRow(i, {
                      overlay_position: undefined,
                      overlay_size_pct: undefined,
                      overlay_stretched_height_pct: undefined,
                    });
                  },
                  disabled:
                    !row.overlay_position &&
                    row.overlay_size_pct === undefined &&
                    row.overlay_stretched_height_pct === undefined,
                  separatorAbove: true,
                  title: 'Clear manual position / size / stretch and fall back to the AI-planned zone',
                },
                {
                  label: row.skip_overlay
                    ? '↻ Allow overlay on this row'
                    : '⊘ Skip overlay on this row',
                  onClick: () => {
                    const next = !row.skip_overlay;
                    console.info('[overlay-skip] row-level toggle', { rowIndex: i, skip_overlay: next });
                    updateRow(i, { skip_overlay: next || undefined });
                  },
                  separatorAbove: true,
                  title: row.skip_overlay
                    ? 'Re-enable overlay auto-fetch for this row (overrides the doc-level setting)'
                    : 'Skip overlay auto-fetch for this row only (overrides the doc-level setting)',
                },
                {
                  label: '✕ Remove overlay',
                  onClick: () => {
                    const ok = window.confirm(
                      'Remove the overlay entirely?\n\nThis clears the stock terms, the fetched image, AI placement, edits, and undo history for this row. The row\'s scene image stays. You can re-add by typing new stock terms.',
                    );
                    if (!ok) return;
                    console.info('[ui overlay] removed (via context menu)', { rowIndex: i });
                    removeOverlayFromRow(i);
                  },
                  destructive: true,
                  title: 'Clear all overlay state on this row (stock terms, image, placement, history)',
                },
              ]}
            />
          );
        })()}

      {missingClipsModal && (
        <MissingClipsModal
          missing={missingClipsModal.missing}
          reloading={missingClipsModal.reloading}
          onReload={reloadMissingClips}
          onContinue={async () => {
            setMissingClipsModal(null);
            await executeRender();
          }}
          onRenderAnyway={async () => {
            console.info('[render skipped-reload]', {
              missingRowIndexes: missingClipsModal.missing.map(m => m.rowIndex),
            });
            setMissingClipsModal(null);
            await executeRender();
          }}
          onClose={() => setMissingClipsModal(null)}
          onMissingChange={(next) =>
            setMissingClipsModal((prev) => (prev ? { ...prev, missing: next } : prev))
          }
          onReloadingChange={(next) =>
            setMissingClipsModal((prev) => (prev ? { ...prev, reloading: next } : prev))
          }
        />
      )}
      {(() => {
        if (editPanelRow === null) return null;
        const idx = editPanelRow;
        const src = rowImages[idx]?.imageUrl;
        if (!src) return null;
        // While the brush modal is open AND no candidate result exists
        // yet, show the paint UI. Otherwise the EditPanel covers both
        // compose mode (initialResult === null) and review mode
        // (initialResult set after a smart apply or brush apply).
        if (editBrushOpen && !editResult) {
          return (
            <MaskBrushEditor
              sourceImageUrl={src}
              option={editOption}
              onOptionChange={updateEditOption}
              onCancel={() => setEditBrushOpen(false)}
              onApply={async ({ maskUrl, prompt, option: appliedOption }) => {
                const r = await editImageForRow(idx, src, prompt, {
                  optionId: appliedOption.id,
                  maskUrl,
                });
                if (r.ok) {
                  setEditResult({ imageUrl: r.imageUrl, saliency: r.saliency });
                  setEditBrushOpen(false);
                } else {
                  toast.error(r.error);
                }
              }}
              onErase={async ({ maskUrl }) => {
                const r = await editImageForRow(idx, src, '', {
                  intent: 'erase',
                  maskUrl,
                });
                if (r.ok) {
                  setEditResult({ imageUrl: r.imageUrl, saliency: r.saliency });
                  setEditBrushOpen(false);
                } else {
                  toast.error(r.error);
                }
              }}
            />
          );
        }
        return (
          <EditPanel
            sourceImageUrl={src}
            initialResult={editResult}
            option={editOption}
            onOptionChange={updateEditOption}
            onApply={(prompt) => editImageForRow(idx, src, prompt, { optionId: editOption.id })}
            onUseThis={(imageUrl, saliency) => acceptEditForRow(idx, imageUrl, saliency)}
            onOpenBrush={() => setEditBrushOpen(true)}
            onClose={closeEditPanel}
          />
        );
      })()}
    </div>

    {/* Phase 3 follow-up (2026-05-25) — Editor view toggle overlay.
        When `editorViewMode === 'editor'` AND a doc is loaded, this
        fullscreen overlay covers the grid view. The overlay pattern is
        deliberate: it avoids touching the 3000+ lines of dense grid JSX
        above (zero risk of mis-bracketing) and lets users return to the
        grid via the header toggle button without losing scroll position
        or in-flight form state. The doc itself is shared between views
        via the same page-level state (doc, rowImages, rowVideoClips,
        etc.) so any edit made in either surface persists in both.
        See plan: `_plans/2026-05-25-editor-view-variant-inspector.md`. */}
    {editorViewMode === 'editor' && doc && (() => {
      // Derive rowLockedAsStill (boolean[]) from the signature-keyed
      // state — same remap the projectPatch code does internally. The
      // boolean[] shape is what EditorViewProps expects.
      const rowLockedAsStill: boolean[] = doc.rows.map((row) => {
        const sig = brollRowSignatureInput({
          timecode: row.timecode,
          visual_description: row.visual_description,
        });
        return Boolean(rowLockSignatures[sig]);
      });
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            background: 'var(--bg-primary, #0a0a0a)',
            overflow: 'auto',
          }}
          role="dialog"
          aria-label="Editor view"
        >
          <div className="p-6 max-w-full" style={{ minHeight: '100vh' }}>
            <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  Editor view
                </h2>
                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                  Multi-pane preview / inspector / section strip. Edits sync with the grid view underneath.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditorViewMode('grid')}
                className="text-xs px-3 py-1.5 rounded whitespace-nowrap"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: 'var(--text-secondary)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  cursor: 'pointer',
                }}
                title="Return to the standard grid view."
              >
                ← Back to grid
              </button>
            </div>
            <EditorView
              doc={doc}
              docId={historyEntryId}
              rowImages={rowImages as Parameters<typeof EditorView>[0]['rowImages']}
              rowVideoClips={rowVideoClips as Parameters<typeof EditorView>[0]['rowVideoClips']}
              rowOverlays={rowOverlays}
              rowLockedAsStill={rowLockedAsStill}
              rowLockSignatures={rowLockSignatures}
              voiceoverUrl={voiceoverUrl}
              voiceoverAlignment={voiceoverAlignment}
              brandKit={brandKit}
              animateScenes={animateScenes}
              suppressLowerThirds={suppressLowerThirds}
              writers={editorWriters}
            />
          </div>
        </div>
      );
    })()}
    </ScheduleLinkProvider>
  );
}
