import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import {
  nLevelsLlmPrompt,
  parseLevelListResult,
  validateLevelList,
  type LevelListResult,
  type LlmPromptInput,
} from '@/lib/thumbnail-formats/n-levels';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { makeSpendContext } from '@/lib/ai-spend';
import { logger } from '@/lib/logger';
import { assertSafePublicUrl } from '@/lib/url-safety';

export const maxDuration = 120;

/**
 * Step 1 of the N Levels Explained pipeline: produce the ordered level list
 * + refined topic for the bottom title bar. Cheap, fast LLM call. The user
 * reviews / edits the output before triggering Step 2 (the expensive image
 * call). Mirrors the sibling topic-card-grid/cards endpoint.
 */

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

// Server-side sanity cap on slice count. The UI doesn't surface a max; this
// is the runaway-prevention layer (20+ levels would produce slices too thin
// to read at any size).
const MAX_LEVEL_COUNT = 20;

/**
 * Per-LLM-call timeout — see the matching constant in the topic-card-grid
 * cards route for the rationale. 150s lets a validation retry fit inside
 * the 300s function budget and surfaces a clean error before Vercel's
 * hard kill returns a raw 504.
 */
const LLM_CALL_TIMEOUT_MS = 150_000;

const FAST_VISION_MODEL_SUGGESTIONS = [
  'Gemini 2.5 Flash (or kie-gemini-2.5-flash)',
  'Gemini 3 Flash (kie-gemini-3-flash)',
  'Claude Haiku 4.5',
  'GPT-4o Mini',
];

function withTimeout<T>(promise: Promise<T>, ms: number, modelName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Model "${modelName}" took longer than ${Math.round(ms / 1000)}s on this prompt. ` +
        `Try a faster vision model — recommended picks: ${FAST_VISION_MODEL_SUGGESTIONS.join(', ')}.`,
      ));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const VISION_ALLOWED = new Set<string>([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-2.0-flash',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'kie-gemini-2.5-flash',
  'kie-gemini-2.5-pro',
  'kie-gemini-3-flash',
  'kie-gemini-3-pro',
  'kie-gemini-3.1-pro',
  'kie-claude-opus-4-7',
  'kie-claude-opus-4-6',
  'kie-claude-sonnet-4-6',
  'kie-claude-sonnet-4-5',
  'kie-claude-opus-4-5',
  'kie-claude-haiku-4-5',
]);

interface ReqBody {
  modelId?: string;
  title?: string;
  niche?: string;
  script?: string;
  description?: string;
  count?: number;
  titleTopic?: string;
  titleTagline?: string;
  /** Whether the rendered thumbnail will include the grunge bottom title
   *  bar. Defaults false (matches the dominant pattern in successful
   *  "N LEVELS OF" thumbnails on YouTube). */
  showBottomTitle?: boolean;
  mode?: 'review' | 'pre-fill' | 'one-shot';
  prefilledLabels?: string[];
  referenceImageUrl?: string;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const { limited, resetIn } = checkRateLimit(`thumb-fmt-n-levels-list:${getClientIP(req)}`, 10, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    let body: ReqBody;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const modelId = body.modelId;
    const title = (body.title || '').trim();
    const niche = (body.niche || '').trim();
    const count = Number(body.count);
    const showBottomTitle = body.showBottomTitle === true;
    const titleTopic = (body.titleTopic || '').trim();
    const titleTagline = body.titleTagline === undefined ? 'EXPLAINED' : String(body.titleTagline);
    const mode = body.mode === 'pre-fill' || body.mode === 'one-shot' ? body.mode : 'review';

    if (!modelId) return NextResponse.json({ error: 'modelId is required' }, { status: 400 });
    if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });
    if (!niche) return NextResponse.json({ error: 'niche is required' }, { status: 400 });
    if (showBottomTitle && !titleTopic) {
      return NextResponse.json({
        error: 'titleTopic is required when the bottom title bar is enabled (the topic that goes in the title strip).',
      }, { status: 400 });
    }
    if (!Number.isInteger(count) || count < 2 || count > MAX_LEVEL_COUNT) {
      return NextResponse.json(
        { error: `count must be an integer between 2 and ${MAX_LEVEL_COUNT}` },
        { status: 400 },
      );
    }

    const model = getModelById(modelId);
    if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    if (!VISION_ALLOWED.has(modelId)) {
      return NextResponse.json(
        {
          error: `Model "${model.name}" cannot read the reference image. Pick a Claude 4.x, GPT-4o, Gemini 2.x, or any Kie Claude/Gemini variant.`,
        },
        { status: 400 },
      );
    }

    const prefilledLabels = Array.isArray(body.prefilledLabels)
      ? body.prefilledLabels.map((s) => String(s || '').trim()).filter((s) => s.length > 0)
      : undefined;
    if (mode === 'pre-fill') {
      if (!prefilledLabels || prefilledLabels.length !== count) {
        return NextResponse.json(
          {
            error: `Pre-fill mode needs exactly ${count} labels (one per level); received ${prefilledLabels?.length ?? 0}.`,
          },
          { status: 400 },
        );
      }
    }

    const referenceImageUrl = (body.referenceImageUrl || '').trim();
    if (!referenceImageUrl) {
      return NextResponse.json(
        { error: 'A reference image is required for this format. Upload one or paste a public HTTPS URL.' },
        { status: 400 },
      );
    }

    logger.info('[thumb-format-n-levels list] start', {
      modelId,
      niche,
      count,
      mode,
      has_user_reference: true,
      prefilled_count: prefilledLabels?.length ?? 0,
    });

    // Fetch + base64 the reference. Same SSRF pattern as the rest of the
    // multimodal flows (string-based assertSafePublicUrl + plain fetch).
    const fetchStart = Date.now();
    let imgRes: Response;
    let rawHostForError = '';
    try {
      try {
        rawHostForError = new URL(referenceImageUrl).hostname;
      } catch {
        /* fall through */
      }
      const safeUrl = assertSafePublicUrl(referenceImageUrl, { allowedProtocols: ['https:'] });
      imgRes = await fetch(safeUrl);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('[thumb-format-n-levels list] reference rejected', { reason, host: rawHostForError });
      return NextResponse.json(
        { error: `Reference image URL was rejected (${rawHostForError || 'unknown host'}): ${reason}` },
        { status: 400 },
      );
    }
    if (!imgRes.ok) {
      return NextResponse.json(
        { error: `Failed to fetch reference image (HTTP ${imgRes.status}).` },
        { status: 502 },
      );
    }
    const declaredLen = Number.parseInt(imgRes.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_REFERENCE_BYTES) {
      return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
    }
    const arrayBuf = await imgRes.arrayBuffer();
    if (arrayBuf.byteLength > MAX_REFERENCE_BYTES) {
      return NextResponse.json({ error: 'Reference image exceeds 8 MB cap' }, { status: 413 });
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const mimeType = contentType.includes('png')
      ? 'image/png'
      : contentType.includes('webp')
        ? 'image/webp'
        : contentType.includes('gif')
          ? 'image/gif'
          : 'image/jpeg';
    const base64 = Buffer.from(arrayBuf).toString('base64');
    logger.info('[thumb-format-n-levels list] reference fetch', {
      host: rawHostForError,
      bytes: arrayBuf.byteLength,
      mime: mimeType,
      duration_ms: Date.now() - fetchStart,
    });

    const promptInput: LlmPromptInput = {
      title,
      niche,
      script: body.script,
      description: body.description,
      count,
      titleTopic: showBottomTitle ? titleTopic : undefined,
      titleTagline: showBottomTitle ? titleTagline : undefined,
      showBottomTitle,
      prefilledLabels: mode === 'pre-fill' ? prefilledLabels : undefined,
    };
    const { system, user } = nLevelsLlmPrompt(promptInput);

    const callLlm = async (userPrompt: string, temperature: number) =>
      withTimeout(
        generateText({
          modelId,
          prompt: userPrompt,
          systemPrompt: system,
          maxTokens: 4000,
          temperature,
          image: { base64, mimeType },
          spend: await makeSpendContext('thumbnail_format_n_levels_list', {
            metadata: { niche, count, mode },
          }),
        }),
        LLM_CALL_TIMEOUT_MS,
        model.name,
      );

    let raw = await callLlm(user, 0.7);
    let parsed: LevelListResult | null = null;
    let validation = validateLevelList([], count);
    let retriesUsed = 0;
    try {
      const parsedJson = parseLlmJson(raw);
      parsed = parseLevelListResult(parsedJson, titleTopic, titleTagline);
      validation = validateLevelList(parsed.levels, count);
    } catch (err) {
      validation = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (!validation.ok) {
      retriesUsed = 1;
      logger.warn('[thumb-format-n-levels list] validation failed', {
        reason: validation.reason,
        offending_level_index: 'offending_level_index' in validation ? validation.offending_level_index : undefined,
        retries_so_far: 0,
      });
      const retryPrompt = `${user}\n\nThe previous attempt was rejected for this reason: ${validation.reason} Return EXACTLY ${count} levels, in narrative order.`;
      raw = await callLlm(retryPrompt, 0.5);
      try {
        const parsedJson = parseLlmJson(raw);
        parsed = parseLevelListResult(parsedJson, titleTopic, titleTagline);
        validation = validateLevelList(parsed.levels, count);
      } catch (err) {
        validation = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    if (!validation.ok || !parsed) {
      logger.warn('[thumb-format-n-levels list] validation failed', {
        reason: validation.ok ? 'parsed is null' : validation.reason,
        offending_level_index:
          !validation.ok && 'offending_level_index' in validation ? validation.offending_level_index : undefined,
        retries_so_far: retriesUsed,
      });
      return NextResponse.json(
        {
          error: validation.ok
            ? 'Level list could not be parsed from the LLM response. Try again or pick a different model.'
            : `Level list validation failed after a retry: ${validation.reason}`,
        },
        { status: 502 },
      );
    }

    logger.info('[thumb-format-n-levels list] done', {
      duration_ms: Date.now() - startedAt,
      levels_count: parsed.levels.length,
      retries_used: retriesUsed,
    });

    return NextResponse.json({
      result: parsed,
      retriesUsed,
    });
  } catch (err) {
    logger.error('[thumb-format-n-levels list] error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Level list generation failed' },
      { status: 500 },
    );
  }
}
