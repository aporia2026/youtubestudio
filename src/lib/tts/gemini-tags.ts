/**
 * Curated audio-tag library for Gemini-TTS style control.
 *
 * Google's docs at docs.cloud.google.com/text-to-speech/docs/gemini-tts
 * formally list 13 tags. The model accepts many additional bracketed
 * adjectives as style hints, but only the documented ones are
 * guaranteed to behave consistently. We surface both sets in the
 * picker, clearly distinguished:
 *
 *   - "documented" — straight from Google's spec
 *   - "experimental" — commonly cited (forums, blog posts, examples)
 *     but not in the official spec. Probably works for many use cases;
 *     test before relying on for production narration.
 *
 * Tags drop into the script text inline, e.g.:
 *
 *   "[whispering] I have a secret. [pause] You won't believe it. [laughing]"
 *
 * The text + style prompt together must stay under 8,000 bytes (text
 * alone under 4,000). The provider's chunker enforces those limits.
 *
 * Search keys cover both the tag bracketed form and free-form
 * keywords ("sad" matches `[sadness]`, "pause" matches all pause
 * variants) so the searchable picker doesn't need exact bracket-form
 * matching.
 */

export interface GeminiTag {
  /** The exact text to insert into the script, including brackets. */
  insert: string;
  /** Short user-facing label. */
  label: string;
  /** Group for the searchable picker UI. */
  category: 'non-speech' | 'pacing' | 'emotion' | 'style' | 'voice';
  /** 'documented' tags are in Google's spec; 'experimental' are
   *  commonly cited but unguaranteed. */
  source: 'documented' | 'experimental';
  /** Optional extra keywords for the search field. */
  keywords?: string[];
}

export const GEMINI_TAGS: ReadonlyArray<GeminiTag> = [
  // ─── Documented (Google spec) ────────────────────────────────────────

  // Non-speech sounds
  { insert: '[sigh]', label: 'Sigh', category: 'non-speech', source: 'documented' },
  { insert: '[laughing]', label: 'Laughing', category: 'non-speech', source: 'documented', keywords: ['laugh', 'haha'] },
  { insert: '[uhm]', label: 'Uhm', category: 'non-speech', source: 'documented', keywords: ['hesitation', 'um', 'thinking'] },

  // Style modifiers
  { insert: '[sarcasm]', label: 'Sarcastic', category: 'style', source: 'documented', keywords: ['sarcastic', 'dry'] },
  { insert: '[robotic]', label: 'Robotic', category: 'style', source: 'documented', keywords: ['robot', 'monotone'] },
  { insert: '[shouting]', label: 'Shouting', category: 'style', source: 'documented', keywords: ['loud', 'yell'] },
  { insert: '[whispering]', label: 'Whispering', category: 'style', source: 'documented', keywords: ['whisper', 'quiet'] },
  { insert: '[extremely fast]', label: 'Extremely fast', category: 'style', source: 'documented', keywords: ['fast', 'speed', 'rushed'] },

  // Vocalized emotion adjectives
  { insert: '[scared]', label: 'Scared', category: 'emotion', source: 'documented', keywords: ['fear', 'frightened'] },
  { insert: '[curious]', label: 'Curious', category: 'emotion', source: 'documented', keywords: ['interested', 'inquisitive'] },
  { insert: '[bored]', label: 'Bored', category: 'emotion', source: 'documented', keywords: ['flat', 'uninterested'] },

  // Pacing
  { insert: '[short pause]', label: 'Short pause', category: 'pacing', source: 'documented', keywords: ['pause', 'beat'] },
  { insert: '[medium pause]', label: 'Medium pause', category: 'pacing', source: 'documented', keywords: ['pause'] },
  { insert: '[long pause]', label: 'Long pause', category: 'pacing', source: 'documented', keywords: ['pause', 'silence'] },

  // ─── Experimental (commonly cited; not in the official spec) ─────────

  // Non-speech sounds
  { insert: '[laughs]', label: 'Laughs', category: 'non-speech', source: 'experimental' },
  { insert: '[chuckles]', label: 'Chuckles', category: 'non-speech', source: 'experimental' },
  { insert: '[gasps]', label: 'Gasps', category: 'non-speech', source: 'experimental', keywords: ['shocked', 'surprised'] },
  { insert: '[clears throat]', label: 'Clears throat', category: 'non-speech', source: 'experimental' },
  { insert: '[breathes deeply]', label: 'Deep breath', category: 'non-speech', source: 'experimental', keywords: ['breath', 'sigh'] },
  { insert: '[exhales]', label: 'Exhales', category: 'non-speech', source: 'experimental', keywords: ['breath'] },

  // Emotions
  { insert: '[excited]', label: 'Excited', category: 'emotion', source: 'experimental', keywords: ['enthusiasm', 'hype'] },
  { insert: '[enthusiasm]', label: 'Enthusiastic', category: 'emotion', source: 'experimental' },
  { insert: '[nervous]', label: 'Nervous', category: 'emotion', source: 'experimental', keywords: ['anxiety', 'worried'] },
  { insert: '[angry]', label: 'Angry', category: 'emotion', source: 'experimental', keywords: ['mad', 'furious'] },
  { insert: '[sad]', label: 'Sad', category: 'emotion', source: 'experimental', keywords: ['sadness', 'down'] },
  { insert: '[happy]', label: 'Happy', category: 'emotion', source: 'experimental', keywords: ['joy', 'cheerful'] },
  { insert: '[surprised]', label: 'Surprised', category: 'emotion', source: 'experimental', keywords: ['shock'] },
  { insert: '[calm]', label: 'Calm', category: 'emotion', source: 'experimental', keywords: ['relaxed', 'peaceful'] },
  { insert: '[confident]', label: 'Confident', category: 'emotion', source: 'experimental', keywords: ['assertive'] },
  { insert: '[hesitant]', label: 'Hesitant', category: 'emotion', source: 'experimental', keywords: ['unsure'] },
  { insert: '[disappointed]', label: 'Disappointed', category: 'emotion', source: 'experimental' },
  { insert: '[awe]', label: 'In awe', category: 'emotion', source: 'experimental', keywords: ['wonder'] },
  { insert: '[admiration]', label: 'Admiring', category: 'emotion', source: 'experimental' },
  { insert: '[amused]', label: 'Amused', category: 'emotion', source: 'experimental', keywords: ['amusement'] },
  { insert: '[determined]', label: 'Determined', category: 'emotion', source: 'experimental', keywords: ['determination', 'resolute'] },
  { insert: '[hopeful]', label: 'Hopeful', category: 'emotion', source: 'experimental', keywords: ['hope', 'optimistic'] },
  { insert: '[frustrated]', label: 'Frustrated', category: 'emotion', source: 'experimental', keywords: ['frustration', 'annoyed'] },

  // Voice characteristics
  { insert: '[deep voice]', label: 'Deep voice', category: 'voice', source: 'experimental', keywords: ['low', 'bass'] },
  { insert: '[high pitched]', label: 'High pitched', category: 'voice', source: 'experimental', keywords: ['squeaky'] },
  { insert: '[soft]', label: 'Soft', category: 'voice', source: 'experimental', keywords: ['gentle', 'quiet'] },
  { insert: '[loud]', label: 'Loud', category: 'voice', source: 'experimental', keywords: ['volume'] },
  { insert: '[trembling]', label: 'Trembling', category: 'voice', source: 'experimental', keywords: ['shaky', 'scared'] },
  { insert: '[breathy]', label: 'Breathy', category: 'voice', source: 'experimental', keywords: ['airy'] },

  // Style modifiers
  { insert: '[dramatic]', label: 'Dramatic', category: 'style', source: 'experimental' },
  { insert: '[mysterious]', label: 'Mysterious', category: 'style', source: 'experimental' },
  { insert: '[storytelling]', label: 'Storytelling', category: 'style', source: 'experimental', keywords: ['narrative', 'narrator'] },
  { insert: '[conspiratorial]', label: 'Conspiratorial', category: 'style', source: 'experimental', keywords: ['secret'] },
  { insert: '[playful]', label: 'Playful', category: 'style', source: 'experimental' },
  { insert: '[serious]', label: 'Serious', category: 'style', source: 'experimental', keywords: ['grave'] },
  { insert: '[urgent]', label: 'Urgent', category: 'style', source: 'experimental', keywords: ['hurry'] },
  { insert: '[slow]', label: 'Slow', category: 'style', source: 'experimental', keywords: ['relaxed pace'] },

  // Pacing
  { insert: '[pause]', label: 'Pause', category: 'pacing', source: 'experimental', keywords: ['silence', 'beat'] },
  { insert: '[breath]', label: 'Breath', category: 'pacing', source: 'experimental' },
];

export const TAG_CATEGORY_LABELS: Readonly<Record<GeminiTag['category'], string>> = {
  'non-speech': 'Non-speech sounds',
  pacing: 'Pacing & pauses',
  emotion: 'Emotion',
  style: 'Style',
  voice: 'Voice character',
};

/**
 * Filter tags by free-form query. Matches against label, insert form
 * (with or without brackets), and the keywords list.
 */
export function searchTags(query: string): GeminiTag[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...GEMINI_TAGS];
  return GEMINI_TAGS.filter((t) => {
    if (t.label.toLowerCase().includes(q)) return true;
    if (t.insert.toLowerCase().includes(q)) return true;
    if (t.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    if (t.category.toLowerCase().includes(q)) return true;
    return false;
  });
}
