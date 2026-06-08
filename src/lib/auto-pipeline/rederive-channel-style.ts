/**
 * Vision-focused channel-style rederivation.
 *
 * The original channel-clone analyze stage produces a
 * ChannelCloneVisualProfile by feeding ONE representative frame to a
 * multimodal LLM with a kitchen-sink prompt (text analysis + visual
 * style + audience psychology). The visual profile fields often come
 * out sparse because the LLM's attention is split, and when they're
 * sparse, deriveChannelStyle in src/lib/channel-clone/derive-channel-style.ts
 * falls back to the literal string:
 *
 *   "hand-drawn illustration style, simple composition, neutral palette"
 *
 * That string then gets appended to EVERY row's prompt — which is why
 * channel-clone runs end up producing generic doodle-style images
 * regardless of what the operator's reference videos actually look
 * like (user complaint 2026-06-08).
 *
 * This module fixes that by calling a SEPARATE multimodal pass that
 * does nothing but style extraction. Multiple frames, focused prompt,
 * required-fields schema. Returned suffix is built from the result and
 * the ref pool is selected from the intake's frame R2 keys.
 *
 * Exposed via POST /api/auto-pipeline/videos/[id]/image-progress/rederive-style
 * so the operator can manually trigger a redo without re-running the
 * whole channel-clone pipeline.
 */

import { KIE_MODEL_MAP } from '@/lib/ai-models';
import { logger } from '@/lib/logger';
import { getDownloadUrlForBucket, getReviewBucket } from '@/lib/r2';
import type {
  ChannelCloneIntakeResult,
  ChannelCloneSampleVideo,
} from '@/lib/channel-clone/types';
import { extractJsonObjectFromModelResponse } from '@/lib/channel-clone/parse-llm-json';
import { selectRepresentativeFrames } from '@/lib/channel-clone/derive-channel-style';

const KIE_BASE = 'https://api.kie.ai';

/** Number of frames to send to the vision model. Three covers the
 *  variety question (different scenes/lighting/composition) without
 *  exploding the request body or per-call cost. */
const REDERIVE_FRAME_COUNT = 3;

/** Pool size for the ref selector — should match TARGET_REF_COUNT in
 *  derive-channel-style.ts so per-row slicing in image-gen sees the
 *  same expanded pool. */
const REF_POOL_SIZE = 12;

export interface RederivedStyle {
  aiImageSuffix: string;
  refR2Keys: string[];
  reason: string;
  rawProfile: VisionStyleProfile;
}

interface VisionStyleProfile {
  art_style: string;
  palette_hex: string[];
  lighting_style: string;
  composition_patterns: string;
  detail_level: string;
  mood: string;
  texture: string;
  rendering_technique: string;
  consistent_visual_motifs: string[];
}

const REDERIVE_SCHEMA_INSTRUCTION = `Examine the attached frames from this channel's videos and extract concrete visual style cues. Return a single JSON object matching this TypeScript shape:

{
  "art_style": string,                    // 1 sentence. Be SPECIFIC: not "illustration" — say things like "flat 2D vector cartoon with bold outlines", "hand-painted gouache with visible brush strokes", "3D rendered claymation", "photorealistic with shallow depth-of-field", etc.
  "palette_hex": string[],                // 4-6 hex values that capture the channel's actual colour story. Pick from the frames themselves, not generic web colours.
  "lighting_style": string,               // 1 sentence. "Flat ambient with no cast shadows", "high-key naturalistic daylight", "studio soft-box from camera left", etc.
  "composition_patterns": string,         // 1-2 sentences on framing/staging. "Subjects centred at frame midline, dialogue scenes in shot-reverse-shot, wide establishing shots open every segment", etc.
  "detail_level": string,                 // 1 sentence. "Background simplified to flat geometric shapes, characters get fine line detail", etc.
  "mood": string,                         // 1 sentence. The emotional register the visuals project, not the topic. "Earnest and slightly melancholy", "punchy and irreverent", "calm and technical", etc.
  "texture": string,                      // 1 sentence on surface treatment. "Crisp digital vector with no grain", "subtle film grain over flat colour fills", "pencil-shaded with visible paper tooth", etc.
  "rendering_technique": string,          // 1 sentence. The MEDIUM that created these frames — "Adobe Illustrator vector with Photoshop comp shadows", "Procreate hand-drawn at 1080×1920", "3D Blender → cel-shader pass", etc.
  "consistent_visual_motifs": string[]    // 3-5 recurring visual elements ACROSS the frames. Specific things — "yellow text callouts in Impact font", "recurring stick-figure protagonist with blue shirt", "circular vignette frame border", etc. NOT vague things like "people" or "scenes".
}

Output ONLY the JSON object. No prose before or after. No markdown fences. The first character of your response MUST be \`{\` and the last must be \`}\`. Every string field must be a non-empty, concrete description — NEVER fall back to vague placeholders like "various" or "illustration style".`;

/** Pull the bytes of one frame from R2 and return base64. Best-effort
 *  — frames that can't be loaded are skipped at the caller. */
async function loadFrameAsBase64(r2Key: string): Promise<string | null> {
  try {
    const url = await getDownloadUrlForBucket(getReviewBucket(), r2Key);
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('[rederive-style] R2 GET failed', { r2Key, status: res.status });
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch (err) {
    logger.warn('[rederive-style] frame load threw', {
      r2Key, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Pick `count` frames from the intake, prioritising the per-video
 *  representative_frame_base64 we already have in state (saves a
 *  round-trip to R2) and falling back to fetching R2 frames. */
async function pickFramesForVision(
  intake: ChannelCloneIntakeResult,
  count: number,
): Promise<Array<{ base64: string; mimeType: 'image/jpeg' | 'image/png' }>> {
  const out: Array<{ base64: string; mimeType: 'image/jpeg' | 'image/png' }> = [];
  // Pass 1: use the in-state representative frames (no R2 fetch).
  const withInline = intake.sampleVideos.filter(
    (v): v is ChannelCloneSampleVideo & { representativeFrameBase64: string; representativeFrameMimeType: 'image/jpeg' | 'image/png' } =>
      typeof v.representativeFrameBase64 === 'string'
      && v.representativeFrameBase64.length > 0
      && (v.representativeFrameMimeType === 'image/jpeg' || v.representativeFrameMimeType === 'image/png'),
  );
  for (const v of withInline) {
    if (out.length >= count) break;
    out.push({ base64: v.representativeFrameBase64, mimeType: v.representativeFrameMimeType });
  }
  if (out.length >= count) return out;

  // Pass 2: load extra middle-ish frames from R2.
  for (const video of intake.sampleVideos) {
    if (out.length >= count) break;
    if (!video.frameR2Keys || video.frameR2Keys.length === 0) continue;
    const mid = Math.floor(video.frameR2Keys.length / 2);
    const r2Key = video.frameR2Keys[mid];
    const b64 = await loadFrameAsBase64(r2Key);
    if (b64) {
      const mimeType: 'image/jpeg' | 'image/png' =
        r2Key.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      out.push({ base64: b64, mimeType });
    }
  }
  return out;
}

/** Direct call to Kie's Google-native generateContent with multiple
 *  inline images. Returns the raw response text (expected JSON). */
async function callKieGeminiVision(
  nativeModelId: string,
  frames: Array<{ base64: string; mimeType: string }>,
): Promise<string> {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error('KIE_API_KEY environment variable is not configured.');
  const url = `${KIE_BASE}/gemini/v1/models/${nativeModelId}:generateContent`;
  const parts: Array<Record<string, unknown>> = [
    { text: 'Frames from the channel:' },
    ...frames.map((f) => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } })),
  ];
  const body = {
    system_instruction: { parts: [{ text: REDERIVE_SCHEMA_INSTRUCTION }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1500,
      responseMimeType: 'application/json',
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kie vision call returned ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  for (const c of data.candidates ?? []) {
    for (const p of c.content?.parts ?? []) {
      if (typeof p.text === 'string' && p.text.length > 0) return p.text;
    }
  }
  throw new Error('Kie vision call returned no text content');
}

/** Validate + coerce the vision model's response into a strongly-typed
 *  VisionStyleProfile. Empty / generic values throw so the caller can
 *  surface a clear error rather than persisting another fallback. */
function parseVisionStyleProfile(raw: string): VisionStyleProfile {
  const obj = extractJsonObjectFromModelResponse(raw);
  if (!obj || typeof obj !== 'object') throw new Error('vision response was not a JSON object');
  const o = obj as Record<string, unknown>;
  const required = ['art_style', 'lighting_style', 'composition_patterns', 'detail_level', 'mood', 'texture', 'rendering_technique'];
  for (const field of required) {
    const value = o[field];
    if (typeof value !== 'string' || value.trim().length < 10) {
      throw new Error(`vision response field "${field}" missing or too sparse`);
    }
  }
  const palette = Array.isArray(o.palette_hex) ? o.palette_hex : [];
  const cleanPalette = palette
    .filter((v): v is string => typeof v === 'string')
    .map((h) => h.trim())
    .filter((h) => /^#?[0-9a-f]{3,8}$/i.test(h))
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .slice(0, 6);
  if (cleanPalette.length < 3) {
    throw new Error('vision response palette must include at least 3 valid hex colours');
  }
  const motifs = Array.isArray(o.consistent_visual_motifs) ? o.consistent_visual_motifs : [];
  // Filter out motifs that describe in-image text / typography. Even
  // when the source channel has text overlays as a visual motif,
  // including that motif in the suffix makes the image model bake
  // mis-positioned text into the rendered frame — which then gets
  // cropped at the safe-edge crop and looks broken. Text overlays are
  // composited separately by Remotion at the renderer layer, where
  // positioning is precise. 2026-06-08 — user pushback on "IGNORE" /
  // "HOSTILE UNIVERSE" labels rendered cropped at frame bottom.
  const TEXT_MOTIF_RE = /\b(text|label|caption|word|letter|font|typography|title\s*card|subtitle|callout|onscreen\s*text|on-screen\s*text)\b/i;
  const cleanMotifs = motifs
    .filter((m): m is string => typeof m === 'string')
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .filter((m) => !TEXT_MOTIF_RE.test(m))
    .slice(0, 5);
  if (cleanMotifs.length < 2) {
    throw new Error('vision response must include at least 2 consistent_visual_motifs (after stripping text-related motifs that would bake mis-cropped text into the image)');
  }
  return {
    art_style: (o.art_style as string).trim(),
    palette_hex: cleanPalette,
    lighting_style: (o.lighting_style as string).trim(),
    composition_patterns: (o.composition_patterns as string).trim(),
    detail_level: (o.detail_level as string).trim(),
    mood: (o.mood as string).trim(),
    texture: (o.texture as string).trim(),
    rendering_technique: (o.rendering_technique as string).trim(),
    consistent_visual_motifs: cleanMotifs,
  };
}

/** Build the ai_image_suffix from the vision profile. Concatenates
 *  every concrete field into one comma-joined cue list, and appends
 *  a hard "no in-image text" directive at the end so the image model
 *  doesn't bake mis-positioned text into the frame (text overlays
 *  are composited by Remotion at the renderer layer instead).
 *
 *  Exported for unit tests. */
export function buildSuffixFromVisionProfile(p: VisionStyleProfile): string {
  const parts = [
    p.art_style,
    `palette: ${p.palette_hex.join(' ')}`,
    `lighting: ${p.lighting_style}`,
    `composition: ${p.composition_patterns}`,
    `detail: ${p.detail_level}`,
    `mood: ${p.mood}`,
    `texture: ${p.texture}`,
    `rendering: ${p.rendering_technique}`,
    `consistent visual motifs: ${p.consistent_visual_motifs.join('; ')}`,
    // Anti-text directive — placed last so the image model weighs it
    // heavily. Models give late tokens disproportionate attention
    // ("what must appear / not appear in the image"), per the same
    // observation that drives augmentCellPrompt's OST positioning
    // ordering (src/lib/prompt-augmentation.ts:182-187).
    'NO TEXT, NO LETTERS, NO WORDS, NO TYPOGRAPHY anywhere in the image — text overlays are composited separately by the renderer, never drawn into the illustration itself',
  ];
  return parts.join(', ');
}

export interface RederiveStyleOptions {
  intake: ChannelCloneIntakeResult;
  /** Kie model id to use for the vision call. Must be in the
   *  kie-gemini-* family (only Kie Geminis support multimodal image
   *  input through our router today). */
  modelId: string;
}

/** Run the full vision-focused style derivation. Returns the suffix +
 *  ref pool + reason, ready to drop into a production_doc's
 *  channel_style_override. */
export async function rederiveChannelStyleFromFrames(
  opts: RederiveStyleOptions,
): Promise<RederivedStyle> {
  const kieConfig = KIE_MODEL_MAP[opts.modelId];
  if (!kieConfig) {
    throw new Error(`model "${opts.modelId}" is not in the Kie model map`);
  }
  const nativeModelId = kieConfig.kieModelId.replace(/-openai$/, '');

  const frames = await pickFramesForVision(opts.intake, REDERIVE_FRAME_COUNT);
  if (frames.length === 0) {
    throw new Error('intake has no frames suitable for vision style derivation');
  }
  logger.info('[rederive-style] vision call start', {
    model: opts.modelId, nativeModelId, frameCount: frames.length,
  });

  const raw = await callKieGeminiVision(nativeModelId, frames);
  const profile = parseVisionStyleProfile(raw);
  const aiImageSuffix = buildSuffixFromVisionProfile(profile);

  const refR2Keys = selectRepresentativeFrames(opts.intake, REF_POOL_SIZE);

  const reason = `vision-rederived (${opts.modelId} over ${frames.length} frames) · ${profile.art_style.slice(0, 80)}${profile.art_style.length > 80 ? '…' : ''}`;

  logger.info('[rederive-style] success', {
    model: opts.modelId,
    suffix_len: aiImageSuffix.length,
    ref_pool_size: refR2Keys.length,
    art_style: profile.art_style.slice(0, 100),
    palette_hex: profile.palette_hex.join(' '),
  });

  return {
    aiImageSuffix,
    refR2Keys,
    reason,
    rawProfile: profile,
  };
}
