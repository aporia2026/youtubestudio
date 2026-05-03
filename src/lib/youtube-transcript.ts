// YouTube transcript fetcher — pulls captions/subtitles for style analysis

import { YoutubeTranscript } from 'youtube-transcript';
import { logger } from '@/lib/logger';

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
    logger.error('Transcript fetch error', { detail: err instanceof Error ? err.message : String(err) });
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

/**
 * Build a full timestamped transcript for deep analysis.
 * Groups segments into logical chunks with timestamps.
 * Returns the COMPLETE transcript with [MM:SS] markers every ~30 seconds.
 */
export function buildTimestampedTranscript(transcript: VideoTranscript): string {
  const lines: string[] = [];
  let lastMarkerSec = -30;

  for (const seg of transcript.segments) {
    const sec = Math.floor(seg.offset / 1000);
    if (sec - lastMarkerSec >= 30) {
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      lines.push(`\n\n[${mm}:${ss}]\n`);
      lastMarkerSec = sec;
    }
    lines.push(seg.text);
  }

  return lines.join(' ').replace(/ +\n/g, '\n').replace(/\n +/g, '\n').trim();
}

/**
 * Extract the hook section (first N seconds) from the transcript.
 */
export function extractHookTranscript(transcript: VideoTranscript, maxSeconds = 30): string {
  return transcript.segments
    .filter(s => s.offset / 1000 <= maxSeconds)
    .map(s => s.text)
    .join(' ');
}

/**
 * Compute pacing statistics from transcript timing data.
 */
export function computePacingStats(transcript: VideoTranscript): {
  avgWordsPerMinute: number;
  sectionPaces: { timeRange: string; wpm: number }[];
  totalDurationMin: number;
} {
  const totalWords = transcript.wordCount;
  const totalMin = transcript.durationSeconds / 60;
  const avgWpm = totalMin > 0 ? Math.round(totalWords / totalMin) : 0;

  // Compute WPM in 60-second windows
  const windowSec = 60;
  const sectionPaces: { timeRange: string; wpm: number }[] = [];

  for (let start = 0; start < transcript.durationSeconds; start += windowSec) {
    const end = Math.min(start + windowSec, transcript.durationSeconds);
    const segsInWindow = transcript.segments.filter(s => {
      const segSec = s.offset / 1000;
      return segSec >= start && segSec < end;
    });
    const wordsInWindow = segsInWindow.reduce((acc, s) => acc + s.text.split(/\s+/).filter(Boolean).length, 0);
    const durationMin = (end - start) / 60;
    const wpm = durationMin > 0 ? Math.round(wordsInWindow / durationMin) : 0;
    const startMM = String(Math.floor(start / 60)).padStart(2, '0');
    const startSS = String(start % 60).padStart(2, '0');
    const endMM = String(Math.floor(end / 60)).padStart(2, '0');
    const endSS = String(end % 60).padStart(2, '0');
    sectionPaces.push({ timeRange: `${startMM}:${startSS}-${endMM}:${endSS}`, wpm });
  }

  return { avgWordsPerMinute: avgWpm, sectionPaces, totalDurationMin: Math.round(totalMin * 10) / 10 };
}
