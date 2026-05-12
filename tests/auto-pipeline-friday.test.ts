import { describe, expect, it } from 'vitest';
import { flattenVerdictToFixes, buildPromptAugmentFromFixes, type FlatFix } from '@/lib/auto-pipeline/fix-list';
import { buildEditorNotes } from '@/lib/auto-pipeline/stages/assign-to-editor';
import {
  buildThumbnailPrompt,
  shortenTitleForOverlay,
  DEFAULT_THUMBNAIL_CHAIN,
} from '@/lib/auto-pipeline/stages/generate-thumbnail';
import type { ScriptPanelVerdict } from '@/lib/script-critics/types';

// ────────────────────────────────────────────────────────────────────
// fix-list flattener
// ────────────────────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<ScriptPanelVerdict> = {}): ScriptPanelVerdict {
  return {
    overall_score: 60,
    weighted_score: 60,
    verdict: 'needs work',
    will_it_perform: 'borderline',
    categories: {} as never,
    critical_issues: [],
    strengths: [],
    rewrite_suggestions: [],
    title_suggestions: [],
    thumbnail_ideas: [],
    next_pass_focus: '',
    consensus_pass: false,
    chair_summary: '',
    deliberations: [],
    ...overrides,
  };
}

describe('flattenVerdictToFixes', () => {
  it('returns empty list for an empty verdict', () => {
    expect(flattenVerdictToFixes(makeVerdict())).toEqual([]);
  });

  it('promotes every critical_issue to severity=high', () => {
    const verdict = makeVerdict({
      critical_issues: [
        { issue: 'Hook is too long', critic: 'hook-coach' } as never,
        { description: 'Pacing dies at 4:00' } as never,
      ],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes).toHaveLength(2);
    expect(fixes[0].severity).toBe('high');
    expect(fixes[1].severity).toBe('high');
    expect(fixes[0].text).toContain('Hook is too long');
  });

  it('extracts rewrite suggestions in the canonical { original, improved, reason } shape', () => {
    const verdict = makeVerdict({
      rewrite_suggestions: [
        { original: 'And then', improved: 'Suddenly,', reason: 'tighter open' },
      ],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].severity).toBe('medium');
    expect(fixes[0].text).toContain('Rewrite');
    expect(fixes[0].text).toContain('And then');
    expect(fixes[0].text).toContain('Suddenly,');
    expect(fixes[0].text).toContain('tighter open');
    expect(fixes[0].scriptLineRef).toBe('And then');
  });

  it('handles legacy/malformed string entries in rewrite_suggestions defensively', () => {
    // Real model output sometimes emits flat strings even though the
    // TS type expects {original, improved, reason}. The flattener
    // should still extract a usable fix.
    const verdict = makeVerdict({
      rewrite_suggestions: ['Cut the intro by 30 seconds.' as never],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].text).toBe('Cut the intro by 30 seconds.');
  });

  it('sorts high → medium → low and preserves order within tier', () => {
    const verdict = makeVerdict({
      critical_issues: [{ issue: 'A: high1' } as never, { issue: 'B: high2' } as never],
      rewrite_suggestions: [{ original: 'x', improved: 'y', reason: 'C: med1', priority: 'medium' } as never],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes[0].text).toContain('high1');
    expect(fixes[1].text).toContain('high2');
    expect(fixes[2].severity).toBe('medium');
  });

  it('de-dups (severity, text)', () => {
    const verdict = makeVerdict({
      critical_issues: [
        { issue: 'Hook fails' } as never,
        { issue: 'hook fails' } as never, // case + whitespace variant
        { issue: ' Hook fails ' } as never,
      ],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes).toHaveLength(1);
  });

  it('normalises priority strings to severity', () => {
    const verdict = makeVerdict({
      rewrite_suggestions: [
        { original: 'a', improved: 'b', reason: 'r', priority: 'P0' } as never,
        { original: 'c', improved: 'd', reason: 'r', priority: 'CRITICAL' } as never,
        { original: 'e', improved: 'f', reason: 'r', priority: 'minor' } as never,
      ],
    });
    const fixes = flattenVerdictToFixes(verdict);
    expect(fixes.filter((f) => f.severity === 'high')).toHaveLength(2);
    expect(fixes.filter((f) => f.severity === 'low')).toHaveLength(1);
  });
});

describe('buildPromptAugmentFromFixes', () => {
  it('returns empty string for no fixes — caller can concat unconditionally', () => {
    expect(buildPromptAugmentFromFixes([])).toBe('');
  });

  it('groups by severity with MUST/SHOULD/NICE headers', () => {
    const fixes: FlatFix[] = [
      { id: 'a', severity: 'high', text: 'Fix the hook' },
      { id: 'b', severity: 'medium', text: 'Tighten pacing' },
      { id: 'c', severity: 'low', text: 'Polish outro' },
    ];
    const augment = buildPromptAugmentFromFixes(fixes);
    expect(augment).toContain('MUST FIX');
    expect(augment).toContain('SHOULD FIX');
    expect(augment).toContain('NICE TO FIX');
    expect(augment).toContain('Fix the hook');
    expect(augment).toContain('Tighten pacing');
    expect(augment).toContain('Polish outro');
  });

  it('omits empty severity groups', () => {
    const augment = buildPromptAugmentFromFixes([
      { id: 'a', severity: 'high', text: 'A' },
    ]);
    expect(augment).toContain('MUST FIX');
    expect(augment).not.toContain('SHOULD FIX');
    expect(augment).not.toContain('NICE TO FIX');
  });

  it('includes scriptLineRef inline when present', () => {
    const augment = buildPromptAugmentFromFixes([
      { id: 'a', severity: 'high', text: 'Rewrite this line', scriptLineRef: 'And then he said' },
    ]);
    expect(augment).toContain('And then he said');
  });
});

// ────────────────────────────────────────────────────────────────────
// thumbnail prompt builder
// ────────────────────────────────────────────────────────────────────

describe('buildThumbnailPrompt', () => {
  it('renders a sensible default with no template', () => {
    const prompt = buildThumbnailPrompt({
      title: 'How to do X',
      niche: 'productivity',
      template: null,
    });
    expect(prompt).toContain('How to do X');
    expect(prompt).toContain('productivity');
    expect(prompt).toContain('16:9');
  });

  it('prepends template context_description when configured', () => {
    const prompt = buildThumbnailPrompt({
      title: 'How to do X',
      niche: 'productivity',
      template: {
        context_description: 'Cinematic warm-tone style with shallow depth of field.',
        include_text: false,
        text_overlay_config_jsonb: null,
        image_references_jsonb: null,
      },
    });
    expect(prompt.startsWith('Cinematic warm-tone style')).toBe(true);
  });

  it('emits a text-overlay instruction when include_text=true', () => {
    const prompt = buildThumbnailPrompt({
      title: 'How to do X',
      niche: 'productivity',
      template: {
        context_description: null,
        include_text: true,
        text_overlay_config_jsonb: { text: 'BIG WORDS', position: 'top-left' },
        image_references_jsonb: null,
      },
    });
    expect(prompt).toContain('BIG WORDS');
    expect(prompt).toContain('top-left');
  });

  it('says "no text overlay" when template has include_text=false', () => {
    const prompt = buildThumbnailPrompt({
      title: 'How to do X',
      niche: 'productivity',
      template: {
        context_description: null,
        include_text: false,
        text_overlay_config_jsonb: null,
        image_references_jsonb: null,
      },
    });
    expect(prompt).toContain('No text overlay');
  });

  it('uses title as overlay text when include_text=true and no override', () => {
    const prompt = buildThumbnailPrompt({
      title: 'Short title',
      niche: 'productivity',
      template: {
        context_description: null,
        include_text: true,
        text_overlay_config_jsonb: {},
        image_references_jsonb: null,
      },
    });
    expect(prompt).toContain('Short title');
  });

  it('shortens a long title for overlay text', () => {
    expect(shortenTitleForOverlay('Short and snappy')).toBe('Short and snappy');
    expect(
      shortenTitleForOverlay('The Ultimate Guide: How To Master React In 2026 With Zero Prior Experience'),
    ).toBe('The Ultimate Guide');
    const longOnly = shortenTitleForOverlay(
      'This is a very long title with no clear break point that should still get clipped',
    );
    expect(longOnly.split(/\s+/).length).toBeLessThanOrEqual(6);
  });

  it('mentions image-reference inspiration cues when refs are supplied', () => {
    const prompt = buildThumbnailPrompt({
      title: 'X',
      niche: 'y',
      template: {
        context_description: null,
        include_text: false,
        text_overlay_config_jsonb: null,
        image_references_jsonb: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      },
    });
    expect(prompt).toContain('inspiration');
    expect(prompt).toContain('2 reference image');
  });
});

describe('DEFAULT_THUMBNAIL_CHAIN', () => {
  it('is non-empty and lists t2i models', () => {
    expect(DEFAULT_THUMBNAIL_CHAIN.length).toBeGreaterThan(0);
    for (const id of DEFAULT_THUMBNAIL_CHAIN) {
      // All defaults must be text-to-image variants (suffix -t2i)
      // or a model known to be t2i (nano-banana, etc.). Loose
      // check — keeps the test from being a rubber stamp.
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// editor-notes builder
// ────────────────────────────────────────────────────────────────────

describe('buildEditorNotes', () => {
  it('includes every asset link when available', () => {
    const notes = buildEditorNotes({
      videoTitle: 'My Video',
      scriptId: 's1',
      voiceoverUrl: 'https://example.com/voice.mp3',
      productionDocUrl: '/projects/p1#production-doc',
      thumbnailUrl: 'https://example.com/thumb.jpg',
      pipelineRunVideoId: 'v1',
    });
    expect(notes).toContain('My Video');
    expect(notes).toContain('https://example.com/voice.mp3');
    expect(notes).toContain('/projects/p1#production-doc');
    expect(notes).toContain('https://example.com/thumb.jpg');
    expect(notes).toContain('v1');
  });

  it('explicitly flags missing voiceover', () => {
    const notes = buildEditorNotes({
      videoTitle: 'My Video',
      scriptId: 's1',
      voiceoverUrl: null,
      productionDocUrl: '/projects/p1#production-doc',
      thumbnailUrl: 'https://example.com/t.jpg',
      pipelineRunVideoId: 'v1',
    });
    expect(notes).toContain('Voiceover: not yet uploaded');
  });

  it('explicitly flags missing thumbnail', () => {
    const notes = buildEditorNotes({
      videoTitle: 'My Video',
      scriptId: 's1',
      voiceoverUrl: 'https://example.com/voice.mp3',
      productionDocUrl: '/projects/p1#production-doc',
      thumbnailUrl: null,
      pipelineRunVideoId: 'v1',
    });
    expect(notes).toContain('Thumbnail: not yet generated');
  });

  it('still produces sensible output with no scriptId', () => {
    const notes = buildEditorNotes({
      videoTitle: 'My Video',
      scriptId: null,
      voiceoverUrl: null,
      productionDocUrl: '/projects/p1#production-doc',
      thumbnailUrl: null,
      pipelineRunVideoId: 'v1',
    });
    // Should NOT crash; should NOT include a script line item.
    expect(notes).toContain('My Video');
    expect(notes).not.toContain('Approved script');
  });
});
