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

/** Clamp a score to fit NUMERIC(4,1) (max 999.9). Coerces strings/garbage to 0. */
function clampScore(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(999.9, Math.round(n * 10) / 10));
}

/** YouTube handle: 3–30 chars, lowercase, [a-z 0-9 _ - .]. */
function normalizeHandle(h: string): string | null {
  const handle = h.replace(/^@/, '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,30}$/.test(handle)) return null;
  return handle;
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
    const name = (body.name || '').trim().slice(0, 200);
    const rawHandle = (body.handle || '').trim();
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const handle = normalizeHandle(rawHandle);
    if (!handle) return NextResponse.json({ error: 'Invalid handle (3-30 chars, a-z 0-9 _ - .)' }, { status: 400 });

    const seo = clampScore(body.seoScore);
    const brand = clampScore(body.brandScore);
    const memo = clampScore(body.memorabilityScore);
    const combined = clampScore(body.combinedScore);
    const niche = (body.niche || '').slice(0, 500);
    const freeText = (body.freeText || '').slice(0, 5000);
    const reasoning = (body.reasoning || '').slice(0, 2000);
    const risks = (body.risks || '').slice(0, 1000);
    const aiModel = (body.aiModel || '').slice(0, 100);
    const notes = (body.notes || '').slice(0, 2000);
    const wasAvailable = typeof body.wasAvailable === 'boolean' ? body.wasAvailable : null;
    const keywordCoverage = Array.isArray(body.keywordCoverage)
      ? body.keywordCoverage.filter(k => typeof k === 'string').slice(0, 20)
      : [];

    // Upsert on handle — if same handle is saved again, update with latest data.
    // ON CONFLICT requires the UNIQUE constraint added in ensureChannelNamesSchema.
    const result = await sql`
      INSERT INTO saved_channel_names (
        name, handle, niche, free_text,
        seo_score, brand_score, memorability_score, combined_score,
        reasoning, keyword_coverage, risks, was_available, ai_model, notes
      ) VALUES (
        ${name}, ${handle}, ${niche}, ${freeText},
        ${seo}, ${brand}, ${memo}, ${combined},
        ${reasoning}, ${JSON.stringify(keywordCoverage)}, ${risks}, ${wasAvailable}, ${aiModel}, ${notes}
      )
      ON CONFLICT (handle) DO UPDATE SET
        name = EXCLUDED.name,
        niche = EXCLUDED.niche,
        free_text = EXCLUDED.free_text,
        seo_score = EXCLUDED.seo_score,
        brand_score = EXCLUDED.brand_score,
        memorability_score = EXCLUDED.memorability_score,
        combined_score = EXCLUDED.combined_score,
        reasoning = EXCLUDED.reasoning,
        keyword_coverage = EXCLUDED.keyword_coverage,
        risks = EXCLUDED.risks,
        was_available = EXCLUDED.was_available,
        ai_model = EXCLUDED.ai_model
      RETURNING *, (xmax = 0) AS is_new
    `;
    const row = result.rows[0];
    return NextResponse.json({ saved: row, created: row.is_new === true });
  } catch (err) {
    console.error('Save name error:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
