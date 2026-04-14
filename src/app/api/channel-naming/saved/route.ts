import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureChannelNamesSchema } from '@/lib/db';

export async function GET() {
  try {
    await ensureChannelNamesSchema();
    const res = await sql`SELECT * FROM saved_channel_names ORDER BY saved_at DESC LIMIT 200`;
    const rows = res.rows.map(r => ({
      ...r,
      seo_score: Number(r.seo_score) || 0,
      brand_score: Number(r.brand_score) || 0,
      memorability_score: Number(r.memorability_score) || 0,
      combined_score: Number(r.combined_score) || 0,
    }));
    return NextResponse.json({ saved: rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureChannelNamesSchema();
    let body: {
      name?: string; handle?: string; niche?: string; freeText?: string;
      seoScore?: number; brandScore?: number; memorabilityScore?: number; combinedScore?: number;
      reasoning?: string; keywordCoverage?: string[]; risks?: string;
      wasAvailable?: boolean; aiModel?: string; notes?: string;
    };
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!body.name || !body.handle) return NextResponse.json({ error: 'name and handle required' }, { status: 400 });

    const result = await sql`
      INSERT INTO saved_channel_names (
        name, handle, niche, free_text,
        seo_score, brand_score, memorability_score, combined_score,
        reasoning, keyword_coverage, risks, was_available, ai_model, notes
      ) VALUES (
        ${body.name}, ${body.handle}, ${body.niche || ''}, ${body.freeText || ''},
        ${body.seoScore ?? 0}, ${body.brandScore ?? 0}, ${body.memorabilityScore ?? 0}, ${body.combinedScore ?? 0},
        ${body.reasoning || ''}, ${JSON.stringify(body.keywordCoverage || [])}, ${body.risks || ''},
        ${body.wasAvailable ?? null}, ${body.aiModel || ''}, ${body.notes || ''}
      )
      RETURNING *
    `;
    return NextResponse.json({ saved: result.rows[0] });
  } catch (err) {
    console.error('Save name error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
