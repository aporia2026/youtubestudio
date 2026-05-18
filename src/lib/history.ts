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
  script?: string;
  description?: string;
  imageModel?: string;
  videoTitle?: string;
  scheduleItemId?: string;
  /** Set when this entry came from a thumbnail format (Topic Card Grid, etc.)
   *  rather than the free-form 5-concept generator. Old entries leave this
   *  field undefined and render via the free-form code path. */
  format?: 'topic-card-grid';
  /** Format-specific payload, discriminated by `format`. */
  formatPayload?: TopicCardGridHistoryPayload;
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
const SCOPE_KEY = '__history_scope__';
const PENDING_KEY = '__history_pending__';
const ALL_CACHE_KEYS = [SCRIPT_KEY, IDEAS_KEY, VOICEOVER_KEY, SEO_KEY, THUMBNAIL_KEY, QA_KEY, PROD_DOC_KEY] as const;
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
      if (scope) {
        // Prepend to cache so the panel updates immediately on the
        // current page without a refetch.
        const cache = readCache<T>(wiring.cacheKey, scope);
        cache.unshift(entry);
        writeCache(wiring.cacheKey, scope, cache);
      }
      return entry;
    }
    warn('saveToServer', `${wiring.kind} → ${res.status}`);
  } catch (err) {
    warn('saveToServer', `${wiring.kind} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Server unreachable / unauth — write a local-only entry with a
  // synthetic id and queue it for upload on the next successful
  // list fetch (see drainPending). Without the queue, this entry
  // would disappear the next time the cache is refreshed from the
  // server.
  const clientId = generateId();
  const fallback = {
    ...(partial as Record<string, unknown>),
    id: clientId,
    timestamp: Date.now(),
  } as T;
  if (scope) {
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
  }
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
  const cache = readCache<T>(wiring.cacheKey, scope);
  const idx = cache.findIndex((e) => e.id === id);
  if (idx < 0) return;
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
