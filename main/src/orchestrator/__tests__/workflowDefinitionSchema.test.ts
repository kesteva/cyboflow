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
  effectiveMaxConcurrency,
  type WorkflowAgentConfig,
  type WorkflowDefinition,
  type FanOutSpec,
} from '../../../../shared/types/workflows';
import { SPRINT_BATCH_CAP } from '../../../../shared/types/sprintBatch';

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

describe('workflowDefinitionSchema (fan-out)', () => {
  // -------------------------------------------------------------------------
  // Accept: a step that declares a valid fanOut spec passes the strict schema.
  // -------------------------------------------------------------------------
  it('accepts a step with a valid fanOut spec', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [
        { id: 'implement', agent: 'implement', name: 'Implement' },
        { id: 'task-verify', agent: 'task-verify', name: 'Verify', optional: true },
      ],
    };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
    expect(validateWorkflowDefinition(def)).toEqual(def);
  });

  // -------------------------------------------------------------------------
  // Accept: fanOut.maxConcurrency at the boundary (1 = serial) and mid-range.
  // -------------------------------------------------------------------------
  it('accepts a fanOut with an explicit maxConcurrency (serial and parallel)', () => {
    const serial = makeValidDefinition();
    serial.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 1,
    };
    expect(() => validateWorkflowDefinition(serial)).not.toThrow();

    const parallel = makeValidDefinition();
    parallel.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 3,
    };
    expect(() => validateWorkflowDefinition(parallel)).not.toThrow();
  });

  it('accepts a fanOut with maxConcurrency absent (defaults resolved elsewhere)', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
    };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
    expect(validateWorkflowDefinition(def).phases[1].steps[0].fanOut?.maxConcurrency).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Reject: zero, negative, and non-integer maxConcurrency.
  // -------------------------------------------------------------------------
  it('rejects a non-positive-integer fanOut.maxConcurrency', () => {
    const zero = makeValidDefinition();
    zero.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 0,
    };
    expect(() => validateWorkflowDefinition(zero)).toThrow(ZodError);

    const negative = makeValidDefinition();
    negative.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: -2,
    };
    expect(() => validateWorkflowDefinition(negative)).toThrow(ZodError);

    const fractional = makeValidDefinition();
    fractional.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 2.5,
    };
    expect(() => validateWorkflowDefinition(fractional)).toThrow(ZodError);
  });

  it('round-trips fanOut.maxConcurrency through validation', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 2,
    };
    expect(validateWorkflowDefinition(def).phases[1].steps[0].fanOut?.maxConcurrency).toBe(2);
  });

  it('round-trips only the persisted FanOutInnerStep fields', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [
        { id: 'implement', agent: 'implement', name: 'Implement', optional: true },
      ],
    };
    const raw = structuredClone(def);
    const rawInner = raw.phases[1].steps[0].fanOut?.inner[0] as unknown as Record<string, unknown>;
    rawInner.retries = 3;
    rawInner.human = true;
    rawInner.mcps = ['filesystem'];
    rawInner.model = 'opus-4.5';

    const parsed = validateWorkflowDefinition(raw);

    expect(parsed.phases[1].steps[0].fanOut?.inner[0]).toEqual({
      id: 'implement',
      agent: 'implement',
      name: 'Implement',
      optional: true,
    });
  });

  // -------------------------------------------------------------------------
  // Reject: an empty inner array.
  // -------------------------------------------------------------------------
  it('rejects a fanOut with an empty inner array', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = { over: 'tasks', inner: [] };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Reject: a missing/empty `over`.
  // -------------------------------------------------------------------------
  it('rejects a fanOut with an empty over key', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: '',
      inner: [{ id: 'implement', agent: 'implement' }],
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Reject: duplicate inner step ids (superRefine, per-step).
  // -------------------------------------------------------------------------
  it('rejects duplicate fanOut inner step ids', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [
        { id: 'implement', agent: 'implement' },
        { id: 'implement', agent: 'write-tests' },
      ],
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Reject: an inner loopback that targets a non-existent inner id.
  // -------------------------------------------------------------------------
  it('rejects a fanOut inner loopback to a missing inner id', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [
        { id: 'implement', agent: 'implement' },
        { id: 'task-verify', agent: 'task-verify', loopback: 'does-not-exist' },
      ],
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Accept: an inner loopback that targets an existing inner id.
  // -------------------------------------------------------------------------
  it('accepts a fanOut inner loopback to an existing inner id', () => {
    const def = makeValidDefinition();
    def.phases[1].steps[0].fanOut = {
      over: 'tasks',
      inner: [
        { id: 'implement', agent: 'implement' },
        { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
      ],
    };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });
});

describe('workflowDefinitionSchema (agentConfigs)', () => {
  // -------------------------------------------------------------------------
  // Accept: model-only, custom-only, and both-set configs.
  // -------------------------------------------------------------------------
  it('accepts a config with only "model" set', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { model: 'opus' } };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  it('accepts a config with only "custom" set', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: {
        custom: {
          description: 'Custom implement agent.',
          systemPrompt: 'You are a focused implementer.',
          tools: ['Read', 'Edit', 'Bash'],
          enabledMcps: ['filesystem'],
        },
      },
    };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  it('accepts a config with both "model" and "custom" set', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: {
        model: 'sonnet',
        custom: {
          description: 'Custom implement agent.',
          systemPrompt: 'You are a focused implementer.',
          tools: ['Read', 'Edit'],
          enabledMcps: [],
        },
      },
    };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Reject: an empty {} config carries no signal and must be pruned by the
  // editor before persisting — the schema rejects it defensively.
  // -------------------------------------------------------------------------
  it('rejects an empty {} agentConfigs entry', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: {} };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Reject: a model alias outside AGENT_MODEL_ALIASES.
  // -------------------------------------------------------------------------
  it('rejects an unknown model alias', () => {
    const def = makeValidDefinition();
    const badConfig = { model: 'not-a-real-model' } as unknown as WorkflowAgentConfig;
    def.agentConfigs = { implement: badConfig };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Reject: an empty systemPrompt on a custom copy.
  // -------------------------------------------------------------------------
  it('rejects a custom copy with an empty systemPrompt', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: {
        custom: {
          description: 'Custom implement agent.',
          systemPrompt: '',
          tools: ['Read'],
          enabledMcps: [],
        },
      },
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  // -------------------------------------------------------------------------
  // Back-compat: a definition without agentConfigs at all is still valid.
  // -------------------------------------------------------------------------
  it('accepts a definition with no agentConfigs field (back-compat)', () => {
    const def = makeValidDefinition();
    expect(def.agentConfigs).toBeUndefined();
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });
});

describe('workflowDefinitionSchema (agentConfigs — Agents-pane validation parity)', () => {
  // A workflow-scoped custom copy is spawned exactly like an Agents-pane override,
  // so updateSpec must enforce the SAME chokepoint rules (validateAgentDraft) — it
  // must not be a side door around the single-writer / MCP-grant invariants.

  /** A parity-clean custom copy the cases below mutate one field at a time. */
  function validCustom(): NonNullable<WorkflowAgentConfig['custom']> {
    return {
      description: 'Custom implement agent.',
      systemPrompt: 'You are a focused implementer.',
      tools: ['Read', 'Edit'],
      enabledMcps: ['filesystem'],
    };
  }

  it('rejects a custom copy granting the cyboflow MCP server (single-writer invariant)', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), enabledMcps: ['cyboflow'] } } };
    expect(() => validateWorkflowDefinition(def)).toThrow(/single-writer/);
  });

  it('rejects a custom copy granting a cyboflow_-prefixed MCP server', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), enabledMcps: ['cyboflow_writer'] } } };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a custom copy whose enabledMcps entry is not a valid server name', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), enabledMcps: ['bad name!'] } } };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a custom copy whose prompt references a cyboflow_* entity-write tool', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: { custom: { ...validCustom(), systemPrompt: 'Then call cyboflow_report_finding.' } },
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(/single-writer|forbidden/);
  });

  it('rejects a custom copy whose description references a cyboflow_* tool', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: { custom: { ...validCustom(), description: 'Files findings via cyboflow_report_finding.' } },
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a custom copy with an empty tools list', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), tools: [] } } };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a custom copy with a whitespace-only description', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), description: '   ' } } };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('rejects a custom copy whose prompt starts with a frontmatter fence', () => {
    const def = makeValidDefinition();
    def.agentConfigs = {
      implement: { custom: { ...validCustom(), systemPrompt: '---\nname: hijack\n---\nbody' } },
    };
    expect(() => validateWorkflowDefinition(def)).toThrow(ZodError);
  });

  it('names the offending agent in the parity error message', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { custom: { ...validCustom(), enabledMcps: ['cyboflow'] } } };
    // ZodError.message JSON-escapes the inner quotes, so match the escaped form.
    expect(() => validateWorkflowDefinition(def)).toThrow(/workflow copy of agent \\"implement\\"/);
  });

  it('still accepts a parity-clean custom copy (parity does not over-reject)', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { model: 'sonnet', custom: validCustom() } };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });

  it('does not run draft parity for model-only configs (no custom body to validate)', () => {
    const def = makeValidDefinition();
    def.agentConfigs = { implement: { model: 'haiku' } };
    expect(() => validateWorkflowDefinition(def)).not.toThrow();
  });
});

describe('effectiveMaxConcurrency (shared/types/workflows helper)', () => {
  it('resolves to SPRINT_BATCH_CAP when maxConcurrency is absent', () => {
    const fanOut: FanOutSpec = { over: 'tasks', inner: [{ id: 'implement', agent: 'implement' }] };
    expect(effectiveMaxConcurrency(fanOut)).toBe(SPRINT_BATCH_CAP);
    expect(effectiveMaxConcurrency(fanOut)).toBe(5);
  });

  it('resolves to the explicit maxConcurrency when set, including 1 (serial)', () => {
    const serial: FanOutSpec = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 1,
    };
    expect(effectiveMaxConcurrency(serial)).toBe(1);

    const capped: FanOutSpec = {
      over: 'tasks',
      inner: [{ id: 'implement', agent: 'implement' }],
      maxConcurrency: 3,
    };
    expect(effectiveMaxConcurrency(capped)).toBe(3);
  });

  it('clamps invalid read-path caps instead of trusting them (empty-wave spin guard)', () => {
    const inner = [{ id: 'implement', agent: 'implement' }];
    // 0 / negative would slice an empty wave in the programmatic controller and
    // spin forever — clamp to serial.
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: 0 })).toBe(1);
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: -3 })).toBe(1);
    // Fractional values floor (then clamp).
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: 2.7 })).toBe(2);
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: 0.4 })).toBe(1);
    // Non-finite values fall back to the default cap.
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: Number.NaN })).toBe(SPRINT_BATCH_CAP);
    expect(effectiveMaxConcurrency({ over: 'tasks', inner, maxConcurrency: Number.POSITIVE_INFINITY })).toBe(
      SPRINT_BATCH_CAP,
    );
  });

  it("sprint and ship's built-in execute-tasks fanOut both resolve to the default cap (no explicit maxConcurrency)", () => {
    const sprintExecute = WORKFLOW_DEFINITIONS.sprint.phases
      .flatMap((p) => p.steps)
      .find((s) => s.id === 'execute-tasks');
    const shipExecute = WORKFLOW_DEFINITIONS.ship.phases
      .flatMap((p) => p.steps)
      .find((s) => s.id === 'execute-tasks');
    expect(sprintExecute?.fanOut).toBeDefined();
    expect(shipExecute?.fanOut).toBeDefined();
    expect(effectiveMaxConcurrency(sprintExecute!.fanOut!)).toBe(SPRINT_BATCH_CAP);
    expect(effectiveMaxConcurrency(shipExecute!.fanOut!)).toBe(SPRINT_BATCH_CAP);
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
