import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';
import { buildKieImageInput, getImageModelSpec, DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/image-models';
import { computeImageSaliency } from '@/lib/image-saliency';
import {
  getDownloadUrlForBucket,
  getImagesBucket,
  uploadToBucket,
} from '@/lib/r2';

export const maxDuration = 300;

const KIE_BASE = 'https://api.kie.ai/api/v1/jobs';

/** Strip HTML (Cloudflare gateway pages) from kie.ai error responses. */
async function kieErrorMsg(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (text.trimStart().startsWith('<') || text.includes('</html>')) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      return `Kie.ai is temporarily unavailable (${res.status}) — please try again in a moment`;
    }
    return `Kie.ai returned an unexpected gateway response (HTTP ${res.status})`;
  }
  try {
    const json = JSON.parse(text);
    const msg = json?.error?.message || json?.message || json?.error;
    if (typeof msg === 'string') return `Kie.ai: ${msg}`;
  } catch { /* not JSON */ }
  return `Kie.ai error ${res.status}: ${text.slice(0, 200)}`;
}

// 95 × 3s = 285s — sits just under the route's `maxDuration = 300`, leaving
// ~15s headroom for R2 upload + saliency compute after the poll returns.
// Earlier ceiling was 30 × 3s = 90s; Flux 2 Pro and GPT Image 2 routinely
// run longer than 90s, so the function returned a timeout error while
// Kie kept running the job to completion — burning credits we never
// collected a result for.
async function pollForResult(taskId: string, apiKey: string): Promise<string> {
  for (let i = 0; i < 95; i++) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const res = await fetch(`${KIE_BASE}/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      if (res.status === 429) continue; // rate limited — retry
      throw new Error(`Poll failed: ${res.status}`);
    }

    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      // Transient bad response — keep polling
      continue;
    }

    const state = (data.data as Record<string, unknown>)?.state;

    if (state === 'success') {
      const dataObj = data.data as Record<string, unknown>;
      let parsed: Record<string, unknown>;
      try {
        parsed = typeof dataObj.resultJson === 'string'
          ? JSON.parse(dataObj.resultJson)
          : (dataObj.resultJson as Record<string, unknown>);
      } catch {
        throw new Error('Invalid result JSON from Kie.ai');
      }
      const urls = parsed?.resultUrls as string[] | undefined;
      if (!urls?.length) throw new Error('No image URLs in result');
      return urls[0];
    }

    if (state === 'fail') {
      const dataObj = data.data as Record<string, unknown>;
      throw new Error((dataObj?.failMsg as string) || 'Image generation failed on Kie.ai');
    }
    // waiting / queuing / generating — keep polling
  }

  throw new Error('Image generation timed out after 285 s — try again');
}

export async function POST(req: NextRequest) {
  try {
    // Separate rate limit key from thumbnails; higher ceiling for bulk generation
    const { limited } = checkRateLimit(`prodoc-img:${getClientIP(req)}`, 30, 60_000);
    if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

    let body: { prompt?: string; model?: string; onScreenText?: string; sectionTitle?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { prompt, model, onScreenText, sectionTitle } = body;
    if (!prompt?.trim()) {
      return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    }

    // Safe-top scene bias — when the row will have a section-title stripe
    // overlay at render time, describe the composition so the top of the
    // frame reads as empty space the stripe can sit on. Phrased as plain
    // scene description, not imperative meta-instruction: directives like
    // "LAYOUT CONSTRAINT — Leave the top 13% as negative space, do NOT
    // place faces…" get rendered verbatim into the image by diffusion
    // models, which can't distinguish rules-to-follow from text-to-draw.
    const hasSectionStripe = Boolean(sectionTitle?.trim());
    const safeTopDirective = hasSectionStripe
      ? `Wide composition with an empty open sky or plain low-detail background across the upper portion of the frame. All characters, faces, objects, and key details sit in the lower portion.\n\n`
      : '';

    // OST baking. Sanitise stray newlines and cap at 120 chars so a
    // malformed string can't smuggle other directives into the prompt.
    // Phrased as a short scene element ("Hand-lettered text 'X' drawn
    // in bold marker style") rather than an imperative ("INCLUDE THE
    // WORDS — do NOT abbreviate…"). The imperative version was being
    // rendered verbatim into the output image alongside the actual
    // words. The phrase is repeated, terse, at the end of the prompt
    // because image models weight late tokens heavily for "what must
    // appear in the image".
    const safeOnScreenText = (onScreenText ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
    const escapedOst = safeOnScreenText.replace(/"/g, '\\"');
    const ostPosition = hasSectionStripe
      ? 'in the lower portion of the frame'
      : 'within the scene';
    const ostLeadingDirective = safeOnScreenText
      ? `Hand-lettered text "${escapedOst}" drawn large in bold marker style ${ostPosition}, in the illustration's own style.\n\n`
      : '';
    const ostTrailingDirective = safeOnScreenText
      ? `\n\nText shown: "${escapedOst}".`
      : '';

    const augmentedPrompt = `${safeTopDirective}${ostLeadingDirective}${prompt.trim()}${ostTrailingDirective}`;

    // Length cap applies to what we ACTUALLY send to Kie — the augmented
    // prompt — not the original. Raised to 2000 to leave room for the
    // OST directive overhead (~150 chars) on top of the existing budget.
    if (augmentedPrompt.length > 2000) {
      return NextResponse.json({ error: 'Prompt too long — maximum 2000 characters' }, { status: 400 });
    }

    const modelValue = model?.trim() || DEFAULT_IMAGE_MODEL;
    const spec = getImageModelSpec(modelValue);
    if (!spec) {
      return NextResponse.json(
        { error: `Unknown image model: ${modelValue}. Valid: ${IMAGE_MODELS.map(m => m.value).join(', ')}` },
        { status: 400 },
      );
    }

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'KIE_API_KEY is not configured' }, { status: 500 });
    }

    // Retry task creation up to 3× on transient 502/503/504 gateway errors
    let createRes!: Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
      createRes = await fetch(`${KIE_BASE}/createTask`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: spec.kieModel,
          input: buildKieImageInput(spec.value, augmentedPrompt),
        }),
      });
      if (createRes.status !== 502 && createRes.status !== 503 && createRes.status !== 504) break;
    }

    if (!createRes.ok) {
      throw new Error(await kieErrorMsg(createRes));
    }

    let createData: Record<string, unknown>;
    try {
      createData = await createRes.json();
    } catch {
      throw new Error('Kie.ai returned non-JSON response during task creation');
    }

    const taskId = (createData.data as Record<string, unknown>)?.taskId as string | undefined;
    if (!taskId) {
      // Surface what Kie actually returned. Common cases hidden behind a
      // bare "no taskId" message: `{code: 401, message: "Insufficient
      // balance"}`, `{code: 422, message: "prompt rejected by policy"}`,
      // or model-deprecation responses. Without this, every failure
      // looks like the same generic bug.
      const code = (createData as Record<string, unknown>).code;
      const message = (createData as Record<string, unknown>).message;
      const detail =
        typeof code !== 'undefined' || typeof message !== 'undefined'
          ? `Kie.ai responded code=${String(code ?? '?')} message=${String(message ?? '(none)')}`
          : `Kie.ai returned an unexpected body: ${JSON.stringify(createData).slice(0, 400)}`;
      console.error('[image-gen] createTask returned no taskId', {
        model: spec.kieModel,
        promptLength: augmentedPrompt.length,
        body: createData,
      });
      throw new Error(`No taskId returned from Kie.ai — ${detail}`);
    }

    const kieUrl = await pollForResult(taskId, apiKey);

    // Re-host in R2 (images bucket) so the URL doesn't depend on Kie's
    // CDN retention. On mirror failure fall back to the Kie URL —
    // image still usable until the upstream expires.
    //
    // The earlier "safe-top crop" step that removed the top 13% of every
    // section-titled image is gone: it destroyed real content (legends,
    // sketched titles, top elements of uploads) for the sake of clearing
    // the stripe zone. The letterbox layout at render time now handles
    // the stripe geometry without ever mutating the image. The safe-top
    // *prompt* directive stays — it's free and biases AI composition
    // toward the lower 87% which still helps in overlay mode and is a
    // bonus in letterbox mode.
    //
    // After upload we also compute a pixel-saliency map of the image
    // so the overlay placement resolver can land overlays on empty
    // cells instead of focal content. Saliency is best-effort: a
    // failure just returns null on the response and the renderer falls
    // back to the LLM's planned zone.
    let imageUrl = kieUrl;
    let imageBuffer: Buffer | null = null;
    try {
      const imgRes = await fetch(kieUrl);
      if (imgRes.ok) {
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        imageBuffer = buffer;
        const outContentType = contentType;
        const outExt = contentType.includes('png') ? 'png' : 'jpg';

        const randomSuffix = Math.random().toString(36).slice(2, 10);
        const bucket = getImagesBucket();
        const r2Key = `prodoc-images/${Date.now()}-${randomSuffix}.${outExt}`;
        await uploadToBucket(bucket, r2Key, buffer, outContentType);
        imageUrl = await getDownloadUrlForBucket(bucket, r2Key, process.env.R2_IMAGES_PUBLIC_URL);
      }
    } catch (uploadErr) {
      console.warn('[image-gen] R2 upload failed, falling back to Kie.ai URL:', uploadErr);
    }

    const saliencyStart = Date.now();
    const saliency = imageBuffer ? await computeImageSaliency(imageBuffer) : null;
    console.info('[saliency compute] done', {
      hasImage: Boolean(imageBuffer),
      hasResult: Boolean(saliency),
      busyness: saliency?.busyness,
      dominantColors: saliency?.dominantColors,
      ms: Date.now() - saliencyStart,
    });

    return NextResponse.json({ imageUrl, saliency });
  } catch (err: unknown) {
    logger.error('Production doc image generation error', { detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
