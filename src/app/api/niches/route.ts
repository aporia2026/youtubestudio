import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  try {
    const result = await sql`SELECT * FROM niches WHERE is_active = true ORDER BY name`;
    return NextResponse.json({ niches: result.rows });
  } catch {
    // Return defaults if DB not yet initialized
    return NextResponse.json({
      niches: [
        { id: '1', name: 'Cybersecurity & Antivirus', description: '', keywords: [] },
        { id: '2', name: 'General Tech', description: '', keywords: [] },
      ],
    });
  }
}

export async function POST(req: NextRequest) {
  const { name, description, keywords } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  try {
    const result = await sql`
      INSERT INTO niches (name, description, keywords)
      VALUES (${name}, ${description || ''}, ${JSON.stringify(keywords || [])})
      RETURNING *
    `;
    return NextResponse.json({ niche: result.rows[0] });
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
