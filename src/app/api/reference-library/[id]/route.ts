import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { deleteCachedReference, ensureReferenceCacheSchema, updateReferenceMetadata } from '@/lib/reference-cache-db';
import { logger } from '@/lib/logger';

/**
 * GET — full record including the analysis JSON. Used when the user
 * picks an item from the library and wants the same payload the live
 * analyze route would have returned.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureReferenceCacheSchema();
    const { id } = await params;
    const { rows } = await sql`SELECT * FROM reference_video_cache WHERE id = ${id} LIMIT 1`;
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ reference: rows[0] });
  } catch (err) {
    logger.error('GET reference error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const fields: { notes?: string; user_tags?: string[] } = {};
    if (typeof body.notes === 'string') fields.notes = body.notes;
    if (Array.isArray(body.user_tags)) fields.user_tags = body.user_tags.filter((t: unknown) => typeof t === 'string');
    const updated = await updateReferenceMetadata(id, fields);
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ reference: updated });
  } catch (err) {
    logger.error('PATCH reference error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteCachedReference(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error('DELETE reference error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
