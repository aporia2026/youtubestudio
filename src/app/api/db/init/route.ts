import { NextResponse } from 'next/server';
import { initDatabase } from '@/lib/db';
import { logger } from '@/lib/logger';

export async function POST() {
  try {
    await initDatabase();
    return NextResponse.json({ success: true, message: 'Database initialized successfully' });
  } catch (err: unknown) {
    logger.error('DB init error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Database initialization failed' },
      { status: 500 }
    );
  }
}
