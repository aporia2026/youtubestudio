import { describe, expect, it } from 'vitest';
import {
  CHANNEL_CLONE_ABSOLUTE_RULES,
  CHANNEL_CLONE_PREAMBLE,
  getChannelCloneStateExtracts,
  getChannelCloneSystemPrompt,
  type ChannelCloneStageFeature,
} from '@/lib/channel-clone/prompts/v2-content-engine';

// Pin the V2.0 prompt-composition contract. The eight stages share
// an always-on preamble (CORE BEHAVIOR + VISUAL GATING + BRANDING
// EXCEPTION) and closer (ABSOLUTE RULES); per-stage extracts are
// inserted between them. These tests guarantee no stage accidentally
// drops the always-on sections, which would break the
// rules-of-engagement the seller's prompt relies on.

const STAGES: ChannelCloneStageFeature[] = [
  'channel-clone-intake-summary',
  'channel-clone-analyze',
  'channel-clone-topic-generation',
  'channel-clone-hook-engineering',
  'channel-clone-script-generation',
  'channel-clone-script-audit',
  'channel-clone-rowify',
  'channel-clone-publish-pack',
];

describe('getChannelCloneSystemPrompt — preamble and closer are always present', () => {
  for (const stage of STAGES) {
    it(`includes preamble + absolute rules for ${stage}`, () => {
      const prompt = getChannelCloneSystemPrompt(stage);
      expect(prompt).toContain(CHANNEL_CLONE_PREAMBLE);
      expect(prompt).toContain(CHANNEL_CLONE_ABSOLUTE_RULES);
      expect(prompt).toMatch(/VISUAL GATING PROTOCOL/);
      expect(prompt).toMatch(/BRANDING EXCEPTION/);
    });
  }
});

describe('getChannelCloneSystemPrompt — per-stage extracts', () => {
  it('analyze stage carries the STATE 6/7/8/13 sections', () => {
    const prompt = getChannelCloneSystemPrompt('channel-clone-analyze');
    expect(prompt).toMatch(/STATE 6: DEEP CHANNEL ANALYSIS/);
    expect(prompt).toMatch(/STATE 7: STYLE DNA EXTRACTION/);
    expect(prompt).toMatch(/STATE 8: AUDIENCE PSYCHOLOGY PROFILE/);
    expect(prompt).toMatch(/STATE 13: VISUAL STYLE ANALYSIS/);
  });

  it('script-audit stage carries the 10-point quality check', () => {
    const prompt = getChannelCloneSystemPrompt('channel-clone-script-audit');
    expect(prompt).toMatch(/STATE 11: SCRIPT QUALITY AUDIT/);
    expect(prompt).toMatch(/10-Point Quality Check/);
  });

  it('hook-engineering stage carries the 5 hook archetypes', () => {
    const prompt = getChannelCloneSystemPrompt('channel-clone-hook-engineering');
    expect(prompt).toMatch(/STATE 9: HOOK ENGINEERING/);
    expect(prompt).toMatch(/Contrarian Statement/);
    expect(prompt).toMatch(/Mystery Setup/);
  });

  it('rowify stage carries the scene-by-scene STANDALONE RULE', () => {
    const prompt = getChannelCloneSystemPrompt('channel-clone-rowify');
    expect(prompt).toMatch(/STATE 14: SCENE-BY-SCENE IMAGE PROMPTS/);
    expect(prompt).toMatch(/STANDALONE RULE/);
  });

  it('publish-pack stage bundles thumbnails + SEO + calendar', () => {
    const prompt = getChannelCloneSystemPrompt('channel-clone-publish-pack');
    expect(prompt).toMatch(/STATE 17: THUMBNAIL ANALYSIS/);
    expect(prompt).toMatch(/STATE 18: THUMBNAIL GENERATION/);
    expect(prompt).toMatch(/STATE 19: SEO & METADATA/);
    expect(prompt).toMatch(/STATE 21: CONTENT CALENDAR/);
  });
});

describe('getChannelCloneStateExtracts', () => {
  it('returns at least one state body per stage', () => {
    for (const stage of STAGES) {
      const extracts = getChannelCloneStateExtracts(stage);
      expect(extracts.length).toBeGreaterThan(0);
      for (const e of extracts) {
        expect(e.length).toBeGreaterThan(20);
      }
    }
  });
});
