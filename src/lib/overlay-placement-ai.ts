/**
 * Vision-aware overlay-placement decision — Phase 2 of
 * `_plans/2026-05-18-overlay-system-overhaul.md`.
 *
 * Given (scene image, overlay PNG, saliency cells), ask a vision LLM to
 * pick size + position for the overlay. Default model is
 * `kie-gemini-3.1-pro` — chosen after a council pass and a research pass
 * for its native pixel-coordinate output and ScreenSpot-Pro lead over
 * Claude / GPT for spatial-localization tasks (see plan for the
 * benchmark numbers). The model is overridable via the
 * OVERLAY_PLACEMENT_MODEL env var; an outage on the primary falls
 * through to `kie-gemini-3-pro` automatically.
 *
 * The function is failure-tolerant by design: anything that goes wrong
 * (missing key, gateway error, malformed JSON, banned zone, NaN size)
 * results in `null` and a logged warning. Callers should treat `null`
 * as "no smart placement available — keep the doc-gen-blind pick."
 */
import { logger } from './logger';

const KIE_BASE = 'https://api.kie.ai';
const DEFAULT_MODEL = 'kie-gemini-3.1-pro';

/** Map our internal model id → the slug Kie expects in its URL path.
 *  Kept tight to known-working Gemini routes. Other models in the
 *  catalog (Claude, GPT) use different endpoints and would need their
 *  own helper; for placement specifically the Gemini family is the
 *  right pick (per plan), so we only enumerate those here. */
const MODEL_TO_KIE_ROUTE: Record<string, string> = {
  'kie-gemini-3.1-pro': 'gemini-3.1-pro',
  'kie-gemini-3-pro': 'gemini-3-pro',
};

/** Outage fallback chain, head-of-line first. The first entry is the
 *  primary; on a non-2xx response we walk down the list. Claude is NOT
 *  on this list — its ScreenSpot-Pro score is half of Gemini's, so a
 *  Claude fallback would degrade placement quality more than skipping
 *  smart placement entirely. */
const FALLBACK_CHAIN: string[] = ['kie-gemini-3.1-pro', 'kie-gemini-3-pro'];

const ALLOWED_ZONES = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center-top',
  'center-bottom',
  'left-center',
  'right-center',
] as const;
type Zone = (typeof ALLOWED_ZONES)[number];

/** Per-overlay min / max width the LLM may pick. Narrower than the
 *  position-editor's 3-60% so the AI defaults sit inside a "tasteful"
 *  band; users can still drag outside this range manually. */
const MIN_SIZE_PCT = 8;
const MAX_SIZE_PCT = 35;

/** Cap on the reason string we store on the row — it gets surfaced as
 *  a tooltip in the editor, so anything long enough to wrap awkwardly
 *  isn't worth keeping. */
const MAX_REASON_LEN = 280;

export interface SaliencyCell {
  row: number;
  col: number;
  score: number;
}

export interface OverlayPlacementInput {
  /** Public URL of the scene image (the doc row's still). */
  sceneImageUrl: string;
  /** Public URL of the overlay PNG (post-RMBG, transparent background). */
  overlayImageUrl: string;
  /** Optional saliency map cells from `row.image_saliency` — when
   *  provided, embedded in the prompt as a numeric grid so the model
   *  can avoid high-attention regions without re-deriving them. */
  saliencyCells?: SaliencyCell[];
  /** Override the default model. Falls back to env var, then to
   *  DEFAULT_MODEL. */
  model?: string;
  /** Optional "previous decision" hint — when the user clicks Rethink,
   *  we pass the previous AI pick so the prompt can explicitly ask for
   *  a meaningfully different placement. Without this, Gemini tends to
   *  return the same answer (or near-identical) on repeat calls. Phase 3
   *  of `_plans/2026-05-18-overlay-system-overhaul.md`. */
  previousDecision?: Pick<
    OverlayPlacementDecision,
    'sizePct' | 'mode' | 'zone' | 'customXPct' | 'customYPct' | 'reason'
  >;
}

export interface OverlayPlacementDecision {
  /** Model id that produced the decision — written to the row so
   *  Phase 0/3 telemetry can compare drag rates per model. */
  model: string;
  /** Width as % of frame width, clamped to [MIN_SIZE_PCT, MAX_SIZE_PCT]. */
  sizePct: number;
  /** When 'zone' the renderer applies the named zone; when 'custom'
   *  it pins to `customXPct, customYPct`. */
  mode: 'zone' | 'custom';
  zone?: Zone;
  customXPct?: number;
  customYPct?: number;
  /** One-sentence rationale surfaced to the user as a tooltip. */
  reason: string;
}

/**
 * Decide overlay placement. Returns `null` on any failure (key missing,
 * network error, parse failure, validation failure) — callers should
 * fall back to the doc-gen-blind pick on null.
 */
export async function decideOverlayPlacement(
  input: OverlayPlacementInput,
): Promise<OverlayPlacementDecision | null> {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    logger.warn('[overlay placement] KIE_API_KEY missing — skipping placement call');
    return null;
  }

  const envModel = process.env.OVERLAY_PLACEMENT_MODEL?.trim();
  const requested = input.model ?? (envModel && envModel.length > 0 ? envModel : DEFAULT_MODEL);
  // Walk the fallback chain starting from the requested model — if the
  // requested model is in the chain we pick up from there; otherwise we
  // try requested first then the chain.
  const chainStart = FALLBACK_CHAIN.indexOf(requested);
  const chain = chainStart >= 0 ? FALLBACK_CHAIN.slice(chainStart) : [requested, ...FALLBACK_CHAIN];

  const prompt = buildPlacementPrompt(input.saliencyCells, input.previousDecision);

  for (const model of chain) {
    const kieRoute = MODEL_TO_KIE_ROUTE[model];
    if (!kieRoute) {
      logger.warn('[overlay placement] unmapped model id — skipping', { model });
      continue;
    }
    try {
      const decision = await callKieGeminiPlacement({
        apiKey,
        kieRoute,
        sceneImageUrl: input.sceneImageUrl,
        overlayImageUrl: input.overlayImageUrl,
        prompt,
      });
      if (decision) {
        logger.info('[overlay placement] decided', {
          model,
          sizePct: decision.sizePct,
          mode: decision.mode,
          zone: decision.zone,
          customXPct: decision.customXPct,
          customYPct: decision.customYPct,
          reason: decision.reason.slice(0, 120),
        });
        return { ...decision, model };
      }
      logger.warn('[overlay placement] empty/invalid response — trying next model', { model });
    } catch (err) {
      logger.warn('[overlay placement] threw — trying next model', {
        model,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn('[overlay placement] all models in chain failed — returning null', { chain });
  return null;
}

interface KieCallInput {
  apiKey: string;
  kieRoute: string;
  sceneImageUrl: string;
  overlayImageUrl: string;
  prompt: string;
}

async function callKieGeminiPlacement(
  i: KieCallInput,
): Promise<Omit<OverlayPlacementDecision, 'model'> | null> {
  const url = `${KIE_BASE}/${i.kieRoute}/v1/chat/completions`;
  // Two image blocks plus the prompt. Labels in the text blocks make
  // the model's "which image is which" decision deterministic — without
  // them, Gemini occasionally swaps scene/overlay roles.
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'SCENE IMAGE (the video frame the overlay will be composited on):' },
          { type: 'image_url', image_url: { url: i.sceneImageUrl } },
          {
            type: 'text',
            text: 'OVERLAY IMAGE (transparent-background PNG — this is what gets placed):',
          },
          { type: 'image_url', image_url: { url: i.overlayImageUrl } },
          { type: 'text', text: i.prompt },
        ],
      },
    ],
    stream: false,
    max_tokens: 800,
    // Gemini-3.x on Kie defaults `include_thoughts: true` which burns
    // the token budget on reasoning and leaves an empty visible message.
    // Mirror the workaround `kieGeminiFetch` already uses in src/lib/ai.ts.
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
    logger.warn('[overlay placement] non-2xx from Kie', {
      route: i.kieRoute,
      status: res.status,
      body: errBody.slice(0, 300),
    });
    return null;
  }

  const data = (await res.json()) as Record<string, unknown>;
  // Kie returns 200 with an error envelope on backend issues — same
  // pattern handled in src/lib/ai.ts. Detect and treat as failure.
  const code = data.code;
  if (typeof code === 'number' && code !== 0 && code !== 200 && !('choices' in data)) {
    const msg = (data.msg ?? data.message ?? 'unknown error') as string;
    logger.warn('[overlay placement] Kie error envelope', { route: i.kieRoute, code, msg });
    return null;
  }

  const content = extractContent(data);
  if (!content) return null;
  return parsePlacement(content);
}

function buildPlacementPrompt(
  saliencyCells?: SaliencyCell[],
  previousDecision?: OverlayPlacementInput['previousDecision'],
): string {
  const saliencyBlock =
    saliencyCells && saliencyCells.length > 0
      ? `\nSALIENCY MAP (8-cell grid of the scene; higher score = more visual attention. AVOID landing on high-score cells unless no clean zone exists):\n${saliencyCells
          .map((c) => `  row ${c.row}, col ${c.col}: ${c.score.toFixed(2)}`)
          .join('\n')}\n`
      : '';

  // Anti-repeat hint for the Rethink path — without this Gemini tends
  // to return the same (or nearly the same) answer on a second call.
  // We tell it what was picked before and ask for something meaningfully
  // different. The model still has freedom to land on a similar spot if
  // it genuinely is the best — but the instruction biases it away.
  const previousBlock = previousDecision
    ? `\nPREVIOUS PICK (the user clicked "Rethink" — choose something meaningfully different from this):
  size_pct: ${previousDecision.sizePct}
  mode: ${previousDecision.mode}${
    previousDecision.mode === 'zone' ? `\n  zone: ${previousDecision.zone ?? 'unknown'}` : ''
  }${
    previousDecision.mode === 'custom'
      ? `\n  custom_x_pct: ${previousDecision.customXPct ?? 'unknown'}\n  custom_y_pct: ${previousDecision.customYPct ?? 'unknown'}`
      : ''
  }
  prior reason: ${previousDecision.reason || 'n/a'}

When rethinking, prefer a DIFFERENT zone (if previously a zone), or a
visibly different region of the frame (if previously custom). Don't
return the exact same placement unless every alternative is clearly
worse — explain that in the reason if you do.\n`
    : '';

  return `You are placing a graphic overlay (logo, brand mark, screenshot) on a YouTube video scene.

Pick:
  - SIZE as % of frame width, integer ${MIN_SIZE_PCT}-${MAX_SIZE_PCT}
  - POSITION via either a named zone OR custom top-left coordinates (% of frame, 0-100)

Avoid:
  - Covering faces, on-screen text, or the most visually busy regions
  - Cropping at frame edges
  - The bottom 12% safe area (YouTube progress bar sits there)
  - Visual conflict with existing scene elements (similar colors, busy textures)

Available zones (use one when a corner/edge slot fits naturally):
  top-left, top-right, bottom-left, bottom-right,
  center-top, center-bottom, left-center, right-center
${saliencyBlock}${previousBlock}
Return a JSON object with NO markdown, NO commentary, NO code fences:
{
  "size_pct": 18,
  "mode": "zone",
  "zone": "top-right",
  "reason": "one short sentence on why this spot works"
}
OR for off-zone placement:
{
  "size_pct": 22,
  "mode": "custom",
  "custom_x_pct": 65,
  "custom_y_pct": 8,
  "reason": "..."
}`;
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
  // Defensive fallback for include_thoughts misfires that route the
  // visible output to reasoning_content — matches src/lib/ai.ts.
  if (typeof message?.reasoning_content === 'string') return message.reasoning_content as string;
  return '';
}

function parsePlacement(content: string): Omit<OverlayPlacementDecision, 'model'> | null {
  // Strip code fences if the model emitted them despite the prompt.
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

  const sizePctRaw = typeof obj.size_pct === 'number' ? obj.size_pct : null;
  if (sizePctRaw === null || !Number.isFinite(sizePctRaw)) return null;
  const sizePct = Math.max(MIN_SIZE_PCT, Math.min(MAX_SIZE_PCT, sizePctRaw));

  const mode = obj.mode === 'zone' || obj.mode === 'custom' ? obj.mode : null;
  if (mode === null) return null;

  const reason =
    typeof obj.reason === 'string' && obj.reason.length > 0
      ? obj.reason.slice(0, MAX_REASON_LEN)
      : '';

  if (mode === 'zone') {
    const zoneRaw = typeof obj.zone === 'string' ? (obj.zone as string) : '';
    const zone = (ALLOWED_ZONES as readonly string[]).includes(zoneRaw) ? (zoneRaw as Zone) : null;
    if (!zone) return null;
    return { sizePct, mode: 'zone', zone, reason };
  }

  // Custom mode
  const xRaw = typeof obj.custom_x_pct === 'number' ? obj.custom_x_pct : null;
  const yRaw = typeof obj.custom_y_pct === 'number' ? obj.custom_y_pct : null;
  if (xRaw === null || yRaw === null || !Number.isFinite(xRaw) || !Number.isFinite(yRaw)) {
    return null;
  }
  return {
    sizePct,
    mode: 'custom',
    customXPct: Math.max(0, Math.min(100, xRaw)),
    customYPct: Math.max(0, Math.min(100, yRaw)),
    reason,
  };
}
