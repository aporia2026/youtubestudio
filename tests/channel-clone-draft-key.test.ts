/**
 * Unit tests for the channel-clone draft-key predicate.
 *
 * The New Session button uses this to decide which localStorage
 * entries to clear. If it accidentally returned true for per-job
 * state keys, "New Session" would wipe operator selections on every
 * saved run — a regression worth guarding against.
 */

import { describe, expect, it } from 'vitest';
import { isChannelCloneDraftKey } from '@/components/channel-clone/NewSessionButton';

describe('isChannelCloneDraftKey: drafts that SHOULD be cleared', () => {
  it('includes the URL paste draft', () => {
    expect(isChannelCloneDraftKey('cc-url-draft')).toBe(true);
  });

  it('includes the intake-mode tab draft', () => {
    expect(isChannelCloneDraftKey('cc-intakeMode-draft')).toBe(true);
  });

  it('includes upload form drafts', () => {
    expect(isChannelCloneDraftKey('cc-upload-sourceLabel-draft')).toBe(true);
    expect(isChannelCloneDraftKey('cc-upload-sourceChannelUrl-draft')).toBe(true);
    expect(isChannelCloneDraftKey('cc-upload-frameIntervalSec-draft')).toBe(true);
    expect(isChannelCloneDraftKey('cc-upload-transcript-drafts')).toBe(true);
  });

  it('includes the landing-scope panel knobs', () => {
    expect(isChannelCloneDraftKey('cc-landing-sampleVideoCount')).toBe(true);
    expect(isChannelCloneDraftKey('cc-landing-topicCount')).toBe(true);
    expect(isChannelCloneDraftKey('cc-landing-threshold')).toBe(true);
    expect(isChannelCloneDraftKey('cc-landing-chosenTopicIndex')).toBe(true);
    expect(isChannelCloneDraftKey('cc-landing-useChannelStyle')).toBe(true);
  });
});

describe('isChannelCloneDraftKey: state that MUST be preserved', () => {
  it('skips per-job state keyed by UUID', () => {
    expect(isChannelCloneDraftKey('cc-3f7955f7-967b-4e60-aa78-f28da6afd90c-chosenTopicIndex')).toBe(false);
    expect(isChannelCloneDraftKey('cc-3f7955f7-967b-4e60-aa78-f28da6afd90c-threshold')).toBe(false);
    expect(isChannelCloneDraftKey('cc-b0ce7129-adea-43ae-8854-55f35c0c93b7-useChannelStyle')).toBe(false);
  });

  it('skips voice-profile collapse preferences (per-job)', () => {
    expect(isChannelCloneDraftKey('cc-voice-profile-collapsed:3f7955f7-967b-4e60-aa78-f28da6afd90c')).toBe(false);
  });

  it('skips unrelated app keys', () => {
    expect(isChannelCloneDraftKey('feature_model_defaults_v2')).toBe(false);
    expect(isChannelCloneDraftKey('something-else-entirely')).toBe(false);
    expect(isChannelCloneDraftKey('')).toBe(false);
  });

  it('treats uppercased UUIDs the same as lowercase', () => {
    expect(isChannelCloneDraftKey('cc-B0CE7129-ADEA-43AE-8854-55F35C0C93B7-chosenTopicIndex')).toBe(false);
  });
});
