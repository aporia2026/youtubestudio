import { NextRequest, NextResponse } from 'next/server';
import { generateText } from '@/lib/ai';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { makeSpendContext } from '@/lib/ai-spend';
import { resolveFeatureModel } from '@/lib/model-defaults';
import { domainErrorResponse } from '@/lib/route-helpers';

/**
 * Convert a raw narration script into an ElevenLabs-ready format.
 *
 *   - v3 (default): inserts audio tags ([excited], [whisper], [laughs],
 *     [sighs], [pause], etc.) inline at appropriate moments based on the
 *     script's emotional/dramatic shape. Documented at
 *     https://elevenlabs.io/blog/v3-audiotags
 *   - v2: applies general best practices (punctuation, pacing, paragraph
 *     breaks, capitalization for emphasis) without audio tags.
 *     https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
 *
 * The output is plain text the user can paste straight into the
 * ElevenLabs TTS box for the corresponding model version. We return one
 * formatted string per requested version so users can A/B both quickly.
 *
 * Input:  { script: string, versions?: ('v2' | 'v3')[], voiceContext?: string }
 * Output: { formatted: { v2?: string, v3?: string } }
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

interface Body {
  script: string;
  versions?: Array<'v2' | 'v3'>;
  /** Optional voice direction hint — e.g. "warm female narrator, mid-30s". */
  voiceContext?: string;
}

const V3_PROMPT = `You are a voice director preparing a script for ElevenLabs v3 TTS. Your job is to rewrite the user's narration script with inline audio tags so the synthesized voice has natural performance — emotion, pacing, and breath.

ElevenLabs v3 audio tags you may use (use sparingly, only when they clearly improve delivery — DO NOT tag every sentence):

EMOTION & TONE:
[excited] [happy] [sad] [angry] [frustrated] [curious] [confused] [serious] [thoughtful] [confident] [nervous] [surprised] [whisper] [shouting] [mischievously] [sarcastic]

NON-VERBAL SOUNDS (use very sparingly — once or twice per minute max):
[laughs] [laughs harder] [chuckles] [sighs] [gasps] [clears throat] [exhales] [snorts]

PACING:
[pause] (a beat) — [long pause] (2-3 sec dramatic pause)
... (trailing thoughtful pause within a sentence)
— em-dash for a sudden cut or aside
- hyphen for a quick beat

EMPHASIS:
- CAPITALIZE words you want stressed (use rarely, max once per paragraph)
- Use *asterisks* around words for slight stress
- Punctuation matters: a comma is a small breath, a period is a full stop

BEST PRACTICES:
- Break the text into short paragraphs (one breath / one beat each).
- Don't tag every sentence — let neutral lines be neutral.
- Tags go BEFORE the words they modify: [excited] This changes everything.
- Numbers: spell out small numbers ("five" not "5") in conversational tone.
- Acronyms: dot them with periods if they should be read letter-by-letter ("F.B.I.").

Return ONLY the rewritten script. No prose explanation, no markdown fencing, no header. Just the script text ready to paste into ElevenLabs v3.`;

const V2_PROMPT = `You are preparing a script for ElevenLabs v2 TTS. Rewrite the user's narration script applying best practices for natural-sounding synthesis. v2 does NOT support audio tags — use ONLY punctuation, capitalization, and paragraph structure to control delivery.

Best practices:
- Break into short paragraphs (one breath per paragraph).
- Use commas, periods, em-dashes, and ellipses deliberately to control pacing.
- Use ... for trailing thoughtful pauses, — for sudden cuts.
- CAPITALIZE words you want stressed (rare, max one per paragraph).
- Spell out small numbers in conversational tone.
- Dot acronyms ("F.B.I.") if they should be read letter-by-letter.
- Avoid run-on sentences — split for breath.
- Don't insert any tags or markup. Plain prose only.

Return ONLY the rewritten script. No prose explanation, no markdown fencing, no header.`;

export async function POST(req: NextRequest) {
  const { limited } = checkRateLimit(`elevenlabs-format:${getClientIP(req)}`, 20, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited — try again shortly' }, { status: 429 });

  let body: Body;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  const script = (body.script || '').trim();
  if (!script) return NextResponse.json({ error: 'script required' }, { status: 400 });
  if (script.length > 50000) return NextResponse.json({ error: 'Script too long (max 50K chars)' }, { status: 400 });

  const versions = (body.versions && body.versions.length > 0) ? body.versions : (['v3'] as const);
  const voiceCtx = body.voiceContext?.trim();

  const out: { v2?: string; v3?: string } = {};

  // Run versions in parallel — each is an independent LLM call.
  const tasks = versions.map(async (v) => {
    const system = v === 'v3' ? V3_PROMPT : V2_PROMPT;
    const userMsg = `${voiceCtx ? `VOICE DIRECTION: ${voiceCtx}\n\n` : ''}SCRIPT TO REFORMAT:\n\n${script}`;
    try {
      const result = await generateText({
        modelId: process.env.SCRIPT_FORMAT_MODEL || (await resolveFeatureModel('script-format')),
        systemPrompt: system,
        prompt: userMsg,
        temperature: 0.4,
        maxTokens: 8000,
        spend: await makeSpendContext('elevenlabs_script_format', { metadata: { version: v } }),
      });
      out[v] = stripFences(result).trim();
    } catch (err) {
      throw new Error(`${v} format failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  try {
    await Promise.all(tasks);
  } catch (err) {
    return domainErrorResponse(err, {
      op: 'script: elevenlabs-format',
      fallbackMessage: 'Could not format script — please try again.',
    });
  }

  return NextResponse.json({ formatted: out });
}

// LLMs occasionally wrap output in ```...``` even when asked not to — strip
// these so the user can paste the result directly.
function stripFences(s: string): string {
  const m = s.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```\s*$/);
  return m ? m[1] : s;
}
