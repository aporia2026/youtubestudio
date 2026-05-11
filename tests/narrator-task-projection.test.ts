/**
 * Locks down the post-processor for the Team Hub narrator-task query.
 *
 * Two things matter here for the UI:
 *   1. `latest_take_duration_seconds` prefers the assignment-cached
 *      full-audio duration when the narrator uploaded one file covering
 *      the whole script, and falls back to the most recent per-section
 *      take's duration otherwise. Either column can come back from the
 *      Postgres driver as either `number` or `string` (NUMERIC has no
 *      universal type parser), so the coercion path needs both branches.
 *   2. `spoken_word_count` is the count of words a narrator *actually
 *      says* — the script with [VISUAL CUE: ...], stage directions, and
 *      metadata lines stripped via `stripProductionCues`. The owner uses
 *      it to compare against the take duration at a glance.
 *
 * The SQL itself is harder to unit-test (it'd want a real Postgres), so
 * we test the pure projection here and rely on the query staying in
 * lockstep with this shape.
 */
import { describe, expect, it } from 'vitest';
import { projectNarratorTaskRow, type NarratorTaskQueryRow } from '@/lib/team-hub-tasks-db';

function baseRow(overrides: Partial<NarratorTaskQueryRow> = {}): NarratorTaskQueryRow {
  return {
    id: 'a-1',
    project_id: 'p-1',
    project_title: 'Test project',
    status: 'recording',
    deadline: null,
    share_token: 'tok',
    last_accessed_at: null,
    created_at: '2026-05-11T00:00:00Z',
    updated_at: '2026-05-11T00:00:00Z',
    total_sections: 0,
    approved_sections: 0,
    latest_take_id: null,
    full_audio_duration_seconds: null,
    latest_section_take_duration_seconds: null,
    scripts_joined: null,
    ...overrides,
  };
}

describe('projectNarratorTaskRow — latest_take_duration_seconds', () => {
  it('returns null when neither full-audio nor per-section take has a duration', () => {
    expect(projectNarratorTaskRow(baseRow()).latest_take_duration_seconds).toBeNull();
  });

  it('prefers full_audio_duration_seconds over per-section take duration', () => {
    // The narrator uploaded a single full-script file (cached at the
    // assignment) AND has older per-section takes hanging around. The
    // full-audio upload is what the owner currently hears, so its
    // duration is the one we surface.
    const row = baseRow({
      full_audio_duration_seconds: 754,
      latest_section_take_duration_seconds: 22,
    });
    expect(projectNarratorTaskRow(row).latest_take_duration_seconds).toBe(754);
  });

  it('falls back to the most recent per-section take when no full-audio upload exists', () => {
    const row = baseRow({ latest_section_take_duration_seconds: 41 });
    expect(projectNarratorTaskRow(row).latest_take_duration_seconds).toBe(41);
  });

  it('coerces NUMERIC strings returned by the pg driver', () => {
    // @vercel/postgres can deliver NUMERIC columns as strings depending
    // on the type-parser config — make sure both branches still produce
    // a real `number`.
    expect(
      projectNarratorTaskRow(baseRow({ full_audio_duration_seconds: '93.5' })).latest_take_duration_seconds,
    ).toBe(93.5);
    expect(
      projectNarratorTaskRow(baseRow({ latest_section_take_duration_seconds: '22' })).latest_take_duration_seconds,
    ).toBe(22);
  });

  it('ignores empty strings and non-numeric junk instead of producing NaN', () => {
    // An empty string from a pg driver should be treated as "no value"
    // and let the next column take precedence, not coerce to 0.
    expect(
      projectNarratorTaskRow(
        baseRow({ full_audio_duration_seconds: '', latest_section_take_duration_seconds: 17 }),
      ).latest_take_duration_seconds,
    ).toBe(17);
    expect(
      projectNarratorTaskRow(baseRow({ full_audio_duration_seconds: 'bad' })).latest_take_duration_seconds,
    ).toBeNull();
  });
});

describe('projectNarratorTaskRow — spoken_word_count', () => {
  it('returns 0 when there is no script', () => {
    expect(projectNarratorTaskRow(baseRow()).spoken_word_count).toBe(0);
    expect(projectNarratorTaskRow(baseRow({ scripts_joined: '' })).spoken_word_count).toBe(0);
  });

  it('counts only spoken words — strips [VISUAL CUE: ...] and stage directions', () => {
    // The whole point: the narrator only utters "Welcome to the show" —
    // the bracketed cue and the headers are stripped before counting.
    const row = baseRow({
      scripts_joined: '## Intro\n[VISUAL CUE: City skyline at sunset]\nWelcome to the show.\n[SFX: applause]',
    });
    expect(projectNarratorTaskRow(row).spoken_word_count).toBe(4);
  });

  it('strips inline metadata parentheticals + markdown emphasis', () => {
    const row = baseRow({
      scripts_joined: 'This is **really** important. (Spoken words: 5)',
    });
    // "This is really important." → 4 spoken words. The metadata
    // parenthetical and the ** wrappers both drop.
    expect(projectNarratorTaskRow(row).spoken_word_count).toBe(4);
  });

  it('handles multi-section aggregated scripts joined by newlines', () => {
    // Two sections (4 + 5 = 9 spoken words) glued with the same separator
    // string_agg uses in the SQL — the bracketed cue between them drops.
    const row = baseRow({
      scripts_joined: 'Section one has four.\n\n[VISUAL CUE: cut]\n\nSection two has four words.',
    });
    expect(projectNarratorTaskRow(row).spoken_word_count).toBe(9);
  });
});

describe('projectNarratorTaskRow — passes existing fields through unchanged', () => {
  it('does not drop or rename anything the card already renders', () => {
    const row = baseRow({
      total_sections: 14,
      approved_sections: 3,
      latest_take_id: 't-9',
      project_title: 'Every Major Cyber Attack in History',
    });
    const projected = projectNarratorTaskRow(row);
    expect(projected.total_sections).toBe(14);
    expect(projected.approved_sections).toBe(3);
    expect(projected.latest_take_id).toBe('t-9');
    expect(projected.project_title).toBe('Every Major Cyber Attack in History');
  });
});
