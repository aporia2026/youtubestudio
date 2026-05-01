/**
 * Per-channel brand kit — voice / tone / banned-phrase / hook-style guidance
 * that auto-pipes into every script-generation and QA prompt when the
 * channel is the active one.
 *
 * Stored in `channels.brand_kit` (JSONB). Versioned shape so future fields
 * can be added without coordinated migrations. `parseBrandKit` is fault-
 * tolerant: a corrupt blob, version mismatch, or missing field returns a
 * conservative default rather than throwing — a malformed kit shouldn't
 * break script generation.
 */
import { sql } from '@vercel/postgres';
import type { SessionPayload } from './session';
import { getActiveChannelId } from './active-channel';

export const BRAND_KIT_VERSION = 1;

export type VocabularyLevel = 'casual' | 'conversational' | 'professional' | 'technical';
export type SentenceLength = 'short' | 'medium' | 'long' | 'mixed';

export interface ChannelBrandKit {
  v: typeof BRAND_KIT_VERSION;
  /** Sample sentences from prior scripts — the LLM is instructed to write IN this voice. */
  voice_examples?: string[];
  /** Free-text tone descriptor: "warm authority", "irreverent expert", etc. */
  tone?: string;
  vocabulary_level?: VocabularyLevel;
  sentence_length?: SentenceLength;
  /** Phrases the LLM must NEVER write. Adds to the global AI-cliché blocklist. */
  banned_phrases?: string[];
  /** Phrases the LLM must work in (channel slogans, recurring callbacks). */
  required_phrases?: string[];
  topics_to_avoid?: string[];
  topics_to_emphasize?: string[];
  /** Free-text hook recipe: "data-driven cold open with a surprising stat". */
  hook_style?: string;
  intro_template?: string;
  cta_template?: string;
  outro_template?: string;
  /** SEO seeds — keywords to work in naturally. */
  brand_keywords?: string[];
}

const DEFAULTS: ChannelBrandKit = { v: BRAND_KIT_VERSION };

const VOCAB: ReadonlySet<string> = new Set(['casual', 'conversational', 'professional', 'technical']);
const SENTENCE: ReadonlySet<string> = new Set(['short', 'medium', 'long', 'mixed']);

/**
 * Pure parser. Accepts any unknown blob (from JSONB or a typed response)
 * and returns a well-shaped ChannelBrandKit. Anything that doesn't match
 * the schema is silently dropped.
 */
export function parseBrandKit(raw: unknown): ChannelBrandKit {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const obj = raw as Record<string, unknown>;
  // Tolerate missing v on legacy rows seeded with {} default — treat as v1.
  if (obj.v !== undefined && obj.v !== BRAND_KIT_VERSION) return { ...DEFAULTS };

  const out: ChannelBrandKit = { v: BRAND_KIT_VERSION };

  const stringArray = (k: string): string[] | undefined => {
    const v = obj[k];
    if (!Array.isArray(v)) return undefined;
    const cleaned = v
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const trimmedString = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };

  const voice = stringArray('voice_examples');
  if (voice) out.voice_examples = voice.slice(0, 10);
  const tone = trimmedString('tone');
  if (tone) out.tone = tone;
  if (typeof obj.vocabulary_level === 'string' && VOCAB.has(obj.vocabulary_level)) {
    out.vocabulary_level = obj.vocabulary_level as VocabularyLevel;
  }
  if (typeof obj.sentence_length === 'string' && SENTENCE.has(obj.sentence_length)) {
    out.sentence_length = obj.sentence_length as SentenceLength;
  }
  const banned = stringArray('banned_phrases');
  if (banned) out.banned_phrases = banned.slice(0, 50);
  const required = stringArray('required_phrases');
  if (required) out.required_phrases = required.slice(0, 25);
  const avoid = stringArray('topics_to_avoid');
  if (avoid) out.topics_to_avoid = avoid.slice(0, 25);
  const emphasize = stringArray('topics_to_emphasize');
  if (emphasize) out.topics_to_emphasize = emphasize.slice(0, 25);
  const hook = trimmedString('hook_style');
  if (hook) out.hook_style = hook;
  const intro = trimmedString('intro_template');
  if (intro) out.intro_template = intro;
  const cta = trimmedString('cta_template');
  if (cta) out.cta_template = cta;
  const outro = trimmedString('outro_template');
  if (outro) out.outro_template = outro;
  const keywords = stringArray('brand_keywords');
  if (keywords) out.brand_keywords = keywords.slice(0, 50);

  return out;
}

/** True if the kit has any user-provided guidance worth piping into prompts. */
export function isBrandKitNonEmpty(kit: ChannelBrandKit): boolean {
  return (
    Boolean(kit.tone) ||
    Boolean(kit.vocabulary_level) ||
    Boolean(kit.sentence_length) ||
    Boolean(kit.hook_style) ||
    Boolean(kit.intro_template) ||
    Boolean(kit.cta_template) ||
    Boolean(kit.outro_template) ||
    (kit.voice_examples?.length ?? 0) > 0 ||
    (kit.banned_phrases?.length ?? 0) > 0 ||
    (kit.required_phrases?.length ?? 0) > 0 ||
    (kit.topics_to_avoid?.length ?? 0) > 0 ||
    (kit.topics_to_emphasize?.length ?? 0) > 0 ||
    (kit.brand_keywords?.length ?? 0) > 0
  );
}

/**
 * Render the kit as a system-prompt block. Empty kits return ''. The block
 * is framed as non-negotiable so it overrides conflicting style guidance
 * lower in the prompt.
 *
 * Pure — used by the prompt builders in src/lib/prompts.ts.
 */
export function buildBrandKitPromptBlock(kit: ChannelBrandKit | null | undefined): string {
  if (!kit || !isBrandKitNonEmpty(kit)) return '';
  const lines: string[] = [];
  if (kit.tone) lines.push(`- Tone: ${kit.tone}`);
  if (kit.vocabulary_level) lines.push(`- Vocabulary level: ${kit.vocabulary_level}`);
  if (kit.sentence_length) {
    const note =
      kit.sentence_length === 'short'
        ? 'short, punchy, mostly under 12 words'
        : kit.sentence_length === 'long'
          ? 'longer rolling sentences with deliberate momentum'
          : kit.sentence_length === 'mixed'
            ? 'mixed — alternate short punches with longer rolling sentences for rhythm'
            : 'medium — average 12-20 words per sentence';
    lines.push(`- Sentence length: ${note}`);
  }
  if (kit.voice_examples?.length) {
    lines.push(`- Write IN this voice (sample sentences from prior on-brand scripts):`);
    for (const v of kit.voice_examples.slice(0, 5)) lines.push(`  • "${v}"`);
  }
  if (kit.banned_phrases?.length) {
    lines.push(`- NEVER write any of these phrases: ${kit.banned_phrases.map((p) => `"${p}"`).join(', ')}`);
  }
  if (kit.required_phrases?.length) {
    lines.push(`- Work in at least one of these channel callbacks naturally: ${kit.required_phrases.map((p) => `"${p}"`).join(', ')}`);
  }
  if (kit.hook_style) lines.push(`- Hook recipe: ${kit.hook_style}`);
  if (kit.intro_template) lines.push(`- Intro pattern: ${kit.intro_template}`);
  if (kit.cta_template) lines.push(`- CTA pattern: ${kit.cta_template}`);
  if (kit.outro_template) lines.push(`- Outro pattern: ${kit.outro_template}`);
  if (kit.topics_to_avoid?.length) lines.push(`- Topics to avoid: ${kit.topics_to_avoid.join(', ')}`);
  if (kit.topics_to_emphasize?.length) lines.push(`- Topics to emphasize: ${kit.topics_to_emphasize.join(', ')}`);
  if (kit.brand_keywords?.length) lines.push(`- SEO keywords (work in naturally; do not stuff): ${kit.brand_keywords.join(', ')}`);
  return `\n\n## CHANNEL BRAND KIT — non-negotiable, applies every line\n${lines.join('\n')}\n\nThe brand kit overrides any conflicting style guidance below.`;
}

// ---------------------------------------------------------------------------
// DB I/O
// ---------------------------------------------------------------------------

export class ChannelNotFoundError extends Error {
  constructor(channelId: string) {
    super(`Channel ${channelId} not found in this workspace.`);
    this.name = 'ChannelNotFoundError';
  }
}

/** Read a channel's brand kit. Workspace-scoped — returns null if the
 *  channel doesn't exist in the user's workspace. */
export async function getChannelBrandKit(
  channelId: string,
  workspaceId: string,
): Promise<ChannelBrandKit | null> {
  if (!channelId) return null;
  const { rows } = await sql<{ brand_kit: unknown }>`
    SELECT brand_kit FROM channels
     WHERE id = ${channelId}::uuid AND workspace_id = ${workspaceId}::uuid
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  return parseBrandKit(rows[0]!.brand_kit);
}

/** Replace a channel's brand kit. Validates ownership before writing. */
export async function updateChannelBrandKit(
  channelId: string,
  workspaceId: string,
  patch: Partial<ChannelBrandKit>,
): Promise<ChannelBrandKit> {
  // Re-validate the patch through parseBrandKit so we never persist garbage.
  const sanitized = parseBrandKit({ ...patch, v: BRAND_KIT_VERSION });
  const { rowCount } = await sql`
    UPDATE channels
       SET brand_kit = ${JSON.stringify(sanitized)}::jsonb
     WHERE id = ${channelId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  if (rowCount === 0) throw new ChannelNotFoundError(channelId);
  return sanitized;
}

/**
 * Resolve the brand kit for an incoming generation request.
 *
 * Priority:
 *   1. Explicit `bodyChannelId` if the route accepted one.
 *   2. The user's pinned active-channel.
 *   3. Otherwise null (no brand kit applies).
 *
 * Returns null on every failure path (channel deleted, cross-workspace,
 * etc.) so generation never breaks because of a bad kit reference.
 */
export async function resolveBrandKitForRequest(
  session: SessionPayload,
  bodyChannelId?: string | null,
): Promise<ChannelBrandKit | null> {
  let channelId: string | null = null;
  if (typeof bodyChannelId === 'string' && bodyChannelId) {
    channelId = bodyChannelId;
  } else {
    channelId = await getActiveChannelId(session.uid);
  }
  if (!channelId) return null;
  try {
    return await getChannelBrandKit(channelId, session.ws);
  } catch {
    return null;
  }
}
