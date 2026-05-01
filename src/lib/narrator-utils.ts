/**
 * Narrator utility functions — section splitting, emphasis parsing, duration estimation.
 */

import { stripProductionCues } from './utils';

// v3 audio tags from ElevenLabs
const EMOTION_TAGS = ['excited', 'happy', 'sad', 'angry', 'frustrated', 'curious', 'confused', 'serious', 'thoughtful', 'confident', 'nervous', 'surprised', 'whisper', 'shouting', 'mischievously', 'sarcastic'];
const NONVERBAL_TAGS = ['laughs', 'laughs harder', 'chuckles', 'sighs', 'gasps', 'clears throat', 'exhales', 'snorts'];
const PACING_TAGS = ['pause', 'long pause'];
const ALL_TAGS = [...EMOTION_TAGS, ...NONVERBAL_TAGS, ...PACING_TAGS];

const TAG_REGEX = new RegExp(`\\[(${ALL_TAGS.join('|')})\\]`, 'gi');

export interface EmphasisMarker {
  tag: string;
  position: number; // character offset in the section text
  category: 'emotion' | 'nonverbal' | 'pacing';
}

export interface ScriptSection {
  label?: string;
  script_text: string;
  estimated_duration_seconds: number;
  emphasis_markers: EmphasisMarker[];
}

/**
 * Parse emphasis markers from script text (v3 audio tags like [excited], [pause], etc.)
 */
export function parseEmphasisMarkers(text: string): EmphasisMarker[] {
  const markers: EmphasisMarker[] = [];
  let match;
  const regex = new RegExp(TAG_REGEX.source, 'gi');
  while ((match = regex.exec(text)) !== null) {
    const tag = match[1].toLowerCase();
    let category: EmphasisMarker['category'] = 'emotion';
    if (NONVERBAL_TAGS.includes(tag)) category = 'nonverbal';
    else if (PACING_TAGS.includes(tag)) category = 'pacing';
    markers.push({ tag, position: match.index, category });
  }
  return markers;
}

/**
 * Count words a narrator would actually say. Delegates to the canonical
 * stripProductionCues() in lib/utils.ts so section sizing, project word
 * totals, the narrator dashboard, and the teleprompter all agree on
 * what "spoken" means — bracketed cues, markdown headers, emphasis
 * markers, and inline word-count metadata are excluded uniformly.
 */
function countWords(text: string): number {
  const clean = stripProductionCues(text);
  return clean ? clean.split(/\s+/).filter(w => w.length > 0).length : 0;
}

/**
 * Split a script into recordable sections.
 * Strategy: split on ## headings first, then by paragraph groups for long sections.
 * Groups short paragraphs together (min 30 words per section).
 */
export function splitScriptIntoSections(text: string, wpm: number = 150): ScriptSection[] {
  const MIN_WORDS = 30;
  const MAX_WORDS = 300;

  // First try splitting on ## headings
  const headingSplit = text.split(/^## /m);
  const rawSections: { label?: string; text: string }[] = [];

  if (headingSplit.length > 1) {
    // First chunk before any heading
    const preamble = headingSplit[0].trim();
    if (preamble) rawSections.push({ text: preamble });

    for (let i = 1; i < headingSplit.length; i++) {
      const lines = headingSplit[i].split('\n');
      const label = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      if (body) rawSections.push({ label, text: body });
    }
  } else {
    // No headings — split by double newlines (paragraphs)
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    for (const p of paragraphs) {
      rawSections.push({ text: p });
    }
  }

  // Merge short sections and split long ones
  const merged: { label?: string; text: string }[] = [];
  let buffer: { label?: string; text: string } | null = null;

  for (const section of rawSections) {
    const words = countWords(section.text);

    if (words > MAX_WORDS) {
      // Flush buffer first
      if (buffer) { merged.push(buffer); buffer = null; }
      // Split long section into sub-sections by paragraph
      const paras = section.text.split(/\n\s*\n/).filter(Boolean);
      let subBuffer = '';
      for (const para of paras) {
        if (countWords(subBuffer + '\n\n' + para) > MAX_WORDS && subBuffer) {
          merged.push({ label: section.label, text: subBuffer.trim() });
          subBuffer = para;
          // Only label the first sub-section
        } else {
          subBuffer += (subBuffer ? '\n\n' : '') + para;
        }
      }
      if (subBuffer) merged.push({ text: subBuffer.trim() });
    } else if (words < MIN_WORDS && buffer) {
      // Merge with buffer
      buffer.text += '\n\n' + section.text;
    } else if (words < MIN_WORDS && !buffer) {
      buffer = { ...section };
    } else {
      if (buffer) { merged.push(buffer); buffer = null; }
      merged.push(section);
    }
  }
  if (buffer) merged.push(buffer);

  // Convert to ScriptSections with duration estimates and emphasis markers.
  // Drop sections that contain no spoken words after stripping cues +
  // metadata — happens when the LLM emits a closing block that is purely
  // production stuff (e.g. a final "**TOTAL SPOKEN WORD COUNT: …**"
  // summary, or an Outro that's just an SFX line). Keeping them would
  // surface empty cards in the narrator portal.
  const out: ScriptSection[] = [];
  for (const s of merged) {
    const words = countWords(s.text);
    if (words === 0) continue;
    const durationSec = Math.round((words / wpm) * 60);
    const markers = parseEmphasisMarkers(s.text);
    out.push({
      label: s.label,
      script_text: s.text,
      estimated_duration_seconds: durationSec,
      emphasis_markers: markers,
    });
  }
  return out;
}

/**
 * Generate section labels using AI. Returns label suggestions.
 */
export function buildLabelPrompt(sections: ScriptSection[]): string {
  const summaries = sections.map((s, i) => {
    const preview = s.script_text.slice(0, 100).replace(/\n/g, ' ');
    return `Section ${i + 1}: "${preview}..."`;
  }).join('\n');

  return `Label each section of this narration script with a short, descriptive name (2-4 words). Common labels: Hook, Introduction, Main Point, Example, Transition, Deep Dive, Comparison, Statistics, Story, Call to Action, Conclusion, Outro.

${summaries}

Return ONLY a JSON array of strings (one label per section), e.g.: ["Hook", "Introduction", "Main Point 1", ...]`;
}

/**
 * Simple word-level diff for script version comparison.
 * Returns tokens with type: 'same' | 'added' | 'removed'.
 */
export interface DiffToken {
  text: string;
  type: 'same' | 'added' | 'removed';
}

export function diffWords(oldText: string, newText: string): DiffToken[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);

  // Simple LCS-based diff
  const m = oldWords.length;
  const n = newWords.length;

  // For performance with long scripts, use a simplified approach
  if (m * n > 1000000) {
    // Fallback: line-level diff for very long texts
    return [{ text: newText, type: 'same' }];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack
  const result: DiffToken[] = [];
  let i = m, j = n;
  const temp: DiffToken[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      temp.push({ text: oldWords[i - 1], type: 'same' });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ text: newWords[j - 1], type: 'added' });
      j--;
    } else {
      temp.push({ text: oldWords[i - 1], type: 'removed' });
      i--;
    }
  }

  // Reverse since we built it backwards
  for (let k = temp.length - 1; k >= 0; k--) result.push(temp[k]);
  return result;
}
