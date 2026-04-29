import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSeriesSchema } from '@/lib/db';

// Bulk-insert a batch of generated ideas so they are persisted immediately
// without requiring the user to manually click "Save" on each one.
export async function POST(req: NextRequest) {
  try {
    const { ideas, niche, seriesId, partNumber } = await req.json();
    if (!Array.isArray(ideas) || ideas.length === 0) {
      return NextResponse.json({ error: 'ideas array is required' }, { status: 400 });
    }

    // Only ensure the series migration has run if this batch is actually
    // linked to a series — cheap, but no point running it on every save.
    if (seriesId) await ensureSeriesSchema();

    const inserted: unknown[] = [];
    for (let i = 0; i < ideas.length; i++) {
      const idea = ideas[i];
      // Each idea gets a sequential part number starting from the caller's
      // `partNumber` (so a single batch for "Parts 5-10" gets tagged 5,6,7…).
      // If the caller didn't pass one, each idea inherits null.
      const perIdeaPart = seriesId && typeof partNumber === 'number' ? partNumber + i : null;
      try {
        const result = await sql`
          INSERT INTO video_ideas (
            niche, title, hook, description, target_audience,
            estimated_views_potential, trend_relevance, difficulty,
            tags, is_saved, series_id, part_number
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
            true,
            ${seriesId || null}::uuid,
            ${perIdeaPart}
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
