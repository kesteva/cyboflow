/**
 * Unit tests for RunDirectives — the per-run, MUTABLE operator-steering object
 * the WorkflowController reads live during a walk. Pins the factory + the
 * mutate-by-reference semantics the controller / SpawnStepRunner rely on.
 */
import { describe, it, expect } from 'vitest';
import { createRunDirectives } from '../runDirectives';

describe('createRunDirectives', () => {
  it('creates an empty, independent directives object', () => {
    const d = createRunDirectives();
    expect(d.userSkippedStepIds.size).toBe(0);
    expect(d.stepGuidance.size).toBe(0);

    // Distinct instances share no backing collections (per-run isolation).
    const other = createRunDirectives();
    d.userSkippedStepIds.add('a');
    d.stepGuidance.set('a', 'go');
    expect(other.userSkippedStepIds.size).toBe(0);
    expect(other.stepGuidance.size).toBe(0);
  });

  it('mutates in place so a held reference sees later skip additions/removals', () => {
    const d = createRunDirectives();
    const ref = d; // the controller holds the SAME object by reference

    d.userSkippedStepIds.add('s1');
    d.userSkippedStepIds.add('s2');
    expect(ref.userSkippedStepIds.has('s1')).toBe(true);
    expect(ref.userSkippedStepIds.has('s2')).toBe(true);

    d.userSkippedStepIds.delete('s1');
    expect(ref.userSkippedStepIds.has('s1')).toBe(false);
    expect(ref.userSkippedStepIds.has('s2')).toBe(true);
  });

  it('mutates guidance in place, overwriting a prior entry for the same step id', () => {
    const d = createRunDirectives();
    const ref = d;

    d.stepGuidance.set('impl', 'use the new API');
    expect(ref.stepGuidance.get('impl')).toBe('use the new API');

    d.stepGuidance.set('impl', 'actually, revert to the old API');
    expect(ref.stepGuidance.get('impl')).toBe('actually, revert to the old API');
    expect(ref.stepGuidance.size).toBe(1);
  });
});
