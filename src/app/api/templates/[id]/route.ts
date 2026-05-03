import { NextRequest, NextResponse } from 'next/server';
import { getTemplate, updateTemplate, deleteTemplate } from '@/lib/templates-db';
import { logger } from '@/lib/logger';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const template = await getTemplate(id);
    if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ template });
  } catch (err) {
    logger.error('GET template error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const fields: { name?: string; content?: string; is_default?: boolean } = {};
    if (typeof body.name === 'string') fields.name = body.name.trim();
    if (typeof body.content === 'string') fields.content = body.content.trim();
    if (typeof body.is_default === 'boolean') fields.is_default = body.is_default;
    const template = await updateTemplate(id, fields);
    if (!template) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ template });
  } catch (err) {
    logger.error('PATCH template error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE template error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  }
}
