import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { domainErrorResponse } from '@/lib/route-helpers';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await sql`DELETE FROM video_ideas WHERE id = ${id}`;
    return NextResponse.json({ success: true });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'ideas: delete',
      fallbackMessage: 'Could not delete idea — please try again.',
    });
  }
}
