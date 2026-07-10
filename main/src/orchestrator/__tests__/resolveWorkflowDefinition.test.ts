/**
 * Unit tests for the shared READ-path workflow-definition resolver helpers
 * (`shared/types/workflows.ts`).
 *
 * Behaviors covered (per the editable-blueprint contract):
 * 1. isCyboflowWorkflowName: true for each built-in, false otherwise
 * 2. parseWorkflowDefinition: valid spec round-trips; null/undefined/''/'{}' -> null;
 *    invalid JSON -> null; non-object -> null; structurally-broken (no phases,
 *    empty phases, phase missing fields, step missing fields) -> null
 * 3. resolveWorkflowDefinition: built-in fallback when spec empty; valid spec
 *    override wins over the built-in; custom name + no spec -> null;
 *    custom name + valid spec -> uses the spec
 *
 * These helpers are intentionally lenient (READ path) — they do NOT enforce
 * kebab-case ids, hex colours, uniqueness, or loopback targeting. That strict
 * write-path validation is covered in workflowDefinitionSchema.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  isCyboflowWorkflowName,
  parseWorkflowDefinition,
  resolveWorkflowDefinition,
  CYBOFLOW_WORKFLOW_NAMES,
  WORKFLOW_DEFINITIONS,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';

/** A minimal but structurally-valid custom definition for override/spec tests. */
function makeValidDefinition(id = 'custom-flow'): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'phase-one',
        label: 'Phase One',
        color: '#3b6dd6',
        steps: [
          {
            id: 'do-thing',
            name: 'Do the thing',
            agent: 'executor',
            mcps: ['filesystem'],
            retries: 0,
          },
        ],
      },
    ],
  };
}

describe('isCyboflowWorkflowName', () => {
  // -------------------------------------------------------------------------
  // Case 1: every built-in name is recognised
  // -------------------------------------------------------------------------
  it('returns true for each built-in workflow name (planner/sprint/compound/ship)', () => {
    for (const name of CYBOFLOW_WORKFLOW_NAMES) {
      expect(isCyboflowWorkflowName(name)).toBe(true);
    }
    // Explicit coverage for the built-ins, incl. the Ship flow.
    expect(isCyboflowWorkflowName('planner')).toBe(true);
    expect(isCyboflowWorkflowName('sprint')).toBe(true);
    expect(isCyboflowWorkflowName('compound')).toBe(true);
    expect(isCyboflowWorkflowName('ship')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 2: anything else is rejected (custom flows, sentinel, empty)
  // -------------------------------------------------------------------------
  it('returns false for custom names, the quick sentinel, and empty strings', () => {
    expect(isCyboflowWorkflowName('wf-1-custom-abcd1234')).toBe(false);
    expect(isCyboflowWorkflowName('__quick__')).toBe(false);
    expect(isCyboflowWorkflowName('SOLOFLOW')).toBe(false);
    expect(isCyboflowWorkflowName('')).toBe(false);
  });
});

describe('parseWorkflowDefinition', () => {
  // -------------------------------------------------------------------------
  // Case 1: a valid spec round-trips back to an equal definition
  // -------------------------------------------------------------------------
  it('parses a valid stringified WorkflowDefinition', () => {
    const def = makeValidDefinition();
    const parsed = parseWorkflowDefinition(JSON.stringify(def));
    expect(parsed).toEqual(def);
  });

  // -------------------------------------------------------------------------
  // Case 1b: agentConfigs is an unknown-top-level-field pass-through — the
  // lenient reader does not validate its shape, only that it survives parse.
  // -------------------------------------------------------------------------
  it('round-trips agentConfigs (model + custom) through the lenient parser', () => {
    const def: WorkflowDefinition = {
      ...makeValidDefinition(),
      agentConfigs: {
        'sprint-review': { model: 'opus' },
        implement: {
          custom: {
            description: 'Custom implement agent for this workflow.',
            systemPrompt: 'You are a focused implementer.',
            tools: ['Read', 'Edit', 'Bash'],
            enabledMcps: ['filesystem'],
          },
        },
      },
    };
    const parsed = parseWorkflowDefinition(JSON.stringify(def));
    expect(parsed).toEqual(def);
    expect(parsed?.agentConfigs?.['sprint-review']).toEqual({ model: 'opus' });
    expect(parsed?.agentConfigs?.implement?.custom?.tools).toEqual(['Read', 'Edit', 'Bash']);
  });

  // -------------------------------------------------------------------------
  // Case 2: null / undefined / '' / '{}' all mean "no spec" -> null
  // -------------------------------------------------------------------------
  it('returns null for null, undefined, empty string, and empty object literal', () => {
    expect(parseWorkflowDefinition(null)).toBeNull();
    expect(parseWorkflowDefinition(undefined)).toBeNull();
    expect(parseWorkflowDefinition('')).toBeNull();
    expect(parseWorkflowDefinition('   ')).toBeNull();
    expect(parseWorkflowDefinition('{}')).toBeNull();
    expect(parseWorkflowDefinition('  {}  ')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 3: invalid JSON does not throw — it returns null
  // -------------------------------------------------------------------------
  it('returns null for malformed JSON without throwing', () => {
    expect(parseWorkflowDefinition('{ not valid json ')).toBeNull();
    expect(parseWorkflowDefinition('definitely not json')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 4: valid JSON that is not an object shape -> null
  // -------------------------------------------------------------------------
  it('returns null for valid JSON that is not a definition object', () => {
    expect(parseWorkflowDefinition('null')).toBeNull();
    expect(parseWorkflowDefinition('42')).toBeNull();
    expect(parseWorkflowDefinition('"a string"')).toBeNull();
    expect(parseWorkflowDefinition('[1, 2, 3]')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 5: structurally-broken definitions -> null
  // -------------------------------------------------------------------------
  it('returns null when id is missing or empty', () => {
    expect(parseWorkflowDefinition(JSON.stringify({ phases: [] }))).toBeNull();
    expect(
      parseWorkflowDefinition(JSON.stringify({ id: '', phases: makeValidDefinition().phases })),
    ).toBeNull();
  });

  it('returns null when phases is missing or empty', () => {
    expect(parseWorkflowDefinition(JSON.stringify({ id: 'x' }))).toBeNull();
    expect(parseWorkflowDefinition(JSON.stringify({ id: 'x', phases: [] }))).toBeNull();
  });

  it('returns null when a phase is missing required fields', () => {
    const missingLabel = {
      id: 'x',
      phases: [{ id: 'p', color: '#3b6dd6', steps: [{ id: 's', name: 'S', agent: 'a' }] }],
    };
    const missingColor = {
      id: 'x',
      phases: [{ id: 'p', label: 'P', steps: [{ id: 's', name: 'S', agent: 'a' }] }],
    };
    const emptySteps = {
      id: 'x',
      phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [] }],
    };
    expect(parseWorkflowDefinition(JSON.stringify(missingLabel))).toBeNull();
    expect(parseWorkflowDefinition(JSON.stringify(missingColor))).toBeNull();
    expect(parseWorkflowDefinition(JSON.stringify(emptySteps))).toBeNull();
  });

  it('returns null when a step is missing required id/name/agent', () => {
    const missingName = {
      id: 'x',
      phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 's', agent: 'a' }] }],
    };
    const missingAgent = {
      id: 'x',
      phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 's', name: 'S' }] }],
    };
    const emptyId = {
      id: 'x',
      phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: '', name: 'S', agent: 'a' }] }],
    };
    expect(parseWorkflowDefinition(JSON.stringify(missingName))).toBeNull();
    expect(parseWorkflowDefinition(JSON.stringify(missingAgent))).toBeNull();
    expect(parseWorkflowDefinition(JSON.stringify(emptyId))).toBeNull();
  });
});

describe('resolveWorkflowDefinition', () => {
  // -------------------------------------------------------------------------
  // Case 1: built-in name with no spec falls back to WORKFLOW_DEFINITIONS
  // -------------------------------------------------------------------------
  it('falls back to the built-in definition when spec is empty', () => {
    expect(resolveWorkflowDefinition('planner', '{}')).toEqual(WORKFLOW_DEFINITIONS.planner);
    expect(resolveWorkflowDefinition('sprint', null)).toEqual(WORKFLOW_DEFINITIONS.sprint);
    expect(resolveWorkflowDefinition('planner', '')).toEqual(WORKFLOW_DEFINITIONS.planner);
    // Ship is a built-in: a no-spec resolve round-trips to WORKFLOW_DEFINITIONS.ship.
    expect(resolveWorkflowDefinition('ship', '{}')).toEqual(WORKFLOW_DEFINITIONS.ship);
    expect(resolveWorkflowDefinition('ship', null)).toEqual(WORKFLOW_DEFINITIONS.ship);
  });

  // -------------------------------------------------------------------------
  // Case 2: a valid spec overrides the built-in (edited built-in flow)
  // -------------------------------------------------------------------------
  it('uses a valid spec override in preference to the built-in', () => {
    const edited = makeValidDefinition('planner');
    const resolved = resolveWorkflowDefinition('planner', JSON.stringify(edited));
    expect(resolved).toEqual(edited);
    expect(resolved).not.toEqual(WORKFLOW_DEFINITIONS.planner);
  });

  // -------------------------------------------------------------------------
  // Case 3: a built-in with a broken spec still resolves to the built-in
  // -------------------------------------------------------------------------
  it('falls back to the built-in when the spec is structurally broken', () => {
    expect(resolveWorkflowDefinition('sprint', '{ broken json')).toEqual(
      WORKFLOW_DEFINITIONS.sprint,
    );
    expect(resolveWorkflowDefinition('sprint', JSON.stringify({ id: 'x', phases: [] }))).toEqual(
      WORKFLOW_DEFINITIONS.sprint,
    );
  });

  // -------------------------------------------------------------------------
  // Case 4: a custom name with no usable spec is an error state -> null
  // -------------------------------------------------------------------------
  it('returns null for a custom name with a missing or broken spec', () => {
    expect(resolveWorkflowDefinition('wf-1-custom-deadbeef', '{}')).toBeNull();
    expect(resolveWorkflowDefinition('wf-1-custom-deadbeef', null)).toBeNull();
    expect(resolveWorkflowDefinition('wf-1-custom-deadbeef', '{ broken')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 5: a custom name with a valid spec resolves to that spec
  // -------------------------------------------------------------------------
  it('uses the spec for a custom name when it is valid', () => {
    const custom = makeValidDefinition('wf-1-custom-deadbeef');
    expect(resolveWorkflowDefinition('wf-1-custom-deadbeef', JSON.stringify(custom))).toEqual(
      custom,
    );
  });
});
