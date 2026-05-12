import { describe, expect, it } from 'vitest';
import { validateCreatePipelineRunInput, CreatePipelineRunError } from '@/lib/auto-pipeline/create-run';
import {
  PIPELINE_STAGES,
  ACTIVE_STAGES,
  WAITING_STAGES,
  TERMINAL_STAGES,
  FAILURE_STAGES,
  isActiveStage,
  isTerminalStage,
  isPipelineStage,
} from '@/lib/auto-pipeline/types';
import { getStageHandler } from '@/lib/auto-pipeline/orchestrator';

// ────────────────────────────────────────────────────────────────────
// validateCreatePipelineRunInput — pure, exhaustive rejection paths
// ────────────────────────────────────────────────────────────────────

describe('validateCreatePipelineRunInput', () => {
  const base = { workspaceId: 'ws-1', presetId: 'p-1' };

  it('rejects when both modes are empty', () => {
    const r = validateCreatePipelineRunInput({ ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_input');
  });

  it('rejects mixed mode (both countToGenerate and existingIdeaIds non-zero)', () => {
    const r = validateCreatePipelineRunInput({
      ...base,
      countToGenerate: 3,
      existingIdeaIds: ['idea-1', 'idea-2'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('mixed_mode_not_supported');
  });

  it('rejects countToGenerate > 50', () => {
    const r = validateCreatePipelineRunInput({ ...base, countToGenerate: 51 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('count_out_of_range');
  });

  it('rejects countToGenerate < 0 (the 0 path triggers no_input, < 0 triggers range)', () => {
    const r = validateCreatePipelineRunInput({ ...base, countToGenerate: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('count_out_of_range');
  });

  it('rejects existingIdeaIds with > 50 entries', () => {
    const ideas = Array.from({ length: 51 }, (_, i) => `idea-${i}`);
    const r = validateCreatePipelineRunInput({ ...base, existingIdeaIds: ideas });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_many_ideas');
  });

  it('rejects duplicate idea ids', () => {
    const r = validateCreatePipelineRunInput({
      ...base,
      existingIdeaIds: ['idea-1', 'idea-2', 'idea-1'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('duplicate_ideas');
  });

  it('accepts fresh-mode input with valid count', () => {
    const r = validateCreatePipelineRunInput({ ...base, countToGenerate: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('fresh');
      if (r.mode === 'fresh') expect(r.count).toBe(5);
    }
  });

  it('accepts existing-mode input with unique ids', () => {
    const r = validateCreatePipelineRunInput({
      ...base,
      existingIdeaIds: ['a', 'b', 'c'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('existing');
      if (r.mode === 'existing') expect(r.ideaIds).toEqual(['a', 'b', 'c']);
    }
  });

  it('preserves caller-supplied idea order (order = priority)', () => {
    const r = validateCreatePipelineRunInput({
      ...base,
      existingIdeaIds: ['z', 'a', 'm'],
    });
    if (r.ok && r.mode === 'existing') {
      expect(r.ideaIds).toEqual(['z', 'a', 'm']);
    } else {
      throw new Error('expected ok existing-mode result');
    }
  });

  it('CreatePipelineRunError exposes a code field', () => {
    const err = new CreatePipelineRunError('preset_not_found', 'Preset 123 not found.');
    expect(err.code).toBe('preset_not_found');
    expect(err.message).toBe('Preset 123 not found.');
    expect(err.name).toBe('CreatePipelineRunError');
  });
});

// ────────────────────────────────────────────────────────────────────
// Stage union + set invariants
// ────────────────────────────────────────────────────────────────────

describe('PIPELINE_STAGES + set helpers', () => {
  it('every stage is exactly one of active / waiting / terminal', () => {
    for (const stage of PIPELINE_STAGES) {
      const inActive = ACTIVE_STAGES.has(stage);
      const inWaiting = WAITING_STAGES.has(stage);
      const inTerminal = TERMINAL_STAGES.has(stage);
      const memberships = [inActive, inWaiting, inTerminal].filter(Boolean).length;
      expect(memberships, `stage "${stage}" should be in exactly one set`).toBe(1);
    }
  });

  it('FAILURE_STAGES is a subset of TERMINAL_STAGES', () => {
    for (const s of FAILURE_STAGES) {
      expect(TERMINAL_STAGES.has(s)).toBe(true);
    }
  });

  it('FAILURE_STAGES excludes "done" and "cancelled_by_user"', () => {
    expect(FAILURE_STAGES.has('done')).toBe(false);
    expect(FAILURE_STAGES.has('cancelled_by_user')).toBe(false);
  });

  it('isActiveStage / isTerminalStage agree with the sets', () => {
    expect(isActiveStage('generating_script')).toBe(true);
    expect(isActiveStage('done')).toBe(false);
    expect(isActiveStage('waiting_narration')).toBe(false);
    expect(isActiveStage('unknown_stage_name')).toBe(false);
    expect(isTerminalStage('done')).toBe(true);
    expect(isTerminalStage('thumbnail_failed')).toBe(true);
    expect(isTerminalStage('generating_script')).toBe(false);
  });

  it('isPipelineStage rejects unknown stages', () => {
    expect(isPipelineStage('done')).toBe(true);
    expect(isPipelineStage('totally_made_up')).toBe(false);
    expect(isPipelineStage('')).toBe(false);
  });

  it('all stages added 2026-05-12 (thumbnail + editor) are present and routable', () => {
    expect(PIPELINE_STAGES.includes('generating_thumbnail' as never)).toBe(true);
    expect(PIPELINE_STAGES.includes('assigning_to_editor' as never)).toBe(true);
    expect(PIPELINE_STAGES.includes('thumbnail_failed' as never)).toBe(true);
    expect(PIPELINE_STAGES.includes('editor_assignment_failed' as never)).toBe(true);
    expect(ACTIVE_STAGES.has('generating_thumbnail')).toBe(true);
    expect(ACTIVE_STAGES.has('assigning_to_editor')).toBe(true);
    expect(FAILURE_STAGES.has('thumbnail_failed')).toBe(true);
    expect(FAILURE_STAGES.has('editor_assignment_failed')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Orchestrator dispatch — every ACTIVE stage has a handler;
// nothing else does.
// ────────────────────────────────────────────────────────────────────

describe('orchestrator dispatch (getStageHandler)', () => {
  it('returns a handler for every active stage', () => {
    for (const stage of ACTIVE_STAGES) {
      expect(getStageHandler(stage), `missing handler for active stage "${stage}"`).not.toBeNull();
    }
  });

  it('returns null for waiting stages', () => {
    for (const stage of WAITING_STAGES) {
      expect(getStageHandler(stage), `waiting stage "${stage}" must not have a handler`).toBeNull();
    }
  });

  it('returns null for terminal stages', () => {
    for (const stage of TERMINAL_STAGES) {
      expect(getStageHandler(stage), `terminal stage "${stage}" must not have a handler`).toBeNull();
    }
  });

  it('returns null for unknown stage names', () => {
    expect(getStageHandler('totally_unknown')).toBeNull();
    expect(getStageHandler('')).toBeNull();
  });

  it('queued + generating_idea dispatch to the same handler (idea-gen alias)', () => {
    const a = getStageHandler('queued');
    const b = getStageHandler('generating_idea');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);
  });

  it('running_qa + qa_retry dispatch to the same handler (Tuesday: retry is alias; Friday will split them)', () => {
    const a = getStageHandler('running_qa');
    const b = getStageHandler('qa_retry');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).toBe(b);
  });
});
