import { sql } from '@vercel/postgres';

// ---------------------------------------------------------------------------
// Reusable prompt templates.
//
// Lets the user save named presets ("Fast & Engaging Script", "Documentary
// Tone", "Crypto Niche YouTube Description", etc.) keyed by `field_type` so
// the same infrastructure can power AI-generation features across the app:
//   - script  → Script Generator
//   - youtube_description → Description generator
//   - title, thumbnail, idea, ... (future)
//
// Each template carries a body of context the user wants prepended to the
// AI's user-message every time. Combined with the per-call "extra context"
// box, this gives a low-friction way to set up reusable creative directions
// without re-typing them for every video.
// ---------------------------------------------------------------------------

export type TemplateFieldType =
  | 'script'
  | 'youtube_description'
  | 'title'
  | 'thumbnail'
  | 'idea'
  | 'qa'
  | 'production_doc'
  | 'other';

export interface PromptTemplate {
  id: string;
  field_type: TemplateFieldType;
  name: string;
  content: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

let migrated = false;

export async function ensureTemplatesSchema() {
  if (migrated) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        field_type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    try { await sql`CREATE INDEX IF NOT EXISTS idx_prompt_templates_field ON prompt_templates(field_type)`; } catch {}
    migrated = true;
  } catch (err) {
    console.error('ensureTemplatesSchema error:', err);
  }
}

export async function listTemplates(fieldType?: TemplateFieldType): Promise<PromptTemplate[]> {
  await ensureTemplatesSchema();
  const { rows } = fieldType
    ? await sql`SELECT * FROM prompt_templates WHERE field_type = ${fieldType} ORDER BY is_default DESC, name ASC`
    : await sql`SELECT * FROM prompt_templates ORDER BY field_type ASC, is_default DESC, name ASC`;
  return rows as PromptTemplate[];
}

export async function getTemplate(id: string): Promise<PromptTemplate | null> {
  await ensureTemplatesSchema();
  const { rows } = await sql`SELECT * FROM prompt_templates WHERE id = ${id} LIMIT 1`;
  return (rows[0] as PromptTemplate) ?? null;
}

export async function createTemplate(fields: {
  field_type: TemplateFieldType;
  name: string;
  content: string;
  is_default?: boolean;
}): Promise<PromptTemplate> {
  await ensureTemplatesSchema();
  // If marking default, clear other defaults for the same field_type so
  // there's exactly one default per type at any time.
  if (fields.is_default) {
    await sql`UPDATE prompt_templates SET is_default = false WHERE field_type = ${fields.field_type}`;
  }
  const { rows } = await sql`
    INSERT INTO prompt_templates (field_type, name, content, is_default)
    VALUES (${fields.field_type}, ${fields.name}, ${fields.content}, ${fields.is_default ?? false})
    RETURNING *
  `;
  return rows[0] as PromptTemplate;
}

export async function updateTemplate(id: string, fields: Partial<{
  name: string;
  content: string;
  is_default: boolean;
}>): Promise<PromptTemplate | null> {
  await ensureTemplatesSchema();
  if (fields.is_default) {
    // Clear other defaults for the same field_type before promoting this one.
    const existing = await getTemplate(id);
    if (existing) {
      await sql`UPDATE prompt_templates SET is_default = false WHERE field_type = ${existing.field_type} AND id <> ${id}`;
    }
  }
  const { rows } = await sql`
    UPDATE prompt_templates
    SET name = COALESCE(${fields.name ?? null}, name),
        content = COALESCE(${fields.content ?? null}, content),
        is_default = COALESCE(${fields.is_default ?? null}, is_default),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as PromptTemplate) ?? null;
}

export async function deleteTemplate(id: string): Promise<void> {
  await ensureTemplatesSchema();
  await sql`DELETE FROM prompt_templates WHERE id = ${id}`;
}
