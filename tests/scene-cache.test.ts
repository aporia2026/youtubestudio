import { describe, expect, it } from 'vitest';
import {
  buildSceneContinuationEditPrompt,
  getCachedSceneBase,
  writeSceneToCache,
  type SceneCache,
} from '@/lib/scene-cache';

describe('buildSceneContinuationEditPrompt', () => {
  it('wraps a raw scene prompt in the location-preservation Edit instruction', () => {
    const out = buildSceneContinuationEditPrompt(
      'The Sodder family home at night, smoke rising from the roof and orange flames in the windows.',
    );
    // The load-bearing phrases — these are the guard-rails that make
    // the scene continuation work without drifting the architecture.
    expect(out).toContain('SAME location');
    expect(out).toContain('EXACTLY identical');
    expect(out).toContain('architecture');
    expect(out).toContain('color palette');
    expect(out).toContain('The Sodder family home at night');
    expect(out).toContain('hand-drawn doodle style');
  });

  it('contrasts with the character-continuation prompt — anchors LOCATION, not character identity', () => {
    const out = buildSceneContinuationEditPrompt('A wide shot of the burning house');
    // Scene prompt does NOT mention face/hair/clothing — those belong
    // to the character path. Scene preserves architecture/palette.
    expect(out).not.toContain('face');
    expect(out).not.toContain('hair');
    expect(out).not.toContain('clothing');
    expect(out).toContain('architecture');
  });

  it('trims surrounding whitespace from the scene prompt', () => {
    const out = buildSceneContinuationEditPrompt('   A dim cabin interior   ');
    expect(out).toContain('this new beat: A dim cabin interior.');
    expect(out).not.toContain('   A dim');
  });
});

describe('getCachedSceneBase', () => {
  const cache: SceneCache = {
    'sodder-house': { base_url: 'https://r2/sodder-house.png', first_seen_row_index: 0 },
    'investigator-desk': { base_url: 'https://r2/desk.png', first_seen_row_index: 17 },
  };

  it('returns the base url for a hit', () => {
    expect(getCachedSceneBase(cache, 'sodder-house')).toBe('https://r2/sodder-house.png');
    expect(getCachedSceneBase(cache, 'investigator-desk')).toBe('https://r2/desk.png');
  });

  it('returns undefined on a miss', () => {
    expect(getCachedSceneBase(cache, 'fire-ladder-shed')).toBeUndefined();
  });

  it('returns undefined for empty / whitespace scene_id', () => {
    expect(getCachedSceneBase(cache, '')).toBeUndefined();
    expect(getCachedSceneBase(cache, '   ')).toBeUndefined();
  });

  it('returns undefined when the cache itself is null or undefined', () => {
    expect(getCachedSceneBase(undefined, 'sodder-house')).toBeUndefined();
    expect(getCachedSceneBase(null, 'sodder-house')).toBeUndefined();
  });
});

describe('writeSceneToCache', () => {
  it('inserts a new entry into an empty cache', () => {
    const next = writeSceneToCache(undefined, 'sodder-house', 'https://r2/h.png', 2);
    expect(next).toEqual({
      'sodder-house': { base_url: 'https://r2/h.png', first_seen_row_index: 2 },
    });
  });

  it('preserves existing entries when adding a new scene', () => {
    const before: SceneCache = {
      'sodder-house': { base_url: 'https://r2/h.png', first_seen_row_index: 0 },
    };
    const after = writeSceneToCache(before, 'investigator-desk', 'https://r2/d.png', 17);
    expect(after).toEqual({
      'sodder-house': { base_url: 'https://r2/h.png', first_seen_row_index: 0 },
      'investigator-desk': { base_url: 'https://r2/d.png', first_seen_row_index: 17 },
    });
  });

  it('first-occurrence wins — does NOT overwrite an existing entry', () => {
    const before: SceneCache = {
      'sodder-house': { base_url: 'https://r2/canonical.png', first_seen_row_index: 0 },
    };
    const after = writeSceneToCache(before, 'sodder-house', 'https://r2/different.png', 5);
    expect(after['sodder-house'].base_url).toBe('https://r2/canonical.png');
    expect(after['sodder-house'].first_seen_row_index).toBe(0);
  });

  it('does NOT mutate the input cache', () => {
    const before: SceneCache = {
      'sodder-house': { base_url: 'https://r2/h.png', first_seen_row_index: 0 },
    };
    const snapshot = JSON.parse(JSON.stringify(before));
    writeSceneToCache(before, 'investigator-desk', 'https://r2/d.png', 17);
    expect(before).toEqual(snapshot);
  });

  it('returns the cache unchanged when scene_id is empty or whitespace', () => {
    const before: SceneCache = {
      'sodder-house': { base_url: 'https://r2/h.png', first_seen_row_index: 0 },
    };
    expect(writeSceneToCache(before, '', 'https://r2/x.png', 1)).toEqual(before);
    expect(writeSceneToCache(before, '   ', 'https://r2/x.png', 1)).toEqual(before);
  });

  it('returns the cache unchanged when baseUrl is empty', () => {
    const before: SceneCache = {};
    expect(writeSceneToCache(before, 'sodder-house', '', 1)).toEqual({});
    expect(writeSceneToCache(before, 'sodder-house', '   ', 1)).toEqual({});
  });
});
