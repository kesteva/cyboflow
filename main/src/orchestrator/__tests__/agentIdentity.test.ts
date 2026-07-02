/**
 * agentIdentity.test.ts — locks the canonical agent-key vocabulary + the
 * step-aware legacy resolver against WORKFLOW_DEFINITIONS.
 *
 * Coverage:
 *   AC-P0-1: every shipped step.agent is canonical OR the human gate.
 *   AC-P0-2: resolveStepAgentKey maps legacy/dual-binding labels correctly.
 *   AC-P0-3: phantom labels (visual-verifier, test-writer) are NOT remapped.
 *   Plus: CANONICAL_AGENT_KEYS shape + isCanonicalAgentKey guard.
 */
import { describe, it, expect } from 'vitest';

import {
  resolveStepAgentKey,
  normalizeAgentLabel,
  CANONICAL_AGENT_KEYS,
  HUMAN_GATE_AGENT,
  isCanonicalAgentKey,
} from '../../../../shared/types/agentIdentity';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';

describe('AC-P0-1: every shipped step.agent is canonical or the human gate', () => {
  const allowed = new Set<string>([...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]);

  for (const [name, def] of Object.entries(WORKFLOW_DEFINITIONS)) {
    for (const phase of def.phases) {
      for (const step of phase.steps) {
        it(`${name} / ${phase.id} / ${step.id} → agent "${step.agent}" is allowed`, () => {
          expect(allowed.has(step.agent)).toBe(true);
        });
      }
    }
  }
});

describe('AC-P0-2: resolveStepAgentKey', () => {
  it('disambiguates the dual-binding task-refiner label by stepId', () => {
    expect(resolveStepAgentKey('epics', 'task-refiner')).toBe('epics');
    expect(resolveStepAgentKey('tasks', 'task-refiner')).toBe('tasks');
  });

  it('maps legacy labels to their canonical key', () => {
    expect(resolveStepAgentKey('sprint-verify', 'verifier')).toBe('sprint-verify');
    expect(resolveStepAgentKey('sprint-review', 'code-reviewer')).toBe('sprint-review');
    expect(resolveStepAgentKey('execute-tasks', 'executor')).toBe('implement');
    expect(resolveStepAgentKey('context', 'idea-extractor')).toBe('context');
    expect(resolveStepAgentKey('research', 'researcher')).toBe('research');
  });

  it('returns null for the human gate regardless of stepId', () => {
    expect(resolveStepAgentKey('anything', 'human')).toBeNull();
    expect(resolveStepAgentKey('epics', 'human')).toBeNull();
  });

  it('is identity for already-canonical labels', () => {
    expect(resolveStepAgentKey('execute-tasks', 'implement')).toBe('implement');
  });
});

describe('AC-P0-3: no phantom labels remapped', () => {
  it('leaves phantom labels untouched (never appeared in a shipped definition)', () => {
    expect(normalizeAgentLabel('visual-verifier')).toBe('visual-verifier');
    expect(normalizeAgentLabel('test-writer')).toBe('test-writer');
  });

  it('still maps a real legacy label', () => {
    expect(normalizeAgentLabel('executor')).toBe('implement');
  });
});

describe('CANONICAL_AGENT_KEYS shape + isCanonicalAgentKey guard', () => {
  it('has exactly 15 canonical keys', () => {
    expect(CANONICAL_AGENT_KEYS.length).toBe(15);
  });

  it('returns true for a member and false for a non-member', () => {
    expect(isCanonicalAgentKey('implement')).toBe(true);
    expect(isCanonicalAgentKey('not-an-agent')).toBe(false);
  });
});
