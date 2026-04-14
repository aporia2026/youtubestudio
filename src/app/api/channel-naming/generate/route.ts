import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { channelNamingPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { fetchVideoMetadata, checkHandlesBatch } from '@/lib/youtube';

export const maxDuration = 180;

interface Candidate {
  name: string;
  handle: string;
  seo_score: number;
  brand_score: number;
  memorability_score: number;
  pronounceability: string;
  reasoning: string;
  keyword_coverage: string[];
  risks: string;
}

interface EnrichedCandidate extends Candidate {
  available: boolean;
  takenBy?: { id: string; title: string; thumbnail?: string };
  checkError?: string;
  availabilityNote?: string;
  combinedScore: number;
}

function sanitizeHandle(h: string): string {
  return h.replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
}

export async function POST(req: NextRequest) {
  const { limited } = checkRateLimit(`channel-naming:${getClientIP(req)}`, 5, 60_000);
  if (limited) return NextResponse.json({ error: 'Rate limited' }, { status: 429 });

  let body: {
    modelId?: string;
    niche?: string;
    freeText?: string;
    referenceVideoUrls?: string[];
    referenceImages?: { base64: string; mimeType: string }[];
    count?: number;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { modelId, niche, freeText, referenceVideoUrls = [], referenceImages = [], count = 20 } = body;
  if (!modelId) return NextResponse.json({ error: 'modelId required' }, { status: 400 });

  const model = getModelById(modelId);
  if (!model) return NextResponse.json({ error: 'Invalid model' }, { status: 400 });

  // If images provided, restrict to vision-capable models
  if (referenceImages.length > 0) {
    const VISION_OK = new Set([
      'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
      'gpt-4o', 'gpt-4o-mini',
      'gemini-2.0-flash', 'gemini-2.0-flash-thinking-exp',
      'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3.1-pro',
      'kie-gemini-2.5-flash', 'kie-gemini-2.5-pro', 'kie-gemini-3-flash', 'kie-gemini-3-pro', 'kie-gemini-3.1-pro',
      'kie-claude-opus-4-6', 'kie-claude-sonnet-4-6', 'kie-claude-sonnet-4-5', 'kie-claude-opus-4-5', 'kie-claude-haiku-4-5',
    ]);
    if (!VISION_OK.has(modelId)) {
      return NextResponse.json({
        error: `Model "${model.name}" does not accept images. Remove the reference images or pick a Claude, GPT-4o, or Gemini model.`,
      }, { status: 400 });
    }
  }

  try {
    // 1) Fetch reference video metadata in parallel. De-dupe by video ID so pasting
    // both "youtu.be/abc" and "www.youtube.com/watch?v=abc" is a single lookup.
    const { extractVideoId } = await import('@/lib/youtube');
    const seenIds = new Set<string>();
    const uniqueUrls: string[] = [];
    for (const url of referenceVideoUrls.slice(0, 15)) {
      const id = extractVideoId(url) || url;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      uniqueUrls.push(url);
      if (uniqueUrls.length >= 10) break;
    }

    const refResults = await Promise.all(
      uniqueUrls.map(async url => ({ url, data: await fetchVideoMetadata(url) })),
    );
    const refVideoData = refResults.filter(r => r.data).map(r => r.data!);
    const refFetchFailures = refResults.filter(r => !r.data).map(r => r.url);

    const refSummary = refVideoData.length
      ? refVideoData.map((v, i) => `${i + 1}. "${v.title}" by ${v.channelTitle}${v.tags.length ? ` [tags: ${v.tags.slice(0, 6).join(', ')}]` : ''}`).join('\n')
      : '';

    // 2) Build prompt
    const clampedCount = Math.min(40, Math.max(10, Number(count) || 20));
    const { system, user } = channelNamingPrompt({
      niche: niche || '',
      freeText: freeText || '',
      referenceVideosSummary: refSummary,
      hasImages: referenceImages.length > 0,
      count: clampedCount,
    });

    // 3) Generate candidates. Only pass ONE image (most providers support one-at-a-time
    // cleanly in our existing wrapper). If multiple images are provided, describe the rest
    // textually by noting count.
    const firstImage = referenceImages[0];
    const augmentedPrompt = referenceImages.length > 1
      ? `${user}\n\n(Note: ${referenceImages.length} reference images provided; the first is attached for visual tone, the rest follow the same aesthetic.)`
      : user;

    const raw = await generateText({
      modelId,
      prompt: augmentedPrompt,
      systemPrompt: system,
      maxTokens: 6000,
      temperature: 0.8,
      image: firstImage,
    });

    let parsed: unknown;
    try { parsed = parseLlmJson(raw); } catch {
      return NextResponse.json({ error: 'Failed to parse candidates', raw: raw.slice(0, 500) }, { status: 500 });
    }

    // Accept both { candidates: [...] } and root-level array shapes
    let rawCandidates: Candidate[];
    if (Array.isArray(parsed)) {
      rawCandidates = parsed as Candidate[];
    } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { candidates?: unknown }).candidates)) {
      rawCandidates = (parsed as { candidates: Candidate[] }).candidates;
    } else {
      rawCandidates = [];
    }
    if (rawCandidates.length === 0) {
      return NextResponse.json({ error: 'Model returned no candidates' }, { status: 500 });
    }

    // 4) Dedupe + sanitize handles
    const seen = new Set<string>();
    const clean: Candidate[] = [];
    for (const c of rawCandidates) {
      const handle = sanitizeHandle(c.handle || '');
      if (!handle || handle.length < 3 || seen.has(handle)) continue;
      seen.add(handle);
      clean.push({ ...c, handle });
    }

    // 5) Availability check in parallel
    const handles = clean.map(c => c.handle);
    const availabilityMap = await checkHandlesBatch(handles, undefined, 5);

    // 6) Enrich + rank
    const enriched: EnrichedCandidate[] = clean.map(c => {
      const avail = availabilityMap[c.handle] || { available: false, error: 'not-checked' };
      // Coerce scores defensively — the LLM occasionally returns strings
      const seo = Number(c.seo_score) || 0;
      const brand = Number(c.brand_score) || 0;
      const memo = Number(c.memorability_score) || 0;
      const combinedScore = seo * 0.4 + brand * 0.35 + memo * 0.25;
      return {
        ...c,
        seo_score: seo,
        brand_score: brand,
        memorability_score: memo,
        available: avail.available,
        takenBy: avail.takenBy,
        checkError: avail.error,
        availabilityNote: avail.note,
        combinedScore,
      };
    });

    // Available first, then by combined score descending
    enriched.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return b.combinedScore - a.combinedScore;
    });

    // Top 10 available (or pad with unavailable if fewer than 10 available)
    const availableOnly = enriched.filter(c => c.available);
    const top = availableOnly.length >= 10
      ? availableOnly.slice(0, 10)
      : [...availableOnly, ...enriched.filter(c => !c.available).slice(0, 10 - availableOnly.length)];

    return NextResponse.json({
      candidates: top,
      allChecked: enriched.length,
      availableCount: availableOnly.length,
      model: model.name,
      refVideosUsed: refVideoData.length,
      refVideosFailed: refFetchFailures,
      availabilityCaveat: 'Availability is best-effort based on YouTube forHandle lookup. Always verify by visiting youtube.com/@handle before claiming.',
    });
  } catch (err) {
    console.error('Channel naming error:', err);
    const detail = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ error: `Channel naming failed: ${detail}` }, { status: 500 });
  }
}
