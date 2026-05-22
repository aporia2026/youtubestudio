/**
 * Narrator utility functions — section splitting, emphasis parsing, duration estimation.
 */

import { stripProductionCues } from './utils';
import type { ForcedAlignmentResponse, ForcedAlignmentWord } from './elevenlabs';

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

  // First try splitting on ## headings. Accept `##Title` and `## Title`
  // both; skip h3+ via negative lookahead.
  const headingSplit = text.split(/^##(?!#)\s*/m);
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
 * Generic structural / meta labels the generator emits for the script's
 * skeleton sections. The narrator shouldn't read these aloud as
 * transitions — saying "Outro." or "Hook." before a section is awkward
 * compared to a topical title like "Morris Worm" or "Stuxnet".
 *
 * Match is exact (case-insensitive) on the trimmed label after
 * stripping a trailing " N" (so "Main Point 2" normalises to
 * "main point"). Anything not in this set is treated as a topical
 * title and gets prefixed.
 */
const META_SECTION_LABELS = new Set([
  'hook',
  'intro',
  'introduction',
  'opening',
  'cold open',
  'cold-open',
  'main',
  'main content',
  'main section',
  'main point',
  'body',
  'middle',
  'transition',
  'outro',
  'ending',
  'closing',
  'conclusion',
  'wrap up',
  'wrap-up',
  'recap',
  'summary',
  'cta',
  'call to action',
  'subscribe',
  'subscribe cta',
]);

/**
 * Returns the text the narrator should actually read for a section —
 * the section title prepended as a spoken sentence to the body. Without
 * this, the title (e.g. "## Morris Worm") gets extracted into `label`
 * for UI orientation only and never makes it into the spoken script,
 * so the narrator skips silently from the end of one section into the
 * next without saying the title aloud as a transition.
 *
 * Idempotent — if the body already starts with the label (e.g. the
 * generator wrote it inline, or this function ran on already-prefixed
 * text), no second copy is added. Falls back to `script_text` unchanged
 * when:
 *   - There is no label at all (preamble before the first heading).
 *   - The label is the splitter's "Section N" fallback, since reading
 *     "Section 1." aloud as a transition isn't natural narration.
 *   - The label is a generic structural / meta label like "Hook",
 *     "Intro", "Outro", "Conclusion", "Main Point 1" — see
 *     META_SECTION_LABELS. Topical titles ("Morris Worm", "Stuxnet")
 *     still get prefixed.
 *
 * Uses display-layer prefixing on purpose so the same helper covers
 * both new assignments (whose split sections were stored without the
 * title) AND existing assignments already in the database — no data
 * migration needed.
 */
export function getSpokenSectionText(
  label: string | null | undefined,
  scriptText: string,
): string {
  const body = scriptText || '';
  if (!label) return body;
  const trimmed = label.trim();
  if (!trimmed) return body;
  if (/^section\s+\d+$/i.test(trimmed)) return body;
  // Strip a trailing " N" so "Main Point 2" / "Hook 1" both fold into
  // their meta-label form before lookup.
  const normalized = trimmed.toLowerCase().replace(/\s+\d+$/, '').trim();
  if (META_SECTION_LABELS.has(normalized)) return body;

  const labelEsc = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Already starts with the label (followed by punctuation, end of body, or
  // a newline)? Don't double up.
  if (new RegExp(`^[\\s]*${labelEsc}(?:[.,!?;:\\s]|$)`, 'i').test(body)) {
    return body;
  }
  return `${trimmed}.\n\n${body}`;
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

// ─── Audio MIME normalisation for narrator uploads ──────────────────────────
//
// Browsers vary on the mime they emit for audio files. Some report
// `application/octet-stream` (or an empty string) for less-common formats —
// AIFF in particular, but also files that came through a desktop "save as"
// or were renamed without re-encoding. The narrator routes' allowlist used
// to reject those outright; we now fall back to the file extension before
// validating, and let both client and server agree on the resolved mime so
// the R2 presigned PUT's signed Content-Type matches what the browser sends.

export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a',
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/webm',
  'audio/ogg', 'audio/opus',
  'audio/flac', 'audio/x-flac',
  'audio/aac',
  'audio/aiff', 'audio/x-aiff',
];

const EXTENSION_TO_AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
};

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** Returns the contentType unchanged when it's a known audio mime; otherwise
 *  derives one from the file extension. Returns the original contentType if
 *  no fallback was found, so callers' allowlist check still rejects truly
 *  non-audio uploads with a useful error. */
export function resolveAudioMime(contentType: string, fileName: string): string {
  if (ALLOWED_AUDIO_MIME_TYPES.includes(contentType)) return contentType;
  const ext = extOf(fileName);
  return EXTENSION_TO_AUDIO_MIME[ext] || contentType;
}

/** Client-side guard. Accepts the file when either the browser-reported mime
 *  starts with `audio/`, or the extension is one we know how to upload —
 *  matters for AIFF / odd exports where browsers emit `application/octet-stream`. */
export function isLikelyAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  return extOf(file.name) in EXTENSION_TO_AUDIO_MIME;
}

// ─── Forced-alignment helpers (Narration tab synced player) ─────────────────
//
// ElevenLabs returns one flat array of words for the whole audio. The
// Narration tab's synced player needs to know which word belongs to which
// section so the script can scroll the active section into view and so
// click-to-seek behaves naturally.

export interface SectionAlignedWords {
  sectionIndex: number;
  words: ForcedAlignmentWord[];
}

// Both helpers only read script_text from each section, so they accept the
// structural shape rather than the full ScriptSection type — that lets
// raw SQL rows from getRealSectionsForAssignment flow through without an
// extra mapping step.
type AlignmentSectionShape = { script_text: string };

/**
 * Build the canonical script text sent to the forced-alignment endpoint.
 * Strips production cues per section so the aligner doesn't try to time
 * a `[pause]` marker. Joins with a newline so adjacent sections stay
 * visually / temporally separated in the response. Exported so the
 * alignment route and the slicer agree on the exact bytes that crossed
 * the wire.
 */
export function buildAlignmentScript(sections: AlignmentSectionShape[]): string {
  return sections
    .map((s) => stripProductionCues(s.script_text).trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

/**
 * Filter out non-word tokens (pure whitespace, ElevenLabs `type === 'spacing'`
 * entries) so the per-section word count check is apples-to-apples with
 * the script's tokenised word count.
 */
function isSpokenWordToken(w: ForcedAlignmentWord): boolean {
  return /\S/.test(w.text);
}

/**
 * Map the aligner's flat word array onto the per-section structure the
 * Narration tab renders. Forced alignment guarantees one timed word per
 * input word in order, so we slice by per-section word counts computed
 * the same way the script was built for the API call. If the response
 * happens to include spacing-type tokens, those are dropped first.
 *
 * If word counts ever drift (e.g. the aligner failed mid-stream and
 * returned fewer words than the script has), the trailing sections
 * receive fewer / no aligned words and the UI's fallback rendering
 * kicks in — the slicer never throws.
 */
export function sliceAlignmentToSections(
  alignment: ForcedAlignmentResponse,
  sections: AlignmentSectionShape[],
): SectionAlignedWords[] {
  const spoken = (alignment.words || []).filter(isSpokenWordToken);

  const result: SectionAlignedWords[] = [];
  let offset = 0;
  for (let i = 0; i < sections.length; i++) {
    const clean = stripProductionCues(sections[i].script_text).trim();
    const n = clean ? clean.split(/\s+/).filter(Boolean).length : 0;
    const take = Math.min(n, Math.max(0, spoken.length - offset));
    result.push({
      sectionIndex: i,
      words: spoken.slice(offset, offset + take),
    });
    offset += take;
  }
  return result;
}

/**
 * Binary-search the active word index at a given audio time. Returns -1
 * when no word's [start, end] interval contains the time (the typical
 * "gap between words" case). Words are required to be sorted by `start`
 * ascending — the aligner guarantees this.
 */
export function findActiveWordIndex(words: ForcedAlignmentWord[], timeSeconds: number): number {
  if (!words.length) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (timeSeconds < w.start) hi = mid - 1;
    else if (timeSeconds >= w.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}
