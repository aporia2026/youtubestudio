/**
 * Persistent history for the seven generator panels (script, ideas,
 * voiceover, seo, thumbnail, qa, production_doc).
 *
 * History is **server-backed** as of migration 0049 — entries sync
 * across devices for the signed-in collaborator within their
 * workspace. Browser localStorage is kept as a write-through cache
 * for instant paint + offline tolerance.
 *
 * ## Public surface
 *   - `get*History()` — async; returns the canonical list from the
 *     server, then refreshes the localStorage cache. Falls back to
 *     the cache on network/auth failure (degraded mode).
 *   - `get*HistoryCached()` — sync; returns the localStorage cache
 *     only. Used by the autocomplete helpers (which can't await) and
 *     by pages that want to paint instantly before the fetch lands.
 *   - `save*` / `delete*` / `clear*` / `update*` — async write-through.
 *   - `wipeHistoryCaches()` — clear every cache + sentinel + pending
 *     entry. Called from login/logout to prevent cross-account leak
 *     on shared browsers.
 *
 * ## Scope envelope (defense in depth)
 *
 * Every cache entry is wrapped as `{ scope: "<ws>:<uid>", items, v: 1 }`.
 * A read from a different scope returns `[]` instead of leaking the
 * previous user's data. The scope itself is derived from
 * `/api/auth/me` and memoized for the lifetime of the page.
 *
 * ## Pending uploads (recover from offline saves + partial migration)
 *
 * Saves that fail to reach the server (and entries from the legacy
 * localStorage migration that didn't all upload on the first try) go
 * into a `__history_pending__` queue. Every subsequent
 * `get*History()` call drains the queue before fetching from the
 * server, so no entry is lost even across page reloads.
 */

import type { HistoryKind } from './user-history-types';
import type { ThumbnailVariant } from './thumbnail-variants';

/**
 * Typed error thrown by save paths when the server save genuinely
 * cannot proceed and the caller MUST surface the failure to the user.
 *
 * Why this exists (2026-06-04):
 *   Before this, every save failure was silently degraded into a
 *   synthetic-id local fallback. That hid TWO very different cases
 *   behind the same return value:
 *
 *     - "Authenticated user is offline / 5xx" — recoverable. The
 *       entry gets queued in `__history_pending__` and `drainPending`
 *       retries on the next list fetch. Fallback is correct here.
 *
 *     - "User has no auth session" — UNrecoverable. With no scope,
 *       the entry can't be cached, can't be queued, can't be
 *       retried. The synthetic id is a dead-end — every downstream
 *       consumer (`useProject`, `persistRowAsset`, the editor route)
 *       rejects it. The user works on the doc thinking it's saved;
 *       a single navigation wipes everything.
 *
 *   This error fires the second case loudly so callers can refuse
 *   to enter the dead-end state and surface a "save failed, please
 *   sign in and retry" banner instead.
 *
 * Caller contract:
 *   - `kind: 'no_session'` — `/api/auth/me` returned non-200. Refresh
 *     the page or sign in again, then retry.
 *   - `kind: 'unauthorized'` — POST returned 401/403. Same recovery.
 *   - `kind: 'rejected'` — POST returned 4xx other than 401/403
 *     (validation, 413 too-large, etc.). Caller fixes the payload
 *     and retries. Not retryable without intervention.
 *
 *   `httpStatus` is set for the 'unauthorized' / 'rejected' kinds;
 *   undefined for 'no_session' (no HTTP call made).
 */
export class HistorySaveError extends Error {
  constructor(
    message: string,
    public readonly kind: 'no_session' | 'unauthorized' | 'rejected',
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'HistorySaveError';
  }
}

export interface ScriptHistoryEntry {
  id: string;
  timestamp: number;
  topic: string;
  niche: string;
  tone: string;
  style: string;
  duration: number;
  modelId: string;
  script: string;
  wordCount: number;
  audience?: string;
  context?: string;
  refs?: Array<{ url: string; title: string; channelTitle?: string; viewCount?: number; thumbnailUrl?: string }>;
  constraints?: {
    skipHook?: boolean;
    skipSubscribeCTA?: boolean;
    skipClickableLinks?: boolean;
    custom?: string[];
  };
  seriesId?: string;
  seriesTitle?: string;
  partNumber?: number;
  // The planned video's title at save time — the linked schedule item's
  // title when there is one, else whatever the user typed into `topic`.
  // Stamped onto every history kind so the history panel can show *which
  // video* this entry belongs to, regardless of whether the entry itself
  // is voice-, idea-, QA-, or thumbnail-shaped. Optional for forward
  // compatibility with rows written before this field existed.
  videoTitle?: string;
  scheduleItemId?: string;
}

export interface IdeasHistoryEntry {
  id: string;
  timestamp: number;
  niche: string;
  focus: string;
  videoType: string;
  modelId: string;
  count: number;
  ideas: Array<Record<string, unknown>>;
  audience?: string;
  usedReddit?: boolean;
  refs?: Array<{ url: string; title: string; channelTitle?: string; viewCount?: number }>;
  videoTitle?: string;
  scheduleItemId?: string;
}

/** Hook-first Shorts idea batch — produced by ShortNativeIdeasSurface.
 *  Stored under its own history kind so the long-form `ideas` panel
 *  stays uncluttered and the Shorts sidebar shows only Shorts batches. */
export interface ShortsIdeasHistoryEntry {
  id: string;
  timestamp: number;
  niche: string;
  count: number;
  /** The literal idea cards the model returned. Same shape as the
   *  `ShortIdea` server type but kept loose here so future field
   *  additions don't force a history schema migration. */
  ideas: Array<Record<string, unknown>>;
  /** Free-text context the user pasted into the box. */
  context?: string;
  /** Workspace niches table row id, when the user picked from the dropdown
   *  instead of typing free-text. Lets the rehydration step restore the
   *  exact picker selection. */
  nicheRowId?: string;
  /** Phase 15.6 series id, when the user picked one. Same rehydration role. */
  seriesId?: string;
  /** Phase 15.8 format hints. */
  targetLengthSec?: number;
  hookStyle?: string;
  tone?: string;
  pov?: string;
  /** Phase 15.8 inspired-by + avoid lists at save time so the user can
   *  see what context the model actually saw. */
  inspiredByTitles?: string[];
  avoidTitles?: string[];
  /** AI model id that produced the batch. */
  modelId?: string;
}

export interface VoiceoverHistoryEntry {
  id: string;
  timestamp: number;
  voiceName: string;
  voiceId: string;
  modelId: string;
  textPreview: string;
  charCount: number;
  audioUrl: string;
  tone: string;
  style: string;
  text?: string;
  settings?: {
    stability: number;
    similarity_boost: number;
    style: number;
    use_speaker_boost: boolean;
    model_id: string;
  };
  videoTitle?: string;
  scheduleItemId?: string;
}

export interface SeoHistoryEntry {
  id: string;
  timestamp: number;
  topic: string;
  niche: string;
  modelId: string;
  titlesCount: number;
  bestTitle: string;
  bestScore: number;
  tagsCount: number;
  result?: unknown;
  script?: string;
  targetKeywords?: string;
  existingTitle?: string;
  videoTitle?: string;
  scheduleItemId?: string;
}

export interface ThumbnailHistoryEntry {
  id: string;
  timestamp: number;
  title: string;
  niche: string;
  modelId: string;
  conceptsCount: number;
  bestConceptName: string;
  bestScore: number;
  generatedImageUrl?: string;
  result?: unknown;
  generatedImages?: Record<number, string>;
  /** Free-form 3-variants payload — keyed by the same concept index as
   *  `generatedImages`. Each entry holds the 3 variants generated for
   *  that concept slot. When present, the UI shows a `VariantPicker`
   *  in that slot; when absent, the legacy single-image `generatedImages`
   *  entry renders. Old entries (pre-variants migration) leave this
   *  undefined and render single-image. See
   *  `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`. */
  generatedImageVariants?: Record<number, ThumbnailVariant[]>;
  /** Free-form per-concept selected variant index. Indexed by concept
   *  slot, matching `generatedImageVariants`. Missing slot ⇒ defaults
   *  to 0 (first variant) at read time via `getSelectedVariantUrl`. */
  generatedImageSelectedVariantIndex?: Record<number, number>;
  script?: string;
  description?: string;
  imageModel?: string;
  videoTitle?: string;
  scheduleItemId?: string;
  /** Set when this entry came from a thumbnail format (Topic Card Grid, etc.)
   *  rather than the free-form 5-concept generator. Old entries leave this
   *  field undefined and render via the free-form code path. */
  format?: 'topic-card-grid' | 'n-levels' | 'flex-icon-grid' | 'doodle-explainer';
  /** Format-specific payload, discriminated by `format`. */
  formatPayload?:
    | TopicCardGridHistoryPayload
    | NLevelsHistoryPayload
    | FlexIconGridHistoryPayload
    | DoodleExplainerHistoryPayload;
}

/** Stored alongside a `format: 'topic-card-grid'` thumbnail history entry.
 *  Captures the full input + output so a restored entry can be re-rendered
 *  (Step 2 only, no fresh Step 1 spend) without re-asking the user. */
export interface TopicCardGridHistoryPayload {
  gridRows: number;
  gridCols: number;
  gridMode: 'preset' | 'custom';
  /** Which flow mode the user generated under. */
  mode: 'review' | 'pre-fill' | 'one-shot';
  /** The cards as actually fed to Step 2 (post-user-edit). */
  cards: Array<{
    index: number;
    label: string;
    icon_concept: string;
    accent_color?: string;
  }>;
  globalPalette: {
    background: string;
    primary_accent: string;
    secondary_accent: string;
  };
  imageUrl: string;
  /** 3-variant array, populated by the fan-out image route as of
   *  2026-06-09. `imageUrl` stays as the legacy single-image field for
   *  entries saved before the migration; new writes always populate
   *  `variants` and mirror the selected variant's url into `imageUrl`
   *  so downstream consumers that haven't yet adopted
   *  `getSelectedVariantUrl` still work. Resolution order at read time
   *  is owned by `getSelectedVariantUrl` in `thumbnail-variants.ts`. */
  variants?: ThumbnailVariant[];
  /** Index into `variants` of the user's picked thumbnail. Missing /
   *  undefined ⇒ first variant by convention. */
  selectedVariantIndex?: number;
  /** Computed region rectangles for the rendered grid (intrinsic-image pixels). */
  regions: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }>;
  /** The reference image URL that anchored the run, if the user provided one. */
  referenceImageUrl?: string;
  /** The image model used in Step 2 (defaults to gpt-image-2-i2i). */
  formatImageModel: string;
  /** Output dimensions used for region math. */
  outputWidth: number;
  outputHeight: number;
}

/** Stored alongside a `format: 'n-levels'` thumbnail history entry. Mirrors
 *  TopicCardGridHistoryPayload's shape but for the N Levels Explained
 *  format: a variable count of vertical slices with a bottom title bar. */
export interface NLevelsHistoryPayload {
  count: number;
  /** Which flow mode the user generated under. */
  mode: 'review' | 'pre-fill' | 'one-shot';
  /** The levels as actually fed to Step 2 (post-user-edit). */
  levels: Array<{
    level: number;
    label: string;
    illustration_concept: string;
    accent_color?: string;
    /** Per-slice color lock flag. Old entries leave this undefined; on
     *  restore, undefined means the color is a soft hint (matches the
     *  pre-toggle behaviour). */
    accent_color_locked?: boolean;
  }>;
  /** Whether this generation included the grunge bottom title bar. Old
   *  entries (pre-toggle) leave this undefined and restore treats them as
   *  `true` for backwards compat. */
  showBottomTitle?: boolean;
  /** Whether per-slice labels rendered under each LEVEL N heading. Old
   *  entries leave this undefined; restore treats undefined as `true`
   *  (matches the pre-toggle behaviour). */
  showLevelLabels?: boolean;
  /** The refined topic that went into the bottom title bar. Empty when
   *  `showBottomTitle` is false. */
  titleTopic: string;
  /** Defaults to "EXPLAINED" or whatever the user chose; empty string = no tag. */
  titleTagline: string;
  imageUrl: string;
  /** 3-variant array, populated by the fan-out image route as of
   *  2026-06-09. See `TopicCardGridHistoryPayload.variants` for the
   *  legacy / new-write resolution rules — same contract here. */
  variants?: ThumbnailVariant[];
  /** Index into `variants` of the user's picked thumbnail. */
  selectedVariantIndex?: number;
  /** Computed region rectangles per slice (intrinsic-image pixels). */
  regions: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }>;
  /** The reference image URL that anchored the run, if the user provided one. */
  referenceImageUrl?: string;
  /** The image model used in Step 2 (defaults to gpt-image-2-i2i). */
  formatImageModel: string;
  /** Output dimensions used for region math. */
  outputWidth: number;
  outputHeight: number;
}

/** Stored alongside a `format: 'flex-icon-grid'` thumbnail history entry.
 *  Carries the full `FlexIconGridConfig` so a restored entry can be
 *  re-rendered deterministically without any user input. The config
 *  object is intentionally `unknown` here so this module doesn't take
 *  a hard dependency on the format module — the panel validates the
 *  shape on hydrate via `parseConfig`. */
export interface FlexIconGridHistoryPayload {
  imageUrl: string;
  /** Phase 3 (2026-06-10) — N-variant fan-out output. Same shape as the
   *  TCG / N-Levels payload; variants represent re-renders of the
   *  config with rotated cell + background hues. */
  variants?: ThumbnailVariant[];
  /** Index into `variants` of the user's picked thumbnail. */
  selectedVariantIndex?: number;
  /** Full FlexIconGridConfig — validated by parseConfig on restore. */
  config: unknown;
  regions: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }>;
  outputWidth: number;
  outputHeight: number;
}

/** Stored alongside a `format: 'doodle-explainer'` thumbnail history
 *  entry — the Paint Explainer doodle style introduced 2026-06-09.
 *  Carries the structured input the user supplied (hook, expression,
 *  background) plus the 3 generated variants and the user's pick. The
 *  format is variant-only by design (no legacy single-image entries
 *  pre-date it), so `variants` is required, not optional. */
export interface DoodleExplainerHistoryPayload {
  /** The big bold yellow phrase the LLM is told to render verbatim.
   *  Capped at 60 chars at the API layer (hook text in this genre is
   *  always a 1-3 word phrase). */
  hookText: string;
  /** One of `ThumbnailStyle.supported_character_expressions` for the
   *  resolved style. Free-text accepted as a fallback when the user
   *  picks "other". */
  characterExpression: string;
  /** One of `ThumbnailStyle.supported_background_scenes[].id`. The
   *  literal `'custom'` flips on `customBackground` as the source. */
  backgroundScene: string;
  /** Free-text background description, used only when
   *  `backgroundScene === 'custom'`. Capped at 200 chars at the API. */
  customBackground?: string;
  /** Style id from `THUMBNAIL_STYLES`. Currently always
   *  `'paint_explainer_v1_doodle'` but persisted so future styles
   *  reuse the panel and round-trip cleanly. */
  styleId: string;
  /** Image model id (matches `MODEL_MAP` keys). Defaults to the
   *  style's `preferred_image_model` (`gpt-image-2-t2i`) but the
   *  user can override per-generation. */
  imageModel: string;
  /** The 3 generated variants. Always populated for this format. */
  variants: ThumbnailVariant[];
  /** Index into `variants` of the user's pick. Defaults to 0. */
  selectedVariantIndex: number;
}

export interface QAHistoryEntry {
  id: string;
  timestamp: number;
  niche: string;
  aggressiveness: string;
  modelId: string;
  scriptPreview: string;
  overallScore: number;
  verdict: string;
  passCount: number;
  script?: string;
  results?: unknown[];
  /** @deprecated Older entries used the singular field. */
  result?: unknown;
  videoTitle?: string;
  scheduleItemId?: string;
}

export interface ProductionDocHistoryEntry {
  id: string;
  timestamp: number;
  title: string;
  niche: string;
  topic: string;
  modelId: string;
  shotCount: number;
  totalDuration: string;
  totalWords: number;
  stylePreset: string;
  doc?: unknown;
  script?: string;
  rowImages?: Record<number, string>;
  /** Per-row B-roll clip ID. The Remotion renderer reads `videoUrl` from
   *  the broll_clips DB row keyed by this id, so we only persist the id —
   *  the URL is re-fetched on restore via `/api/broll/{id}`. Stops
   *  history-sidebar restore from silently dropping every clip the user
   *  generated for this doc. See `_plans/2026-05-17-render-state-hardening.md`. */
  rowVideoClips?: Record<number, string>;
  /** Per-row auto-fetched overlay state. Saved as the resolved
   *  status + url so a refresh + history restore can rebuild the
   *  parent's `rowOverlays` map without re-fetching from Brave. */
  rowOverlays?: Record<number, { status: string; url?: string }>;
  /** Voiceover MP3 URL, when one's been generated/assigned. Persisted
   *  so the shot-graph editor at /edit/[projectId] can play audio in
   *  the preview without re-fetching from a separate source. */
  voiceoverUrl?: string;
  videoTitle?: string;
  scheduleItemId?: string;
  /** Per-video override for the channel's visual brand kit (fonts /
   *  colors / logo). Shape matches ChannelVisualBrandKit; persisted as
   *  part of the entry payload so it follows the doc across devices. */
  visualBrandKitOverride?: unknown;
}

// ---------------------------------------------------------------------------
// Cache + transport plumbing
// ---------------------------------------------------------------------------

const SCRIPT_KEY = 'script_history';
const IDEAS_KEY = 'ideas_history';
const VOICEOVER_KEY = 'voiceover_history';
const SEO_KEY = 'seo_history';
const THUMBNAIL_KEY = 'thumbnail_history';
const QA_KEY = 'qa_history';
const PROD_DOC_KEY = 'production_doc_history';
const SHORTS_IDEAS_KEY = 'shorts_ideas_history';
const SCOPE_KEY = '__history_scope__';
const PENDING_KEY = '__history_pending__';
const ALL_CACHE_KEYS = [SCRIPT_KEY, IDEAS_KEY, VOICEOVER_KEY, SEO_KEY, THUMBNAIL_KEY, QA_KEY, PROD_DOC_KEY, SHORTS_IDEAS_KEY] as const;
const MAX_SCRIPT_LENGTH = 15000; // truncate very long scripts in history

interface KindWiring {
  kind: HistoryKind;
  cacheKey: string;
}

const SCRIPT: KindWiring = { kind: 'script', cacheKey: SCRIPT_KEY };
const IDEAS: KindWiring = { kind: 'ideas', cacheKey: IDEAS_KEY };
const VOICEOVER: KindWiring = { kind: 'voiceover', cacheKey: VOICEOVER_KEY };
const SEO: KindWiring = { kind: 'seo', cacheKey: SEO_KEY };
const THUMBNAIL: KindWiring = { kind: 'thumbnail', cacheKey: THUMBNAIL_KEY };
const QA: KindWiring = { kind: 'qa', cacheKey: QA_KEY };
const PROD_DOC: KindWiring = { kind: 'production_doc', cacheKey: PROD_DOC_KEY };
const SHORTS_IDEAS: KindWiring = { kind: 'shorts_ideas', cacheKey: SHORTS_IDEAS_KEY };

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/**
 * Light-weight diagnostic logger. We deliberately avoid pulling in
 * the server `logger` module here (it depends on AsyncLocalStorage
 * which doesn't ship to the browser bundle). Lines emit at warn
 * level so an operator looking at "user reports their history is
 * empty" has a starting trail in DevTools.
 */
function warn(op: string, detail: string): void {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[history] ${op}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Scope — derived from /api/auth/me, used to wrap every cache write
// ---------------------------------------------------------------------------

let scopePromise: Promise<string | null> | null = null;

/**
 * Resolve the current session's (workspace_id, collaborator_id)
 * scope. Memoized for the lifetime of the page — `loadScope()`
 * fetches `/api/auth/me` exactly once and reuses the promise.
 *
 * If the resolved scope differs from the previously-cached scope
 * (e.g. user A signed out, user B signed in on the same browser
 * without a clean wipe), this function clears every history cache +
 * sentinel + pending entry so user B doesn't inherit user A's data.
 */
async function loadScope(): Promise<string | null> {
  if (scopePromise) return scopePromise;
  scopePromise = (async () => {
    if (!isBrowser()) return null;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) {
        warn('loadScope', `auth/me returned ${res.status}`);
        return null;
      }
      const me = (await res.json()) as { id?: string; workspace_id?: string };
      if (!me.id || !me.workspace_id) {
        warn('loadScope', 'auth/me missing id or workspace_id');
        return null;
      }
      const scope = `${me.workspace_id}:${me.id}`;
      const prev = safeGetItem(SCOPE_KEY);
      if (prev && prev !== scope) {
        warn('loadScope', `scope changed (${prev} → ${scope}); wiping caches`);
        wipeCacheKeysOnly();
      }
      safeSetItem(SCOPE_KEY, scope);
      return scope;
    } catch (err) {
      warn('loadScope', err instanceof Error ? err.message : String(err));
      return null;
    }
  })();
  return scopePromise;
}

/**
 * Sync companion — returns whatever scope we last successfully
 * resolved (or null on a fresh device before the first
 * `loadScope()`). Used by the `get*HistoryCached()` helpers and the
 * autocomplete aggregators.
 */
function cachedScope(): string | null {
  return safeGetItem(SCOPE_KEY);
}

function safeGetItem(key: string): string | null {
  if (!isBrowser()) return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSetItem(key: string, value: string): void {
  if (!isBrowser()) return;
  try { localStorage.setItem(key, value); } catch { /* quota — caller decides */ }
}

function safeRemoveItem(key: string): void {
  if (!isBrowser()) return;
  try { localStorage.removeItem(key); } catch {}
}

// ---------------------------------------------------------------------------
// Scoped cache envelope — every cache write carries the scope it was
// written under, and reads return [] on scope mismatch.
// ---------------------------------------------------------------------------

interface CacheEnvelope<T> {
  scope: string;
  v: 1;
  items: T[];
}

function readCache<T>(cacheKey: string, scope: string | null): T[] {
  if (!scope) return [];
  const raw = safeGetItem(cacheKey);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CacheEnvelope<T> | unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'scope' in parsed &&
      'items' in parsed &&
      (parsed as CacheEnvelope<T>).scope === scope &&
      Array.isArray((parsed as CacheEnvelope<T>).items)
    ) {
      return (parsed as CacheEnvelope<T>).items;
    }
    return [];
  } catch {
    return [];
  }
}

function writeCache<T>(cacheKey: string, scope: string, items: T[]): void {
  const envelope: CacheEnvelope<T> = { scope, v: 1, items };
  try {
    safeSetItem(cacheKey, JSON.stringify(envelope));
  } catch {
    // Quota exceeded — halve and retry once. We don't loop because the
    // server is authoritative; the next refetch will repopulate.
    try {
      const half: CacheEnvelope<T> = { scope, v: 1, items: items.slice(0, Math.max(5, Math.floor(items.length / 2))) };
      safeSetItem(cacheKey, JSON.stringify(half));
    } catch {
      warn('writeCache', `${cacheKey} quota exhausted`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pending queue — entries that haven't successfully POSTed yet
// (offline save, partial migration upload). Drained on every
// successful list fetch.
// ---------------------------------------------------------------------------

interface PendingEntry {
  kind: HistoryKind;
  /** The legacy localStorage id (or a synthetic id for offline saves). */
  clientId: string;
  payload: Record<string, unknown>;
  /** When this entry was queued — used to surface "stuck" pending in logs. */
  queuedAt: number;
  /** The originating scope. Pending entries from a different scope
   *  are dropped (treated as belonging to a previous user). */
  scope: string;
}

function readPending(scope: string | null): PendingEntry[] {
  if (!scope) return [];
  const raw = safeGetItem(PENDING_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as PendingEntry[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && typeof p === 'object' && p.scope === scope);
  } catch {
    return [];
  }
}

function writePending(all: PendingEntry[]): void {
  try { safeSetItem(PENDING_KEY, JSON.stringify(all)); } catch {}
}

function enqueuePending(entry: PendingEntry): void {
  const raw = safeGetItem(PENDING_KEY);
  let all: PendingEntry[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) all = parsed;
    } catch {}
  }
  all.push(entry);
  writePending(all);
}

function removePending(scope: string, kind: HistoryKind, clientId: string): void {
  const raw = safeGetItem(PENDING_KEY);
  if (!raw) return;
  try {
    const all = JSON.parse(raw) as PendingEntry[];
    if (!Array.isArray(all)) return;
    const next = all.filter((p) => !(p.scope === scope && p.kind === kind && p.clientId === clientId));
    writePending(next);
  } catch {}
}

/**
 * Try to upload every pending entry of `kind` for the current scope.
 * Successful uploads are removed from the queue. Failed entries stay
 * for next time. Logged at warn so an operator can spot a queue that
 * never drains.
 */
async function drainPending(kind: HistoryKind, scope: string): Promise<void> {
  const queue = readPending(scope).filter((p) => p.kind === kind);
  if (queue.length === 0) return;
  for (const entry of queue) {
    const ok = await postEntry(entry.kind, entry.payload, entry.clientId);
    if (ok) {
      removePending(scope, entry.kind, entry.clientId);
    } else {
      warn('drainPending', `${kind} entry ${entry.clientId} failed (queued ${new Date(entry.queuedAt).toISOString()}); will retry`);
    }
  }
}

// ---------------------------------------------------------------------------
// Server row mapping
// ---------------------------------------------------------------------------

interface ServerRow {
  id: string;
  payload: Record<string, unknown>;
  client_id: string | null;
  created_at: string;
}

function fromServerRow<T extends { id: string; timestamp: number }>(row: ServerRow): T {
  return {
    ...(row.payload as Record<string, unknown>),
    id: row.id,
    timestamp: new Date(row.created_at).getTime(),
  } as T;
}

function toPayload<T extends { id: string; timestamp: number }>(entry: T): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  delete rest.id;
  delete rest.timestamp;
  return rest;
}

// ---------------------------------------------------------------------------
// One-shot localStorage → server migration (legacy unscoped cache)
// ---------------------------------------------------------------------------

/**
 * Per-(scope, kind) sentinel. Once set, this device has finished
 * uploading its pre-server-sync localStorage entries for that kind.
 * Stored under a key that includes the scope so a different user on
 * the same browser doesn't inherit the previous user's "already
 * migrated" state.
 */
function migrationSentinelKey(scope: string, cacheKey: string): string {
  return `__hist_mig:${scope}:${cacheKey}:v1`;
}

/**
 * In-flight migration promises keyed by `${scope}:${cacheKey}`, so
 * concurrent get*History() calls during page load only run the
 * upload once.
 */
const migrationsInFlight = new Map<string, Promise<void>>();

/**
 * On the very first load after the server-sync feature shipped,
 * users had pre-existing entries in the LEGACY unscoped cache key
 * (e.g. `script_history` containing a raw array, no envelope). This
 * function detects that legacy shape, queues every entry into the
 * pending uploader (so each entry's success/failure is tracked
 * individually), and then drops the legacy cache. The entries flow
 * through `drainPending` like any other queued entry.
 */
function migrateLegacyCacheToPending(scope: string, wiring: KindWiring): boolean {
  const raw = safeGetItem(wiring.cacheKey);
  if (!raw) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  // The server-sync envelope is `{scope, v, items}`. A bare array is
  // the pre-migration legacy shape.
  if (!Array.isArray(parsed)) return false;
  const legacy = parsed as Array<{ id?: string } & Record<string, unknown>>;
  if (legacy.length === 0) {
    safeRemoveItem(wiring.cacheKey);
    return true;
  }
  // Sort oldest-first so the server's created_at order matches the
  // order the user originally saved them in.
  const ordered = [...legacy].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  for (const entry of ordered) {
    const clientId = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : generateId();
    const payload: Record<string, unknown> = { ...entry };
    delete payload.id;
    delete payload.timestamp;
    enqueuePending({ kind: wiring.kind, clientId, payload, queuedAt: Date.now(), scope });
  }
  // Drop the legacy cache. The next successful list fetch will
  // populate the new envelope-shape cache.
  safeRemoveItem(wiring.cacheKey);
  return true;
}

async function migrateLocalToServerOnce(scope: string, wiring: KindWiring): Promise<void> {
  if (!isBrowser()) return;
  const sentinelKey = migrationSentinelKey(scope, wiring.cacheKey);
  if (safeGetItem(sentinelKey) === '1') return;

  const inFlightKey = `${scope}:${wiring.cacheKey}`;
  const inFlight = migrationsInFlight.get(inFlightKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    // Step 1: move legacy unscoped entries into the pending queue
    // (idempotent — once moved, the legacy cache is gone).
    migrateLegacyCacheToPending(scope, wiring);
    // Step 2: try to drain the queue. Sentinel is set unconditionally
    // — entries that fail stay in the queue and retry on the next
    // page load via the regular drainPending path.
    await drainPending(wiring.kind, scope);
    safeSetItem(sentinelKey, '1');
  })();

  migrationsInFlight.set(inFlightKey, run);
  try {
    await run;
  } finally {
    migrationsInFlight.delete(inFlightKey);
  }
}

/**
 * POST one entry to the server. Returns true on 2xx, false otherwise.
 * Logged at warn on failure so operators can correlate to server-side
 * errors when the pending queue stops draining.
 */
async function postEntry(
  kind: HistoryKind,
  payload: Record<string, unknown>,
  clientId?: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload, clientId }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      warn('postEntry', `${kind} → ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    warn('postEntry', `${kind} fetch threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Generic CRUD
// ---------------------------------------------------------------------------

async function listFromServer<T extends { id: string; timestamp: number }>(
  wiring: KindWiring,
): Promise<T[]> {
  const scope = await loadScope();
  // Migration runs first so any pre-existing local entries are
  // visible in the server response on this same call.
  if (scope) await migrateLocalToServerOnce(scope, wiring);
  // Drain any pending entries (offline-save fallbacks + retries from
  // a partial migration) before fetching server state.
  if (scope) await drainPending(wiring.kind, scope);

  if (!scope) {
    // No session — the surrounding chrome will redirect to /login.
    // Returning the cached items keeps autocomplete/etc. working
    // long enough for the navigation.
    return readCache<T>(wiring.cacheKey, cachedScope());
  }

  try {
    const res = await fetch(`/api/history?kind=${wiring.kind}`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      warn('listFromServer', `${wiring.kind} → ${res.status}`);
      return readCache<T>(wiring.cacheKey, scope);
    }
    const json = (await res.json()) as { items: ServerRow[] };
    const entries = (json.items || []).map((r) => fromServerRow<T>(r));
    writeCache(wiring.cacheKey, scope, entries);
    return entries;
  } catch (err) {
    warn('listFromServer', `${wiring.kind} threw: ${err instanceof Error ? err.message : String(err)}`);
    return readCache<T>(wiring.cacheKey, scope);
  }
}

async function saveToServer<T extends { id: string; timestamp: number }>(
  wiring: KindWiring,
  partial: Omit<T, 'id' | 'timestamp'>,
): Promise<T> {
  const scope = await loadScope();

  // 2026-06-04: refuse the silent synthetic-id fallback when there's
  // no auth scope. Without scope the fallback can't be queued AND
  // can't be cached — every downstream consumer of the returned id
  // (useProject GET, persistRowAsset POST, editor route) rejects the
  // non-UUID id, the user works thinking it's saved, and one
  // navigation wipes everything. See _plans/2026-06-04-prevent-
  // production-doc-silent-loss.md for the post-mortem.
  if (!scope) {
    console.warn('[doc-save initial] no session — throwing', { kind: wiring.kind });
    throw new HistorySaveError(
      'Not signed in — couldn\'t save to the server. Please refresh the page and sign in again, then retry.',
      'no_session',
    );
  }

  let httpStatus: number | undefined;
  try {
    const res = await fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: wiring.kind, payload: partial }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const json = (await res.json()) as { item: ServerRow };
      const entry = fromServerRow<T>(json.item);
      // Prepend to cache so the panel updates immediately on the
      // current page without a refetch.
      const cache = readCache<T>(wiring.cacheKey, scope);
      cache.unshift(entry);
      writeCache(wiring.cacheKey, scope, cache);
      console.info('[doc-save initial] committed', { kind: wiring.kind, id: entry.id });
      return entry;
    }
    httpStatus = res.status;
    warn('saveToServer', `${wiring.kind} → ${res.status}`);

    // 401 / 403: session expired or scope mismatch. Same fix as
    // no_session above — caller must surface a sign-in prompt; the
    // fallback path is a dead-end for these.
    if (res.status === 401 || res.status === 403) {
      throw new HistorySaveError(
        'Your session expired — couldn\'t save to the server. Please refresh the page and sign in, then retry.',
        'unauthorized',
        res.status,
      );
    }
    // Other 4xx (validation, 413 too-large): the payload is the
    // problem, not the connection. Queueing the same payload for
    // retry would just fail again — surface to caller.
    if (res.status >= 400 && res.status < 500) {
      throw new HistorySaveError(
        `Server rejected the save (HTTP ${res.status}). Edit the doc to make it smaller, then retry.`,
        'rejected',
        res.status,
      );
    }
    // 5xx falls through to the offline-queue path below.
  } catch (err) {
    // Don't re-wrap our own throws.
    if (err instanceof HistorySaveError) throw err;
    warn('saveToServer', `${wiring.kind} threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Authenticated session + transient failure (network blip / 5xx).
  // Write a local-only entry with a synthetic id and queue it for
  // upload on the next successful list fetch (see drainPending).
  // This path IS recoverable because scope is set: the queued entry
  // belongs to this user/workspace and the drain on next mount will
  // retry it. Returning the fallback lets the user keep working in
  // the meantime; the caller must still treat the synthetic id as
  // "not yet on the server" and refuse to set it as a permanent
  // historyEntryId until the drain rebinds to a real UUID.
  const clientId = generateId();
  const fallback = {
    ...(partial as Record<string, unknown>),
    id: clientId,
    timestamp: Date.now(),
  } as T;
  enqueuePending({
    kind: wiring.kind,
    clientId,
    payload: partial as Record<string, unknown>,
    queuedAt: Date.now(),
    scope,
  });
  const cache = readCache<T>(wiring.cacheKey, scope);
  cache.unshift(fallback);
  writeCache(wiring.cacheKey, scope, cache);
  console.info('[doc-save initial] queued offline', {
    kind: wiring.kind,
    clientId,
    httpStatus,
  });
  return fallback;
}

async function deleteFromServer<T extends { id: string; timestamp: number }>(
  wiring: KindWiring,
  id: string,
): Promise<void> {
  const scope = await loadScope();
  // Optimistically update the cache + drop any pending row with the
  // same id, so the UI feels snappy.
  if (scope) {
    const next = readCache<T>(wiring.cacheKey, scope).filter((e) => e.id !== id);
    writeCache(wiring.cacheKey, scope, next);
    removePending(scope, wiring.kind, id);
  }
  // If the id is a synthetic local-only id (set by saveToServer's
  // fallback path when the server was unreachable), the server will
  // 404 — skip the network call to avoid the wasted round-trip and
  // log noise. Server ids are RFC 4122 UUIDs.
  if (!isUuidLike(id)) return;
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 404) {
      warn('deleteFromServer', `${wiring.kind} ${id} → ${res.status}`);
    }
  } catch (err) {
    warn('deleteFromServer', `${wiring.kind} ${id} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function updateOnServer<T extends { id: string; timestamp: number }>(
  wiring: KindWiring,
  id: string,
  patch: Partial<T>,
): Promise<void> {
  const scope = await loadScope();
  if (!scope) return;
  // Apply the patch to the cached row so we know the full payload
  // to send (the server stores the entire payload, not a diff).
  // **Last-write-wins across devices** — two concurrent updates from
  // different devices can clobber each other's changes. Acceptable
  // for the current use case (image-attach after generate); if we
  // ever add genuinely concurrent edits, this needs a versioning
  // scheme (e.g. payload-hash etag).
  let cache = readCache<T>(wiring.cacheKey, scope);
  let idx = cache.findIndex((e) => e.id === id);
  if (idx < 0) {
    // Cache miss — previously this bailed silently and the PATCH never
    // reached the server. That dropped real money-spent generations
    // when localStorage was evicted or the user moved to another
    // device. 2026-05-22 fix: refetch the entire list from the server
    // to repopulate the cache, then retry the findIndex. The list
    // GET is a one-time cost paid only on cache miss, so the steady
    // state (cache hit) is unchanged.
    cache = await listFromServer<T>(wiring);
    idx = cache.findIndex((e) => e.id === id);
    if (idx < 0) {
      // Server doesn't have it either — genuinely gone. Bail with a
      // log so the absence is visible in diagnostics rather than the
      // silent return that masked the original bug.
      warn('updateOnServer', `${wiring.kind} ${id} cache-miss and server-miss; PATCH skipped`);
      return;
    }
  }
  const merged = { ...cache[idx], ...patch };
  cache[idx] = merged;
  writeCache(wiring.cacheKey, scope, cache);

  if (!isUuidLike(id)) return;
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: toPayload(merged) }),
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 404) {
      warn('updateOnServer', `${wiring.kind} ${id} → ${res.status}`);
    }
  } catch (err) {
    warn('updateOnServer', `${wiring.kind} ${id} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function clearOnServer(wiring: KindWiring): Promise<void> {
  const scope = await loadScope();
  // Clear the cache + sentinel + any pending entries of this kind
  // immediately so the UI updates and a re-login on the same browser
  // doesn't replay them.
  safeRemoveItem(wiring.cacheKey);
  if (scope) {
    safeRemoveItem(migrationSentinelKey(scope, wiring.cacheKey));
    const remaining = readPending(scope).filter((p) => p.kind !== wiring.kind);
    writePending(remaining);
  }
  try {
    const res = await fetch('/api/history/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: wiring.kind }),
      credentials: 'same-origin',
    });
    if (!res.ok) warn('clearOnServer', `${wiring.kind} → ${res.status}`);
  } catch (err) {
    warn('clearOnServer', `${wiring.kind} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// RFC 4122 UUID-shape check. Mirrors `isUuid` in user-history-types
// but kept inline here so the client lib doesn't pull in a server-
// adjacent module.
function isUuidLike(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$|^00000000-0000-0000-0000-000000000000$/i.test(v);
}

// ---------------------------------------------------------------------------
// Cache wipe — called from login + logout flows
// ---------------------------------------------------------------------------

/**
 * Internal: remove every history-related localStorage entry. Does
 * NOT reset `scopePromise` — used by `loadScope` itself when it
 * detects a scope change mid-flight.
 */
function wipeCacheKeysOnly(): void {
  for (const k of ALL_CACHE_KEYS) {
    safeRemoveItem(k);
    // Sentinels are scoped, so wipe by prefix rather than by exact key.
  }
  // Clear all `__hist_mig:` sentinels regardless of scope.
  if (isBrowser()) {
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('__hist_mig:')) toRemove.push(key);
      }
      for (const key of toRemove) safeRemoveItem(key);
    } catch {}
  }
  safeRemoveItem(PENDING_KEY);
}

/**
 * Public — wipe every history cache + sentinel + pending entry, and
 * reset the in-memory scope so the next `loadScope()` re-fetches.
 *
 * Call this from the login form's success handler (so the new user
 * starts with a clean slate) and from the logout button (so the
 * next user on the same browser doesn't see the previous user's
 * data even briefly).
 */
export function wipeHistoryCaches(): void {
  wipeCacheKeysOnly();
  safeRemoveItem(SCOPE_KEY);
  scopePromise = null;
  migrationsInFlight.clear();
}

// ---------------------------------------------------------------------------
// Public API — Scripts
// ---------------------------------------------------------------------------

export async function getScriptHistory(): Promise<ScriptHistoryEntry[]> {
  return listFromServer(SCRIPT);
}

export function getScriptHistoryCached(): ScriptHistoryEntry[] {
  return readCache<ScriptHistoryEntry>(SCRIPT_KEY, cachedScope());
}

export async function saveScript(
  entry: Omit<ScriptHistoryEntry, 'id' | 'timestamp'>,
): Promise<ScriptHistoryEntry> {
  const scriptText = entry.script.length > MAX_SCRIPT_LENGTH
    ? entry.script.slice(0, MAX_SCRIPT_LENGTH) + '\n\n[... truncated in history ...]'
    : entry.script;
  return saveToServer(SCRIPT, { ...entry, script: scriptText });
}

export async function deleteScriptEntry(id: string): Promise<void> {
  return deleteFromServer(SCRIPT, id);
}

export async function clearScriptHistory(): Promise<void> {
  return clearOnServer(SCRIPT);
}

// ---------------------------------------------------------------------------
// Public API — Ideas
// ---------------------------------------------------------------------------

export async function getIdeasHistory(): Promise<IdeasHistoryEntry[]> {
  return listFromServer(IDEAS);
}

export function getIdeasHistoryCached(): IdeasHistoryEntry[] {
  return readCache<IdeasHistoryEntry>(IDEAS_KEY, cachedScope());
}

export async function saveIdeas(
  entry: Omit<IdeasHistoryEntry, 'id' | 'timestamp'>,
): Promise<IdeasHistoryEntry> {
  return saveToServer(IDEAS, entry);
}

export async function deleteIdeasEntry(id: string): Promise<void> {
  return deleteFromServer(IDEAS, id);
}

export async function clearIdeasHistory(): Promise<void> {
  return clearOnServer(IDEAS);
}

// ---------------------------------------------------------------------------
// Public API — Shorts Ideas (Phase 15.8 sidebar)
// ---------------------------------------------------------------------------
// Mirrors the long-form Ideas helpers above. Kept under its own kind so
// the long-form Ideas history panel never accidentally surfaces a
// hook-first Shorts batch and vice versa.

export async function getShortsIdeasHistory(): Promise<ShortsIdeasHistoryEntry[]> {
  return listFromServer(SHORTS_IDEAS);
}

export function getShortsIdeasHistoryCached(): ShortsIdeasHistoryEntry[] {
  return readCache<ShortsIdeasHistoryEntry>(SHORTS_IDEAS_KEY, cachedScope());
}

export async function saveShortsIdeas(
  entry: Omit<ShortsIdeasHistoryEntry, 'id' | 'timestamp'>,
): Promise<ShortsIdeasHistoryEntry> {
  return saveToServer(SHORTS_IDEAS, entry);
}

export async function deleteShortsIdeasEntry(id: string): Promise<void> {
  return deleteFromServer(SHORTS_IDEAS, id);
}

export async function clearShortsIdeasHistory(): Promise<void> {
  return clearOnServer(SHORTS_IDEAS);
}

// ---------------------------------------------------------------------------
// Public API — Voiceovers
// ---------------------------------------------------------------------------

export async function getVoiceoverHistory(): Promise<VoiceoverHistoryEntry[]> {
  return listFromServer(VOICEOVER);
}

export function getVoiceoverHistoryCached(): VoiceoverHistoryEntry[] {
  return readCache<VoiceoverHistoryEntry>(VOICEOVER_KEY, cachedScope());
}

export async function saveVoiceover(
  entry: Omit<VoiceoverHistoryEntry, 'id' | 'timestamp'>,
): Promise<VoiceoverHistoryEntry> {
  return saveToServer(VOICEOVER, entry);
}

export async function deleteVoiceoverEntry(id: string): Promise<void> {
  return deleteFromServer(VOICEOVER, id);
}

export async function clearVoiceoverHistory(): Promise<void> {
  return clearOnServer(VOICEOVER);
}

// ---------------------------------------------------------------------------
// Public API — SEO
// ---------------------------------------------------------------------------

export async function getSeoHistory(): Promise<SeoHistoryEntry[]> {
  return listFromServer(SEO);
}

export function getSeoHistoryCached(): SeoHistoryEntry[] {
  return readCache<SeoHistoryEntry>(SEO_KEY, cachedScope());
}

export async function saveSeoEntry(
  entry: Omit<SeoHistoryEntry, 'id' | 'timestamp'>,
): Promise<SeoHistoryEntry> {
  return saveToServer(SEO, entry);
}

export async function deleteSeoEntry(id: string): Promise<void> {
  return deleteFromServer(SEO, id);
}

export async function clearSeoHistory(): Promise<void> {
  return clearOnServer(SEO);
}

// ---------------------------------------------------------------------------
// Public API — Thumbnails
// ---------------------------------------------------------------------------

export async function getThumbnailHistory(): Promise<ThumbnailHistoryEntry[]> {
  return listFromServer(THUMBNAIL);
}

export function getThumbnailHistoryCached(): ThumbnailHistoryEntry[] {
  return readCache<ThumbnailHistoryEntry>(THUMBNAIL_KEY, cachedScope());
}

export async function saveThumbnailEntry(
  entry: Omit<ThumbnailHistoryEntry, 'id' | 'timestamp'>,
): Promise<ThumbnailHistoryEntry> {
  return saveToServer(THUMBNAIL, entry);
}

/**
 * Patches an existing thumbnail history entry.
 *
 * **Important — `formatPayload` is shallow-replaced, not deep-merged.**
 * The patch path does `{ ...existing, ...patch }` at the top level, which
 * means `patch.formatPayload` (if present) **completely replaces** the
 * stored formatPayload. Sending `{ formatPayload: { selectedVariantIndex: 2 } }`
 * would wipe `cards`, `palette`, `imageUrl`, etc.
 *
 * Callers updating formatPayload MUST send the FULL payload. The
 * thumbnails page does this via per-format `buildPayload()` factories
 * that reconstruct the entire payload from live in-memory result state
 * before patching — see the TCG / N-Levels / FlexIcon / Doodle save
 * effects in `src/app/(app)/thumbnails/page.tsx`. Don't add a partial-
 * patch caller without first converting it to the buildPayload pattern.
 *
 * Why shallow: deep-merging discriminated-union shapes (the per-format
 * payloads diverge structurally) is error-prone; shallow lets the
 * caller take ownership of the merge.
 */
export async function updateThumbnailEntry(
  id: string,
  patch: Partial<ThumbnailHistoryEntry>,
): Promise<void> {
  return updateOnServer(THUMBNAIL, id, patch);
}

export async function deleteThumbnailEntry(id: string): Promise<void> {
  return deleteFromServer(THUMBNAIL, id);
}

export async function clearThumbnailHistory(): Promise<void> {
  return clearOnServer(THUMBNAIL);
}

// ---------------------------------------------------------------------------
// Public API — QA Engine
// ---------------------------------------------------------------------------

export async function getQAHistory(): Promise<QAHistoryEntry[]> {
  return listFromServer(QA);
}

export function getQAHistoryCached(): QAHistoryEntry[] {
  return readCache<QAHistoryEntry>(QA_KEY, cachedScope());
}

export async function saveQAEntry(
  entry: Omit<QAHistoryEntry, 'id' | 'timestamp'>,
): Promise<QAHistoryEntry> {
  return saveToServer(QA, entry);
}

export async function deleteQAEntry(id: string): Promise<void> {
  return deleteFromServer(QA, id);
}

export async function clearQAHistory(): Promise<void> {
  return clearOnServer(QA);
}

// ---------------------------------------------------------------------------
// Public API — Production Doc
// ---------------------------------------------------------------------------

export async function getProductionDocHistory(): Promise<ProductionDocHistoryEntry[]> {
  return listFromServer(PROD_DOC);
}

export function getProductionDocHistoryCached(): ProductionDocHistoryEntry[] {
  return readCache<ProductionDocHistoryEntry>(PROD_DOC_KEY, cachedScope());
}

export async function saveProductionDocEntry(
  entry: Omit<ProductionDocHistoryEntry, 'id' | 'timestamp'>,
): Promise<ProductionDocHistoryEntry> {
  return saveToServer(PROD_DOC, entry);
}

export async function updateProductionDocEntry(
  id: string,
  patch: Partial<ProductionDocHistoryEntry>,
): Promise<void> {
  return updateOnServer(PROD_DOC, id, patch);
}

/**
 * Update the localStorage cache row for a production-doc entry WITHOUT
 * touching the server. Use this from the production-doc page where the
 * canonical `useProject` save path is already the source of truth for
 * the server, and the only reason to write here is to keep the
 * history-sidebar thumbnails / shot counts visually fresh.
 *
 * Why this exists separately from `updateProductionDocEntry`: the full
 * `updateOnServer` path PATCHes `/api/history/[id]`, which blindly
 * overwrites `user_history.payload` with `{ ...cache[idx], ...patch }`.
 * When the cache is stale (initial-save snapshot, cross-tab divergence)
 * the legacy PATCH clobbers the canonical row's `doc.rows`,
 * `paint_explainer_v1_settings`, `flags`, and every other field the
 * canonical payload carries that the entry shape doesn't. That was the
 * silent-data-loss path the user hit when opening the editor — see the
 * 2026-06-04 fix at the call sites in `production-doc/page.tsx`.
 *
 * Cache miss is a no-op: the next `getProductionDocHistory()` GET will
 * repopulate from the server. We don't refetch here because the goal
 * is only sidebar liveness and a refetch is async / expensive.
 */
export async function updateProductionDocEntryCacheOnly(
  id: string,
  patch: Partial<ProductionDocHistoryEntry>,
): Promise<void> {
  const scope = await loadScope();
  if (!scope) return;
  const cache = readCache<ProductionDocHistoryEntry>(PROD_DOC_KEY, scope);
  const idx = cache.findIndex((e) => e.id === id);
  if (idx < 0) {
    // Cache miss is the steady state right after a fresh save before
    // the first list refresh — nothing to do locally.
    return;
  }
  cache[idx] = { ...cache[idx], ...patch };
  writeCache(PROD_DOC_KEY, scope, cache);
}

export async function deleteProductionDocEntry(id: string): Promise<void> {
  return deleteFromServer(PROD_DOC, id);
}

export async function clearProductionDocHistory(): Promise<void> {
  return clearOnServer(PROD_DOC);
}

// ---------------------------------------------------------------------------
// Aggregate autocomplete helpers
//
// These read the localStorage cache only — they're called from
// inside React render in autocomplete dropdowns where we can't
// await a fetch. Once each get*History() runs after page mount,
// the cache is populated and these return useful suggestions.
//
// Pages whose only need is autocomplete (e.g. /channel-naming)
// should fire `primeHistoryCaches()` once on mount so suggestions
// are populated even if the user never opens a generator panel.
// ---------------------------------------------------------------------------

/** Returns unique niche strings from the cached history of every kind, ordered by recency. */
export function getRecentNiches(): string[] {
  if (!isBrowser()) return [];
  const seen = new Set<string>();
  const results: string[] = [];
  const add = (v: string | undefined) => {
    if (!v?.trim()) return;
    const norm = v.trim();
    const key = norm.toLowerCase();
    if (!seen.has(key)) { seen.add(key); results.push(norm); }
  };
  getScriptHistoryCached().forEach((e) => add(e.niche));
  getIdeasHistoryCached().forEach((e) => add(e.niche));
  getSeoHistoryCached().forEach((e) => add(e.niche));
  getThumbnailHistoryCached().forEach((e) => add(e.niche));
  getQAHistoryCached().forEach((e) => add(e.niche));
  getProductionDocHistoryCached().forEach((e) => add(e.niche));
  return results.slice(0, 30);
}

/** Returns unique topic strings from the cached history of every kind, ordered by recency. */
export function getRecentTopics(): string[] {
  if (!isBrowser()) return [];
  const seen = new Set<string>();
  const results: string[] = [];
  const add = (v: string | undefined) => {
    if (!v?.trim()) return;
    const norm = v.trim();
    const key = norm.toLowerCase();
    if (!seen.has(key)) { seen.add(key); results.push(norm); }
  };
  getScriptHistoryCached().forEach((e) => add(e.topic));
  getSeoHistoryCached().forEach((e) => add(e.topic));
  getThumbnailHistoryCached().forEach((e) => add(e.title));
  getProductionDocHistoryCached().forEach((e) => add(e.topic));
  return results.slice(0, 30);
}

/**
 * Fetch every kind's history in parallel so the localStorage cache
 * is fresh enough for `getRecentNiches()` / `getRecentTopics()` to
 * return useful suggestions.
 *
 * Use this on pages whose only history dependency is the autocomplete
 * helpers — e.g. /channel-naming. Pages with their own history
 * panel don't need it (they already call get*History() on mount).
 *
 * Resolves when all seven fetches settle. Errors are swallowed —
 * autocomplete is a best-effort feature.
 */
export async function primeHistoryCaches(): Promise<void> {
  await Promise.allSettled([
    getScriptHistory(),
    getIdeasHistory(),
    getVoiceoverHistory(),
    getSeoHistory(),
    getThumbnailHistory(),
    getQAHistory(),
    getProductionDocHistory(),
  ]);
}
