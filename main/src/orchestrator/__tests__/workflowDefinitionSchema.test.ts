/**
 * Unit tests for the strict WRITE-path zod validator
 * (`workflowDefinitionSchema.ts`).
 *
 * Behaviors covered (per the editable-blueprint contract):
 * 1. accepts a fully-valid definition (and round-trips an unchanged built-in)
 * 2. rejects a non-kebab step id
 * 3. rejects a non-kebab phase id
 * 4. rejects a bad (non-hex) phase colour
 * 5. rejects an empty phases array and an empty steps array
 * 6. rejects a negative / non-integer retries value
 * 7. rejects duplicate phase ids across the definition
 * 8. rejects duplicate step ids within a single phase
 * 9. rejects a loopback that targets a step in a DIFFERENT phase (cross-phase)
 * 10. accepts an intra-phase loopback
 *
 * Contrast with resolveWorkflowDefinition.test.ts: that suite covers the lenient
 * READ-path parser, which intentionally does NOT enforce these invariants.
 */
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  validateWorkflowDefinition,
  workflowDefinitionSchema,
} from '../workflowDefinitionSchema';
import {
  WORKFLOW_DEFINITIONS,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';

/** A fully-valid two-phase definition used as the mutation base for reject cases. */
function makeValidDefinition(): WorkflowDefinition {
  return {
    id: 'custom-flow',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Get context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
          { id: 'research', name: 'Research', agent: 'researcher', mcps: [], retries: 1, optional: true },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'implement', name: 'Implement', agent: 'executor', mcps: ['bash'], retries: 3 },
          {
            id: 'task-verify',
            name: 'Task verification',
            agent: 'verifier',
            mcps: ['filesystem'],
            retries: 3,
            loopback: 'implement',
          },
        ],
      },
    ],
  };
}

describe('validateWorkflowDefinition (accept cases)', () => {
  // -------------------------------------------------------------------------
  // Case 1: a hand-built valid definition parses and returns the same shape
  // -------------------------------------------------------------------------
  it('accepts a fully-valid definition and returns it', () => {
    const def = makeValidDefinition();
    expect(validateWorkflowDefinition(def)).toEqual(def);
  });

  // -------------------------------------------------------------------------
  // Case 1b: every shipped built-in must pass the strict schema
  // -------------------------------------------------------------------------
  it('accepts each of the five built-in definitions', () => {
    for (const def of Object.values(WORKFLOW_DEFINITIONS)) {
      expect(() => validateWorkflowDefinition(def)).not.toThrow();
    }
  });

  // -------------------------------------------------------------------------
  // Case 10: an intra-phase loopback is allowed (task-verify -> implement)
  // -------------------------------------------------------------------------
  it('accepts an intra-phase loopback target', () => {
    const def = makeValidDefinition();
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });
});

describe('validateWorkflowDefinition (reject cases)', () => {
  // -------------------------------------------------------------------------
  // Case 2: non-kebab step id
  // -------------------------------------------------------------------------
  it('rejects a step id that is not kebab-case', () => {
    const def = makeValidDefinition();
    def.phases[0].steps[0].id = 'Not_Kebab';
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 3: non-kebab phase id
  // -------------------------------------------------------------------------
  it('rejects a phase id that is not kebab-case', () => {
    const def = makeValidDefinition();
    def.phases[0].id = 'Plan Phase';
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 4: bad hex colour
  // -------------------------------------------------------------------------
  it('rejects a phase colour that is not a 6-digit hex value', () => {
    const def = makeValidDefinition();
    def.phases[0].color = 'blue';
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);

    const tooShort = makeValidDefinition();
    tooShort.phases[0].color = '#abc';
    expect(() => validateWorkflowDefinition(tooShort)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 5: empty phases / empty steps
  // -------------------------------------------------------------------------
  it('rejects an empty phases array', () => {
    const def = makeValidDefinition();
    def.phases = [];
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a phase with an empty steps array', () => {
    const def = makeValidDefinition();
    def.phases[0].steps = [];
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 6: invalid retries
  // -------------------------------------------------------------------------
  it('rejects a negative or non-integer retries value', () => {
    const negative = makeValidDefinition();
    negative.phases[0].steps[0].retries = -1;
    expect(() => validateWorkflowDefinition(negative)).toThrow(ZodError);

    const fractional = makeValidDefinition();
    fractional.phases[0].steps[0].retries = 1.5;
    expect(() => validateWorkflowDefinition(fractional)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 7: duplicate phase ids across the definition (superRefine)
  // -------------------------------------------------------------------------
  it('rejects duplicate phase ids across the definition', () => {
    const def = makeValidDefinition();
    def.phases[1].id = def.phases[0].id; // both become 'plan'
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 8: duplicate step ids within a single phase (superRefine)
  // -------------------------------------------------------------------------
  it('rejects duplicate step ids within a phase', () => {
    const def = makeValidDefinition();
    def.phases[0].steps[1].id = def.phases[0].steps[0].id; // both become 'context'
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Case 9: cross-phase loopback (target lives in a different phase)
  // -------------------------------------------------------------------------
  it('rejects a loopback that references a step in a different phase', () => {
    const def = makeValidDefinition();
    // 'context' lives in phase 'plan'; 'task-verify' lives in phase 'execute'.
    def.phases[1].steps[1].loopback = 'context';
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Bonus: a loopback to a non-existent step id is also rejected
  // -------------------------------------------------------------------------
  it('rejects a loopback that references a non-existent step id', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[1].loopback = 'does-not-exist';
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });
});

describe('workflowDefinitionSchema (direct .safeParse use as a tRPC input)', () => {
  // -------------------------------------------------------------------------
  // The schema is exported for direct use as a tRPC .input() field. Confirm it
  // behaves as a parseable schema via safeParse (success + failure shapes).
  // -------------------------------------------------------------------------
  it('safeParse succeeds for a valid definition', () => {
    const result = workflowDefinitionSchema.safeParse(makeValidDefinition());
    expect(result.success).toBe(true);
  });

  it('safeParse fails (without throwing) for an invalid definition', () => {
    const def = makeValidDefinition();
    def.phases[0].color = 'not-a-hex';
    const result = workflowDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });
});
