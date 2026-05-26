/**
 * Saved style-instruction templates for Gemini-TTS.
 *
 * Users craft style prompts ("Documentary narrator. Steady, deliberate
 * pacing. Calm gravitas on key facts.") that often repeat across
 * projects. This module persists them by name so the picker can
 * surface one-click reapplication.
 *
 * Storage: localStorage, same posture as favorites.ts and recent.ts
 * (personal preference, no API trip, instant feedback on save/load).
 * If cross-device sync is ever needed, the shape can be lifted into
 * workspaces.tts_settings without changing this module's interface —
 * callers consume `listTemplates / saveTemplate / deleteTemplate`,
 * not the underlying storage.
 *
 * Schema versioning is in the storage key (`_v1`) so a future shape
 * change can drop old data instead of breaking it.
 */

const STORAGE_KEY = 'voiceover_style_templates_v1';
const MAX_TEMPLATES = 50;          // hard cap, prevents localStorage bloat
const MAX_NAME_LENGTH = 60;
const MAX_TEXT_LENGTH = 4000;      // matches Gemini's per-prompt byte cap

export interface StyleTemplate {
  /** Random unique id. Lets two templates share a display name
   *  during a rename without colliding. */
  id: string;
  /** User-given display name. Trimmed, max 60 chars. */
  name: string;
  /** The actual style-instruction text passed to Gemini. Trimmed,
   *  max 4000 chars (Gemini's per-prompt limit). */
  text: string;
  /** Wall-clock ms. */
  createdAt: number;
  updatedAt: number;
}

function makeId(): string {
  // Tiny random id — collision risk is irrelevant at 50-template scale.
  return `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampName(s: string): string {
  return s.trim().slice(0, MAX_NAME_LENGTH);
}

function clampText(s: string): string {
  return s.trim().slice(0, MAX_TEXT_LENGTH);
}

function isStyleTemplate(x: unknown): x is StyleTemplate {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.text === 'string' &&
    typeof o.createdAt === 'number' &&
    typeof o.updatedAt === 'number'
  );
}

/**
 * Read all templates. Sorted by most-recently-updated first so the
 * picker UI naturally surfaces the templates the user touched last.
 * Returns [] on the server (no window) and on malformed storage.
 */
export function listTemplates(): StyleTemplate[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStyleTemplate).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeAll(templates: StyleTemplate[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(templates.slice(0, MAX_TEMPLATES)),
    );
  } catch {
    // Quota exceeded / private mode — swallow. Templates are a
    // convenience, not load-bearing data.
  }
}

/**
 * Insert a new template or update an existing one (by id). Name and
 * text are trimmed + length-clamped. Returns the saved template so
 * callers can update React state immediately.
 *
 * If `id` is omitted, a new id is minted. If `id` is provided but
 * doesn't match any existing template, the entry is inserted with
 * that id (used by tests that need deterministic ids).
 */
export function saveTemplate(
  input: { id?: string; name: string; text: string },
): StyleTemplate {
  const name = clampName(input.name);
  const text = clampText(input.text);
  const now = Date.now();
  const existing = listTemplates();
  if (input.id) {
    const idx = existing.findIndex((t) => t.id === input.id);
    if (idx >= 0) {
      const updated: StyleTemplate = {
        ...existing[idx],
        name,
        text,
        updatedAt: now,
      };
      const next = [...existing];
      next[idx] = updated;
      writeAll(next);
      return updated;
    }
  }
  const created: StyleTemplate = {
    id: input.id ?? makeId(),
    name,
    text,
    createdAt: now,
    updatedAt: now,
  };
  writeAll([created, ...existing]);
  return created;
}

export function deleteTemplate(id: string): void {
  const filtered = listTemplates().filter((t) => t.id !== id);
  writeAll(filtered);
}
