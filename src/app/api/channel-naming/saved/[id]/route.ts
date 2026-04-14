import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureChannelNamesSchema } from '@/lib/db';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureChannelNamesSchema();
    await sql`DELETE FROM saved_channel_names WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
