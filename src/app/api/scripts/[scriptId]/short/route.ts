import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import { extractAndSaveShort } from '@/lib/shorts';

export const maxDuration = 60;

interface ScriptForExtract {
  id: string;
  project_id: string | null;
  content: string;
  niche: string | null;
}

/**
 * POST /api/scripts/[scriptId]/short
 *
 * Body: { tone?: string, targetSeconds?: number, modelId?: string }
 *
 * Reads the long script, runs the LLM extractor, persists a `shorts` row,
 * returns the new id + the extracted beats so the UI can render the result
 * without a follow-up GET.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ scriptId: string }> }) => {
    const { scriptId } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      // Body is optional — empty body is fine, defaults take over.
      body = {};
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const tone = typeof b.tone === 'string' && b.tone.trim() ? b.tone.trim() : undefined;
    const targetSeconds = typeof b.targetSeconds === 'number' ? b.targetSeconds : undefined;
    const modelId = typeof b.modelId === 'string' ? b.modelId : undefined;

    // Workspace-scope: pull script + project niche, verify project belongs
    // to the workspace.
    const { rows } = await sql<ScriptForExtract>`
      SELECT s.id, s.project_id, s.content, p.niche
        FROM scripts s
        JOIN projects p ON p.id = s.project_id
       WHERE s.id = ${scriptId}::uuid
         AND p.workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    const script = rows[0];
    if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    if (!script.content || script.content.trim().length < 200) {
      return NextResponse.json(
        { error: 'Script body is empty or too short to extract a Short from' },
        { status: 400 },
      );
    }

    try {
      const result = await extractAndSaveShort({
        workspaceId: session.ws,
        projectId: script.project_id,
        sourceScriptId: script.id,
        longScript: script.content,
        niche: script.niche || 'General',
        tone,
        targetSeconds,
        modelId,
      });
      return NextResponse.json({ id: result.id, short: result.short }, { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  },
);
