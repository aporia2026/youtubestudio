/**
 * Unit tests for the voice-profile LLM-response parser + Gemini
 * response extractor (Plan 1A).
 *
 * No model calls — these tests exercise the pure parsing branches
 * with hand-crafted payloads, including the well-formed golden path,
 * markdown-fence stripping, enum violation, missing field, and the
 * empty-output empty-state path.
 *
 * See _plans/2026-06-07-channel-clone-narrator-voice-elevenlabs.md.
 */

import { describe, expect, it } from 'vitest';
import {
  extractTextFromGeminiResponse,
  parseVoiceProfileResponse,
} from '@/lib/channel-clone/voice-profile-runner';

const VALID_PROFILE = {
  gender: 'male',
  ageBracket: 'middle-aged',
  pace: 'moderate',
  timbre: 'warm baritone with slight nasal resonance',
  accent: 'general american',
  energy: 'measured',
  emotionalRegister: 'wry, knowing, slightly detached',
  signatureMoves: [
    'rising terminal on rhetorical questions',
    'breathy emphasis on key nouns',
    'half-second pauses before reveals',
  ],
  voiceDesignPrompt:
    'A middle-aged American male narrator with a warm baritone voice, measured pace, and a wry, knowing delivery. Subtle nasal resonance and a soft rising terminal on questions. Breathy emphasis on key nouns and half-second pauses before reveals create an intimate, conspiratorial register.',
};

describe('voice-profile: parseVoiceProfileResponse — golden path', () => {
  it('parses a well-formed JSON response', () => {
    const result = parseVoiceProfileResponse(JSON.stringify(VALID_PROFILE), 'kie-gemini-2.5-flash');
    expect(result.gender).toBe('male');
    expect(result.ageBracket).toBe('middle-aged');
    expect(result.pace).toBe('moderate');
    expect(result.energy).toBe('measured');
    expect(result.timbre).toBe('warm baritone with slight nasal resonance');
    expect(result.accent).toBe('general american');
    expect(result.signatureMoves).toHaveLength(3);
    expect(result.voiceDesignPrompt).toMatch(/middle-aged/);
    expect(result.modelUsed).toBe('kie-gemini-2.5-flash');
    expect(typeof result.analyzedAt).toBe('string');
  });

  it('strips ```json … ``` markdown fences before parsing', () => {
    const fenced = '```json\n' + JSON.stringify(VALID_PROFILE) + '\n```';
    const result = parseVoiceProfileResponse(fenced, 'kie-gemini-2.5-flash');
    expect(result.gender).toBe('male');
  });

  it('strips bare ``` fences (no language hint)', () => {
    const fenced = '```\n' + JSON.stringify(VALID_PROFILE) + '\n```';
    const result = parseVoiceProfileResponse(fenced, 'kie-gemini-2.5-flash');
    expect(result.gender).toBe('male');
  });

  it('trims leading and trailing whitespace', () => {
    const padded = '\n   ' + JSON.stringify(VALID_PROFILE) + '   \n';
    const result = parseVoiceProfileResponse(padded, 'kie-gemini-2.5-flash');
    expect(result.gender).toBe('male');
  });
});

describe('voice-profile: parseVoiceProfileResponse — failure modes', () => {
  it('throws on empty string', () => {
    expect(() => parseVoiceProfileResponse('', 'kie-gemini-2.5-flash')).toThrow();
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseVoiceProfileResponse('this is not JSON', 'kie-gemini-2.5-flash')).toThrow();
  });

  it('throws when gender carries an invalid enum value', () => {
    const bad = { ...VALID_PROFILE, gender: 'robot' };
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/gender/);
  });

  it('throws when ageBracket is missing', () => {
    const bad: Record<string, unknown> = { ...VALID_PROFILE };
    delete bad.ageBracket;
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/ageBracket/);
  });

  it('throws when pace has an invalid enum value', () => {
    const bad = { ...VALID_PROFILE, pace: 'glacial' };
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/pace/);
  });

  it('throws when voiceDesignPrompt is missing', () => {
    const bad: Record<string, unknown> = { ...VALID_PROFILE };
    delete bad.voiceDesignPrompt;
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/voiceDesignPrompt/);
  });

  it('throws when signatureMoves is an empty array', () => {
    const bad = { ...VALID_PROFILE, signatureMoves: [] };
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/signatureMoves/);
  });

  it('throws when signatureMoves is not an array at all', () => {
    const bad = { ...VALID_PROFILE, signatureMoves: 'pauses' };
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/signatureMoves/);
  });

  it('throws on an empty timbre string', () => {
    const bad = { ...VALID_PROFILE, timbre: '   ' };
    expect(() => parseVoiceProfileResponse(JSON.stringify(bad), 'kie-gemini-2.5-flash')).toThrow(/timbre/);
  });

  it('throws on a non-object response (top-level array)', () => {
    expect(() => parseVoiceProfileResponse('[1, 2, 3]', 'kie-gemini-2.5-flash')).toThrow();
  });
});

describe('voice-profile: extractTextFromGeminiResponse', () => {
  it('returns the first text part from the first candidate', () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [{ text: 'hello world' }],
          },
        },
      ],
    };
    expect(extractTextFromGeminiResponse(data)).toBe('hello world');
  });

  it('returns the first non-empty text across multiple parts', () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [{ text: '' }, { text: 'real content' }],
          },
        },
      ],
    };
    expect(extractTextFromGeminiResponse(data)).toBe('real content');
  });

  it('returns empty string when there are no candidates', () => {
    expect(extractTextFromGeminiResponse({})).toBe('');
    expect(extractTextFromGeminiResponse({ candidates: [] })).toBe('');
  });

  it('returns empty string when content.parts is missing', () => {
    const data = { candidates: [{ content: {} }] };
    expect(extractTextFromGeminiResponse(data)).toBe('');
  });

  it('returns empty string when every text part is empty', () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [{ text: '' }, { text: '' }],
          },
        },
      ],
    };
    expect(extractTextFromGeminiResponse(data)).toBe('');
  });

  it('falls through to the second candidate if the first has no text', () => {
    const data = {
      candidates: [
        { content: { parts: [{ text: '' }] } },
        { content: { parts: [{ text: 'fallback' }] } },
      ],
    };
    expect(extractTextFromGeminiResponse(data)).toBe('fallback');
  });
});
