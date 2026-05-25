/**
 * Client-safe constants + types for the channel-description generator.
 *
 * Kept out of `prompts.ts` because that file imports server-only modules
 * (channel-brand-kit pulls in @vercel/postgres). Both server (the prompt
 * builder + the API route) and client (the modal in /components/channel)
 * import from here.
 */

export type ChannelDescriptionStyle =
  | 'short-bio'
  | 'seo-heavy'
  | 'with-chapters'
  | 'story-driven'
  | 'authority';

export const CHANNEL_DESCRIPTION_STYLES: ReadonlyArray<{
  value: ChannelDescriptionStyle;
  label: string;
  hint: string;
}> = [
  { value: 'short-bio',     label: 'Short bio',          hint: '2–3 sentence elevator pitch, under 80 words' },
  { value: 'seo-heavy',     label: 'SEO-heavy',          hint: 'Keyword-dense, structured for discovery; 200–350 words' },
  { value: 'with-chapters', label: 'With sections',      hint: 'Adds "What you\'ll find here / Upload schedule / Connect" headers' },
  { value: 'story-driven',  label: 'Story-driven',       hint: 'Leads with the channel\'s why, first-person, narrative' },
  { value: 'authority',     label: 'Authority',          hint: 'Credentials-first, expert framing, third-person tone' },
];
