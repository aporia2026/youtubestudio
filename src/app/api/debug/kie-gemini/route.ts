import { NextRequest, NextResponse } from 'next/server';

/**
 * Diagnostic endpoint for Kie Gemini routes.
 *
 * Sends a small test prompt to a chosen Kie model and returns the FULL
 * raw response so we can see exactly what Kie's gateway is sending back.
 * Used to debug "200 OK + empty content" failures on gemini-3.x without
 * having to run code locally.
 *
 * Usage:
 *   GET /api/debug/kie-gemini?model=gemini-3.1-pro&include_thoughts=false
 *
 * Query params:
 *   - model: the Kie model id (e.g. gemini-3.1-pro, gemini-2.5-pro)
 *   - include_thoughts: 'false' to explicitly disable, anything else to leave default
 *   - reasoning_effort: 'low' | 'high' to set
 *   - content_array: 'false' to send content as a plain string instead of an array
 *   - stream: 'true' to request streaming (we'll just accumulate chunks)
 */
export async function GET(req: NextRequest) {
  if (!process.env.KIE_API_KEY) {
    return NextResponse.json({ error: 'KIE_API_KEY not configured' }, { status: 500 });
  }
  const sp = req.nextUrl.searchParams;
  const model = sp.get('model') || 'gemini-3.1-pro';
  const includeThoughtsRaw = sp.get('include_thoughts');
  const reasoningEffort = sp.get('reasoning_effort');
  const contentAsArray = sp.get('content_array') !== 'false';
  const stream = sp.get('stream') === 'true';

  const url = `https://api.kie.ai/${model}/v1/chat/completions`;
  const userText = 'Reply with the single word: OK';

  const body: Record<string, unknown> = {
    messages: [
      {
        role: 'user',
        content: contentAsArray
          ? [{ type: 'text', text: userText }]
          : userText,
      },
    ],
    stream,
    max_tokens: 200,
  };
  if (includeThoughtsRaw === 'false') body.include_thoughts = false;
  else if (includeThoughtsRaw === 'true') body.include_thoughts = true;
  if (reasoningEffort === 'low' || reasoningEffort === 'high') body.reasoning_effort = reasoningEffort;

  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;

  // Capture the response as text so we can show whatever shape the
  // gateway returned, even if it's not valid JSON.
  const rawText = await res.text();
  let parsed: unknown = null;
  let parseError: string | null = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch (e) { parseError = (e as Error).message; }

  return NextResponse.json({
    request: {
      url,
      body,
    },
    response: {
      status: res.status,
      ok: res.ok,
      elapsedMs,
      headers: Object.fromEntries(res.headers.entries()),
      bodyLength: rawText.length,
      bodyTextHead: rawText.slice(0, 4000),
      parsed,
      parseError,
    },
  });
}
