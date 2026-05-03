import { NextRequest, NextResponse } from 'next/server';
import { sql, ensureSeriesSchema } from '@/lib/db';
import { countWords, estimateDuration } from '@/lib/utils';
import { logger } from '@/lib/logger';

/** Rough token budget helper — ~4 chars per token is a serviceable approximation
 * for English prose. We care about not blowing the context window; the model's
 * actual tokenizer would pack this slightly tighter. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** GET /api/series/:id/parts
 *  Query params:
 *    - before=N          only parts with part_number < N (used when the client is about to generate Part N)
 *    - maxTokens=15000   soft budget for the whole response
 *  Returns parts ordered asc. The immediately-preceding part keeps its full
 *  text; older parts fall back to the stored series_summary when present, or a
 *  head+tail slice of the full content otherwise. Everything outside the token
 *  budget is silently dropped from the tail (oldest first). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureSeriesSchema();
    const { searchParams } = new URL(req.url);
    const before = searchParams.get('before');
    const maxTokensRaw = searchParams.get('maxTokens');
    const maxTokens = maxTokensRaw ? Math.max(500, Math.min(100000, parseInt(maxTokensRaw))) : 15000;

    const result = before
      ? await sql`
          SELECT id, part_number, content, word_count, series_summary, created_at, ai_model
          FROM scripts
          WHERE series_id = ${id}::uuid AND part_number IS NOT NULL AND part_number < ${parseInt(before)}
          ORDER BY part_number ASC
        `
      : await sql`
          SELECT id, part_number, content, word_count, series_summary, created_at, ai_model
          FROM scripts
          WHERE series_id = ${id}::uuid
          ORDER BY part_number ASC NULLS LAST, created_at ASC
        `;
    const rows = result.rows;
    if (rows.length === 0) return NextResponse.json({ parts: [] });

    // The last row is the "immediately previous" part (keep verbatim).
    // Everything before that gets the summary-or-slice treatment.
    const last = rows[rows.length - 1];
    const older = rows.slice(0, -1);

    const fullText = last.content || '';
    const fullTokens = approxTokens(fullText);

    // Reserve ~60% of budget for the immediately-previous part (it's the most
    // important for continuity), up to 10k tokens.
    const prevBudget = Math.min(Math.floor(maxTokens * 0.6), 10000);
    let prevBody = fullText;
    if (fullTokens > prevBudget) {
      // Truncate from the middle: keep the last (current-to-the-next-part) 70%
      // and the first 30% for setup. A crude chop, but preserves the cliffhanger
      // end which is what the next part actually needs to continue from.
      const maxChars = prevBudget * 4;
      const headChars = Math.floor(maxChars * 0.3);
      const tailChars = maxChars - headChars;
      prevBody = fullText.slice(0, headChars) + '\n\n[… middle truncated …]\n\n' + fullText.slice(-tailChars);
    }

    const olderBudget = maxTokens - approxTokens(prevBody);
    let budgetLeft = olderBudget;
    const olderPayload: Array<{ part_number: number | null; summary: string; source: 'summary' | 'slice' }> = [];

    // Walk older parts from newest-to-oldest so if we overflow, we drop the
    // oldest context first (freshest history is more valuable for continuity).
    for (const row of [...older].reverse()) {
      let summary: string;
      let source: 'summary' | 'slice';
      if (row.series_summary && String(row.series_summary).trim()) {
        summary = String(row.series_summary).trim();
        source = 'summary';
      } else {
        // No summary stored — fall back to a head+tail slice (~400 chars each)
        // so the model at least sees how that part opened and closed.
        const c = String(row.content || '');
        summary = c.length > 900
          ? c.slice(0, 450).trim() + ' … ' + c.slice(-450).trim()
          : c;
        source = 'slice';
      }
      const t = approxTokens(summary);
      if (t > budgetLeft) {
        // Try a tighter clip first
        const maxChars = Math.max(200, budgetLeft * 4);
        if (maxChars < 200) break; // no room at all
        summary = summary.slice(0, maxChars) + ' …';
      }
      olderPayload.unshift({ part_number: row.part_number, summary, source });
      budgetLeft -= approxTokens(summary);
      if (budgetLeft <= 0) break;
    }

    return NextResponse.json({
      parts: [
        ...olderPayload.map(p => ({
          part_number: p.part_number,
          kind: 'summary' as const,
          body: p.summary,
          source: p.source,
        })),
        {
          part_number: last.part_number,
          kind: 'full' as const,
          body: prevBody,
          truncated: prevBody.length < fullText.length,
        },
      ],
      tokenBudget: maxTokens,
    });
  } catch (err) {
    logger.error('GET /api/series/:id/parts error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/** POST /api/series/:id/parts
 *  Body: { content, partNumber, modelId?, summary?, projectId? }
 *  Creates a new script row linked to this series. project_id is optional —
 *  series parts can exist outside of projects. If `summary` isn't provided,
 *  the column stays NULL; the GET handler falls back to a head+tail slice. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await ensureSeriesSchema();
    const { content, partNumber, modelId, summary, projectId } = await req.json();
    if (!content || typeof content !== 'string') {
      return NextResponse.json({ error: 'content required' }, { status: 400 });
    }
    const words = countWords(content);
    const duration = estimateDuration(words);

    // workspace_id is NOT NULL on scripts since migration 0013 — copy it
    // from the parent series (always present for this route).
    const result = await sql`
      INSERT INTO scripts (
        project_id, series_id, part_number, version, content,
        word_count, estimated_duration_seconds, ai_model, series_summary, is_active, workspace_id
      )
      SELECT
        ${projectId || null}::uuid, ${id}::uuid, ${partNumber || null},
        1, ${content}, ${words}, ${duration},
        ${modelId || null}, ${summary || null}, true, s.workspace_id
        FROM series s WHERE s.id = ${id}::uuid
      RETURNING *
    `;
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Series not found' }, { status: 404 });
    }
    await sql`UPDATE series SET updated_at = NOW() WHERE id = ${id}::uuid`;
    return NextResponse.json({ script: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/series/:id/parts error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
