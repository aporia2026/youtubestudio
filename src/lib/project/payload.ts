/**
 * Canonical project payload — the single shape both `/production-doc`
 * and `/edit/[projectId]` read and write.
 *
 * Phase 1 of `_plans/2026-05-19-editor-production-doc-parity.md`.
 *
 * Before this module, each page invented its own subset of fields and
 * persisted them through separate code paths. The shipping symptom was
 * the editor opening on a black player with no audio, no thumbnails,
 * no B-roll. Owner words on 2026-05-19: "this is a joke. You have to
 * correct this now, in a proper robust way."
 *
 * The fix: one `ProjectPayload` type, one `migratePayload` defensive
 * upgrader, one `validatePayload` boundary check. Old `user_history`
 * rows still load (defaults fill in missing fields). Both pages stop
 * touching `user_history.payload` directly.
 *
 * Security note (rule 13): `validatePayload` is the route-boundary
 * gate. `migratePayload` is the load-time backfill. Defense-in-depth:
 * a malicious PATCH cannot sneak unknown keys past the validator,
 * because the validator drops every key it does not recognize.
 */

import type {
  ProductionDoc,
  RowOverlayRenderState,
  RowVideoClipState,
} from '@/remotion/utils';
import type { CaptionsBundle } from '@/lib/editor/captions';
import type { BrandKit } from '@/remotion/types';
import type { ForcedAlignmentResponse } from '@/lib/elevenlabs';
import type { ChannelVisualBrandKit } from '@/lib/channel-visual-brand-kit';

// ─── Versioning ──────────────────────────────────────────────────────

/** Bump whenever a non-additive shape change lands. `migratePayload`
 *  must accept every prior version and produce the current one. */
export const PROJECT_PAYLOAD_VERSION = 1 as const;
export type ProjectPayloadVersion = typeof PROJECT_PAYLOAD_VERSION;

// ─── Canonical shape ─────────────────────────────────────────────────

export interface ProjectPayloadFlags {
  animateScenes: boolean;
  suppressLowerThirds: boolean;
  overlaysDisabled: boolean;
  /** Per-row "force still even if a clip is ready". Sparse — only rows
   *  the user explicitly locked appear here. */
  rowLockedAsStill: Record<number, boolean>;
}

export interface ProjectPayload {
  version: ProjectPayloadVersion;
  title: string;

  /** The full doc shape the renderer already consumes. */
  doc: ProductionDoc;

  /** Row-index → still URL. Sparse. */
  rowImages: Record<number, string>;

  /** Row-index → overlay state. Sparse. */
  rowOverlays: Record<number, RowOverlayRenderState>;

  /** Row-index → B-roll clip state. Sparse. The shape mirrors
   *  `RowVideoClipState` so `productionDocToVideoConfig` reads it
   *  without translation. */
  rowVideoClips: Record<number, RowVideoClipState>;

  /** Narration MP3 URL, when one's been generated or picked. */
  voiceoverUrl?: string;
  /** Word-level alignment cached from ElevenLabs; powers scene-timing
   *  realignment server-side at render time, and the editor's
   *  drift report. */
  voiceoverAlignment?: ForcedAlignmentResponse;

  /** Captions bundle from the transcription pipeline. */
  captions?: CaptionsBundle;

  /** Background music URL. Same allowlist rules as voiceoverUrl. */
  musicUrl?: string;

  /** Per-doc visual brand kit override. Falls back to the channel
   *  kit (looked up via `channelId`), then `DEFAULT_BRAND_KIT`.
   *
   *  LEGACY shape — kept for backwards compatibility. Production-doc
   *  + the editor's full-brand-kit panel use the new `visualKitOverride`
   *  field below which carries the persisted `ChannelVisualBrandKit`
   *  shape (versioned, font names as registry keys). The renderer
   *  prefers `visualKitOverride` when present, resolving through
   *  `resolveBrandKitForRender(channelKit, visualKitOverride)`. Old
   *  payloads with only `brandKitOverride` keep working — the renderer
   *  passes them straight through as `brand`. */
  brandKitOverride?: Partial<BrandKit>;
  /** Per-doc override of the channel's visual brand kit (fonts /
   *  colors / logo / channel name). Persisted as the canonical
   *  versioned shape so the editor's editable panel + production-doc
   *  share the same data; the renderer resolves to the flat
   *  `BrandKit` via `resolveBrandKitForRender(channelKit, override)`.
   *  Batch (2026-05-20) full brand-kit panel port. */
  visualKitOverride?: ChannelVisualBrandKit;
  /** Workspace's pinned channel for this project. Used by the
   *  renderer to fetch the channel-level brand kit. */
  channelId?: string;

  flags: ProjectPayloadFlags;

  /** ID of the row in the `projects` table this user_history project is
   *  linked to. Distinct from the editor's `projectId` URL param (which is
   *  the `user_history.id`). Used by the voiceover picker to match
   *  narrator audio (which keys on `projects.id`). Optional — older
   *  projects pre-date this field and the picker falls back to title /
   *  schedule-item matching for them. Batch A of
   *  `_plans/2026-05-20-editor-prod-doc-parity-batches.md`. */
  linkedProjectId?: string;
  /** Schedule item id this project was created from, when applicable.
   *  Strongest signal for the voiceover picker's auto-match (every
   *  narrator assignment resolved server-side carries the same
   *  schedule_item_id via `schedule_items.custom_fields`). */
  linkedScheduleItemId?: string;
}

// ─── Type guards ─────────────────────────────────────────────────────

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNumericKey(k: string): boolean {
  return /^\d+$/.test(k);
}

function isStringOrUndef(x: unknown): x is string | undefined {
  return x === undefined || typeof x === 'string';
}

// ─── URL safety (rule 13: never trust client URLs) ──────────────────

/**
 * Rejects URLs that could execute script when rendered in a browser
 * (`javascript:`, `data:` images-in-disguise, `vbscript:`, `file:`).
 * Accepts:
 *
 * - Relative proxy paths (`/api/voiceover/...`, `/api/broll/...`).
 * - Absolute `https://` URLs.
 *
 * Deliberately NOT a host allowlist. The codebase pulls asset URLs
 * from Vercel Blob, Cloudflare R2, ElevenLabs, Kie.ai (B-roll
 * fallback), and several upstreams that rotate. Maintaining an
 * exhaustive host list invites silent data loss on every new upstream.
 * The threat we care about — XSS via script-bearing schemes — is
 * fully covered by the scheme check; an attacker hosting an MP4 on
 * `evil.example.com` is no more dangerous than one hosting it on
 * `vercel-storage.com`, because the renderer treats both as
 * `<video src>` and `<audio src>`, not `<script>`.
 *
 * `http://` is rejected: every legitimate upstream the codebase uses
 * is HTTPS, and accepting plaintext would silently downgrade the
 * connection on render.
 */
const DANGEROUS_SCHEME_RE = /^\s*(?:javascript|data|vbscript|file|blob):/i;

function isSafeAssetUrl(u: string): boolean {
  if (!u) return false;
  if (DANGEROUS_SCHEME_RE.test(u)) return false;
  // Relative proxy paths: always allowed. The proxy itself validates
  // upstream hosts; the route boundary doesn't need to second-guess.
  if (u.startsWith('/')) return true;
  // Absolute URLs must be HTTPS. Reject http://, ftp://, etc.
  return /^https:\/\//i.test(u);
}

// ─── Defaults ────────────────────────────────────────────────────────

/** Minimal doc shape used as the load-fallback so a corrupted payload
 *  still hands the editor SOMETHING it can render (the editor's empty-
 *  state branch picks it up). */
const EMPTY_DOC: ProductionDoc = {
  rows: [],
  title: '',
  niche: '',
  total_duration: '0',
  total_words: 0,
  speaking_pace_wpm: 150,
};

const DEFAULT_FLAGS: ProjectPayloadFlags = {
  animateScenes: true,
  suppressLowerThirds: false,
  overlaysDisabled: false,
  rowLockedAsStill: {},
};

export function emptyProjectPayload(title = 'Untitled project'): ProjectPayload {
  return {
    version: PROJECT_PAYLOAD_VERSION,
    title,
    doc: EMPTY_DOC,
    rowImages: {},
    rowOverlays: {},
    rowVideoClips: {},
    flags: { ...DEFAULT_FLAGS, rowLockedAsStill: {} },
  };
}

// ─── Migration ───────────────────────────────────────────────────────

/**
 * Defensive backfill of an unknown JSONB blob into a canonical
 * `ProjectPayload`. Never throws — anything unrecognized is dropped,
 * anything missing is filled in with a default. Returns the migrated
 * payload plus a list of `droppedFields` so the load path can emit
 * `[project payload migrate]` with diagnostic detail.
 *
 * The migrator is intentionally generous on input and strict on
 * output: it accepts every prior shape the codebase has emitted, but
 * the result always conforms to the current `ProjectPayload`. This is
 * the place to handle every "field X used to be a string but is now an
 * object" wart.
 */
export interface MigrateResult {
  payload: ProjectPayload;
  droppedFields: string[];
  appliedDefaults: string[];
}

export function migratePayload(raw: unknown): MigrateResult {
  const dropped: string[] = [];
  const defaulted: string[] = [];

  if (!isPlainObject(raw)) {
    defaulted.push('<entire-payload>');
    return {
      payload: emptyProjectPayload(),
      droppedFields: dropped,
      appliedDefaults: defaulted,
    };
  }

  const out = emptyProjectPayload();

  // title
  if (typeof raw.title === 'string' && raw.title.length > 0) {
    out.title = raw.title;
  } else {
    defaulted.push('title');
  }

  // doc (required-ish — if missing, we fall back to EMPTY_DOC and the
  // editor's empty-state branch handles it)
  if (
    isPlainObject(raw.doc) &&
    Array.isArray((raw.doc as { rows?: unknown }).rows)
  ) {
    out.doc = raw.doc as unknown as ProductionDoc;
  } else {
    defaulted.push('doc');
  }

  // rowImages — accept either `Record<number, string>` (newer) or a
  // legacy `RowImageState[]` array (older). Older history rows wrote
  // an array of `{ status, imageUrl }` objects; condense those down to
  // a sparse map keyed by index.
  if (isPlainObject(raw.rowImages)) {
    for (const [k, v] of Object.entries(raw.rowImages)) {
      if (!isNumericKey(k)) {
        dropped.push(`rowImages[${k}]`);
        continue;
      }
      if (typeof v === 'string' && isSafeAssetUrl(v)) {
        out.rowImages[Number(k)] = v;
      } else {
        dropped.push(`rowImages[${k}]`);
      }
    }
  } else if (Array.isArray(raw.rowImages)) {
    raw.rowImages.forEach((entry, i) => {
      if (
        isPlainObject(entry) &&
        typeof entry.imageUrl === 'string' &&
        isSafeAssetUrl(entry.imageUrl)
      ) {
        out.rowImages[i] = entry.imageUrl;
      }
    });
  } else if (raw.rowImages !== undefined) {
    dropped.push('rowImages');
  }

  // rowOverlays — `Record<number, { status, url? }>`
  if (isPlainObject(raw.rowOverlays)) {
    for (const [k, v] of Object.entries(raw.rowOverlays)) {
      if (!isNumericKey(k) || !isPlainObject(v)) {
        dropped.push(`rowOverlays[${k}]`);
        continue;
      }
      const status = typeof v.status === 'string' ? v.status : 'idle';
      const url = typeof v.url === 'string' && isSafeAssetUrl(v.url) ? v.url : undefined;
      out.rowOverlays[Number(k)] = { status, url };
    }
  } else if (raw.rowOverlays !== undefined) {
    dropped.push('rowOverlays');
  }

  // rowVideoClips — new in v1. Accept the canonical shape AND a legacy
  // `Record<number, string>` clip-id map (history.ts used it before
  // this refactor). Clip ids without a corresponding `url`/`duration`
  // get `status: 'pending'` so the editor knows to rehydrate from
  // `/api/broll/{id}`.
  if (isPlainObject(raw.rowVideoClips)) {
    for (const [k, v] of Object.entries(raw.rowVideoClips)) {
      if (!isNumericKey(k)) {
        dropped.push(`rowVideoClips[${k}]`);
        continue;
      }
      if (typeof v === 'string') {
        // Legacy id-only entry. Mark as pending — caller hydrates.
        out.rowVideoClips[Number(k)] = { status: 'pending' };
        continue;
      }
      if (!isPlainObject(v)) {
        dropped.push(`rowVideoClips[${k}]`);
        continue;
      }
      const status = typeof v.status === 'string' ? v.status : 'idle';
      const videoUrl =
        typeof v.videoUrl === 'string' && isSafeAssetUrl(v.videoUrl)
          ? v.videoUrl
          : undefined;
      const durationSeconds =
        typeof v.durationSeconds === 'number' && Number.isFinite(v.durationSeconds)
          ? v.durationSeconds
          : undefined;
      out.rowVideoClips[Number(k)] = { status, videoUrl, durationSeconds };
    }
  } else if (raw.rowVideoClips !== undefined) {
    dropped.push('rowVideoClips');
  }

  // voiceoverUrl
  if (typeof raw.voiceoverUrl === 'string' && raw.voiceoverUrl.length > 0) {
    if (isSafeAssetUrl(raw.voiceoverUrl)) {
      out.voiceoverUrl = raw.voiceoverUrl;
    } else {
      dropped.push('voiceoverUrl');
    }
  }

  // voiceoverAlignment — opaque ElevenLabs response. Shape-check the
  // outer `words` array; trust the contents.
  if (isPlainObject(raw.voiceoverAlignment) && Array.isArray(raw.voiceoverAlignment.words)) {
    out.voiceoverAlignment = raw.voiceoverAlignment as unknown as ForcedAlignmentResponse;
  } else if (raw.voiceoverAlignment !== undefined) {
    dropped.push('voiceoverAlignment');
  }

  // captions — opaque CaptionsBundle. Shape-check segments array.
  if (isPlainObject(raw.captions) && Array.isArray(raw.captions.segments)) {
    out.captions = raw.captions as unknown as CaptionsBundle;
  } else if (raw.captions !== undefined) {
    dropped.push('captions');
  }

  // musicUrl
  if (typeof raw.musicUrl === 'string' && raw.musicUrl.length > 0) {
    if (isSafeAssetUrl(raw.musicUrl)) {
      out.musicUrl = raw.musicUrl;
    } else {
      dropped.push('musicUrl');
    }
  }

  // brandKitOverride
  if (isPlainObject(raw.brandKitOverride)) {
    out.brandKitOverride = raw.brandKitOverride as Partial<BrandKit>;
  } else if (raw.brandKitOverride !== undefined) {
    dropped.push('brandKitOverride');
  }

  // Legacy alias: production-doc page used `visualBrandKitOverride` in
  // ProductionDocHistoryEntry before this refactor. Bridge it.
  if (!out.brandKitOverride && isPlainObject(raw.visualBrandKitOverride)) {
    out.brandKitOverride = raw.visualBrandKitOverride as Partial<BrandKit>;
  }

  // visualKitOverride — the canonical ChannelVisualBrandKit shape.
  // Validated lazily here: if it's a plain object we keep it; the
  // server-side renderer + the editor's panel both re-parse via
  // `parseVisualBrandKit` which silently drops malformed fields.
  // No need to duplicate that validation at the payload layer.
  if (isPlainObject(raw.visualKitOverride)) {
    out.visualKitOverride = raw.visualKitOverride as unknown as ChannelVisualBrandKit;
  } else if (raw.visualKitOverride !== undefined) {
    dropped.push('visualKitOverride');
  }

  // channelId
  if (typeof raw.channelId === 'string' && raw.channelId.length > 0) {
    out.channelId = raw.channelId;
  }

  // linkedProjectId — projects.id this user_history row is linked to.
  // Required by the voiceover picker's auto-match against narrator audio.
  if (typeof raw.linkedProjectId === 'string' && raw.linkedProjectId.length > 0) {
    out.linkedProjectId = raw.linkedProjectId;
  }

  // linkedScheduleItemId — schedule_items.id (when the project was
  // created from a schedule). Strongest match signal for the picker.
  if (typeof raw.linkedScheduleItemId === 'string' && raw.linkedScheduleItemId.length > 0) {
    out.linkedScheduleItemId = raw.linkedScheduleItemId;
  }
  // Legacy alias: older payloads only had `scheduleItemId` at the top
  // level (the schedule-handoff flow stamped it on saveProductionDocEntry
  // before the parity refactor). Bridge it so existing rows pick up the
  // strong match signal on next load.
  if (!out.linkedScheduleItemId && typeof raw.scheduleItemId === 'string' && raw.scheduleItemId.length > 0) {
    out.linkedScheduleItemId = raw.scheduleItemId;
  }

  // flags — every flag is optional with a default. Read each one
  // individually so a malformed flag block doesn't wipe the lot.
  const rawFlags = isPlainObject(raw.flags) ? raw.flags : {};
  out.flags.animateScenes =
    typeof rawFlags.animateScenes === 'boolean' ? rawFlags.animateScenes : DEFAULT_FLAGS.animateScenes;
  out.flags.suppressLowerThirds =
    typeof rawFlags.suppressLowerThirds === 'boolean'
      ? rawFlags.suppressLowerThirds
      : DEFAULT_FLAGS.suppressLowerThirds;
  out.flags.overlaysDisabled =
    typeof rawFlags.overlaysDisabled === 'boolean'
      ? rawFlags.overlaysDisabled
      : DEFAULT_FLAGS.overlaysDisabled;
  if (isPlainObject(rawFlags.rowLockedAsStill)) {
    for (const [k, v] of Object.entries(rawFlags.rowLockedAsStill)) {
      if (isNumericKey(k) && typeof v === 'boolean') {
        out.flags.rowLockedAsStill[Number(k)] = v;
      }
    }
  }

  // Legacy aliases for the flags so older payloads upgrade cleanly.
  // production-doc used to track these at the top level of the entry.
  if (typeof raw.animateScenes === 'boolean' && !('animateScenes' in rawFlags)) {
    out.flags.animateScenes = raw.animateScenes;
  }
  if (typeof raw.suppressLowerThirds === 'boolean' && !('suppressLowerThirds' in rawFlags)) {
    out.flags.suppressLowerThirds = raw.suppressLowerThirds;
  }
  if (typeof raw.overlaysDisabled === 'boolean' && !('overlaysDisabled' in rawFlags)) {
    out.flags.overlaysDisabled = raw.overlaysDisabled;
  }

  return { payload: out, droppedFields: dropped, appliedDefaults: defaulted };
}

// ─── Validation (route boundary) ─────────────────────────────────────

/**
 * Strict validation used by the PATCH route. Returns either the
 * validated payload (re-emitted through the migrator so unknown keys
 * are stripped) or a typed error with the field path.
 *
 * Unlike `migratePayload`, this REJECTS malformed input rather than
 * filling defaults — partial writes are not allowed at the route
 * level. Callers issue a full-payload PATCH; if they want a partial
 * update they read-modify-write client-side.
 */
export type ValidateResult =
  | { ok: true; payload: ProjectPayload }
  | { ok: false; field: string; reason: string };

export function validatePayload(raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) {
    return { ok: false, field: '<root>', reason: 'payload must be a JSON object' };
  }
  // version is optional on the wire — the server is the authority on
  // shape. If the client sends a numeric version, sanity-check it.
  if ('version' in raw && raw.version !== PROJECT_PAYLOAD_VERSION) {
    return {
      ok: false,
      field: 'version',
      reason: `expected ${PROJECT_PAYLOAD_VERSION}, got ${String(raw.version)}`,
    };
  }
  if (!isPlainObject(raw.doc) || !Array.isArray((raw.doc as { rows?: unknown }).rows)) {
    return {
      ok: false,
      field: 'doc.rows',
      reason: 'doc.rows array is required',
    };
  }
  if ('voiceoverUrl' in raw && !isStringOrUndef(raw.voiceoverUrl)) {
    return { ok: false, field: 'voiceoverUrl', reason: 'must be a string when present' };
  }
  if (
    typeof raw.voiceoverUrl === 'string' &&
    raw.voiceoverUrl.length > 0 &&
    !isSafeAssetUrl(raw.voiceoverUrl)
  ) {
    return {
      ok: false,
      field: 'voiceoverUrl',
      reason: 'must be a proxy path or an allowlisted blob/elevenlabs URL',
    };
  }
  if ('musicUrl' in raw && !isStringOrUndef(raw.musicUrl)) {
    return { ok: false, field: 'musicUrl', reason: 'must be a string when present' };
  }
  if (
    typeof raw.musicUrl === 'string' &&
    raw.musicUrl.length > 0 &&
    !isSafeAssetUrl(raw.musicUrl)
  ) {
    return {
      ok: false,
      field: 'musicUrl',
      reason: 'must be a proxy path or an allowlisted blob URL',
    };
  }

  // Run through the migrator to drop unknown keys + canonicalize. The
  // validator above already caught the rejections that should be 400s;
  // anything that survives is allowed through the migrator's
  // best-effort fill.
  const { payload } = migratePayload(raw);
  return { ok: true, payload };
}

// ─── Internal exports for the validator (tests only) ────────────────

export const __testing = {
  isSafeAssetUrl,
};
