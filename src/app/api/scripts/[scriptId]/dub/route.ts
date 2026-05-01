import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';
import { apiRoute } from '@/lib/route-helpers';
import {
  dubScript,
  isSupportedLanguage,
  type SupportedLanguage,
} from '@/lib/dubbing';

export const maxDuration = 60;

interface ScriptRow {
  id: string;
  project_id: string | null;
  content: string;
}

/**
 * POST /api/scripts/[scriptId]/dub
 *
 * Body: { targetLanguage: SupportedLanguage, voiceId: string,
 *         translationModelId?: string }
 *
 * Single-language by design — multi-language requests fan out client-side
 * so each call comfortably fits the 60s function budget. Returns when the
 * dub reaches `ready` or `failed`. The client uses GET .../dubs to poll
 * progress when running multiple in parallel.
 */
export const POST = apiRoute.authed(
  async (session, req: NextRequest, ctx: { params: Promise<{ scriptId: string }> }) => {
    const { scriptId } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const b = (body ?? {}) as Record<string, unknown>;

    const targetLanguageRaw = typeof b.targetLanguage === 'string' ? b.targetLanguage : '';
    const voiceId = typeof b.voiceId === 'string' ? b.voiceId.trim() : '';
    const translationModelId =
      typeof b.translationModelId === 'string' ? b.translationModelId : undefined;

    if (!isSupportedLanguage(targetLanguageRaw)) {
      return NextResponse.json(
        { error: 'Unsupported targetLanguage' },
        { status: 400 },
      );
    }
    const targetLanguage = targetLanguageRaw as SupportedLanguage;

    if (!voiceId) {
      return NextResponse.json({ error: 'voiceId is required' }, { status: 400 });
    }

    // Workspace-scope: only dub scripts the user's workspace owns. JOINs
    // through projects (which carries workspace_id) — a script orphaned
    // from its project (project_id NULL) is rejected to avoid edge-case
    // tenant escape.
    const { rows } = await sql<ScriptRow>`
      SELECT s.id, s.project_id, s.content
        FROM scripts s
        JOIN projects p ON p.id = s.project_id
       WHERE s.id = ${scriptId}::uuid
         AND p.workspace_id = ${session.ws}::uuid
       LIMIT 1
    `;
    const script = rows[0];
    if (!script) return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    if (!script.content || script.content.trim().length < 50) {
      return NextResponse.json(
        { error: 'Script body is empty or too short to dub' },
        { status: 400 },
      );
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ELEVENLABS_API_KEY is not configured on the server.' },
        { status: 503 },
      );
    }

    const result = await dubScript({
      workspaceId: session.ws,
      projectId: script.project_id,
      scriptId: script.id,
      sourceText: script.content,
      targetLanguage,
      voiceId,
      translationModelId,
      elevenLabsApiKey: apiKey,
    });

    return NextResponse.json({ dub: result }, { status: result.status === 'failed' ? 502 : 200 });
  },
);
