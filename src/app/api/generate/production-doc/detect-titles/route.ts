import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { apiRoute } from '@/lib/route-helpers';
import { logger } from '@/lib/logger';
import { extractScriptTitles } from '@/lib/script-titles';
import { preprocessSsmlForProductionDoc } from '@/lib/ssml-production-doc';

// Pre-flight title-detection endpoint. Mirrors the exact SSML pre-pass
// + `##` extractor the main /production-doc route runs so the user sees
// the same title list the LLM would have seen. The UI calls this BEFORE
// generation; the user reviews / edits / deletes / adds, then submits
// the corrected list to /production-doc as `userTitles`.
//
// See `_plans/2026-05-31-preflight-title-review.md`.
export const POST = apiRoute.authed(async (_session, req: NextRequest) => {
  const { limited, resetIn } = checkRateLimit(`prodoc-detect:${getClientIP(req)}`, 30, 60_000);
  if (limited) {
    return NextResponse.json({ error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` }, { status: 429 });
  }

  let body: { script?: unknown };
  try {
    body = (await req.json()) as { script?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const script = typeof body.script === 'string' ? body.script : '';
  if (!script.trim()) {
    return NextResponse.json({ error: 'script is required' }, { status: 400 });
  }

  const ssmlPre = preprocessSsmlForProductionDoc(script);
  const scriptForPipeline = ssmlPre.wasSsml ? ssmlPre.cleanScript : script;
  const extracted = extractScriptTitles(scriptForPipeline);

  logger.info('[production-doc detect-titles]', {
    inputBytes: Buffer.byteLength(script, 'utf8'),
    wasSsml: ssmlPre.wasSsml,
    detectedCount: extracted.titles.length,
    warningCount: extracted.warnings.length,
  });

  return NextResponse.json({
    titles: extracted.titles,
    warnings: extracted.warnings,
  });
});
