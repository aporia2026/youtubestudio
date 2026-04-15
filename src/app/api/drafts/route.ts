import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureDraftsSchema } from '@/lib/db';

export async function GET() {
  try {
    await ensureDraftsSchema();
    const result = await sql`
      SELECT id, title, niche, step, data, updated_at, created_at
      FROM workflow_drafts
      ORDER BY updated_at DESC
      LIMIT 50
    `;
    // Merge the stored `data` blob back into a flat WorkflowDraft shape
    const drafts = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      niche: row.niche,
      step: row.step,
      updatedAt: new Date(row.updated_at).getTime(),
      ...row.data,
    }));
    return NextResponse.json({ drafts });
  } catch (err) {
    console.error('GET /api/drafts error:', err);
    return NextResponse.json({ drafts: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureDraftsSchema();
    const draft = await req.json();
    if (!draft.id || !draft.title) {
      return NextResponse.json({ error: 'id and title are required' }, { status: 400 });
    }

    // Store everything except the top-level indexed columns inside `data`
    const { id, title, niche, step, updatedAt, ...rest } = draft;
    const data = rest;

    await sql`
      INSERT INTO workflow_drafts (id, title, niche, step, data, updated_at)
      VALUES (
        ${id},
        ${title || ''},
        ${niche || ''},
        ${step || 'idea'},
        ${JSON.stringify(data)},
        ${new Date(updatedAt || Date.now()).toISOString()}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        niche = EXCLUDED.niche,
        step = EXCLUDED.step,
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at
    `;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('POST /api/drafts error:', err);
    return NextResponse.json({ error: 'Failed to save draft' }, { status: 500 });
  }
}
