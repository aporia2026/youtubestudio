import { NextRequest, NextResponse } from 'next/server';
import { listTemplates, createTemplate, type TemplateFieldType } from '@/lib/templates-db';

const VALID_TYPES: TemplateFieldType[] = ['script', 'youtube_description', 'title', 'thumbnail', 'idea', 'qa', 'production_doc', 'other'];

export async function GET(req: NextRequest) {
  try {
    const fieldTypeParam = req.nextUrl.searchParams.get('field_type');
    const fieldType = fieldTypeParam && VALID_TYPES.includes(fieldTypeParam as TemplateFieldType)
      ? (fieldTypeParam as TemplateFieldType)
      : undefined;
    const templates = await listTemplates(fieldType);
    return NextResponse.json({ templates });
  } catch (err) {
    console.error('GET templates error:', err);
    return NextResponse.json({ error: 'Failed to list templates' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { field_type, name, content, is_default } = body;
    if (!field_type || !name || !content) {
      return NextResponse.json({ error: 'field_type, name, and content are required' }, { status: 400 });
    }
    if (!VALID_TYPES.includes(field_type)) {
      return NextResponse.json({ error: `Invalid field_type. Must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 });
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return NextResponse.json({ error: 'content must be a non-empty string' }, { status: 400 });
    }
    const template = await createTemplate({
      field_type,
      name: name.trim(),
      content: content.trim(),
      is_default: !!is_default,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    console.error('POST template error:', err);
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
}
