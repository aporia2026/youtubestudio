/**
 * GET  /api/production-doc/styles  — list every style available to the
 *                                    current workspace + caller. Mixes
 *                                    built-ins, workspace-wide saved
 *                                    styles, and the caller's own
 *                                    private styles. Drafts excluded.
 *
 * POST /api/production-doc/styles  — create a new saved style.
 *
 *   Two creation modes:
 *
 *   (1) Draft (v2 editor flow). Body: { draft: true, name?,
 *       style_prompt?, preferred_cloud_model? }. Creates an owner-private
 *       draft row that the editor immediately starts uploading refs
 *       against. ai_image_suffix defaults to '' on a draft and is
 *       backfilled from style_prompt on save (PATCH with save:true).
 *
 *   (2) Workspace-wide (v1 legacy flow). Body: { name, ai_image_suffix,
 *       … }. Creates a saved style visible to the whole workspace,
 *       owner_id NULL. Kept for back-compat with existing surfaces and
 *       admin / migration scripts that bulk-import styles.
 *
 *   Returns 409 when the (workspace_id, name) pair is already taken.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { listAllStyles, getBuiltInStyle, type SavedStyleRow } from '@/lib/production-doc-styles';
import { I2I_MODEL_VALUES } from '@/lib/image-models-i2i';

const MAX_NAME_LEN = 80;
const MAX_DESCRIPTION_LEN = 240;
const MAX_SUFFIX_LEN = 1200;
const MAX_MIXING_RULES_LEN = 8000;
const MAX_STYLE_PROMPT_LEN = 2000;

/**
 * Cloud i2i model spec values the editor is allowed to pin as a
 * style's `preferred_cloud_model`. Derived from IMAGE_MODELS so the
 * picker UI and the validator share one source of truth — adding a
 * new i2i entry to image-models.ts surfaces it here automatically.
 */
const ALLOWED_PREFERRED_CLOUD_MODELS = new Set<string>(I2I_MODEL_VALUES);

interface CreateStyleBody {
  name?: unknown;
  description?: unknown;
  ai_image_suffix?: unknown;
  mixing_rules?: unknown;
  allow_overlay_stock?: unknown;
  based_on_built_in?: unknown;
  // v2 fields
  draft?: unknown;
  style_prompt?: unknown;
  preferred_cloud_model?: unknown;
}

export const GET = apiRoute.authed(async (session) => {
  // Pass the caller's uid so the response includes their private
  // styles alongside workspace-wide entries; drafts are filtered out
  // inside listAllStyles().
  const styles = await listAllStyles(session.ws, session.uid);
  return NextResponse.json({ styles });
});

export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: CreateStyleBody;
  try {
    body = (await req.json()) as CreateStyleBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Mode dispatch: draft vs workspace-wide. The shape of the validation
  // call differs — drafts allow empty ai_image_suffix and a missing
  // name (the editor patches both in later). Workspace-wide creates
  // require both, matching the v1 contract.
  const asDraft = body.draft === true;

  const validation = validateStyleInput(body, {
    requireName: !asDraft,
    requireSuffix: !asDraft,
  });
  if ('error' in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const {
    name,
    description,
    ai_image_suffix,
    mixing_rules,
    allow_overlay_stock,
    based_on_built_in,
    style_prompt,
    preferred_cloud_model,
  } = validation;

  // owner_id derivation. Never trust the client — the only path to an
  // owner-private row is the draft flow, which we always tie to the
  // current session. v1 workspace-wide creates set owner_id NULL.
  const ownerId: string | null = asDraft ? session.uid : null;

  // For drafts, give the row a placeholder name so it shows up in the
  // editor list as "Untitled style" until the user picks a real one.
  // For workspace-wide creates, validation already required a name.
  const insertName = name || (asDraft ? 'Untitled style' : '');

  try {
    const { rows } = await sql<SavedStyleRow>`
      INSERT INTO production_doc_styles (
        workspace_id, name, description,
        ai_image_suffix, mixing_rules, allow_overlay_stock,
        based_on_built_in, created_by,
        owner_id, draft, style_prompt, preferred_cloud_model
      ) VALUES (
        ${session.ws}, ${insertName}, ${description},
        ${ai_image_suffix}, ${mixing_rules}, ${allow_overlay_stock},
        ${based_on_built_in}, ${session.uid},
        ${ownerId}, ${asDraft}, ${style_prompt}, ${preferred_cloud_model}
      )
      RETURNING id, workspace_id, name, description,
                ai_image_suffix, mixing_rules, allow_overlay_stock,
                based_on_built_in, created_by, created_at, updated_at,
                owner_id, draft, approved_at, version,
                style_prompt, preferred_cloud_model
    `;
    return NextResponse.json({ style: rows[0] }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return NextResponse.json(
        { error: `A style named "${insertName}" already exists in this workspace` },
        { status: 409 },
      );
    }
    throw err;
  }
});

interface ValidatedStyleInput {
  name: string;
  description: string | null;
  ai_image_suffix: string;
  mixing_rules: string | null;
  allow_overlay_stock: boolean;
  based_on_built_in: string | null;
  // v2 fields
  style_prompt: string | null;
  preferred_cloud_model: string | null;
}

/**
 * Coerce + length-check the JSON body.
 *
 * `requireName` / `requireSuffix` flag the two fields that must be
 * present on POST workspace-wide creates (v1 contract) but are
 * optional on draft creates and on PATCH — the PATCH route only
 * writes columns the caller actually included via `'name' in body` /
 * `'ai_image_suffix' in body` checks.
 *
 * Non-string types for any string field (e.g. an accidental number
 * or object) are rejected outright so a malformed client can't
 * silently overwrite a column with NULL by sending a value the
 * validator coerces to "".
 */
export function validateStyleInput(
  body: CreateStyleBody,
  opts: { requireName: boolean; requireSuffix: boolean },
): ValidatedStyleInput | { error: string } {
  // name
  let name = '';
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { error: 'name must be a string' };
    name = body.name.trim();
    if (name.length > MAX_NAME_LEN) return { error: `name must be ≤ ${MAX_NAME_LEN} chars` };
  }
  if (opts.requireName && !name) return { error: 'name is required' };

  // description
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') return { error: 'description must be a string' };
    description = body.description.trim().length > 0 ? body.description.trim().slice(0, MAX_DESCRIPTION_LEN) : null;
  }

  // ai_image_suffix
  let suffix = '';
  if (body.ai_image_suffix !== undefined) {
    if (typeof body.ai_image_suffix !== 'string') return { error: 'ai_image_suffix must be a string' };
    suffix = body.ai_image_suffix.trim();
    if (suffix.length > MAX_SUFFIX_LEN) {
      return { error: `ai_image_suffix must be ≤ ${MAX_SUFFIX_LEN} chars` };
    }
  }
  if (opts.requireSuffix && !suffix) return { error: 'ai_image_suffix is required' };

  // mixing_rules
  let mixing_rules: string | null = null;
  if (body.mixing_rules !== undefined && body.mixing_rules !== null) {
    if (typeof body.mixing_rules !== 'string') return { error: 'mixing_rules must be a string' };
    mixing_rules = body.mixing_rules.trim().length > 0 ? body.mixing_rules.trim().slice(0, MAX_MIXING_RULES_LEN) : null;
  }

  // allow_overlay_stock — strict boolean only. Silently coerce
  // undefined/null/missing to false; reject anything else so a typo
  // doesn't quietly enable overlays.
  let allow_overlay_stock = false;
  if (body.allow_overlay_stock === true) allow_overlay_stock = true;
  else if (body.allow_overlay_stock === false || body.allow_overlay_stock == null) allow_overlay_stock = false;
  else return { error: 'allow_overlay_stock must be a boolean' };

  // based_on_built_in — when set, must match a real built-in slug.
  // Previously accepted any string ≤64 chars; this let arbitrary
  // values land in the column with no integrity guarantee. The
  // built-in registry is the source of truth.
  let based_on_built_in: string | null = null;
  if (body.based_on_built_in !== undefined && body.based_on_built_in !== null) {
    if (typeof body.based_on_built_in !== 'string') return { error: 'based_on_built_in must be a string' };
    const trimmed = body.based_on_built_in.trim();
    if (trimmed.length > 0) {
      if (!getBuiltInStyle(trimmed)) {
        return { error: `based_on_built_in "${trimmed}" is not a known built-in style id` };
      }
      based_on_built_in = trimmed.slice(0, 64);
    }
  }

  // style_prompt — v2. Plain-English descriptor the user writes in the
  // editor. Empty string trims to null so the column reflects "not set".
  let style_prompt: string | null = null;
  if (body.style_prompt !== undefined && body.style_prompt !== null) {
    if (typeof body.style_prompt !== 'string') return { error: 'style_prompt must be a string' };
    const trimmed = body.style_prompt.trim();
    if (trimmed.length > MAX_STYLE_PROMPT_LEN) {
      return { error: `style_prompt must be ≤ ${MAX_STYLE_PROMPT_LEN} chars` };
    }
    style_prompt = trimmed.length > 0 ? trimmed : null;
  }

  // preferred_cloud_model — v2. Must be one of the known i2i model
  // spec values. The editor only surfaces those four; anything else
  // is a malformed client.
  let preferred_cloud_model: string | null = null;
  if (body.preferred_cloud_model !== undefined && body.preferred_cloud_model !== null) {
    if (typeof body.preferred_cloud_model !== 'string') {
      return { error: 'preferred_cloud_model must be a string' };
    }
    const trimmed = body.preferred_cloud_model.trim();
    if (trimmed.length === 0) {
      preferred_cloud_model = null;
    } else if (!ALLOWED_PREFERRED_CLOUD_MODELS.has(trimmed)) {
      return {
        error: `preferred_cloud_model "${trimmed}" is not a known cloud i2i model`,
      };
    } else {
      preferred_cloud_model = trimmed;
    }
  }

  return {
    name,
    description,
    ai_image_suffix: suffix,
    mixing_rules,
    allow_overlay_stock,
    based_on_built_in,
    style_prompt,
    preferred_cloud_model,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}
