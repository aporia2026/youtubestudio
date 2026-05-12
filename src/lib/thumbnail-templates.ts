/**
 * Thumbnail-template preset CRUD library.
 *
 * Server-only. Backs the user's "save reusable thumbnail
 * templates" feature added 2026-05-12 and consumed by the
 * pipeline's generate-thumbnail handler.
 *
 * Stored on `thumbnail_template_presets` (migration 0053):
 *   - name (workspace-unique)
 *   - niche-agnostic — templates aren't tied to a niche
 *   - image_references: array of URL strings the
 *     pipeline-thumbnail handler describes to the model as
 *     "style inspiration cues" (Kie's t2i models don't accept
 *     reference images; i2i is v2)
 *   - context_description: free-text style notes
 *   - include_text + text_overlay_config: when true, the
 *     generator emits a thumbnail with text overlay; the config
 *     can override the text (default = video title) and position
 *
 * Validation lives in the route handlers — this lib is pure CRUD.
 *
 * Workspace tenancy on every query. Cross-workspace ids return
 * null (caller maps to 404, matching Phase 8.1).
 */
import { sql } from '@vercel/postgres';

export interface ThumbnailTemplate {
  id: string;
  workspace_id: string;
  name: string;
  image_references: string[];
  context_description: string | null;
  include_text: boolean;
  text_overlay_config: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThumbnailTemplateInput {
  name: string;
  image_references?: string[];
  context_description?: string | null;
  include_text?: boolean;
  text_overlay_config?: Record<string, unknown> | null;
}

const ROW_SHAPE = `
  id::text AS id,
  workspace_id::text AS workspace_id,
  name,
  COALESCE(image_references_jsonb, '[]'::jsonb) AS image_references,
  context_description,
  include_text,
  text_overlay_config_jsonb AS text_overlay_config,
  created_by::text AS created_by,
  created_at::text AS created_at,
  updated_at::text AS updated_at
`;

export async function listThumbnailTemplates(workspaceId: string): Promise<ThumbnailTemplate[]> {
  const { rows } = await sql.query<ThumbnailTemplate>(
    `
    SELECT ${ROW_SHAPE}
      FROM thumbnail_template_presets
     WHERE workspace_id = $1::uuid
     ORDER BY updated_at DESC
    `,
    [workspaceId],
  );
  return rows.map(normaliseImageReferences);
}

export async function getThumbnailTemplate(id: string, workspaceId: string): Promise<ThumbnailTemplate | null> {
  const { rows } = await sql.query<ThumbnailTemplate>(
    `
    SELECT ${ROW_SHAPE}
      FROM thumbnail_template_presets
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    `,
    [id, workspaceId],
  );
  if (rows.length === 0) return null;
  return normaliseImageReferences(rows[0]);
}

export async function createThumbnailTemplate(args: {
  workspaceId: string;
  createdBy: string | null;
  input: ThumbnailTemplateInput;
}): Promise<{ id: string }> {
  const { workspaceId, createdBy, input } = args;
  const { rows } = await sql.query<{ id: string }>(
    `
    INSERT INTO thumbnail_template_presets
      (workspace_id, name, image_references_jsonb, context_description,
       include_text, text_overlay_config_jsonb, created_by)
    VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6::jsonb, $7::uuid)
    RETURNING id::text AS id
    `,
    [
      workspaceId,
      input.name,
      JSON.stringify(input.image_references ?? []),
      input.context_description ?? null,
      input.include_text ?? false,
      input.text_overlay_config ? JSON.stringify(input.text_overlay_config) : null,
      createdBy,
    ],
  );
  return rows[0];
}

export async function updateThumbnailTemplate(args: {
  id: string;
  workspaceId: string;
  patch: ThumbnailTemplateInput;
}): Promise<ThumbnailTemplate | null> {
  const { id, workspaceId, patch } = args;
  // COALESCE the patch fields so undefined skips. JSONB fields
  // round-trip through JSON.stringify; explicit null clears them
  // (the route-layer normaliser controls that).
  const { rows } = await sql.query<ThumbnailTemplate>(
    `
    UPDATE thumbnail_template_presets
       SET name = COALESCE($3, name),
           image_references_jsonb = COALESCE($4::jsonb, image_references_jsonb),
           context_description = COALESCE($5, context_description),
           include_text = COALESCE($6, include_text),
           text_overlay_config_jsonb = COALESCE($7::jsonb, text_overlay_config_jsonb),
           updated_at = NOW()
     WHERE id = $1::uuid AND workspace_id = $2::uuid
    RETURNING ${ROW_SHAPE}
    `,
    [
      id,
      workspaceId,
      patch.name ?? null,
      patch.image_references !== undefined ? JSON.stringify(patch.image_references) : null,
      patch.context_description !== undefined ? patch.context_description : null,
      patch.include_text !== undefined ? patch.include_text : null,
      patch.text_overlay_config !== undefined && patch.text_overlay_config !== null
        ? JSON.stringify(patch.text_overlay_config)
        : null,
    ],
  );
  if (rows.length === 0) return null;
  return normaliseImageReferences(rows[0]);
}

export async function deleteThumbnailTemplate(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await sql.query(
    `DELETE FROM thumbnail_template_presets WHERE id = $1::uuid AND workspace_id = $2::uuid`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Pure: validate caller input before it hits the DB. Exported for
 * unit tests + reused by both POST and PATCH routes.
 *
 * Returns `{ ok: false, reason }` on rejection so the route can
 * map to a 400 with a useful message.
 */
export function validateThumbnailTemplateInput(
  input: unknown,
  opts: { allowPartial?: boolean } = {},
): { ok: true; value: ThumbnailTemplateInput } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'Body must be a JSON object.' };
  }
  const b = input as Record<string, unknown>;
  const allowPartial = opts.allowPartial === true;

  const out: ThumbnailTemplateInput = { name: '' };

  if (typeof b.name === 'string') {
    const trimmed = b.name.trim();
    if (!trimmed) return { ok: false, reason: 'name must be non-empty.' };
    if (trimmed.length > 200) return { ok: false, reason: 'name max 200 chars.' };
    out.name = trimmed;
  } else if (!allowPartial) {
    return { ok: false, reason: 'name is required.' };
  }

  if (b.image_references !== undefined) {
    if (!Array.isArray(b.image_references)) {
      return { ok: false, reason: 'image_references must be an array of URL strings.' };
    }
    if (b.image_references.length > 10) {
      return { ok: false, reason: 'image_references: at most 10 entries.' };
    }
    const urls: string[] = [];
    for (const u of b.image_references) {
      if (typeof u !== 'string') return { ok: false, reason: 'image_references must be strings.' };
      const trimmed = u.trim();
      if (!trimmed) continue;
      if (trimmed.length > 2000) return { ok: false, reason: 'image_references entries max 2000 chars.' };
      urls.push(trimmed);
    }
    out.image_references = urls;
  }

  if (b.context_description !== undefined) {
    if (b.context_description !== null && typeof b.context_description !== 'string') {
      return { ok: false, reason: 'context_description must be a string or null.' };
    }
    const s = b.context_description == null ? null : (b.context_description as string).trim();
    if (s && s.length > 5000) return { ok: false, reason: 'context_description max 5000 chars.' };
    out.context_description = s;
  }

  if (b.include_text !== undefined) {
    if (typeof b.include_text !== 'boolean') return { ok: false, reason: 'include_text must be boolean.' };
    out.include_text = b.include_text;
  }

  if (b.text_overlay_config !== undefined) {
    if (b.text_overlay_config !== null) {
      if (typeof b.text_overlay_config !== 'object' || Array.isArray(b.text_overlay_config)) {
        return { ok: false, reason: 'text_overlay_config must be an object or null.' };
      }
      const cfg = b.text_overlay_config as Record<string, unknown>;
      const allowedKeys = ['text', 'position', 'font_size', 'color'];
      for (const k of Object.keys(cfg)) {
        if (!allowedKeys.includes(k)) {
          return { ok: false, reason: `text_overlay_config: unknown key "${k}".` };
        }
      }
      out.text_overlay_config = cfg;
    } else {
      out.text_overlay_config = null;
    }
  }

  return { ok: true, value: out };
}

function normaliseImageReferences(row: ThumbnailTemplate): ThumbnailTemplate {
  // JSONB comes back as `unknown` — coerce to string[] for callers.
  const refs = row.image_references as unknown;
  if (Array.isArray(refs)) {
    row.image_references = refs.filter((x): x is string => typeof x === 'string');
  } else {
    row.image_references = [];
  }
  return row;
}
