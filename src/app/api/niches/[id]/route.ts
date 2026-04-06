import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { is_active, name, description, keywords } = await req.json();
  try {
    await sql`
      UPDATE niches SET
        is_active = COALESCE(${is_active}, is_active),
        name = COALESCE(${name}, name),
        description = COALESCE(${description}, description),
        keywords = COALESCE(${JSON.stringify(keywords)}, keywords)
      WHERE id = ${id}
    `;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await sql`DELETE FROM niches WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
