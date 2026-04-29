import { NextRequest, NextResponse } from 'next/server';
import { updateTake } from '@/lib/narrator-db';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ takeId: string }> }) {
  try {
    const { takeId } = await params;
    const fields = await req.json();
    const take = await updateTake(takeId, fields);
    if (!take) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(take);
  } catch (err) {
    console.error('PUT take error:', err);
    return NextResponse.json({ error: 'Failed to update take' }, { status: 500 });
  }
}
