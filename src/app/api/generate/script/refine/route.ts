import { NextRequest, NextResponse } from 'next/server';
import { generateTextStream, getModelById } from '@/lib/ai';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { buildConstraintsPromptBlock, type ScriptConstraints } from '@/lib/script-options';

export const maxDuration = 300;

/** Post-generation refinement. Takes an already-produced script and the user's
 *  free-form improvement notes, streams back a revised version. Respects the
 *  same constraints as the original generation — if the user disabled the
 *  hook, refinement must not re-add one unless their notes explicitly ask.
 *
 *  Intentionally separate from /api/generate/script (fresh creation) so the
 *  model sees the original verbatim and rewrites surgically instead of
 *  rebuilding from topic/niche. */
export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`refine:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const body = await req.json() as {
      modelId?: string;
      originalScript?: string;
      refinementInstructions?: string;
      topic?: string;
      niche?: string;
      constraints?: ScriptConstraints;
    };

    const { modelId, originalScript, refinementInstructions, topic, niche, constraints } = body;

    if (!originalScript || originalScript.trim().length < 100) {
      return NextResponse.json({ error: 'originalScript is required (min 100 chars)' }, { status: 400 });
    }
    if (!refinementInstructions || refinementInstructions.trim().length < 3) {
      return NextResponse.json({ error: 'refinementInstructions is required' }, { status: 400 });
    }
    if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    const constraintsBlock = buildConstraintsPromptBlock(constraints);

    const system = `You are a world-class YouTube script editor. You refine existing publish-ready scripts surgically — preserving what works, fixing what doesn't, honoring every user-specified constraint.

ABSOLUTE RULES:
- Return the COMPLETE revised script, not a diff or a summary of changes.
- Keep the same format the original uses ([VISUAL CUE: …], [PAUSE], **BOLD**, ## section headers).
- Preserve sections the user did NOT ask to change — do not rewrite the whole thing unless asked.
- Do not add anything that would violate the user's constraints (see below).
- No meta-commentary, no "here's the revised script:" preamble, no summary of edits at the end. Output the script only.`;

    const user = `# Original Script
${topic ? `**Topic:** ${topic}\n` : ''}${niche ? `**Niche:** ${niche}\n` : ''}
\`\`\`
${originalScript}
\`\`\`

# User's Refinement Request
${refinementInstructions}
${constraintsBlock}
# Output
Return the complete refined script now. Apply the user's request. Preserve everything the user did not ask to change. Honor every constraint above.`;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of generateTextStream({
            modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: 8000,
            temperature: 0.6, // a little lower than fresh generation — we want disciplined edits
          })) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        } catch (err) {
          // Sentinel-style error frame — see /api/qa/apply-fixes for
          // why we don't use controller.error() (Next.js edge swallows it).
          const msg = err instanceof Error ? err.message : 'unknown stream error';
          try { controller.enqueue(encoder.encode(`\n\n[ERROR: ${msg}]`)); } catch {}
          try { controller.close(); } catch {}
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err: unknown) {
    console.error('Script refine error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Refine failed' },
      { status: 500 }
    );
  }
}
