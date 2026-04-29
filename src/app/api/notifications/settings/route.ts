import { NextRequest, NextResponse } from 'next/server';
import { getNotificationSettings, updateNotificationSettings } from '@/lib/notifications-db';

export async function GET() {
  try {
    const settings = await getNotificationSettings();
    return NextResponse.json(settings);
  } catch (err) {
    console.error('GET notification settings error:', err);
    return NextResponse.json({ error: 'Failed to load settings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const fields = await req.json();
    const settings = await updateNotificationSettings(fields);
    return NextResponse.json(settings);
  } catch (err) {
    console.error('PUT notification settings error:', err);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
