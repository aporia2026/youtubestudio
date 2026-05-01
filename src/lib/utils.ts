import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function estimateDuration(wordCount: number): number {
  // Average speaking pace ~140 wpm
  return Math.round((wordCount / 140) * 60);
}

/**
 * Strip everything from a script that the narrator does NOT say aloud.
 * Single source of truth for "what's a spoken word" — the generator,
 * project page, narrator portal, teleprompter, exports, and section
 * splitter all route through here so word counts and the reading view
 * stay in lockstep.
 *
 * Removes, in order:
 *   1. Bracketed cues / citations / performance tags — `[VISUAL CUE: …]`,
 *      `[SFX: …]`, `[B-ROLL: …]`, `[PAUSE]`, `[excited]`, `[whisper]`,
 *      Perplexity-style citation markers like `[1]` / `[3][6]`, etc.
 *   2. Standalone markdown header lines — `## Outro`, `### Section 2`.
 *      The section splitter already lifts these into labels, but a stray
 *      one inside a section body (the LLM occasionally emits them mid-
 *      paragraph during expansion passes) would otherwise be read aloud.
 *   3. Whole lines of word-count / duration metadata the generator
 *      inlines for self-tracking — `**TOTAL SPOKEN WORD COUNT: 1570** …`,
 *      `(Word count so far: …)`, `(Spoken words: 84)`, `Estimated
 *      duration: 2:30`, etc. The narrator should never have these
 *      counted as part of the script, let alone read them out.
 *   4. Inline parenthetical metadata that survived the line-level pass —
 *      e.g. `…ends here.(Spoken words: 310) Next paragraph…`. Conservative:
 *      only parens whose content contains a metadata keyword get stripped.
 *   5. Markdown emphasis wrappers — `**bold**`, `*italic*`, `__bold__`,
 *      `_italic_`. The wrapped words ARE spoken; the asterisks/underscores
 *      are editorial-only and would otherwise show up as stray punctuation
 *      in the plain reading view.
 *
 * Whitespace cleanup: trims trailing spaces before newlines and collapses
 * runs of 3+ newlines to a paragraph break, but keeps single/double
 * newlines so paragraph structure survives for the teleprompter.
 */
export function stripProductionCues(text: string): string {
  if (!text) return '';
  return text
    // 1. Bracketed cues — handles empty `[]` too so we don't leave the
    //    literal characters behind.
    .replace(/\[[^\]]*\]/g, '')
    // 2. Markdown header lines (full-line match).
    .replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, '')
    // 3. Whole metadata lines. Match any line containing the canonical
    //    phrases the generator uses — case insensitive, multiline.
    .replace(
      /^.*\b(?:total\s+spoken\s+word\s+count|spoken\s+words?\s*[:=]|word\s+count\s+so\s+far|word\s+count\s*[:=]|wordcount\s*[:=]|estimated\s+duration\s*[:=])\b.*$/gim,
      '',
    )
    // 4. Inline parenthetical metadata. `[^()]*` keeps the match on a
    //    single nesting level so we don't blow past the closing paren.
    .replace(
      /\([^()]*\b(?:spoken\s+words?|word\s+count(?:\s+so\s+far)?|wordcount|estimated\s+duration)\b[^()]*\)/gi,
      '',
    )
    // 5. Markdown emphasis — keep the inner text. Order matters:
    //    `**`/`__` (bold) before `*`/`_` (italic) so we don't half-strip.
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]+?)\*(?!\w)/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+?)_(?!\w)/g, '$1')
    // Whitespace cleanup. Trailing spaces on a line + 3+ newlines → one
    //    paragraph break.
    .replace(/[ \t]+(\r?\n)/g, '$1')
    .replace(/(\r?\n){3,}/g, '\n\n')
    .trim();
}

export function countWords(text: string): number {
  return stripProductionCues(text).split(/\s+/).filter(Boolean).length;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function timeAgo(date: string | Date): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return d.toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function scoreColor(score: number): string {
  if (score >= 75) return 'score-high';
  if (score >= 50) return 'score-mid';
  return 'score-low';
}

export function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Fair';
  if (score >= 40) return 'Poor';
  return 'Critical';
}

export function parseDurationToISO(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0');
  const s = parseInt(match[3] || '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
