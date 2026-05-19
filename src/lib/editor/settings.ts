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

const DEFAULT_ZOOM_LEVEL = 5;
const DEFAULT_SHOW_THUMBNAILS = true;
const DEFAULT_SHOW_SHORTCUT_HINTS = true;
const DEFAULT_AUTO_REGEN_CAPTIONS = false;

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

// ─── Test-only export ─────────────────────────────────────────────

export const __testing = {
  KEY_DEFAULT_ZOOM,
  KEY_SHOW_THUMBNAILS,
  KEY_SHOW_SHORTCUT_HINTS,
  KEY_AUTO_REGEN_CAPTIONS,
  DEFAULT_ZOOM_LEVEL,
  DEFAULT_SHOW_THUMBNAILS,
  DEFAULT_SHOW_SHORTCUT_HINTS,
  DEFAULT_AUTO_REGEN_CAPTIONS,
};
