import { NextRequest, NextResponse } from 'next/server';
import { fetchYouTubeVideoData, extractVideoId } from '@/lib/youtube';
import { fetchTranscript, buildTimestampedTranscript, extractHookTranscript, computePacingStats } from '@/lib/youtube-transcript';
import { generateText } from '@/lib/ai';
import { deepVideoAnalysisPrompt } from '@/lib/prompts';
import { checkRateLimit, getClientIP } from '@/lib/rate-limit';
import { getCachedReference, upsertCachedReference, touchReference } from '@/lib/reference-cache-db';

export const maxDuration = 300; // 5 minutes — deep analysis takes time

/**
 * Fetch a thumbnail image as base64 for multimodal AI analysis.
 */
async function fetchThumbnailBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    // Reject images larger than 5MB to prevent memory issues
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 5 * 1024 * 1024) return null;
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return { base64, mimeType: contentType };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { limited, resetIn } = checkRateLimit(`analyze:${getClientIP(req)}`, 5, 60_000);
    if (limited) {
      return NextResponse.json(
        { error: `Rate limited — try again in ${Math.ceil(resetIn / 1000)}s` },
        { status: 429 },
      );
    }

    const { url, modelId, force } = await req.json();
    if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

    // ── Cache check ──────────────────────────────────────────────────
    // Deep analysis costs a transcript fetch + a multi-thousand-token AI
    // round-trip per add. Anytime the same YouTube video has been added
    // before — even on a different project — we can serve the prior
    // analysis instantly. ?force=true bypasses the cache (e.g. user
    // wants to re-run with a stronger model).
    //
    // Keyed by video_id so http://youtu.be/X, https://youtube.com/watch?v=X,
    // and shorts links all hit the same row.
    const videoId = extractVideoId(url);
    if (videoId && !force) {
      try {
        const cached = await getCachedReference(videoId);
        if (cached && cached.analysis) {
          // Bump usage stats async so the library can sort by recency.
          touchReference(videoId).catch(() => {});
          return NextResponse.json({
            metadata: {
              id: videoId,
              title: cached.title,
              channelTitle: cached.channel_title,
              viewCount: cached.view_count,
              likeCount: cached.like_count ?? 0,
              commentCount: cached.comment_count ?? 0,
              duration: cached.duration_seconds ?? undefined,
              thumbnailUrl: cached.thumbnail_url,
              tags: cached.tags ?? [],
              description: cached.description ?? '',
            },
            hasTranscript: cached.has_transcript,
            transcriptWordCount: cached.transcript_word_count ?? 0,
            transcriptDuration: cached.duration_seconds ?? 0,
            analysis: cached.analysis,
            styleAnalysis: cached.style_analysis,
            warnings: [],
            cached: true,
            cachedAt: cached.created_at,
          });
        }
      } catch (e) {
        console.warn('reference cache lookup failed (proceeding to live analyze):', e);
      }
    }

    // Fetch metadata, transcript, and thumbnail in parallel
    const metadataPromise = fetchYouTubeVideoData(url);
    const transcriptPromise = fetchTranscript(url);

    const [metadata, transcript] = await Promise.all([metadataPromise, transcriptPromise]);

    if (!metadata) {
      return NextResponse.json({ error: 'Could not fetch video data' }, { status: 400 });
    }

    // Fetch high-res thumbnail for visual analysis
    const thumbnailUrl = metadata.thumbnailUrl?.replace('/default.', '/maxresdefault.')
      || metadata.thumbnailUrl
      || `https://img.youtube.com/vi/${metadata.id}/maxresdefault.jpg`;
    const thumbnailImage = await fetchThumbnailBase64(thumbnailUrl);

    // Build analysis data from transcript
    let timestampedTranscript = '';
    let hookTranscript = '';
    let pacingStats = { avgWordsPerMinute: 0, sectionPaces: [] as { timeRange: string; wpm: number }[], totalDurationMin: 0 };

    if (transcript) {
      timestampedTranscript = buildTimestampedTranscript(transcript);
      hookTranscript = extractHookTranscript(transcript, 30);
      pacingStats = computePacingStats(transcript);
    }

    let analysis: Record<string, unknown> | null = null;
    let styleAnalysis: string | null = null;
    const warnings: string[] = [];

    if (!transcript) {
      warnings.push('Transcript not available — captions may be disabled. Analysis will be limited to metadata and thumbnail.');
    }
    if (!modelId) {
      warnings.push('No AI model selected — deep analysis skipped.');
    }

    // Run deep AI analysis
    if (modelId) {
      try {
        const { system, user } = deepVideoAnalysisPrompt({
          title: metadata.title,
          channelTitle: metadata.channelTitle,
          viewCount: metadata.viewCount,
          likeCount: metadata.likeCount,
          commentCount: metadata.commentCount || 0,
          duration: metadata.duration,
          description: metadata.description || '',
          tags: metadata.tags?.slice(0, 20) || [],
          timestampedTranscript: timestampedTranscript || '(Transcript not available — analyze based on metadata and thumbnail only)',
          hookTranscript: hookTranscript || '(Not available)',
          pacingStats,
          hasThumbnail: !!thumbnailImage,
        });

        const raw = await generateText({
          modelId,
          maxTokens: 8000,
          temperature: 0.3,
          systemPrompt: system,
          prompt: user,
          image: thumbnailImage || undefined,
        });

        // Parse structured JSON response — try multiple extraction strategies
        try {
          // Strategy 1: extract from ```json ... ``` code block
          const codeBlockMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
          if (codeBlockMatch?.[1]) {
            analysis = JSON.parse(codeBlockMatch[1]);
          } else {
            // Strategy 2: find the outermost { ... } pair with bracket matching
            const firstBrace = raw.indexOf('{');
            const lastBrace = raw.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
              analysis = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
            } else {
              throw new Error('No JSON object found in response');
            }
          }
        } catch (parseErr) {
          // If JSON parsing fails, store as raw text for backward compatibility
          console.error('Failed to parse analysis JSON:', parseErr);
          styleAnalysis = raw;
        }

        // Build a human-readable summary from structured analysis for backward compatibility
        if (analysis) {
          styleAnalysis = buildReadableSummary(analysis, metadata.title);
        }
      } catch (err) {
        console.error('Deep analysis error:', err);
        warnings.push('AI analysis encountered an error — partial results may be shown.');
      }
    }

    // ── Cache write ─────────────────────────────────────────────────
    // Persist the result so subsequent adds of the same video are
    // instant. Only stash when we actually produced an analysis —
    // partial/failed runs aren't worth keeping. Best-effort: a cache
    // write failure must not break the response to the user.
    if (analysis || styleAnalysis) {
      try {
        await upsertCachedReference({
          youtube_id: metadata.id,
          url,
          title: metadata.title,
          channel_title: metadata.channelTitle || '',
          view_count: metadata.viewCount,
          like_count: metadata.likeCount,
          comment_count: metadata.commentCount || 0,
          duration_seconds: typeof metadata.duration === 'number' ? metadata.duration : undefined,
          thumbnail_url: metadata.thumbnailUrl,
          description: metadata.description?.slice(0, 1000),
          tags: metadata.tags?.slice(0, 30),
          has_transcript: !!transcript,
          transcript_word_count: transcript?.wordCount,
          analysis,
          style_analysis: styleAnalysis,
          model_id: modelId ?? null,
        });
      } catch (e) {
        console.warn('reference cache write failed:', e);
      }
    }

    return NextResponse.json({
      metadata: {
        id: metadata.id,
        title: metadata.title,
        channelTitle: metadata.channelTitle,
        viewCount: metadata.viewCount,
        likeCount: metadata.likeCount,
        commentCount: metadata.commentCount || 0,
        duration: metadata.duration,
        thumbnailUrl: metadata.thumbnailUrl,
        tags: metadata.tags?.slice(0, 15) || [],
        description: metadata.description?.slice(0, 300) || '',
      },
      hasTranscript: !!transcript,
      transcriptWordCount: transcript?.wordCount || 0,
      transcriptDuration: transcript?.durationSeconds || 0,
      // Structured deep analysis (new)
      analysis,
      // Readable summary (backward compatible)
      styleAnalysis,
      warnings,
      cached: false,
    });
  } catch (err: unknown) {
    console.error('Video analyze error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Analysis failed' },
      { status: 500 },
    );
  }
}

/**
 * Convert structured analysis JSON into a rich readable summary
 * for use in reference context when generating scripts/ideas.
 */
function buildReadableSummary(analysis: Record<string, unknown>, title: string): string {
  const lines: string[] = [];

  const thumb = analysis.thumbnail_analysis as Record<string, string> | undefined;
  if (thumb) {
    lines.push(`**THUMBNAIL:** ${thumb.what_makes_it_click_worthy || thumb.visual_composition || ''}`);
    if (thumb.text_overlays) lines.push(`  Text overlays: ${thumb.text_overlays}`);
    if (thumb.clickability_score) lines.push(`  Clickability: ${thumb.clickability_score}`);
  }

  const hook = analysis.hook_breakdown as Record<string, string> | undefined;
  if (hook) {
    lines.push(`**HOOK:** ${hook.opening_technique || ''} — "${hook.first_sentence_verbatim || ''}"`);;
    if (hook.curiosity_mechanism) lines.push(`  Curiosity: ${hook.curiosity_mechanism}`);
    if (hook.emotional_trigger) lines.push(`  Emotional trigger: ${hook.emotional_trigger}`);
  }

  const structure = analysis.content_structure as Record<string, unknown> | undefined;
  if (structure) {
    lines.push(`**STRUCTURE:** ${structure.format_type || ''}`);
    if (structure.narrative_arc) lines.push(`  Arc: ${structure.narrative_arc}`);
    if (structure.transition_style) lines.push(`  Transitions: ${structure.transition_style}`);
    const sections = structure.sections as Array<Record<string, string>> | undefined;
    if (sections?.length) {
      lines.push(`  Sections: ${sections.map(s => `[${s.timestamp}] ${s.label}`).join(' → ')}`);
    }
  }

  const pacing = analysis.pacing_analysis as Record<string, string> | undefined;
  if (pacing) {
    lines.push(`**PACING:** ${pacing.overall_tempo || ''}`);
    if (pacing.energy_map) lines.push(`  Energy: ${pacing.energy_map}`);
    if (pacing.dead_zones) lines.push(`  Dead zones: ${pacing.dead_zones}`);
  }

  const lang = analysis.language_and_voice as Record<string, unknown> | undefined;
  if (lang) {
    lines.push(`**VOICE:** ${lang.tone_profile || ''}`);
    if (lang.personality_markers) lines.push(`  Personality: ${lang.personality_markers}`);
    const phrases = lang.signature_phrases as string[] | undefined;
    if (phrases?.length) lines.push(`  Signature phrases: ${phrases.join(', ')}`);
    if (lang.audience_address_style) lines.push(`  Audience address: ${lang.audience_address_style}`);
  }

  const story = analysis.storytelling_techniques as Record<string, unknown> | undefined;
  if (story) {
    const devices = story.narrative_devices as string[] | undefined;
    if (devices?.length) lines.push(`**STORYTELLING:** ${devices.join(', ')}`);
    if (story.emotional_arc) lines.push(`  Emotional arc: ${story.emotional_arc}`);
    if (story.tension_building) lines.push(`  Tension: ${story.tension_building}`);
  }

  const engagement = analysis.engagement_mechanics as Record<string, unknown> | undefined;
  if (engagement) {
    const gaps = engagement.curiosity_gaps as string[] | undefined;
    if (gaps?.length) lines.push(`**ENGAGEMENT:** Curiosity gaps: ${gaps.join('; ')}`);
    const interrupts = engagement.pattern_interrupts as Array<Record<string, string>> | undefined;
    if (interrupts?.length) lines.push(`  Pattern interrupts: ${interrupts.map(i => `[${i.timestamp}] ${i.technique}`).join('; ')}`);
  }

  const visual = analysis.visual_production_cues as Record<string, string> | undefined;
  if (visual) {
    lines.push(`**VISUALS:** ${visual.inferred_visuals || ''}`);
    if (visual.production_level) lines.push(`  Production: ${visual.production_level}`);
  }

  if (analysis.creator_fingerprint) lines.push(`**CREATOR DNA:** ${analysis.creator_fingerprint}`);

  const replicable = analysis.replicable_elements as string[] | undefined;
  if (replicable?.length) {
    lines.push(`**REPLICABLE TECHNIQUES:**`);
    replicable.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
  }

  if (analysis.what_makes_it_work) lines.push(`**CORE SUCCESS FACTOR:** ${analysis.what_makes_it_work}`);

  const weaknesses = analysis.weaknesses as string[] | undefined;
  if (weaknesses?.length) lines.push(`**WEAKNESSES:** ${weaknesses.join('; ')}`);

  return lines.join('\n');
}
