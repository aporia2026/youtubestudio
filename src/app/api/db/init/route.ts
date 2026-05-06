import { NextResponse } from 'next/server';
import { initDatabase } from '@/lib/db';
import { domainErrorResponse } from '@/lib/route-helpers';

export async function POST() {
  try {
    await initDatabase();
    return NextResponse.json({ success: true, message: 'Database initialized successfully' });
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'db: init',
      fallbackMessage: 'Database initialization failed — please try again.',
    });
  }
}
