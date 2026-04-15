import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';

// Bulk-insert a batch of generated ideas so they are persisted immediately
// without requiring the user to manually click "Save" on each one.
export async function POST(req: NextRequest) {
  try {
    const { ideas, niche } = await req.json();
    if (!Array.isArray(ideas) || ideas.length === 0) {
      return NextResponse.json({ error: 'ideas array is required' }, { status: 400 });
    }

    const inserted: unknown[] = [];
    for (const idea of ideas) {
      try {
        const result = await sql`
          INSERT INTO video_ideas (
            niche, title, hook, description, target_audience,
            estimated_views_potential, trend_relevance, difficulty,
            tags, is_saved
          )
          VALUES (
            ${niche || idea.niche || ''},
            ${idea.title || ''},
            ${idea.hook || ''},
            ${idea.description || idea.why_it_will_perform || ''},
            ${idea.target_audience_segment || ''},
            ${idea.estimated_views_potential || ''},
            ${idea.trend_status || ''},
            ${idea.estimated_difficulty || ''},
            ${JSON.stringify(idea.tags || [])},
            true
          )
          RETURNING id, title
        `;
        inserted.push(result.rows[0]);
      } catch {
        // Skip duplicates or bad rows — don't fail the whole batch
      }
    }

    return NextResponse.json({ inserted: inserted.length, ideas: inserted });
  } catch (err) {
    console.error('POST /api/ideas/batch error:', err);
    return NextResponse.json({ error: 'Batch save failed' }, { status: 500 });
  }
}
