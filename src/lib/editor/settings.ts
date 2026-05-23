/**
 * Editor user preferences — typed localStorage accessors.
 *
 * Phase 4b of `_plans/2026-05-19-editor-production-doc-parity.md`.
 * Rule 15 in the user's global CLAUDE.md says every new feature gets
 * a Settings audit; these are the four keys the parity plan called
 * out:
 *
 *   - `editor.timeline.defaultZoomLevel`    int 1..10, default 5.
 *   - `editor.timeline.showThumbnails`      bool, default true.
 *   - `editor.statusBar.showShortcutHints`  bool, default true.
 *   - `editor.autoRegenCaptions.onVoiceoverChange` bool, default false.
 *
 * Stored in localStorage rather than the server because every value
 * is a per-device viewing preference — the canonical project payload
 * is the wrong place for them (they'd sync across devices and
 * surprise the user). If the workspace ever needs server-synced
 * editor prefs, they migrate cleanly into the existing user_settings
 * API; the accessor functions here are the only consumers.
 *
 * All accessors are SSR-safe: they return the default when `window`
 * is undefined, never throw.
 */

const KEY_DEFAULT_ZOOM = 'editor.timeline.defaultZoomLevel';
const KEY_SHOW_THUMBNAILS = 'editor.timeline.showThumbnails';
const KEY_SHOW_SHORTCUT_HINTS = 'editor.statusBar.showShortcutHints';
const KEY_AUTO_REGEN_CAPTIONS = 'editor.autoRegenCaptions.onVoiceoverChange';
// Phase 4b follow-up — five additional keys promised by the real-NLE
// plan but never wired. Owner asked for them on 2026-05-20.
const KEY_LEFT_RAIL_DEFAULT_TAB = 'editor.layout.leftRailDefaultTab';
const KEY_LANE_HEIGHT_VIDEO = 'editor.timeline.laneHeights.video';
const KEY_LANE_HEIGHT_AUDIO = 'editor.timeline.laneHeights.audio';
const KEY_DEFAULT_PLAYBACK_RATE = 'editor.transport.defaultPlaybackRate';
const KEY_PREVIEW_FIT_MODE = 'editor.preview.fitMode';
// 2026-05-23 — image edit model picker. Three keys:
//   - lastEditOptionId: which dropdown row was active last time.
//   - defaultEraseBackendId: which mask-capable option the Erase
//     button forces. Power users who prefer GPT-4o for object
//     removal can flip it to a `gpt-4o-*` option.
//   - showEditModelPrices: whether the dropdown shows $/edit inline.
// See _plans/2026-05-23-kie-image-edit-models-and-erase.md §9.
const KEY_LAST_EDIT_OPTION = 'editor.imageEdit.lastOptionId';
const KEY_DEFAULT_ERASE_BACKEND = 'editor.imageEdit.defaultEraseBackendId';
const KEY_SHOW_EDIT_PRICES = 'editor.imageEdit.showPrices';
// 2026-05-23 Phase 2 — editor timeline + shots UX overhaul.
//   - showNarrationStrip: hide the "now reading" strip if the user
//     finds it distracting.
//   - narrationFontSize: bump the strip's text up/down for
//     readability without touching the rest of the editor's
//     typography.
//   - clickShotToSeek: escape hatch in case someone wants the old
//     "click selects, doesn't seek" behavior back.
// See _plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md §7.
const KEY_SHOW_NARRATION_STRIP = 'editor.narration.showStrip';
const KEY_NARRATION_FONT_SIZE = 'editor.narration.fontSize';
const KEY_CLICK_SHOT_TO_SEEK = 'editor.playback.clickShotToSeek';
// 2026-05-23 Phase 4 — timeline minimap. Three keys covering whether
// to render the strip at all, whether to wrap to two rows on long
// projects, and the minute-threshold that triggers the wrap. See
// `_plans/2026-05-23-editor-timeline-and-shots-ux-overhaul.md` §12.
const KEY_SHOW_MINIMAP = 'editor.timeline.showMinimap';
const KEY_MINIMAP_WRAP_ENABLED = 'editor.timeline.minimapWrapEnabled';
const KEY_MINIMAP_WRAP_THRESHOLD_MIN = 'editor.timeline.minimapWrapThresholdMinutes';

const DEFAULT_ZOOM_LEVEL = 5;
const DEFAULT_SHOW_THUMBNAILS = true;
const DEFAULT_SHOW_SHORTCUT_HINTS = true;
const DEFAULT_AUTO_REGEN_CAPTIONS = false;
const DEFAULT_LEFT_RAIL_TAB: LeftRailTab = 'shots';
const DEFAULT_LANE_HEIGHT_VIDEO = 64;
const DEFAULT_LANE_HEIGHT_AUDIO = 56;
const DEFAULT_PLAYBACK_RATE: PlaybackRateValue = 1;
const DEFAULT_PREVIEW_FIT_MODE: PreviewFitMode = 'contain';
const DEFAULT_SHOW_NARRATION_STRIP = true;
const DEFAULT_NARRATION_FONT_SIZE = 14;
const DEFAULT_CLICK_SHOT_TO_SEEK = true;
const DEFAULT_SHOW_MINIMAP = true;
const DEFAULT_MINIMAP_WRAP_ENABLED = true;
const DEFAULT_MINIMAP_WRAP_THRESHOLD_MIN = 5;

// ─── Enumerated value types ─────────────────────────────────────

/** Mirrors the six tabs in `EditorLeftRail`. Kept here (instead of
 *  importing from the component) so the settings module stays a
 *  pure-data dependency the components consume — not the other way
 *  around. If the tab list ever changes, the enum below must too. */
export type LeftRailTab = 'shots' | 'media' | 'audio' | 'captions' | 'ai' | 'settings';
const LEFT_RAIL_TABS: readonly LeftRailTab[] = ['shots', 'media', 'audio', 'captions', 'ai', 'settings'];

/** Mirrors the transport-bar dropdown. */
export type PlaybackRateValue = 0.5 | 1 | 1.5 | 2;
const PLAYBACK_RATES: readonly PlaybackRateValue[] = [0.5, 1, 1.5, 2];

/** Mirrors the CSS `object-fit` values the preview uses. `contain`
 *  letterboxes the frame; `fill` stretches it (no letterbox, may
 *  distort). */
export type PreviewFitMode = 'contain' | 'fill';
const PREVIEW_FIT_MODES: readonly PreviewFitMode[] = ['contain', 'fill'];

function safeRead(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / SecurityError — best-effort only */
  }
}

// ─── Default zoom level (1..10) ───────────────────────────────────

export function getDefaultZoomLevel(): number {
  const raw = safeRead(KEY_DEFAULT_ZOOM);
  if (raw === null) return DEFAULT_ZOOM_LEVEL;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 10) return DEFAULT_ZOOM_LEVEL;
  return n;
}

export function setDefaultZoomLevel(level: number): void {
  const clamped = Math.max(1, Math.min(10, Math.round(level)));
  safeWrite(KEY_DEFAULT_ZOOM, String(clamped));
}

// ─── Show thumbnails on timeline tiles ────────────────────────────

export function getShowThumbnails(): boolean {
  const raw = safeRead(KEY_SHOW_THUMBNAILS);
  if (raw === null) return DEFAULT_SHOW_THUMBNAILS;
  return raw === '1' || raw === 'true';
}

export function setShowThumbnails(on: boolean): void {
  safeWrite(KEY_SHOW_THUMBNAILS, on ? '1' : '0');
}

// ─── Show shortcut hints (the `?` icon in StatusBar) ──────────────

export function getShowShortcutHints(): boolean {
  const raw = safeRead(KEY_SHOW_SHORTCUT_HINTS);
  if (raw === null) return DEFAULT_SHOW_SHORTCUT_HINTS;
  return raw === '1' || raw === 'true';
}

export function setShowShortcutHints(on: boolean): void {
  safeWrite(KEY_SHOW_SHORTCUT_HINTS, on ? '1' : '0');
}

// ─── Auto-regen captions on voiceover change ──────────────────────

export function getAutoRegenCaptions(): boolean {
  const raw = safeRead(KEY_AUTO_REGEN_CAPTIONS);
  if (raw === null) return DEFAULT_AUTO_REGEN_CAPTIONS;
  return raw === '1' || raw === 'true';
}

export function setAutoRegenCaptions(on: boolean): void {
  safeWrite(KEY_AUTO_REGEN_CAPTIONS, on ? '1' : '0');
}

// ─── Left-rail default tab ───────────────────────────────────────

export function getLeftRailDefaultTab(): LeftRailTab {
  const raw = safeRead(KEY_LEFT_RAIL_DEFAULT_TAB);
  if (raw === null) return DEFAULT_LEFT_RAIL_TAB;
  if (LEFT_RAIL_TABS.includes(raw as LeftRailTab)) return raw as LeftRailTab;
  return DEFAULT_LEFT_RAIL_TAB;
}

export function setLeftRailDefaultTab(tab: LeftRailTab): void {
  if (!LEFT_RAIL_TABS.includes(tab)) return;
  safeWrite(KEY_LEFT_RAIL_DEFAULT_TAB, tab);
}

// ─── Timeline lane heights (px) ──────────────────────────────────

/** Clamp to a sane range so a malformed value can't blow up the
 *  timeline layout. Mirrors the timeline's CSS expectations:
 *  ≥ 32 px to keep tile content readable, ≤ 128 px to keep four
 *  lanes from blowing past the chrome's timeline region height. */
function clampLane(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(32, Math.min(128, Math.round(n)));
}

export function getVideoLaneHeight(): number {
  const raw = safeRead(KEY_LANE_HEIGHT_VIDEO);
  if (raw === null) return DEFAULT_LANE_HEIGHT_VIDEO;
  return clampLane(Number.parseInt(raw, 10), DEFAULT_LANE_HEIGHT_VIDEO);
}

export function setVideoLaneHeight(px: number): void {
  safeWrite(KEY_LANE_HEIGHT_VIDEO, String(clampLane(px, DEFAULT_LANE_HEIGHT_VIDEO)));
}

export function getAudioLaneHeight(): number {
  const raw = safeRead(KEY_LANE_HEIGHT_AUDIO);
  if (raw === null) return DEFAULT_LANE_HEIGHT_AUDIO;
  return clampLane(Number.parseInt(raw, 10), DEFAULT_LANE_HEIGHT_AUDIO);
}

export function setAudioLaneHeight(px: number): void {
  safeWrite(KEY_LANE_HEIGHT_AUDIO, String(clampLane(px, DEFAULT_LANE_HEIGHT_AUDIO)));
}

// ─── Default playback rate ───────────────────────────────────────

export function getDefaultPlaybackRate(): PlaybackRateValue {
  const raw = safeRead(KEY_DEFAULT_PLAYBACK_RATE);
  if (raw === null) return DEFAULT_PLAYBACK_RATE;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return DEFAULT_PLAYBACK_RATE;
  if (PLAYBACK_RATES.includes(n as PlaybackRateValue)) return n as PlaybackRateValue;
  return DEFAULT_PLAYBACK_RATE;
}

export function setDefaultPlaybackRate(rate: PlaybackRateValue): void {
  if (!PLAYBACK_RATES.includes(rate)) return;
  safeWrite(KEY_DEFAULT_PLAYBACK_RATE, String(rate));
}

// ─── Preview fit mode ────────────────────────────────────────────

export function getPreviewFitMode(): PreviewFitMode {
  const raw = safeRead(KEY_PREVIEW_FIT_MODE);
  if (raw === null) return DEFAULT_PREVIEW_FIT_MODE;
  if (PREVIEW_FIT_MODES.includes(raw as PreviewFitMode)) return raw as PreviewFitMode;
  return DEFAULT_PREVIEW_FIT_MODE;
}

export function setPreviewFitMode(mode: PreviewFitMode): void {
  if (!PREVIEW_FIT_MODES.includes(mode)) return;
  safeWrite(KEY_PREVIEW_FIT_MODE, mode);
}

// ─── Image edit model picker ─────────────────────────────────────
//
// These read/write opaque string ids — the catalog of valid ids lives
// in `src/lib/image-edit-pricing.ts`. We deliberately do NOT import
// the catalog here: the settings module is a pure-data leaf consumed
// by both the picker and the API route, and a circular import would
// break the picker. Callers validate the returned string against the
// catalog before using it (the catalog's `getEditOption` returns
// undefined for stale ids, which the caller falls back from).

export function getLastEditOptionId(fallback: string): string {
  const raw = safeRead(KEY_LAST_EDIT_OPTION);
  return raw ?? fallback;
}

export function setLastEditOptionId(id: string): void {
  if (!id) return;
  safeWrite(KEY_LAST_EDIT_OPTION, id);
}

export function getDefaultEraseBackendId(fallback: string): string {
  const raw = safeRead(KEY_DEFAULT_ERASE_BACKEND);
  return raw ?? fallback;
}

export function setDefaultEraseBackendId(id: string): void {
  if (!id) return;
  safeWrite(KEY_DEFAULT_ERASE_BACKEND, id);
}

const DEFAULT_SHOW_EDIT_PRICES = true;

export function getShowEditModelPrices(): boolean {
  const raw = safeRead(KEY_SHOW_EDIT_PRICES);
  if (raw === null) return DEFAULT_SHOW_EDIT_PRICES;
  return raw === '1' || raw === 'true';
}

export function setShowEditModelPrices(on: boolean): void {
  safeWrite(KEY_SHOW_EDIT_PRICES, on ? '1' : '0');
}

// ─── Narration strip + click-to-seek ─────────────────────────────

export function getShowNarrationStrip(): boolean {
  const raw = safeRead(KEY_SHOW_NARRATION_STRIP);
  if (raw === null) return DEFAULT_SHOW_NARRATION_STRIP;
  return raw === '1' || raw === 'true';
}

export function setShowNarrationStrip(on: boolean): void {
  safeWrite(KEY_SHOW_NARRATION_STRIP, on ? '1' : '0');
}

/** Clamp the narration font size so a malformed setting can't
 *  blow the preview's vertical budget. 10..22 covers everything
 *  from "I want it tiny" to "I'm presenting to a room." */
function clampNarrationFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_NARRATION_FONT_SIZE;
  return Math.max(10, Math.min(22, Math.round(n)));
}

export function getNarrationFontSize(): number {
  const raw = safeRead(KEY_NARRATION_FONT_SIZE);
  if (raw === null) return DEFAULT_NARRATION_FONT_SIZE;
  return clampNarrationFontSize(Number.parseInt(raw, 10));
}

export function setNarrationFontSize(px: number): void {
  safeWrite(KEY_NARRATION_FONT_SIZE, String(clampNarrationFontSize(px)));
}

export function getClickShotToSeek(): boolean {
  const raw = safeRead(KEY_CLICK_SHOT_TO_SEEK);
  if (raw === null) return DEFAULT_CLICK_SHOT_TO_SEEK;
  return raw === '1' || raw === 'true';
}

export function setClickShotToSeek(on: boolean): void {
  safeWrite(KEY_CLICK_SHOT_TO_SEEK, on ? '1' : '0');
}

// ─── Timeline minimap ────────────────────────────────────────────

export function getShowMinimap(): boolean {
  const raw = safeRead(KEY_SHOW_MINIMAP);
  if (raw === null) return DEFAULT_SHOW_MINIMAP;
  return raw === '1' || raw === 'true';
}

export function setShowMinimap(on: boolean): void {
  safeWrite(KEY_SHOW_MINIMAP, on ? '1' : '0');
}

export function getMinimapWrapEnabled(): boolean {
  const raw = safeRead(KEY_MINIMAP_WRAP_ENABLED);
  if (raw === null) return DEFAULT_MINIMAP_WRAP_ENABLED;
  return raw === '1' || raw === 'true';
}

export function setMinimapWrapEnabled(on: boolean): void {
  safeWrite(KEY_MINIMAP_WRAP_ENABLED, on ? '1' : '0');
}

/** Clamp to a sane minute range. 1 minute is the lowest project size
 *  where wrapping has any benefit; 60 minutes is the upper bound — past
 *  that the wrap doesn't help either because individual blocks become
 *  pixel-thin again on each row. */
function clampMinimapWrapMinutes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MINIMAP_WRAP_THRESHOLD_MIN;
  return Math.max(1, Math.min(60, Math.round(n)));
}

export function getMinimapWrapThresholdMinutes(): number {
  const raw = safeRead(KEY_MINIMAP_WRAP_THRESHOLD_MIN);
  if (raw === null) return DEFAULT_MINIMAP_WRAP_THRESHOLD_MIN;
  return clampMinimapWrapMinutes(Number.parseInt(raw, 10));
}

export function setMinimapWrapThresholdMinutes(min: number): void {
  safeWrite(KEY_MINIMAP_WRAP_THRESHOLD_MIN, String(clampMinimapWrapMinutes(min)));
}

// ─── Test-only export ─────────────────────────────────────────────

export const __testing = {
  KEY_DEFAULT_ZOOM,
  KEY_SHOW_THUMBNAILS,
  KEY_SHOW_SHORTCUT_HINTS,
  KEY_AUTO_REGEN_CAPTIONS,
  KEY_LEFT_RAIL_DEFAULT_TAB,
  KEY_LANE_HEIGHT_VIDEO,
  KEY_LANE_HEIGHT_AUDIO,
  KEY_DEFAULT_PLAYBACK_RATE,
  KEY_PREVIEW_FIT_MODE,
  KEY_LAST_EDIT_OPTION,
  KEY_DEFAULT_ERASE_BACKEND,
  KEY_SHOW_EDIT_PRICES,
  DEFAULT_SHOW_EDIT_PRICES,
  DEFAULT_ZOOM_LEVEL,
  DEFAULT_SHOW_THUMBNAILS,
  DEFAULT_SHOW_SHORTCUT_HINTS,
  DEFAULT_AUTO_REGEN_CAPTIONS,
  DEFAULT_LEFT_RAIL_TAB,
  DEFAULT_LANE_HEIGHT_VIDEO,
  DEFAULT_LANE_HEIGHT_AUDIO,
  DEFAULT_PLAYBACK_RATE,
  DEFAULT_PREVIEW_FIT_MODE,
  KEY_SHOW_NARRATION_STRIP,
  KEY_NARRATION_FONT_SIZE,
  KEY_CLICK_SHOT_TO_SEEK,
  KEY_SHOW_MINIMAP,
  KEY_MINIMAP_WRAP_ENABLED,
  KEY_MINIMAP_WRAP_THRESHOLD_MIN,
  DEFAULT_SHOW_NARRATION_STRIP,
  DEFAULT_NARRATION_FONT_SIZE,
  DEFAULT_CLICK_SHOT_TO_SEEK,
  DEFAULT_SHOW_MINIMAP,
  DEFAULT_MINIMAP_WRAP_ENABLED,
  DEFAULT_MINIMAP_WRAP_THRESHOLD_MIN,
  LEFT_RAIL_TABS,
  PLAYBACK_RATES,
  PREVIEW_FIT_MODES,
};
