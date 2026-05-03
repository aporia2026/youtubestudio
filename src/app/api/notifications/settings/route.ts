import { NextRequest, NextResponse } from 'next/server';
import { getNotificationSettings, updateNotificationSettings } from '@/lib/notifications-db';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const settings = await getNotificationSettings();
    return NextResponse.json(settings);
  } catch (err) {
    logger.error('GET notification settings error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const fields = await req.json();
    const settings = await updateNotificationSettings(fields);
    return NextResponse.json(settings);
  } catch (err) {
    logger.error('PUT notification settings error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
