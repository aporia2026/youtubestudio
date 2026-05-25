import { NextRequest, NextResponse } from 'next/server';
import { apiRoute, domainErrorResponse } from '@/lib/route-helpers';
import { askStudio, AskStudioModelNotSupported, listAskStudioQuestions } from '@/lib/ask-studio';
import { isAskStudioSupportedModel } from '@/lib/ai-models';

// Tool-use loops can run up to MAX_TOOL_ITERATIONS sequential model
// calls. With Haiku each call is ~1-3s, so the worst case is ~20s.
// 60s ceiling gives comfortable margin.
export const maxDuration = 180;

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

  // Reject unsupported models at the gate so the user sees the real
  // reason ("Gemini 3.1 Pro isn't supported by Ask Studio yet") instead
  // of the catch-all 502 + "try again" fallback. The validator also
  // prevents an orphan errored row in `ask_studio_questions`.
  if (modelId && !isAskStudioSupportedModel(modelId)) {
    return NextResponse.json(
      { error: new AskStudioModelNotSupported(modelId).message },
      { status: 400 },
    );
  }

  try {
    const result = await askStudio({
      workspaceId: session.ws,
      collaboratorId: session.uid,
      question,
      modelId,
    });
    return NextResponse.json(result);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'ask-studio: question',
      knownPatterns: [
        { match: /question is required/i, status: 400 },
        { match: /^Ask Studio doesn't support /i, status: 400 },
      ],
      // The actual underlying error is persisted in `ask_studio_questions.error_message`
      // so the user can expand the errored card to see it. The fallback
      // toast just points them there.
      fallbackMessage: 'Ask Studio failed — open the question card below to see the error.',
    });
  }
});
