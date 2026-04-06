import { NextResponse } from 'next/server';
import { initDatabase } from '@/lib/db';

export async function POST() {
  try {
    await initDatabase();
    return NextResponse.json({ success: true, message: 'Database initialized successfully' });
  } catch (err: unknown) {
    console.error('DB init error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database initialization failed' },
      { status: 500 }
    );
  }
}
