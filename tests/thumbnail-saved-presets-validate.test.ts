import { describe, expect, it } from 'vitest';
import {
  SAVED_PRESET_MAX_NAME_LENGTH,
  SAVED_PRESET_MAX_PAYLOAD_BYTES,
  validateSavedPresetInput,
} from '@/lib/thumbnail-saved-presets-validate';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MINIMAL_VALID_PRESET = {
  name: 'My house style',
  preset: { postProcess: { filter: 'sepia' }, titleBar: { enabled: false } },
};

// ─── validateSavedPresetInput ───────────────────────────────────────────────

describe('validateSavedPresetInput', () => {
  it('rejects non-object inputs', () => {
    expect(validateSavedPresetInput(null).ok).toBe(false);
    expect(validateSavedPresetInput(undefined).ok).toBe(false);
    expect(validateSavedPresetInput('a string').ok).toBe(false);
    expect(validateSavedPresetInput(42).ok).toBe(false);
  });

  it('rejects missing name', () => {
    const result = validateSavedPresetInput({ preset: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/name is required/);
  });

  it('rejects empty / whitespace-only name', () => {
    expect(validateSavedPresetInput({ name: '', preset: {} }).ok).toBe(false);
    expect(validateSavedPresetInput({ name: '   ', preset: {} }).ok).toBe(false);
  });

  it('rejects names over the length cap', () => {
    const tooLong = 'a'.repeat(SAVED_PRESET_MAX_NAME_LENGTH + 1);
    const result = validateSavedPresetInput({ name: tooLong, preset: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at most/);
  });

  it('accepts a name at exactly the length cap', () => {
    const atCap = 'a'.repeat(SAVED_PRESET_MAX_NAME_LENGTH);
    const result = validateSavedPresetInput({ name: atCap, preset: {} });
    expect(result.ok).toBe(true);
  });

  it('rejects missing preset object', () => {
    expect(validateSavedPresetInput({ name: 'X' }).ok).toBe(false);
    expect(validateSavedPresetInput({ name: 'X', preset: null }).ok).toBe(false);
    expect(validateSavedPresetInput({ name: 'X', preset: 'not an object' }).ok).toBe(false);
  });

  it('accepts the minimal valid payload and trims the name', () => {
    const result = validateSavedPresetInput({
      ...MINIMAL_VALID_PRESET,
      name: '  ' + MINIMAL_VALID_PRESET.name + '  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe(MINIMAL_VALID_PRESET.name);
      expect(result.value.preset).toEqual(MINIMAL_VALID_PRESET.preset);
    }
  });

  it('rejects oversized preset payloads', () => {
    // Build a preset whose JSON.stringify exceeds the cap. A long
    // padding string inside a single field is the simplest way to
    // reliably trip the size check without affecting other paths.
    const huge = { padding: 'x'.repeat(SAVED_PRESET_MAX_PAYLOAD_BYTES) };
    const result = validateSavedPresetInput({ name: 'X', preset: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too large/);
  });
});
