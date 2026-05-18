/**
 * Vision tiebreaker for ambiguous RMBG cutouts — Phase 4 of
 * `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * When the heuristic gate in `overlay-rmbg-gate.ts` says "ambiguous"
 * (high edge halo OR shattered subject), we send BOTH the original
 * source image and the RMBG cutout to a cheap vision model and ask:
 *
 *   "Which one looks like a cleaner overlay for compositing on a
 *    video scene? Reply with 'a' (original), 'b' (cutout), or
 *    'either'. Brief reason."
 *
 * The model: `kie-gemini-3-flash` — Council outcome was that the
 * placement task needs Gemini Pro's spatial-localization edge, but
 * this is binary classification ("which image is cleaner") which is a
 * much easier task. Flash is ~10x cheaper and fast enough to keep the
 * /api/overlay/fetch latency budget intact.
 *
 * Both images are passed as inline base64 data URLs so we don't have
 * to upload the original to R2 just to show the model. The Kie Gemini
 * gateway accepts data URLs in the OpenAI-compatible image_url block
 * (confirmed live for the placement call in
 * `src/lib/overlay-placement-ai.ts`).
 *
 * Returns null on any failure — caller should default to "keep-rmbg"
 * on null (better to ship a slightly imperfect cutout than to revert
 * to an opaque-background JPG).
 */
import { logger } from './logger';

const KIE_BASE = 'https://api.kie.ai';
const DEFAULT_MODEL = 'kie-gemini-3-flash';
const KIE_ROUTE = 'gemini-3-flash';

export type RmbgTiebreakerVote = 'a' | 'b' | 'either';

export interface RmbgTiebreakerResult {
  model: string;
  /** 'a' = original wins, 'b' = cutout wins, 'either' = no clear winner. */
  vote: RmbgTiebreakerVote;
  reason: string;
}

export interface RmbgTiebreakerInput {
  originalBytes: Buffer;
  originalMimeType: string;
  cutoutBytes: Buffer;
  /** Cutout is always PNG (Bria's RMBG output). Defaulted in code; an
   *  explicit value lets a caller override if Bria's output type ever
   *  changes (e.g. a future model that returns WebP). */
  cutoutMimeType?: string;
}

const MAX_REASON_LEN = 240;

/** Run the vision A/B compare. Returns null on any failure (no key,
 *  network error, malformed JSON, banned vote). Callers should treat
 *  null as "keep the cutout" — that's the safer default for ambiguous
 *  cases (the cutout at least has an alpha channel). */
export async function tiebreakRmbg(input: RmbgTiebreakerInput): Promise<RmbgTiebreakerResult | null> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    logger.warn('[overlay rmbg] tiebreaker — KIE_API_KEY missing, skipping');
    return null;
  }

  const cutoutMime = input.cutoutMimeType ?? 'image/png';
  const originalDataUrl = `data:${input.originalMimeType};base64,${input.originalBytes.toString('base64')}`;
  const cutoutDataUrl = `data:${cutoutMime};base64,${input.cutoutBytes.toString('base64')}`;

  const prompt = `Two images of the SAME source. Image A is the original with the original background; Image B has had the background removed (transparent PNG).

Which would composite more cleanly as a small graphic overlay on a YouTube video scene? Look for:
  - Halo / fringe artifacts around the edges of B
  - Whether B has accidentally erased part of the subject
  - Whether B preserved the readable shape clearly
  - Whether A's background is so plain that no removal was needed

Reply with a JSON object — NO markdown, NO commentary:
{
  "vote": "a",       // or "b" or "either"
  "reason": "one short sentence"
}`;

  const url = `${KIE_BASE}/${KIE_ROUTE}/v1/chat/completions`;
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image A (original):' },
          { type: 'image_url', image_url: { url: originalDataUrl } },
          { type: 'text', text: 'Image B (background removed):' },
          { type: 'image_url', image_url: { url: cutoutDataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: 400,
    // Same Gemini-3.x gotcha as the placement call — include_thoughts
    // defaults to true on Kie's gateway and burns the budget on
    // reasoning, leaving an empty visible message.
    include_thoughts: false,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logger.warn('[overlay rmbg] tiebreaker non-2xx', {
        status: res.status,
        body: errBody.slice(0, 300),
      });
      return null;
    }

    const data = (await res.json()) as Record<string, unknown>;
    const code = data.code;
    if (typeof code === 'number' && code !== 0 && code !== 200 && !('choices' in data)) {
      const msg = (data.msg ?? data.message ?? 'unknown error') as string;
      logger.warn('[overlay rmbg] tiebreaker Kie error envelope', { code, msg });
      return null;
    }

    const content = extractContent(data);
    if (!content) {
      logger.warn('[overlay rmbg] tiebreaker — empty content');
      return null;
    }

    const parsed = parseTiebreakerJson(content);
    if (!parsed) {
      logger.warn('[overlay rmbg] tiebreaker — failed to parse', { content: content.slice(0, 200) });
      return null;
    }

    return { ...parsed, model: DEFAULT_MODEL };
  } catch (err) {
    logger.warn('[overlay rmbg] tiebreaker threw', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function extractContent(data: Record<string, unknown>): string {
  const choices = data.choices as unknown[] | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  if (typeof message?.reasoning_content === 'string') return message.reasoning_content as string;
  return '';
}

function parseTiebreakerJson(content: string): Omit<RmbgTiebreakerResult, 'model'> | null {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const voteRaw = typeof obj.vote === 'string' ? obj.vote.toLowerCase().trim() : '';
  const vote: RmbgTiebreakerVote | null =
    voteRaw === 'a' || voteRaw === 'b' || voteRaw === 'either' ? (voteRaw as RmbgTiebreakerVote) : null;
  if (!vote) return null;
  const reason =
    typeof obj.reason === 'string' && obj.reason.length > 0
      ? obj.reason.slice(0, MAX_REASON_LEN)
      : '';
  return { vote, reason };
}
