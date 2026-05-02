import { NextRequest, NextResponse } from 'next/server';
import { generateText, generateTextStream, getModelById } from '@/lib/ai';
import { scriptGenerationPrompt, scriptExpansionPrompt, SCRIPT_WPM } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getSession } from '@/lib/session';
import { resolveBrandKitForRequest } from '@/lib/channel-brand-kit';
import { countWords } from '@/lib/utils';

// 300s is the Pro-plan ceiling without Fluid Compute. The optional
// expansion pass (non-streaming) can add another 30-60s on top of a
// long stream, so the prior 120/240 caps were starving real 10-15 min
// generations of headroom.
export const maxDuration = 300;

/** Sentinel the client looks for to know "discard everything you've shown
 *  so far and start fresh from the bytes that follow." Used when the
 *  first stream undershot the duration target by enough that we ran an
 *  expansion pass — we send the whole expanded script verbatim after this
 *  marker so the editor displays the longer version, not the short one
 *  followed by the long one. Must stay in sync with the matching constant
 *  in src/app/(app)/generator/page.tsx. */
const REPLACE_SENTINEL = '\n__REPLACE_FULL__\n';

/** Compute a dynamic maxTokens cap based on duration. A 15-minute
 *  script targets ~2100 spoken words and another ~30% in [VISUAL CUE]
 *  / [PAUSE] / section headers, so ~2730 output words ≈ 4100 tokens
 *  using the standard ~1.5 token/word ratio for English. We use a 2x
 *  safety multiplier so the model never hits its own cap mid-script,
 *  with an absolute floor of 8000 (matches the legacy default for
 *  short scripts) and a ceiling of 16000 (Anthropic / OpenAI / Gemini
 *  all support that). */
function computeMaxTokens(durationMinutes: number): number {
  const targetWords = durationMinutes * SCRIPT_WPM;
  const tokensFromTarget = Math.round(targetWords * 3); // 2x of (~1.5 tokens/word)
  return Math.max(8000, Math.min(16000, tokensFromTarget));
}

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`script:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { modelId, topic, niche, duration, tone, style, audience, context, referenceContext, previousScripts, seriesContext, constraints, channelId } = await req.json();

    if (!topic || !niche) {
      return NextResponse.json({ error: 'topic and niche are required' }, { status: 400 });
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

    // Resolve the channel brand kit:
    //   - explicit body.channelId wins, then the user's pinned active channel.
    //   - failure modes (no session, no active channel, channel deleted, kit
    //     malformed) all silently produce null and skip the kit injection —
    //     never break script generation because of brand-kit plumbing.
    const session = await getSession();
    const brandKit = session
      ? await resolveBrandKitForRequest(
          session,
          typeof channelId === 'string' ? channelId : undefined,
        )
      : null;

    // Fold recent scripts into additionalContext so the LLM avoids repeating
    // its own prior hooks/angles for this user. Matches the same mechanism
    // used by /api/generate/script-validated.
    const priors = Array.isArray(previousScripts) ? previousScripts.slice(0, 6).filter((s: unknown) => typeof s === 'string' && s) as string[] : [];
    const dedupNote = priors.length > 0
      ? `\n\nPREVIOUSLY GENERATED SCRIPTS — DO NOT REPEAT THESE HOOKS, OPENINGS, OR ANGLES:\n${priors.map((s, i) => `--- Prior #${i + 1} (first 400 chars) ---\n${s.slice(0, 400)}`).join('\n\n')}\nWrite a fundamentally different angle.`
      : '';

    // Series continuity — the client has already budgeted the prior parts
    // (via /api/series/:id/parts) and built this block. It overrides the
    // no-repeat rule: for a series, the next part SHOULD reference prior
    // parts, so seriesContext goes first and the dedup note is suppressed
    // when series mode is active.
    const seriesBlock = typeof seriesContext === 'string' && seriesContext.trim() ? `\n\n${seriesContext.trim()}` : '';
    const additionalContext = seriesBlock
      ? (context || '') + seriesBlock
      : (context || '') + dedupNote;

    const targetDurationMinutes = duration || 7;
    const targetSpokenWords = targetDurationMinutes * SCRIPT_WPM;
    // Threshold under which we kick off a server-side expansion pass.
    // Matches the lower bound advertised in the prompt's HARD requirement
    // so the model and the validator agree on what "long enough" means.
    const minSpokenWords = Math.round(targetSpokenWords * 0.92);
    const dynamicMaxTokens = computeMaxTokens(targetDurationMinutes);

    const { system, user } = scriptGenerationPrompt({
      topic,
      niche,
      targetDurationMinutes,
      tone,
      style,
      targetAudience: audience,
      additionalContext,
      referenceContext,
      constraints,
      brandKit,
    });

    // Stream response.
    //
    // Two failure modes get patched here:
    //   1. Empty-response failure: some providers (notably GPT-4 Turbo via
    //      OpenAI, certain Kie-routed models) silently return 200 with an
    //      empty body when max_tokens exceeds their per-completion cap.
    //      Symptom: stream closes with zero chunks, client shows
    //      "Script generated!" with no content. Mitigation: count chars
    //      as we stream; if <100 chars, retry once non-streaming at a
    //      more conservative cap and enqueue. If that also comes back
    //      empty, emit __EMPTY_RESPONSE__ so the client surfaces a real
    //      failure instead of a misleading success.
    //
    //   2. Length-undershoot failure: even with strong prompt enforcement,
    //      models routinely undershoot duration targets — a 15-minute
    //      script might come back at ~6 minutes (the symptom this route
    //      was last hardened against). Mitigation: after streaming,
    //      count spoken words. If we're below `minSpokenWords` (92% of
    //      target), run a non-streaming expansion pass and emit
    //      __REPLACE_FULL__ followed by the expanded script. The client
    //      strips everything before the marker and shows the expansion.
    const encoder = new TextEncoder();
    const EMPTY_SENTINEL = '__EMPTY_RESPONSE__';
    const stream = new ReadableStream({
      async start(controller) {
        try {
          let total = 0;
          let firstPassText = '';
          for await (const chunk of generateTextStream({
            modelId,
            prompt: user,
            systemPrompt: system,
            maxTokens: dynamicMaxTokens,
            temperature: 0.8,
          })) {
            total += chunk.length;
            firstPassText += chunk;
            controller.enqueue(encoder.encode(chunk));
          }

          // Empty-response handling — keep existing behavior.
          if (total < 100) {
            try {
              const retry = await generateText({
                modelId,
                prompt: user,
                systemPrompt: system,
                maxTokens: Math.min(dynamicMaxTokens, 4000),
                temperature: 0.8,
              });
              if (retry && retry.trim().length >= 100) {
                controller.enqueue(encoder.encode(retry));
                firstPassText = retry;
                total = retry.length;
              } else {
                controller.enqueue(encoder.encode(EMPTY_SENTINEL));
                controller.close();
                return;
              }
            } catch (retryErr) {
              const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              controller.enqueue(encoder.encode(`${EMPTY_SENTINEL}: retry failed (${msg})`));
              controller.close();
              return;
            }
          }

          // Length-undershoot handling. countWords strips bracketed cues
          // so this is a true narrator-spoken count, matching the metric
          // the prompt told the model to hit. We run AT MOST one expansion
          // attempt — a second model round-trip is acceptable, an
          // unbounded loop is not.
          const firstPassSpokenWords = countWords(firstPassText);
          if (firstPassSpokenWords < minSpokenWords) {
            try {
              const { system: expandSystem, user: expandUser } = scriptExpansionPrompt({
                draftScript: firstPassText,
                topic,
                niche,
                targetDurationMinutes,
                currentSpokenWords: firstPassSpokenWords,
                constraints,
              });
              const expanded = await generateText({
                modelId,
                prompt: expandUser,
                systemPrompt: expandSystem,
                maxTokens: dynamicMaxTokens,
                // Lower temperature for the expansion pass — we want
                // disciplined editing, not a fresh creative pass.
                temperature: 0.65,
              });
              const expandedTrimmed = (expanded || '').trim();
              const expandedSpokenWords = countWords(expandedTrimmed);
              // Only swap in the expansion if it's actually longer than
              // what we already streamed. Some providers occasionally
              // return a SHORTER rewrite — in that case, keep the first
              // pass to avoid making things worse.
              if (expandedTrimmed.length > 100 && expandedSpokenWords > firstPassSpokenWords) {
                controller.enqueue(encoder.encode(REPLACE_SENTINEL));
                controller.enqueue(encoder.encode(expandedTrimmed));
              }
            } catch (expandErr) {
              // Expansion is best-effort — if it fails (timeout, provider
              // hiccup) we keep the first-pass script rather than 500ing
              // the whole request. The user still gets the short script
              // and can hit "Generate" again.
              console.warn('[script] expansion pass failed:', expandErr);
            }
          }

          controller.close();
        } catch (err) {
          controller.error(err);
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
    console.error('Script generation error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Generation failed' },
      { status: 500 }
    );
  }
}
