import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACING_PROFILE,
  parsePacingProfile,
  parsePacingProfileWithDefault,
} from '@/lib/pacing-profile';

// Covers the shared parser used by:
//   - /api/generate/production-doc route body whitelist
//   - /api/auto-pipeline/presets POST + PATCH route body validation
//   - auto-pipeline production-doc handler's preset.pacing_profile fallback
//
// All three callers must agree on what's accepted, so one parser → one test.

describe('parsePacingProfile', () => {
  it("accepts each whitelisted literal", () => {
    expect(parsePacingProfile('standard')).toBe('standard');
    expect(parsePacingProfile('fast')).toBe('fast');
    expect(parsePacingProfile('very_fast')).toBe('very_fast');
  });

  it('returns null for missing values', () => {
    expect(parsePacingProfile(undefined)).toBeNull();
    expect(parsePacingProfile(null)).toBeNull();
    expect(parsePacingProfile('')).toBeNull();
  });

  it('returns null for case-mismatched strings', () => {
    // The DB CHECK constraint is case-sensitive; the parser mirrors it
    // so a misformatted client doesn't sneak past validation only to
    // hit a DB error later.
    expect(parsePacingProfile('FAST')).toBeNull();
    expect(parsePacingProfile('Standard')).toBeNull();
    expect(parsePacingProfile('VERY_FAST')).toBeNull();
  });

  it('returns null for whitespace-padded strings', () => {
    // Deliberate: silent whitespace trim would hide a buggy caller.
    expect(parsePacingProfile('fast ')).toBeNull();
    expect(parsePacingProfile(' fast')).toBeNull();
    expect(parsePacingProfile('\tfast\n')).toBeNull();
  });

  it('returns null for non-string types', () => {
    expect(parsePacingProfile(42)).toBeNull();
    expect(parsePacingProfile(true)).toBeNull();
    expect(parsePacingProfile({})).toBeNull();
    expect(parsePacingProfile([])).toBeNull();
    expect(parsePacingProfile(['fast'])).toBeNull();
  });

  it('returns null for unknown strings, including near-misses', () => {
    expect(parsePacingProfile('faster')).toBeNull();
    expect(parsePacingProfile('slow')).toBeNull();
    expect(parsePacingProfile('very-fast')).toBeNull(); // hyphen, not underscore
  });
});

describe('parsePacingProfileWithDefault', () => {
  it('returns the parsed value for valid input', () => {
    expect(parsePacingProfileWithDefault('standard')).toBe('standard');
    expect(parsePacingProfileWithDefault('fast')).toBe('fast');
    expect(parsePacingProfileWithDefault('very_fast')).toBe('very_fast');
  });

  it('returns the documented default for any invalid input', () => {
    expect(parsePacingProfileWithDefault(undefined)).toBe(DEFAULT_PACING_PROFILE);
    expect(parsePacingProfileWithDefault(null)).toBe(DEFAULT_PACING_PROFILE);
    expect(parsePacingProfileWithDefault('')).toBe(DEFAULT_PACING_PROFILE);
    expect(parsePacingProfileWithDefault('SLOW')).toBe(DEFAULT_PACING_PROFILE);
    expect(parsePacingProfileWithDefault(42)).toBe(DEFAULT_PACING_PROFILE);
  });

  it("the documented default is 'fast'", () => {
    // Lock the contract so a future commit that changes the default
    // also has to touch this test, surfacing the decision.
    expect(DEFAULT_PACING_PROFILE).toBe('fast');
  });
});
