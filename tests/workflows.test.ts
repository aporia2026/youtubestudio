import { describe, expect, it } from 'vitest';
import { evaluateCondition, resolveField } from '@/lib/workflows';
import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_EVENTS,
  isWorkflowActionType,
  isWorkflowTriggerEvent,
  type WorkflowCondition,
} from '@/lib/workflows-types';

describe('resolveField', () => {
  it('returns top-level fields', () => {
    expect(resolveField({ a: 1, b: 'x' }, 'a')).toBe(1);
    expect(resolveField({ a: 1, b: 'x' }, 'b')).toBe('x');
  });

  it('returns nested fields via dotted path', () => {
    expect(resolveField({ outer: { inner: 42 } }, 'outer.inner')).toBe(42);
    expect(resolveField({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('returns undefined for missing fields without throwing', () => {
    expect(resolveField({}, 'missing')).toBeUndefined();
    expect(resolveField({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(resolveField({ a: 1 }, 'a.x')).toBeUndefined();
    expect(resolveField({ a: null }, 'a.x')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    expect(resolveField({ a: 1 }, '')).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  const payload = {
    video_id: 'abc',
    ctr_percentage: 3.5,
    winner: 'a',
    channel: { name: 'My Channel', db_id: 'ch1' },
    consensus_pass: true,
  };

  it('empty / no-op condition always matches', () => {
    expect(evaluateCondition({}, payload)).toBe(true);
    expect(evaluateCondition({ field: 'video_id' }, payload)).toBe(true); // no op
  });

  it('equals / not_equals on strings', () => {
    expect(evaluateCondition({ field: 'winner', op: 'equals', value: 'a' }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'winner', op: 'equals', value: 'b' }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'winner', op: 'not_equals', value: 'b' }, payload)).toBe(true);
  });

  it('numeric comparators (lt/lte/gt/gte) only match when both sides are numbers', () => {
    expect(evaluateCondition({ field: 'ctr_percentage', op: 'lt', value: 5 }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'ctr_percentage', op: 'lt', value: 3 }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'ctr_percentage', op: 'gte', value: 3.5 }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'ctr_percentage', op: 'lte', value: 3.4 }, payload)).toBe(false);
    // String value: doesn't compare numerically.
    expect(evaluateCondition({ field: 'ctr_percentage', op: 'lt', value: '5' as unknown as number }, payload)).toBe(false);
  });

  it('exists checks non-null presence', () => {
    expect(evaluateCondition({ field: 'video_id', op: 'exists' }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'no_such_field', op: 'exists' }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'channel.name', op: 'exists' }, payload)).toBe(true);
  });

  it('in operator', () => {
    expect(evaluateCondition({ field: 'winner', op: 'in', value: ['a', 'c'] }, payload)).toBe(true);
    expect(evaluateCondition({ field: 'winner', op: 'in', value: ['b', 'c'] }, payload)).toBe(false);
  });

  it('all combinator (every sub-condition)', () => {
    const cond: WorkflowCondition = {
      all: [
        { field: 'winner', op: 'equals', value: 'a' },
        { field: 'ctr_percentage', op: 'lt', value: 5 },
      ],
    };
    expect(evaluateCondition(cond, payload)).toBe(true);
    expect(
      evaluateCondition(
        {
          all: [
            { field: 'winner', op: 'equals', value: 'a' },
            { field: 'ctr_percentage', op: 'gt', value: 5 },
          ],
        },
        payload,
      ),
    ).toBe(false);
  });

  it('any combinator (at least one sub-condition)', () => {
    const cond: WorkflowCondition = {
      any: [
        { field: 'winner', op: 'equals', value: 'b' },
        { field: 'ctr_percentage', op: 'lt', value: 5 },
      ],
    };
    expect(evaluateCondition(cond, payload)).toBe(true);
    expect(
      evaluateCondition(
        {
          any: [
            { field: 'winner', op: 'equals', value: 'b' },
            { field: 'ctr_percentage', op: 'gt', value: 5 },
          ],
        },
        payload,
      ),
    ).toBe(false);
  });

  it('any with empty array matches (no impossible-to-satisfy rules)', () => {
    expect(evaluateCondition({ any: [] }, payload)).toBe(true);
  });

  it('nested combinators', () => {
    const cond: WorkflowCondition = {
      all: [
        { field: 'winner', op: 'equals', value: 'a' },
        {
          any: [
            { field: 'ctr_percentage', op: 'lt', value: 1 }, // false
            { field: 'consensus_pass', op: 'equals', value: true }, // true
          ],
        },
      ],
    };
    expect(evaluateCondition(cond, payload)).toBe(true);
  });

  it('unknown op returns false (defensive)', () => {
    expect(
      evaluateCondition({ field: 'winner', op: 'matches' as unknown as 'equals', value: 'a' }, payload),
    ).toBe(false);
  });

  it('numeric comparators against missing fields return false', () => {
    expect(evaluateCondition({ field: 'no_field', op: 'lt', value: 5 }, payload)).toBe(false);
    expect(evaluateCondition({ field: 'no_field', op: 'gte', value: 0 }, payload)).toBe(false);
  });
});

describe('WORKFLOW_TRIGGER_EVENTS / WORKFLOW_ACTION_TYPES registries', () => {
  it('every trigger event is recognised by the guard', () => {
    for (const e of WORKFLOW_TRIGGER_EVENTS) {
      expect(isWorkflowTriggerEvent(e.type)).toBe(true);
      expect(e.label.length).toBeGreaterThan(3);
      expect(e.description.length).toBeGreaterThan(20);
    }
  });

  it('every action type is recognised by the guard', () => {
    for (const a of WORKFLOW_ACTION_TYPES) {
      expect(isWorkflowActionType(a.type)).toBe(true);
      expect(a.label.length).toBeGreaterThan(3);
    }
  });

  it('rejects unknown trigger / action types', () => {
    expect(isWorkflowTriggerEvent('made_up_event')).toBe(false);
    expect(isWorkflowTriggerEvent(null)).toBe(false);
    expect(isWorkflowActionType('made_up_action')).toBe(false);
    expect(isWorkflowActionType(42)).toBe(false);
  });

  it('every trigger event type is unique', () => {
    const names = WORKFLOW_TRIGGER_EVENTS.map((e) => e.type);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every action type is unique', () => {
    const names = WORKFLOW_ACTION_TYPES.map((a) => a.type);
    expect(new Set(names).size).toBe(names.length);
  });
});
