// YouTube transcript fetcher — pulls captions/subtitles for style analysis

import { YoutubeTranscript } from 'youtube-transcript';

export interface TranscriptSegment {
  text: string;
  offset: number;   // ms
  duration: number;  // ms
}

export interface VideoTranscript {
  videoId: string;
  segments: TranscriptSegment[];
  fullText: string;
  wordCount: number;
  durationSeconds: number;
}

/**
 * Fetch transcript for a YouTube video.
 * Works with auto-generated and manual captions.
 * Does NOT require a YouTube API key.
 */
export async function fetchTranscript(videoIdOrUrl: string): Promise<VideoTranscript | null> {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoIdOrUrl);
    if (!segments?.length) return null;

    const mapped: TranscriptSegment[] = segments.map(s => ({
      text: s.text,
      offset: s.offset,
      duration: s.duration,
    }));

    const fullText = mapped.map(s => s.text).join(' ');
    const lastSeg = mapped[mapped.length - 1];
    const durationSeconds = Math.round((lastSeg.offset + lastSeg.duration) / 1000);

    return {
      videoId: extractId(videoIdOrUrl),
      segments: mapped,
      fullText,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
      durationSeconds,
    };
  } catch (err) {
    console.error('Transcript fetch error:', err);
    return null;
  }
}

function extractId(input: string): string {
  const match = input.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
  return match?.[1] || input;
}

/**
 * Get a condensed version of the transcript for AI analysis.
 * Takes the first ~3000 words to stay within context limits.
 */
export function condenseTranscript(transcript: VideoTranscript, maxWords = 3000): string {
  const words = transcript.fullText.split(/\s+/);
  if (words.length <= maxWords) return transcript.fullText;

  // Take intro (first 30%), middle sample (20%), and outro (last 20%)
  const introEnd = Math.floor(maxWords * 0.4);
  const midStart = Math.floor(words.length * 0.4);
  const midEnd = midStart + Math.floor(maxWords * 0.25);
  const outroStart = words.length - Math.floor(maxWords * 0.25);

  return [
    words.slice(0, introEnd).join(' '),
    '\n\n[... middle section ...]\n\n',
    words.slice(midStart, midEnd).join(' '),
    '\n\n[... later section ...]\n\n',
    words.slice(outroStart).join(' '),
  ].join('');
}
