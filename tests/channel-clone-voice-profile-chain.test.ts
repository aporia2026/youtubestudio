/**
 * Tests for the voice-profile fallback chain builder.
 *
 * The runner walks an ordered list of audio-capable Kie Gemini models.
 * Critical properties tested here:
 *   - Operator-picked / configured model is tried FIRST.
 *   - Every default fallback gets a turn after that (deduped).
 *   - Unknown / non-Kie-Gemini ids are excluded so the runner doesn't
 *     waste a call on a model that has no audio path.
 *
 * See src/lib/channel-clone/voice-profile-runner.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildVoiceProfileModelChain } from '@/lib/channel-clone/voice-profile-runner';

describe('buildVoiceProfileModelChain', () => {
  it('puts the configured model first', () => {
    const chain = buildVoiceProfileModelChain('kie-gemini-3-pro');
    expect(chain[0]).toBe('kie-gemini-3-pro');
  });

  it('includes every Kie Gemini variant exactly once', () => {
    const chain = buildVoiceProfileModelChain('kie-gemini-3-5-flash');
    const unique = new Set(chain);
    expect(unique.size).toBe(chain.length);
    // All 6 Kie Gemini variants should be in there.
    expect(chain).toContain('kie-gemini-3-5-flash');
    expect(chain).toContain('kie-gemini-2.5-flash');
    expect(chain).toContain('kie-gemini-3-pro');
    expect(chain).toContain('kie-gemini-2.5-pro');
    expect(chain).toContain('kie-gemini-3-flash');
    expect(chain).toContain('kie-gemini-3.1-pro');
  });

  it('excludes non-Kie-Gemini ids when supplied as the primary', () => {
    // The runner gets a non-audio-capable model as the configured
    // default (e.g. Anthropic). The chain should drop that and start
    // from the fallback defaults.
    const chain = buildVoiceProfileModelChain('claude-opus-4-8');
    expect(chain).not.toContain('claude-opus-4-8');
    expect(chain[0]).toBe('kie-gemini-3-5-flash'); // default fallback head
  });

  it('excludes an unknown id when supplied as the primary', () => {
    const chain = buildVoiceProfileModelChain('made-up-model-id');
    expect(chain).not.toContain('made-up-model-id');
    expect(chain[0]).toBe('kie-gemini-3-5-flash');
  });

  it('does not duplicate the primary when it is also a fallback default', () => {
    const chain = buildVoiceProfileModelChain('kie-gemini-2.5-flash');
    const firstAppearance = chain.indexOf('kie-gemini-2.5-flash');
    const lastAppearance = chain.lastIndexOf('kie-gemini-2.5-flash');
    expect(firstAppearance).toBe(lastAppearance);
    expect(firstAppearance).toBe(0); // and it's at the head
  });

  it('returns a chain of length 6 when a Kie Gemini is the primary', () => {
    expect(buildVoiceProfileModelChain('kie-gemini-3-5-flash')).toHaveLength(6);
    expect(buildVoiceProfileModelChain('kie-gemini-3-pro')).toHaveLength(6);
    expect(buildVoiceProfileModelChain('kie-gemini-2.5-flash')).toHaveLength(6);
  });
});
