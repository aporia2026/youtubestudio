/**
 * Encrypted per-user settings, persisted in `collaborators.encrypted_settings`.
 *
 * The column is encrypted at rest (AES-256-GCM via crypto.ts). The blob holds
 * a versioned JSON object so future fields can be added without coordinated
 * migrations. Clients read settings server-side via `getUserSettings(userId)`
 * and mutate via `updateUserSettings(userId, patch)`.
 *
 * For Phase 2 PR #1 the only field is `active_channel_id` — the channel
 * pinned to the top-bar switcher. Future fields can be slotted in alongside
 * (UI density, keyboard-shortcut overrides, default models per feature, etc.).
 */
import { sql } from '@vercel/postgres';
import { encrypt, decrypt } from './crypto';

export const SETTINGS_VERSION = 1;

export interface UserSettings {
  v: typeof SETTINGS_VERSION;
  active_channel_id?: string | null;
  /** Per-user default model for the production-doc B-roll / animation
   *  picker. `null` or absent means "fall back to the registry's
   *  DEFAULT_BROLL_MODEL_ID". Validated against the live registry at
   *  the API layer before being persisted.
   *
   *  Historically a single field; since the per-kind split, this is the
   *  default used when a row's auto-pick mode is image-to-video (the
   *  registry default is also i2v) OR as a back-compat fallback for
   *  accounts saved before the split. New writes go to
   *  `default_broll_t2v_model_id` / `default_broll_i2v_model_id`. */
  default_broll_model_id?: string | null;
  /** Per-user default model when the cell needs a text-to-video model
   *  (rows without a still). Validated kind === 'text-to-video' at the
   *  API layer. `null` or absent ⇒ fall back to the legacy
   *  `default_broll_model_id` if it's a t2v model, otherwise to the
   *  registry's `DEFAULT_BROLL_T2V_MODEL_ID`. */
  default_broll_t2v_model_id?: string | null;
  /** Per-user default model when the cell needs an image-to-video model
   *  (rows that have a generated still). Validated kind ===
   *  'image-to-video' at the API layer. `null` or absent ⇒ fall back to
   *  the legacy `default_broll_model_id` if it's an i2v model, otherwise
   *  to `DEFAULT_BROLL_MODEL_ID`. */
  default_broll_i2v_model_id?: string | null;
  /** Per-user default visual-style preset for the production-doc form.
   *  Stored as the style slug (e.g. 'doodle_explainer', 'cinematic') or
   *  a workspace-saved style UUID. `null` or absent means "fall back to
   *  the library default". Applied when the user starts a fresh session
   *  (no form-input cache); the in-session form-input cache takes
   *  precedence over this for normal refreshes so the user's most recent
   *  choice always wins for the current doc. */
  default_style_preset?: string | null;
  /** Niche-finder default language as an ISO 639-1 code (e.g. 'en').
   *  Drives `relevanceLanguage` on YouTube searches AND the post-fetch
   *  language filter. `null` or absent means "fall back to 'en'". */
  niche_finder_language?: string | null;
  /** Niche-finder default region as an ISO 3166-1 alpha-2 code
   *  (e.g. 'US'). Drives `regionCode` on YouTube searches. `null` or
   *  absent means "fall back to 'US'". */
  niche_finder_region?: string | null;
  /** Per-user primary vendor for the GPT Image 2 edit operation
   *  (variant button, character/scene continuity, mouth-removal). The
   *  other vendor is the automatic fallback when the primary fails.
   *  `'atlas'` keeps the cost-optimal default (~$0.011/edit on Atlas
   *  Cloud) and falls back to Kie (~$0.05/edit). `'kie'` inverts that.
   *  `null` or absent ⇒ `'atlas'`. See
   *  `_plans/2026-05-29-gpt-image-2-edit-provider-fallback.md`. */
  gpt_image_2_edit_primary?: 'atlas' | 'kie' | null;
  /** Phase 15.15 — per-user default base-frame T2I model for the
   *  Shorts asset pipeline + Shots panel base regen. Stored as a
   *  `ShortsBaseT2iModelId` string (see `shorts-base-t2i.ts`); the
   *  consumer narrows via `resolveBaseT2iModelId` so a stale or
   *  retired model id never crashes. `null` or absent ⇒
   *  DEFAULT_BASE_T2I_MODEL_ID ('kie-gpt-image-2', user-confirmed
   *  2026-06-09 — same OpenAI gpt-image-2 model as the Atlas route
   *  but routed through Kie's gateway). */
  shorts_base_t2i_model_id?: string | null;
  /** Shorts content-QA composite threshold (0..100). Composite below
   *  this turns the editor tab badge red. `null` or absent ⇒
   *  SHORTS_QA_DEFAULT_COMPOSITE_THRESHOLD (80). */
  shorts_qa_composite_threshold?: number | null;
  /** Shorts content-QA per-dimension floor (0..100). Any dimension
   *  below this is auto-promoted to a critical issue. `null` or
   *  absent ⇒ SHORTS_QA_DEFAULT_PER_DIMENSION_FLOOR (70). */
  shorts_qa_per_dimension_floor?: number | null;
  /** Hard cap on Brave fact-check queries per QA run (1..10). Cost
   *  control. `null` or absent ⇒ SHORTS_QA_DEFAULT_FACT_CHECK_CLAIM_CAP
   *  (5). */
  shorts_qa_fact_check_claim_cap?: number | null;
  /** Shorts content-QA fact-check on/off switch. When `false`, the
   *  grader still flags claims but the Brave + judge pass is skipped
   *  entirely. `null` or absent ⇒ SHORTS_QA_DEFAULT_FACT_CHECK_ENABLED
   *  (true). */
  shorts_qa_fact_check_enabled?: boolean | null;
  /** Shorts bulk-batch default voice preset id (ElevenLabs or Google
   *  voice id). Applied as the seed for step 2's voice picker. `null`
   *  or absent ⇒ no default; the picker shows the workspace TTS
   *  default. See `_plans/2026-06-08-shorts-bulk-batch-youtube-upload.md`. */
  shorts_batch_default_voice_id?: string | null;
  /** Default YouTube category id for new batches (e.g. '22' for
   *  People & Blogs). `null` or absent ⇒ the picker requires an
   *  explicit choice. */
  shorts_batch_default_youtube_category_id?: string | null;
  /** Default ISO 639-1 language for new batches. `null` or absent ⇒
   *  picker defaults to 'en'. */
  shorts_batch_default_youtube_language?: string | null;
  /** Default COPPA "made for kids" answer for new batches. `null`
   *  or absent ⇒ picker requires an explicit choice (YouTube rejects
   *  uploads without it). */
  shorts_batch_default_made_for_kids?: boolean | null;
  /** Default IANA timezone for batch schedule pickers (e.g.
   *  'America/New_York'). `null` or absent ⇒ picker auto-detects the
   *  browser's timezone. */
  shorts_batch_default_timezone?: string | null;
  /** Default description template applied to new batches. Supports
   *  `{{title}}`, `{{hook}}`, `{{payoff}}` placeholders, expanded
   *  per-short at SEO-seeding time. `null` or absent ⇒ empty
   *  template (SEO output fills the description directly). */
  shorts_batch_default_description_template?: string | null;
  /** Favorited TTS voices for the voice picker. Each entry pins a
   *  voice from a specific provider so identical voice IDs across
   *  providers don't collide. Empty / absent ⇒ no favorites. */
  tts_favorite_voices?: Array<{ providerId: string; voiceId: string }>;
  /** Default "age restricted (18+)" answer for new batches. `null`
   *  or absent ⇒ false at the batch level. */
  shorts_batch_default_age_restricted?: boolean | null;
  /** Default "contains paid promotion" answer for new batches.
   *  `null` or absent ⇒ false at the batch level. */
  shorts_batch_default_paid_promotion?: boolean | null;
  /** Default "AI content disclosure" answer for new batches. `null`
   *  or absent ⇒ true at the uploader (since this app generates
   *  with AI). User can flip per-short in the review queue. */
  shorts_batch_default_ai_content_disclosure?: boolean | null;
  /** Number of thumbnail variants generated per "Generate" click on
   *  the thumbnails page. Range [1..3]; values outside the range are
   *  clamped at the API layer. `null` or absent ⇒
   *  DEFAULT_VARIANT_COUNT (3) from `thumbnail-variants.ts`. Cost
   *  scales linearly with this value, so users on tight budgets can
   *  drop to 1 / 2. See
   *  `_plans/2026-06-09-doodle-explainer-thumbnails-and-3-variants.md`. */
  thumbnail_variant_count?: number | null;
  /** Default image model id for the thumbnails page Generate flow.
   *  Matches `MODEL_MAP` keys in
   *  `src/app/api/thumbnails/image/route.ts`. `null` or absent ⇒
   *  the picker defaults to `gpt-image-2-t2i` (Kie GPT Image 2).
   *  Validated at the API layer against the live model registry; a
   *  retired id falls back to the registry default rather than
   *  crashing the route. */
  thumbnail_default_image_model?: string | null;
  /** Default thumbnail style id (from `THUMBNAIL_STYLES` in
   *  `thumbnail-styles.ts`) preselected when the user opens the
   *  Doodle Explainer panel — and reused as the seed for any future
   *  style-aware format. `null` or absent ⇒ no style preselected
   *  (panel uses its own first-style fallback). */
  thumbnail_default_style?: string | null;
  /** Phased rollout flag for the multi-variant thumbnail flow. When
   *  `false` / unset, every format ships its legacy single-image
   *  output and the `VariantPicker` is not mounted — so a regression
   *  in the variants codepath is a one-toggle revert. Flip to `true`
   *  after Phase 4 manual QA per the rollout plan. Stored per-user
   *  so we can opt cohorts in gradually. */
  thumbnail_variants_enabled?: boolean | null;
}

const DEFAULTS: UserSettings = { v: SETTINGS_VERSION };

/**
 * Pure parser. Used inside getUserSettings; exported for tests so the
 * fault-tolerant logic doesn't require a real DB to verify.
 *
 * Anything that fails to decrypt, parse, or shape-check returns DEFAULTS —
 * a corrupt blob shouldn't lock the user out of the app.
 */
export function parseUserSettings(encryptedBlob: string | null): UserSettings {
  if (!encryptedBlob) return { ...DEFAULTS };
  let decoded: string;
  try {
    decoded = decrypt(encryptedBlob);
  } catch {
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ...DEFAULTS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== SETTINGS_VERSION) return { ...DEFAULTS };
  const out: UserSettings = { v: SETTINGS_VERSION };
  if (typeof obj.active_channel_id === 'string') {
    out.active_channel_id = obj.active_channel_id;
  } else if (obj.active_channel_id === null) {
    out.active_channel_id = null;
  }
  if (typeof obj.default_broll_model_id === 'string') {
    out.default_broll_model_id = obj.default_broll_model_id;
  } else if (obj.default_broll_model_id === null) {
    out.default_broll_model_id = null;
  }
  if (typeof obj.default_broll_t2v_model_id === 'string') {
    out.default_broll_t2v_model_id = obj.default_broll_t2v_model_id;
  } else if (obj.default_broll_t2v_model_id === null) {
    out.default_broll_t2v_model_id = null;
  }
  if (typeof obj.default_broll_i2v_model_id === 'string') {
    out.default_broll_i2v_model_id = obj.default_broll_i2v_model_id;
  } else if (obj.default_broll_i2v_model_id === null) {
    out.default_broll_i2v_model_id = null;
  }
  if (typeof obj.default_style_preset === 'string') {
    out.default_style_preset = obj.default_style_preset;
  } else if (obj.default_style_preset === null) {
    out.default_style_preset = null;
  }
  if (typeof obj.niche_finder_language === 'string') {
    out.niche_finder_language = obj.niche_finder_language;
  } else if (obj.niche_finder_language === null) {
    out.niche_finder_language = null;
  }
  if (typeof obj.niche_finder_region === 'string') {
    out.niche_finder_region = obj.niche_finder_region;
  } else if (obj.niche_finder_region === null) {
    out.niche_finder_region = null;
  }
  if (obj.gpt_image_2_edit_primary === 'atlas' || obj.gpt_image_2_edit_primary === 'kie') {
    out.gpt_image_2_edit_primary = obj.gpt_image_2_edit_primary;
  } else if (obj.gpt_image_2_edit_primary === null) {
    out.gpt_image_2_edit_primary = null;
  }
  if (typeof obj.shorts_base_t2i_model_id === 'string') {
    out.shorts_base_t2i_model_id = obj.shorts_base_t2i_model_id;
  } else if (obj.shorts_base_t2i_model_id === null) {
    out.shorts_base_t2i_model_id = null;
  }
  if (typeof obj.shorts_qa_composite_threshold === 'number' && Number.isFinite(obj.shorts_qa_composite_threshold)) {
    out.shorts_qa_composite_threshold = obj.shorts_qa_composite_threshold;
  } else if (obj.shorts_qa_composite_threshold === null) {
    out.shorts_qa_composite_threshold = null;
  }
  if (typeof obj.shorts_qa_per_dimension_floor === 'number' && Number.isFinite(obj.shorts_qa_per_dimension_floor)) {
    out.shorts_qa_per_dimension_floor = obj.shorts_qa_per_dimension_floor;
  } else if (obj.shorts_qa_per_dimension_floor === null) {
    out.shorts_qa_per_dimension_floor = null;
  }
  if (typeof obj.shorts_qa_fact_check_claim_cap === 'number' && Number.isFinite(obj.shorts_qa_fact_check_claim_cap)) {
    out.shorts_qa_fact_check_claim_cap = obj.shorts_qa_fact_check_claim_cap;
  } else if (obj.shorts_qa_fact_check_claim_cap === null) {
    out.shorts_qa_fact_check_claim_cap = null;
  }
  if (typeof obj.shorts_qa_fact_check_enabled === 'boolean') {
    out.shorts_qa_fact_check_enabled = obj.shorts_qa_fact_check_enabled;
  } else if (obj.shorts_qa_fact_check_enabled === null) {
    out.shorts_qa_fact_check_enabled = null;
  }
  if (typeof obj.shorts_batch_default_voice_id === 'string') {
    out.shorts_batch_default_voice_id = obj.shorts_batch_default_voice_id;
  } else if (obj.shorts_batch_default_voice_id === null) {
    out.shorts_batch_default_voice_id = null;
  }
  if (typeof obj.shorts_batch_default_youtube_category_id === 'string') {
    out.shorts_batch_default_youtube_category_id = obj.shorts_batch_default_youtube_category_id;
  } else if (obj.shorts_batch_default_youtube_category_id === null) {
    out.shorts_batch_default_youtube_category_id = null;
  }
  if (typeof obj.shorts_batch_default_youtube_language === 'string') {
    out.shorts_batch_default_youtube_language = obj.shorts_batch_default_youtube_language;
  } else if (obj.shorts_batch_default_youtube_language === null) {
    out.shorts_batch_default_youtube_language = null;
  }
  if (typeof obj.shorts_batch_default_made_for_kids === 'boolean') {
    out.shorts_batch_default_made_for_kids = obj.shorts_batch_default_made_for_kids;
  } else if (obj.shorts_batch_default_made_for_kids === null) {
    out.shorts_batch_default_made_for_kids = null;
  }
  if (typeof obj.shorts_batch_default_timezone === 'string') {
    out.shorts_batch_default_timezone = obj.shorts_batch_default_timezone;
  } else if (obj.shorts_batch_default_timezone === null) {
    out.shorts_batch_default_timezone = null;
  }
  if (typeof obj.shorts_batch_default_description_template === 'string') {
    out.shorts_batch_default_description_template = obj.shorts_batch_default_description_template;
  } else if (obj.shorts_batch_default_description_template === null) {
    out.shorts_batch_default_description_template = null;
  }
  if (Array.isArray(obj.tts_favorite_voices)) {
    const cleaned: Array<{ providerId: string; voiceId: string }> = [];
    for (const item of obj.tts_favorite_voices) {
      if (
        item
        && typeof item === 'object'
        && typeof (item as { providerId?: unknown }).providerId === 'string'
        && typeof (item as { voiceId?: unknown }).voiceId === 'string'
      ) {
        cleaned.push({
          providerId: (item as { providerId: string }).providerId,
          voiceId: (item as { voiceId: string }).voiceId,
        });
      }
    }
    out.tts_favorite_voices = cleaned;
  }
  if (typeof obj.shorts_batch_default_age_restricted === 'boolean') {
    out.shorts_batch_default_age_restricted = obj.shorts_batch_default_age_restricted;
  } else if (obj.shorts_batch_default_age_restricted === null) {
    out.shorts_batch_default_age_restricted = null;
  }
  if (typeof obj.shorts_batch_default_paid_promotion === 'boolean') {
    out.shorts_batch_default_paid_promotion = obj.shorts_batch_default_paid_promotion;
  } else if (obj.shorts_batch_default_paid_promotion === null) {
    out.shorts_batch_default_paid_promotion = null;
  }
  if (typeof obj.shorts_batch_default_ai_content_disclosure === 'boolean') {
    out.shorts_batch_default_ai_content_disclosure = obj.shorts_batch_default_ai_content_disclosure;
  } else if (obj.shorts_batch_default_ai_content_disclosure === null) {
    out.shorts_batch_default_ai_content_disclosure = null;
  }
  if (typeof obj.thumbnail_variant_count === 'number' && Number.isFinite(obj.thumbnail_variant_count)) {
    out.thumbnail_variant_count = obj.thumbnail_variant_count;
  } else if (obj.thumbnail_variant_count === null) {
    out.thumbnail_variant_count = null;
  }
  if (typeof obj.thumbnail_default_image_model === 'string') {
    out.thumbnail_default_image_model = obj.thumbnail_default_image_model;
  } else if (obj.thumbnail_default_image_model === null) {
    out.thumbnail_default_image_model = null;
  }
  if (typeof obj.thumbnail_default_style === 'string') {
    out.thumbnail_default_style = obj.thumbnail_default_style;
  } else if (obj.thumbnail_default_style === null) {
    out.thumbnail_default_style = null;
  }
  if (typeof obj.thumbnail_variants_enabled === 'boolean') {
    out.thumbnail_variants_enabled = obj.thumbnail_variants_enabled;
  } else if (obj.thumbnail_variants_enabled === null) {
    out.thumbnail_variants_enabled = null;
  }
  return out;
}

/** Pure serializer; always stamps the current version regardless of input. */
export function serializeUserSettings(settings: UserSettings): string {
  return encrypt(JSON.stringify({ ...settings, v: SETTINGS_VERSION }));
}

/** Read the user's settings. Falls back to defaults on missing / corrupt data. */
export async function getUserSettings(userId: string): Promise<UserSettings> {
  if (!userId) return { ...DEFAULTS };
  const { rows } = await sql<{ encrypted_settings: string | null }>`
    SELECT encrypted_settings FROM collaborators WHERE id = ${userId} LIMIT 1
  `;
  return parseUserSettings(rows[0]?.encrypted_settings ?? null);
}

/** Merge `patch` into the user's settings + persist. Returns the merged shape. */
export async function updateUserSettings(
  userId: string,
  patch: Partial<UserSettings>,
): Promise<UserSettings> {
  if (!userId) throw new Error('userId is required');
  const current = await getUserSettings(userId);
  const merged: UserSettings = { ...current, ...patch, v: SETTINGS_VERSION };
  const encrypted = serializeUserSettings(merged);
  await sql`
    UPDATE collaborators SET encrypted_settings = ${encrypted} WHERE id = ${userId}
  `;
  return merged;
}
