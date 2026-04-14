import { NextRequest, NextResponse } from 'next/server';
import { generateText, getModelById } from '@/lib/ai';
import { channelNamingPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { parseLlmJson } from '@/lib/parse-llm-json';
import { fetchVideoMetadata, checkHandlesBatch, parseYouTubeUrl, fetchChannelData, fetchChannelVideosRich } from '@/lib/youtube';

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
    // 1) Classify each reference URL — accept both VIDEO URLs and CHANNEL URLs.
    //    For channels, fetch the 5 most-recent videos as style signal.
    //    Dedupe video URLs by extracted ID.
    const seenVideoIds = new Set<string>();
    const seenChannels = new Set<string>();
    type RefInput =
      | { kind: 'video'; url: string }
      | { kind: 'channel'; url: string; handleOrId: string };
    const refInputs: RefInput[] = [];

    for (const url of referenceVideoUrls.slice(0, 15)) {
      const parsed = parseYouTubeUrl(url);
      if (parsed.kind === 'video') {
        if (seenVideoIds.has(parsed.videoId)) continue;
        seenVideoIds.add(parsed.videoId);
        refInputs.push({ kind: 'video', url });
      } else if (parsed.kind === 'channel-handle' || parsed.kind === 'channel-id') {
        const key = parsed.kind === 'channel-handle' ? `@${parsed.handle}` : parsed.channelId;
        if (seenChannels.has(key)) continue;
        seenChannels.add(key);
        refInputs.push({ kind: 'channel', url, handleOrId: key });
      }
      // 'unknown' URLs are silently skipped — reported as failures below via compareset
    }
    const unknownUrls = referenceVideoUrls
      .slice(0, 15)
      .filter(u => parseYouTubeUrl(u).kind === 'unknown');

    type RefVideoMeta = { title: string; description: string; channelTitle: string; tags: string[] };
    const refResults = await Promise.all(refInputs.map(async (inp): Promise<{ url: string; videos: RefVideoMeta[] }> => {
      if (inp.kind === 'video') {
        const data = await fetchVideoMetadata(inp.url);
        return { url: inp.url, videos: data ? [data] : [] };
      }
      // Channel — resolve, then fetch 5 most-recent videos
      const channel = await fetchChannelData(inp.handleOrId);
      if (!channel) return { url: inp.url, videos: [] };
      const videos = await fetchChannelVideosRich(channel.id, 5);
      return {
        url: inp.url,
        videos: videos.map(v => ({
          title: v.title, description: v.description, channelTitle: v.channelTitle, tags: v.tags,
        })),
      };
    }));

    const refVideoData: RefVideoMeta[] = refResults.flatMap(r => r.videos);
    const refFetchFailures = [
      ...refResults.filter(r => r.videos.length === 0).map(r => r.url),
      ...unknownUrls,
    ];

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

    // Each candidate now carries ~12 fields including 2-sentence reasoning.
    // Rough budget: ~200 tokens × N candidates + system overhead.
    const tokenBudget = Math.min(16000, 1500 + clampedCount * 250);
    const raw = await generateText({
      modelId,
      prompt: augmentedPrompt,
      systemPrompt: system,
      maxTokens: tokenBudget,
      temperature: 0.95, // higher creativity for branding work
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
