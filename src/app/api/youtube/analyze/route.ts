import { NextRequest, NextResponse } from 'next/server';
import { fetchYouTubeVideoData } from '@/lib/youtube';
import { fetchTranscript, condenseTranscript } from '@/lib/youtube-transcript';
import { generateText } from '@/lib/ai';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { url, modelId } = await req.json();
    if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

    // Fetch metadata and transcript in parallel
    const [metadata, transcript] = await Promise.all([
      fetchYouTubeVideoData(url),
      fetchTranscript(url),
    ]);

    if (!metadata) {
      return NextResponse.json({ error: 'Could not fetch video data' }, { status: 400 });
    }

    const condensed = transcript ? condenseTranscript(transcript) : null;

    // If we have a transcript, analyze the style with AI
    let styleAnalysis: string | null = null;
    if (condensed && modelId) {
      try {
        styleAnalysis = await generateText({
          modelId,
          maxTokens: 1500,
          temperature: 0.3,
          systemPrompt: `You are a YouTube content analyst. Analyze video transcripts to extract the creator's style, tone, and approach. Be specific and actionable — a content creator should be able to replicate this style from your analysis.`,
          prompt: `Analyze this YouTube video and extract its style DNA.

**Title:** ${metadata.title}
**Channel:** ${metadata.channelTitle}
**Views:** ${metadata.viewCount.toLocaleString()}
**Likes:** ${metadata.likeCount.toLocaleString()}

**Transcript (${transcript!.wordCount} words, ${Math.round(transcript!.durationSeconds / 60)}min):**
${condensed}

Provide a concise style analysis in this exact format:

**Tone:** (e.g., casual/authoritative/humorous/dramatic — be specific)
**Pacing:** (fast/medium/slow, how they use pauses, energy shifts)
**Hook Style:** (how the first 30 seconds grab attention)
**Structure:** (how the video is organized — sections, transitions, callbacks)
**Language Level:** (vocabulary complexity, jargon usage, audience level)
**Unique Patterns:** (catchphrases, recurring techniques, signature moves)
**Engagement Techniques:** (questions, challenges, pattern interrupts, CTAs)
**What Makes It Work:** (the core reason this video performs well — 1-2 sentences)`,
        });
      } catch (err) {
        console.error('Style analysis error:', err);
      }
    }

    return NextResponse.json({
      metadata: {
        id: metadata.id,
        title: metadata.title,
        channelTitle: metadata.channelTitle,
        viewCount: metadata.viewCount,
        likeCount: metadata.likeCount,
        duration: metadata.duration,
        thumbnailUrl: metadata.thumbnailUrl,
        tags: metadata.tags.slice(0, 10),
      },
      hasTranscript: !!transcript,
      transcriptWordCount: transcript?.wordCount || 0,
      transcriptDuration: transcript?.durationSeconds || 0,
      styleAnalysis,
      warnings: [
        ...(!transcript ? ['Transcript not available — captions may be disabled for this video'] : []),
        ...(transcript && !modelId ? ['No AI model selected — style analysis skipped'] : []),
      ].filter(Boolean),
    });
  } catch (err: unknown) {
    console.error('Video analyze error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Analysis failed' },
      { status: 500 },
    );
  }
}
