/**
 * Vision-pass anchor extraction for paint_explainer_v1 character bases.
 *
 * Given a generated character base image URL, ask a vision LLM to
 * return the canvas-percentage coordinates of the character's key
 * anchor points (mouth, eyes, body center). The image-gen pipeline
 * caches the result on the doc so the renderer's <MouthSwap> /
 * <LabelPopOn> / <PropSlideIn> components can layer overlays at the
 * RIGHT pixels for any character pose — not just the centered close-up
 * that the hardcoded fallback in <MouthSwap> calibrated against.
 *
 * Architecture: §5 of `_plans/2026-05-28-paint-explainer-v1-architecture.md`.
 *
 * ─── Provider & cost ─────────────────────────────────────────────────
 * Model: `kie-gemini-3.1-pro` via Kie.ai (same gateway + same pattern
 * as `overlay-placement-ai.ts` — chosen after a prior council pass for
 * Gemini's ScreenSpot-Pro lead over Claude / GPT on spatial-localization
 * tasks). Fallback: `kie-gemini-3-pro`.
 *
 * Cost per call: ~$0.001–0.005 via Kie. The architecture plan's
 * original $0.0001 estimate assumed direct Gemini Flash; Pro via Kie is
 * 10–50× pricier. Honest accounting: 3 unique characters per doc ×
 * $0.005 ≈ $0.015 — still well under the $1 ceiling because the
 * per-doc cache fires this once per character, not once per row.
 *
 * If cost becomes a real concern: swap `kie-gemini-3.1-pro` for a Flash
 * variant once Kie exposes one OR migrate this single file to call
 * Google's `@google/generative-ai` SDK directly (the package is already
 * a dependency for other features).
 *
 * ─── Failure modes ───────────────────────────────────────────────────
 * Returns `null` on any failure (missing key, gateway error, parse
 * failure, validation failure, all-coords-out-of-bounds). Callers
 * treat `null` as "no smart anchors — keep MouthSwap's hardcoded
 * centered-close-up default." Never throws.
 *
 * ─── Observability (rule 14) ─────────────────────────────────────────
 * Every call emits:
 *   - `[paint-explainer-v1 anchor-vision-pass] start` with base URL head
 *   - `[paint-explainer-v1 anchor-vision-pass] done`  with extracted anchors
 *   - `[paint-explainer-v1 anchor-vision-pass] failed` with detail
 *
 * Caller (stage handler) is expected to wrap with a per-character-id
 * tagged log so the cost ledger stays grep-able by character.
 */
import { logger } from './logger';

const KIE_BASE = 'https://api.kie.ai';
const DEFAULT_MODEL = 'kie-gemini-3.1-pro';

const MODEL_TO_KIE_ROUTE: Record<string, string> = {
  'kie-gemini-3.1-pro': 'gemini-3.1-pro',
  'kie-gemini-3-pro': 'gemini-3-pro',
};

const FALLBACK_CHAIN: string[] = ['kie-gemini-3.1-pro', 'kie-gemini-3-pro'];

/** The shape the function returns. Each anchor is a percent of the
 *  canvas (0..100 on each axis, dead-center = 50,50). Fields are
 *  individually optional — a side-view character without visible
 *  eyes returns `eyesCenter: null` but still gives a valid
 *  `mouthCenter`. */
export interface CharacterAnchors {
  /** Center of the character's mouth (post-removal, where the
   *  procedural mouth PNG should land). The single most important
   *  anchor — drives <MouthSwap>. Null when the character has no
   *  visible / locatable mouth area (back of head, prop-only shot). */
  mouthCenter: { xPct: number; yPct: number } | null;
  /** Approximate midpoint between the eyes. Drives <LabelPopOn>'s
   *  default 'auto-eyes' anchor (labels float just above the eyes
   *  for emphasis without covering the mouth). */
  eyesCenter: { xPct: number; yPct: number } | null;
  /** Body / overall character center. Useful for <PropSlideIn>'s
   *  drop-in target and as a generic 'auto-center' fallback. */
  characterCenter: { xPct: number; yPct: number } | null;
  /** Model id that produced this result — surfaced in the per-doc
   *  cache so a debugger can see which model's coords are stored. */
  model: string;
}

export interface AnchorVisionInput {
  /** Public URL of the character base image (mouth-removed OR the
   *  original — the vision-pass output is robust to either, since it
   *  locates anatomical features that survive the mouth removal). */
  baseImageUrl: string;
  /** Override the default model. Falls back to env var
   *  PAINT_EXPLAINER_V1_VISION_MODEL, then to DEFAULT_MODEL. */
  model?: string;
}

/**
 * Extract the character's anchor coordinates from a base image.
 * Returns null on any failure — caller falls back to MouthSwap's
 * hardcoded centered-close-up default.
 */
export async function extractCharacterAnchors(
  input: AnchorVisionInput,
): Promise<CharacterAnchors | null> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    logger.warn('[paint-explainer-v1 anchor-vision-pass] KIE_API_KEY missing — skipping');
    return null;
  }

  const envModel = process.env.PAINT_EXPLAINER_V1_VISION_MODEL?.trim();
  const requested =
    input.model ?? (envModel && envModel.length > 0 ? envModel : DEFAULT_MODEL);
  const chainStart = FALLBACK_CHAIN.indexOf(requested);
  const chain = chainStart >= 0
    ? FALLBACK_CHAIN.slice(chainStart)
    : [requested, ...FALLBACK_CHAIN];

  logger.info('[paint-explainer-v1 anchor-vision-pass] start', {
    base_url_head: input.baseImageUrl.slice(0, 80),
    chain,
  });

  const prompt = buildAnchorPrompt();

  for (const model of chain) {
    const kieRoute = MODEL_TO_KIE_ROUTE[model];
    if (!kieRoute) {
      logger.warn('[paint-explainer-v1 anchor-vision-pass] unmapped model id — skipping', { model });
      continue;
    }
    try {
      const anchors = await callKieGeminiVisionPass({
        apiKey,
        kieRoute,
        baseImageUrl: input.baseImageUrl,
        prompt,
      });
      if (anchors) {
        logger.info('[paint-explainer-v1 anchor-vision-pass] done', {
          model,
          mouth: anchors.mouthCenter,
          eyes: anchors.eyesCenter,
          center: anchors.characterCenter,
        });
        return { ...anchors, model };
      }
      logger.warn('[paint-explainer-v1 anchor-vision-pass] empty/invalid response — trying next model', { model });
    } catch (err) {
      logger.warn('[paint-explainer-v1 anchor-vision-pass] failed', {
        model,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn('[paint-explainer-v1 anchor-vision-pass] all models in chain failed — returning null', { chain });
  return null;
}

interface KieCallInput {
  apiKey: string;
  kieRoute: string;
  baseImageUrl: string;
  prompt: string;
}

async function callKieGeminiVisionPass(
  i: KieCallInput,
): Promise<Omit<CharacterAnchors, 'model'> | null> {
  const url = `${KIE_BASE}/${i.kieRoute}/v1/chat/completions`;
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'CHARACTER BASE IMAGE (paint_explainer_v1 style — hand-drawn doodle on white background):',
          },
          { type: 'image_url', image_url: { url: i.baseImageUrl } },
          { type: 'text', text: i.prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: 400,
    // Same workaround as overlay-placement-ai.ts — Gemini-3.x on Kie
    // burns the budget on thoughts and leaves the visible message
    // empty without this.
    include_thoughts: false,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${i.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    logger.warn('[paint-explainer-v1 anchor-vision-pass] non-2xx from Kie', {
      route: i.kieRoute,
      status: res.status,
      body: errBody.slice(0, 240),
    });
    return null;
  }

  const data = (await res.json()) as Record<string, unknown>;
  // Mirror overlay-placement-ai.ts's 200-but-error-envelope detection.
  const code = data.code;
  if (typeof code === 'number' && code !== 0 && code !== 200 && !('choices' in data)) {
    const msg = (data.msg ?? data.message ?? 'unknown error') as string;
    logger.warn('[paint-explainer-v1 anchor-vision-pass] Kie error envelope', {
      route: i.kieRoute,
      code,
      msg,
    });
    return null;
  }

  const content = extractContent(data);
  if (!content) return null;
  return parseAnchors(content);
}

/** Build the vision-LLM prompt. The instructions are tuned to:
 *  - Return raw JSON without code fences (the parser strips fences as
 *    defense in depth but the prompt asks the model to skip them).
 *  - Use 'null' for missing features (not omit fields) so the parser
 *    can distinguish "feature absent" from "model forgot to include".
 *  - Stay tight to the four fields we need — Gemini tends to add
 *    extra metadata fields without specific instruction to the
 *    contrary.
 *
 *  Exported for unit testing (rule 14 — load-bearing string lives in
 *  one place and is greppable).
 */
export function buildAnchorPrompt(): string {
  return `You are looking at a hand-drawn doodle character on a white background.
This image is a CHARACTER BASE for an explainer video. The next stage
of the rendering pipeline will composite overlays (mouth shapes,
labels, props) on top of this image, so I need the pixel-percentage
coordinates of the character's anatomy.

For each anchor below, return BOTH coordinates as percentages of the
image's width and height (0 at the left/top edge, 100 at the right/
bottom edge). If the feature isn't visible in the image (back of
head, prop-only shot, full-body silhouette with no face), return
null for that anchor — do NOT guess.

Return a JSON object with NO markdown, NO commentary, NO code fences.
Schema:
{
  "mouth_center":     { "x_pct": <0-100>, "y_pct": <0-100> } | null,
  "eyes_center":      { "x_pct": <0-100>, "y_pct": <0-100> } | null,
  "character_center": { "x_pct": <0-100>, "y_pct": <0-100> } | null
}

Notes:
- mouth_center: the geometric center of where the character's mouth
  is (or would be — if the mouth has been erased for compositing, use
  the center of the cleared region below the eyes).
- eyes_center: the midpoint of the two eyes. For a one-eye / side-
  view pose, return the visible eye's center.
- character_center: the visual centroid of the entire drawn character
  (head + body if visible). Used for slide-in animations.`;
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
  // Mirror overlay-placement-ai.ts include_thoughts fallback.
  if (typeof message?.reasoning_content === 'string') {
    return message.reasoning_content as string;
  }
  return '';
}

/** Parse the JSON object the model returns into a structured anchor
 *  set. Tolerant of code-fence wrapping (the model sometimes ignores
 *  the no-fence directive). Returns null when the JSON can't be
 *  recovered, OR when EVERY anchor is null / malformed (no useful
 *  data → caller falls back to hardcoded defaults).
 *
 *  Exported for unit testing — the parser is the load-bearing bridge
 *  between Kie's response shape and the renderer's anchor shape.
 */
export function parseAnchors(content: string): Omit<CharacterAnchors, 'model'> | null {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fall back to finding a JSON object embedded in prose.
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

  const mouthCenter = parsePoint(obj.mouth_center);
  const eyesCenter = parsePoint(obj.eyes_center);
  const characterCenter = parsePoint(obj.character_center);

  // If every anchor is null, the call produced no useful data — bail
  // so the caller treats it as a failure and falls back to defaults.
  if (mouthCenter === null && eyesCenter === null && characterCenter === null) {
    return null;
  }

  return { mouthCenter, eyesCenter, characterCenter };
}

/** Parse a single { x_pct, y_pct } point. Returns null when missing,
 *  malformed, or out of [0, 100] bounds on either axis. */
function parsePoint(raw: unknown): { xPct: number; yPct: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = typeof r.x_pct === 'number' ? r.x_pct : null;
  const y = typeof r.y_pct === 'number' ? r.y_pct : null;
  if (x === null || y === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Reject hard out-of-range — keeps a hallucinated 200,200 from
  // becoming a clamped 100,100 (which would silently land at the
  // bottom-right of the canvas).
  if (x < 0 || x > 100 || y < 0 || y > 100) return null;
  return { xPct: x, yPct: y };
}
