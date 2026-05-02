import { NextRequest, NextResponse } from 'next/server';
import { apiRoute } from '@/lib/route-helpers';
import { askStudio, listAskStudioQuestions } from '@/lib/ask-studio';

// Tool-use loops can run up to MAX_TOOL_ITERATIONS sequential model
// calls. With Haiku each call is ~1-3s, so the worst case is ~20s.
// 60s ceiling gives comfortable margin.
export const maxDuration = 60;

/**
 * GET /api/ask-studio/questions?limit=
 *
 * Recent questions in the workspace, newest first.
 */
export const GET = apiRoute.authed(async (session, req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const limit = Number.parseInt(searchParams.get('limit') ?? '30', 10) || 30;
  const questions = await listAskStudioQuestions(session.ws, { limit });
  return NextResponse.json({ questions });
});

/**
 * POST /api/ask-studio/questions
 *
 * Body: { question: string, modelId?: string }
 *
 * Runs the agent loop, persists the question + answer + tool trace.
 */
export const POST = apiRoute.authed(async (session, req: NextRequest) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const question = typeof b.question === 'string' ? b.question : '';
  if (!question.trim()) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }
  const modelId = typeof b.modelId === 'string' && b.modelId ? b.modelId : undefined;

  try {
    const result = await askStudio({
      workspaceId: session.ws,
      collaboratorId: session.uid,
      question,
      modelId,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
});
