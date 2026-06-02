/**
 * Hook scoring — measures how strong a Short's opening line is, 0..1.
 *
 * Used by:
 *   - Mode A (clip-scorer.ts) to rank candidate moments by their first
 *     1.5s of caption text.
 *   - Mode C (Phase 2 shorts-qa.ts) as a dedicated QA criterion.
 *
 * Why pure / deterministic:
 *   Auto-fan-out fires on every long-form script save. Even one AI call
 *   per candidate × 3 candidates per fire × N fires per day adds up. The
 *   council's expansion case (auto-fan-out as compounding wedge) only
 *   stays cheap if the per-candidate scoring is heuristic. We can add an
 *   AI calibration pass behind a workspace setting later; for Phase 1
 *   the deterministic floor is the bar.
 *
 * The heuristics:
 *   - Strong-hook patterns (question forms, concrete numbers,
 *     second-person, negation / counter-intuitive flags, action verbs,
 *     high-impact lone words) PUSH the score up.
 *   - Weak-hook patterns (filler openers, "let's / let me", channel
 *     boilerplate "hey guys / in this video") PULL it down.
 *   - Length boundaries cap the score: anything under 3 spoken words is
 *     too thin to evaluate; anything over 20 words is too dense to land
 *     inside the 1.5s window the algorithm rewards.
 *
 * What this is NOT:
 *   - Not a content-quality judge. A grammatically clean hook that's
 *     boring will still score high; a typo-ridden hook that's electric
 *     will still score low. That's the trade-off for being deterministic.
 *   - Not a guarantee. Scores correlate with hook strength on the
 *     training-set patterns; they don't predict performance.
 *
 * Caller responsibility:
 *   The caller slices the opening — this function does not look at
 *   anything beyond the first ~1.5s the caller passes in.
 */

export interface HookScoreResult {
  /** 0..1 confidence the opening is a strong Shorts hook. */
  score: number;
  /** Human-readable reasons that moved the score (for debug + UI explain). */
  reasons: string[];
}

/** Words considered "filler" when they OPEN the hook. Lowercased + de-punctuated
 *  before lookup. Ordered roughly by frequency of misuse. */
const FILLER_OPENERS = new Set([
  'today', 'so', 'well', 'okay', 'ok', 'um', 'uh', 'like',
  'hey', 'hi', 'hello', 'alright', 'now', 'actually', 'basically',
]);

/** Multi-word channel-boilerplate openings. Stored in NORMALIZED form
 *  (lowercased, no punctuation) so `normalized.startsWith(prefix)` matches
 *  after the same normalize() the input goes through. */
const BOILERPLATE_PREFIXES = [
  'in this video',
  'on this channel',
  'welcome back',
  'welcome to',
  'hey guys',
  'hey everyone',
  'hey friends',
  'what s up',         // "what's up" with apostrophe stripped
  'whats up',
  'thanks for watching',
  'thanks for joining',
  'we re going to',    // "we're going to"
  'we are going to',
  'today i want to',
  'today we want to',
];

/** "Let's / Let me / Let us" — softer-than-filler but still weak.
 *  Apostrophes stripped to match the normalized input. */
const LET_PREFIXES = ['let s', 'let us', 'let me'];

/** Spelled-out cardinal numbers — caught as "specific number" hits the
 *  same way digits are. "one" is intentionally excluded: it's noisy as a
 *  generic pronoun ("no one knows"). */
const SPELLED_NUMBERS = new Set([
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'twenty', 'thirty', 'fifty', 'hundred', 'thousand', 'million',
]);

/** Interrogative leading words — used as a hint when there's no `?`. */
const WH_OPENERS = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose']);

/** Words that signal a counter-intuitive / negation hook. Lowercased. */
const NEGATION_HITS = new Set([
  'never', "shouldn't", 'shouldnt', "doesn't", 'doesnt',
  "isn't", 'isnt', "won't", 'wont', "can't", 'cant',
  'nobody', 'no one', 'nothing', 'nowhere',
  'wrong', 'lie', 'lied', 'lies', 'myth', 'mistake', 'mistakes',
  'but', 'however', 'except', 'unless',
]);

/** Action / imperative verbs that punch in a 1.5s opening. */
const ACTION_VERBS = new Set([
  'stop', 'watch', 'listen', 'look', 'wait', 'remember',
  'will', "won't", 'wont', 'should', 'must', 'have',
]);

/** Second-person pronouns + possessives. */
const SECOND_PERSON = new Set([
  'you', 'your', 'yours', 'yourself', "you're", 'youre', "you'll", 'youll',
  "you've", 'youve', "you'd", 'youd',
]);

/** High-impact lone words (capped) that suggest a specific reveal. */
const IMPACT_WORDS = new Set([
  'secret', 'truth', 'lie', 'real', 'actually', 'this',
  'exactly', 'every', 'only', 'first', 'last', 'best', 'worst',
]);

/** Drops punctuation and lowercases. Returns the cleaned text. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:()"'`]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Splits on whitespace, drops empty tokens, returns word array. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function scoreHook(opening: string): HookScoreResult {
  const raw = (opening ?? '').toString();
  if (!raw.trim()) return { score: 0, reasons: ['empty input'] };

  const normalized = normalize(raw);
  const words = tokenize(normalized);
  const reasons: string[] = [];

  // Length boundaries — hard caps before any bonus/penalty math.
  if (words.length < 3) {
    return { score: 0.3, reasons: ['too short (under 3 words)'] };
  }
  if (words.length > 20) {
    // Score gets a soft cap rather than a hard one — a 21-word opening can
    // still beat boilerplate, but won't max out.
    reasons.push(`long opening (${words.length} words) — soft cap 0.6`);
  }

  let score = 0.5; // Neutral starting point.

  // ── Strong signals ────────────────────────────────────────────────────
  const hasQuestionMark = /\?/.test(raw);
  const firstWord = words[0] ?? '';
  if (hasQuestionMark) {
    score += 0.15;
    reasons.push('question form (+0.15)');
  } else if (WH_OPENERS.has(firstWord)) {
    score += 0.10;
    reasons.push(`opens with "${firstWord}" (+0.10)`);
  }

  // Concrete numbers — digits OR spelled-out cardinals. The spelled-out
  // check matters because Shorts scripts are almost always written, not
  // typed-by-hand, so "three reasons" is more common than "3 reasons".
  const hasDigit = /\d/.test(raw);
  const hasSpelledNumber = words.some((w) => SPELLED_NUMBERS.has(w));
  if (hasDigit || hasSpelledNumber) {
    score += 0.10;
    reasons.push('contains a specific number (+0.10)');
  }

  // Second-person pronouns.
  let secondPersonHits = 0;
  for (const w of words) {
    if (SECOND_PERSON.has(w)) secondPersonHits++;
  }
  if (secondPersonHits > 0) {
    score += 0.10;
    reasons.push(`second-person address (+0.10)`);
  }

  // Negation / counter-intuitive.
  let negationHits = 0;
  for (const w of words) {
    if (NEGATION_HITS.has(w)) negationHits++;
  }
  if (normalized.includes('no one')) negationHits++;
  if (negationHits > 0) {
    score += 0.10;
    reasons.push('counter-intuitive / negation marker (+0.10)');
  }

  // Action verbs.
  let actionHits = 0;
  for (const w of words) {
    if (ACTION_VERBS.has(w)) actionHits++;
  }
  if (actionHits > 0) {
    score += 0.08;
    reasons.push('action / imperative verb (+0.08)');
  }

  // High-impact words — capped at 0.10 regardless of count.
  let impactHits = 0;
  for (const w of words) {
    if (IMPACT_WORDS.has(w)) impactHits++;
  }
  if (impactHits > 0) {
    const delta = Math.min(0.10, impactHits * 0.05);
    score += delta;
    reasons.push(`high-impact word(s) (+${delta.toFixed(2)})`);
  }

  // ── Weak signals ──────────────────────────────────────────────────────
  if (FILLER_OPENERS.has(firstWord)) {
    score -= 0.20;
    reasons.push(`weak opener "${firstWord}" (-0.20)`);
  }

  for (const prefix of BOILERPLATE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      score -= 0.20;
      reasons.push(`channel boilerplate "${prefix}" (-0.20)`);
      break;
    }
  }

  for (const prefix of LET_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      score -= 0.10;
      reasons.push(`weak "${prefix}" opener (-0.10)`);
      break;
    }
  }

  // Soft cap on long openings.
  if (words.length > 20) {
    score = Math.min(score, 0.6);
  }

  // Final clamp.
  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(3)), reasons };
}
