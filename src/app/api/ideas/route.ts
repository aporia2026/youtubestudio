import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  try {
    const result = await sql`SELECT * FROM video_ideas WHERE is_saved = true ORDER BY created_at DESC`;
    return NextResponse.json({ ideas: result.rows });
  } catch {
    return NextResponse.json({ ideas: [] });
  }
}

export async function POST(req: NextRequest) {
  const idea = await req.json();
  try {
    const result = await sql`
      INSERT INTO video_ideas (
        niche, title, hook, description, target_audience,
        estimated_views_potential, trend_relevance, difficulty,
        tags, is_saved
      )
      VALUES (
        ${idea.niche || ''},
        ${idea.title},
        ${idea.hook || ''},
        ${idea.description || idea.why_it_will_perform || ''},
        ${idea.target_audience_segment || ''},
        ${idea.estimated_views_potential || ''},
        ${idea.trend_status || ''},
        ${idea.estimated_difficulty || ''},
        ${JSON.stringify(idea.tags || [])},
        true
      )
      RETURNING *
    `;
    return NextResponse.json({ idea: result.rows[0] });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
