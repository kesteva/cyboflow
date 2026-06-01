/**
 * useWorkflowEditorState reducer tests (FEATURE: user-editable workflow blueprint editor).
 *
 * Exercises the PURE reducer + initial-state builder (no React) so the editor's
 * graph-coherence invariants are pinned independent of the canvas/inspector UI:
 *   - scalar field edits (name/agent/retries/desc; retries clamped to int >= 0)
 *   - TOGGLE_OPTIONAL / TOGGLE_HUMAN / TOGGLE_MCP add+remove semantics
 *   - SET_LOOPBACK same-phase restriction (rejects self + cross-phase + missing)
 *   - ADD/REMOVE/MOVE_STEP, incl. REMOVE_STEP clearing a dangling same-phase loopback
 *   - ADD/REMOVE/MOVE_PHASE (with last-phase / last-step guards)
 *   - SET_PHASE_LABEL / SET_PHASE_COLOR
 *   - generated step/phase ids stay unique + kebab-case
 */
import { describe, it, expect } from 'vitest';
import {
  workflowEditorReducer,
  initWorkflowEditorState,
  type WorkflowEditorState,
} from '../useWorkflowEditorState';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A two-phase definition with a loopback inside the second phase. */
function makeDefinition(): WorkflowDefinition {
  return {
    id: 'soloflow',
    phases: [
      {
        id: 'plan',
        label: 'Plan',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Context', agent: 'idea-extractor', mcps: ['filesystem'], retries: 0 },
          { id: 'approve-idea', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
        ],
      },
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'implement', name: 'Implement', agent: 'executor', mcps: ['filesystem', 'bash'], retries: 3 },
          { id: 'verify', name: 'Verify', agent: 'verifier', mcps: ['bash'], retries: 3, loopback: 'implement' },
        ],
      },
    ],
  };
}

function makeState(): WorkflowEditorState {
  return initWorkflowEditorState(makeDefinition(), 'soloflow');
}

/** Find a step by id across all phases. */
function findStep(def: WorkflowDefinition, stepId: string) {
  for (const phase of def.phases) {
    const step = phase.steps.find((s) => s.id === stepId);
    if (step) return step;
  }
  return undefined;
}

/** Find a phase by id. */
function findPhase(def: WorkflowDefinition, phaseId: string) {
  return def.phases.find((p) => p.id === phaseId);
}

// ---------------------------------------------------------------------------
// initWorkflowEditorState
// ---------------------------------------------------------------------------

describe('initWorkflowEditorState', () => {
  it('selects the first step of the first phase', () => {
    const state = makeState();
    expect(state.name).toBe('soloflow');
    expect(state.selectedStepId).toBe('context');
    expect(state.definition.phases).toHaveLength(2);
  });

  it('selects null when the graph has no steps', () => {
    const empty: WorkflowDefinition = { id: 'empty', phases: [] };
    const state = initWorkflowEditorState(empty, 'empty');
    expect(state.selectedStepId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SET_STEP_FIELD
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — SET_STEP_FIELD', () => {
  it('updates the step name', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FIELD',
      phaseId: 'plan',
      stepId: 'context',
      field: 'name',
      value: 'Renamed step',
    });
    expect(findStep(next.definition, 'context')?.name).toBe('Renamed step');
  });

  it('updates the step agent (free text allowed)', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FIELD',
      phaseId: 'plan',
      stepId: 'context',
      field: 'agent',
      value: 'my-custom-agent',
    });
    expect(findStep(next.definition, 'context')?.agent).toBe('my-custom-agent');
  });

  it('updates the step description', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FIELD',
      phaseId: 'plan',
      stepId: 'context',
      field: 'desc',
      value: 'A new description',
    });
    expect(findStep(next.definition, 'context')?.desc).toBe('A new description');
  });

  it('clamps retries to a non-negative integer', () => {
    const negative = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      field: 'retries',
      value: -5,
    });
    expect(findStep(negative.definition, 'implement')?.retries).toBe(0);

    const fractional = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      field: 'retries',
      value: 2.9,
    });
    expect(findStep(fractional.definition, 'implement')?.retries).toBe(2);
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    const before = JSON.stringify(state.definition);
    workflowEditorReducer(state, {
      type: 'SET_STEP_FIELD',
      phaseId: 'plan',
      stepId: 'context',
      field: 'name',
      value: 'mutated?',
    });
    expect(JSON.stringify(state.definition)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// TOGGLE_OPTIONAL / TOGGLE_HUMAN
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — TOGGLE_OPTIONAL / TOGGLE_HUMAN', () => {
  it('toggles optional on then off', () => {
    const on = workflowEditorReducer(makeState(), {
      type: 'TOGGLE_OPTIONAL',
      phaseId: 'execute',
      stepId: 'implement',
    });
    expect(findStep(on.definition, 'implement')?.optional).toBe(true);

    const off = workflowEditorReducer(on, {
      type: 'TOGGLE_OPTIONAL',
      phaseId: 'execute',
      stepId: 'implement',
    });
    expect(findStep(off.definition, 'implement')?.optional).toBe(false);
  });

  it('toggles human off then on', () => {
    const off = workflowEditorReducer(makeState(), {
      type: 'TOGGLE_HUMAN',
      phaseId: 'plan',
      stepId: 'approve-idea',
    });
    expect(findStep(off.definition, 'approve-idea')?.human).toBe(false);

    const on = workflowEditorReducer(off, {
      type: 'TOGGLE_HUMAN',
      phaseId: 'plan',
      stepId: 'approve-idea',
    });
    expect(findStep(on.definition, 'approve-idea')?.human).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TOGGLE_MCP
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — TOGGLE_MCP', () => {
  it('adds an MCP not already present', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'TOGGLE_MCP',
      phaseId: 'execute',
      stepId: 'implement',
      mcp: 'git',
    });
    expect(findStep(next.definition, 'implement')?.mcps).toContain('git');
  });

  it('removes an MCP already present', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'TOGGLE_MCP',
      phaseId: 'execute',
      stepId: 'implement',
      mcp: 'bash',
    });
    expect(findStep(next.definition, 'implement')?.mcps).not.toContain('bash');
    // Untouched entries remain.
    expect(findStep(next.definition, 'implement')?.mcps).toContain('filesystem');
  });
});

// ---------------------------------------------------------------------------
// SET_LOOPBACK
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — SET_LOOPBACK', () => {
  it('sets a loopback to another step in the same phase', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_LOOPBACK',
      phaseId: 'plan',
      stepId: 'approve-idea',
      loopback: 'context',
    });
    expect(findStep(next.definition, 'approve-idea')?.loopback).toBe('context');
  });

  it('clears the loopback when passed null', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_LOOPBACK',
      phaseId: 'execute',
      stepId: 'verify',
      loopback: null,
    });
    expect(findStep(next.definition, 'verify')?.loopback).toBeUndefined();
    // Key dropped entirely, not set to undefined-as-string.
    expect('loopback' in (findStep(next.definition, 'verify') ?? {})).toBe(false);
  });

  it('ignores a self-loopback', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_LOOPBACK',
      phaseId: 'execute',
      stepId: 'verify',
      loopback: 'verify',
    });
    // Self-loopback is rejected — the prior loopback is dropped, not set to self.
    expect(findStep(next.definition, 'verify')?.loopback).toBeUndefined();
  });

  it('ignores a loopback to a step in a different phase', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_LOOPBACK',
      phaseId: 'execute',
      stepId: 'verify',
      // 'context' lives in the 'plan' phase, not 'execute'.
      loopback: 'context',
    });
    expect(findStep(next.definition, 'verify')?.loopback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADD_STEP / REMOVE_STEP / MOVE_STEP
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — ADD_STEP', () => {
  it('appends a kebab-case, unique-id step and selects it', () => {
    const next = workflowEditorReducer(makeState(), { type: 'ADD_STEP', phaseId: 'plan' });
    const plan = findPhase(next.definition, 'plan');
    expect(plan?.steps).toHaveLength(3);
    const added = plan?.steps[plan.steps.length - 1];
    expect(added?.id).toMatch(KEBAB);
    expect(next.selectedStepId).toBe(added?.id);

    // The id is unique across the whole definition.
    const allIds = next.definition.phases.flatMap((p) => p.steps.map((s) => s.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('generates distinct kebab-case ids when adding multiple steps', () => {
    let state = makeState();
    state = workflowEditorReducer(state, { type: 'ADD_STEP', phaseId: 'plan' });
    state = workflowEditorReducer(state, { type: 'ADD_STEP', phaseId: 'plan' });
    state = workflowEditorReducer(state, { type: 'ADD_STEP', phaseId: 'execute' });

    const allIds = state.definition.phases.flatMap((p) => p.steps.map((s) => s.id));
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const id of allIds) expect(id).toMatch(KEBAB);
  });
});

describe('workflowEditorReducer — REMOVE_STEP', () => {
  it('removes a step from its phase', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'REMOVE_STEP',
      phaseId: 'plan',
      stepId: 'approve-idea',
    });
    expect(findStep(next.definition, 'approve-idea')).toBeUndefined();
    expect(findPhase(next.definition, 'plan')?.steps).toHaveLength(1);
  });

  it('clears a dangling same-phase loopback when its target is removed', () => {
    // 'verify' loops back to 'implement'; removing 'implement' must clear it.
    const next = workflowEditorReducer(makeState(), {
      type: 'REMOVE_STEP',
      phaseId: 'execute',
      stepId: 'implement',
    });
    expect(findStep(next.definition, 'implement')).toBeUndefined();
    expect(findStep(next.definition, 'verify')?.loopback).toBeUndefined();
  });

  it('refuses to remove the last step of a phase', () => {
    // Reduce 'plan' down to a single step first.
    const oneLeft = workflowEditorReducer(makeState(), {
      type: 'REMOVE_STEP',
      phaseId: 'plan',
      stepId: 'approve-idea',
    });
    const stillOne = workflowEditorReducer(oneLeft, {
      type: 'REMOVE_STEP',
      phaseId: 'plan',
      stepId: 'context',
    });
    expect(findPhase(stillOne.definition, 'plan')?.steps).toHaveLength(1);
    expect(findStep(stillOne.definition, 'context')).toBeDefined();
  });

  it('reselects a neighbour when the selected step is removed', () => {
    const state = workflowEditorReducer(makeState(), { type: 'SELECT_STEP', stepId: 'approve-idea' });
    const next = workflowEditorReducer(state, {
      type: 'REMOVE_STEP',
      phaseId: 'plan',
      stepId: 'approve-idea',
    });
    expect(next.selectedStepId).not.toBe('approve-idea');
    // Reselected id still exists in the graph.
    expect(findStep(next.definition, next.selectedStepId ?? '')).toBeDefined();
  });
});

describe('workflowEditorReducer — MOVE_STEP', () => {
  it('moves a step down within its phase', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'MOVE_STEP',
      phaseId: 'plan',
      stepId: 'context',
      dir: 'down',
    });
    expect(findPhase(next.definition, 'plan')?.steps.map((s) => s.id)).toEqual([
      'approve-idea',
      'context',
    ]);
  });

  it('moves a step up within its phase', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'MOVE_STEP',
      phaseId: 'execute',
      stepId: 'verify',
      dir: 'up',
    });
    expect(findPhase(next.definition, 'execute')?.steps.map((s) => s.id)).toEqual([
      'verify',
      'implement',
    ]);
  });

  it('is a no-op when moving the first step up', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'MOVE_STEP',
      phaseId: 'plan',
      stepId: 'context',
      dir: 'up',
    });
    expect(findPhase(next.definition, 'plan')?.steps.map((s) => s.id)).toEqual([
      'context',
      'approve-idea',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ADD_PHASE / REMOVE_PHASE / MOVE_PHASE
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — ADD_PHASE', () => {
  it('appends a phase with a unique kebab-case id + one seed step, and selects the step', () => {
    const next = workflowEditorReducer(makeState(), { type: 'ADD_PHASE' });
    expect(next.definition.phases).toHaveLength(3);
    const added = next.definition.phases[2];
    expect(added.id).toMatch(KEBAB);
    expect(added.steps).toHaveLength(1);
    expect(added.steps[0].id).toMatch(KEBAB);
    expect(next.selectedStepId).toBe(added.steps[0].id);

    // Phase ids unique.
    const phaseIds = next.definition.phases.map((p) => p.id);
    expect(new Set(phaseIds).size).toBe(phaseIds.length);
    // Step ids unique across the definition.
    const stepIds = next.definition.phases.flatMap((p) => p.steps.map((s) => s.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('keeps phase ids distinct when adding multiple phases', () => {
    let state = makeState();
    state = workflowEditorReducer(state, { type: 'ADD_PHASE' });
    state = workflowEditorReducer(state, { type: 'ADD_PHASE' });
    const phaseIds = state.definition.phases.map((p) => p.id);
    expect(new Set(phaseIds).size).toBe(phaseIds.length);
    for (const id of phaseIds) expect(id).toMatch(KEBAB);
  });
});

describe('workflowEditorReducer — REMOVE_PHASE', () => {
  it('removes a phase', () => {
    const next = workflowEditorReducer(makeState(), { type: 'REMOVE_PHASE', phaseId: 'execute' });
    expect(next.definition.phases).toHaveLength(1);
    expect(findPhase(next.definition, 'execute')).toBeUndefined();
  });

  it('refuses to remove the last remaining phase', () => {
    const oneLeft = workflowEditorReducer(makeState(), { type: 'REMOVE_PHASE', phaseId: 'execute' });
    const stillOne = workflowEditorReducer(oneLeft, { type: 'REMOVE_PHASE', phaseId: 'plan' });
    expect(stillOne.definition.phases).toHaveLength(1);
  });

  it('reselects a surviving step when the removed phase held the selection', () => {
    const state = workflowEditorReducer(makeState(), { type: 'SELECT_STEP', stepId: 'implement' });
    const next = workflowEditorReducer(state, { type: 'REMOVE_PHASE', phaseId: 'execute' });
    expect(next.selectedStepId).not.toBe('implement');
    expect(findStep(next.definition, next.selectedStepId ?? '')).toBeDefined();
  });
});

describe('workflowEditorReducer — MOVE_PHASE', () => {
  it('moves a phase down', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'MOVE_PHASE',
      phaseId: 'plan',
      dir: 'down',
    });
    expect(next.definition.phases.map((p) => p.id)).toEqual(['execute', 'plan']);
  });

  it('is a no-op moving the first phase up', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'MOVE_PHASE',
      phaseId: 'plan',
      dir: 'up',
    });
    expect(next.definition.phases.map((p) => p.id)).toEqual(['plan', 'execute']);
  });
});

// ---------------------------------------------------------------------------
// SET_PHASE_LABEL / SET_PHASE_COLOR / SET_NAME / SELECT_STEP
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — phase + top-level scalars', () => {
  it('SET_PHASE_LABEL updates the phase label', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_PHASE_LABEL',
      phaseId: 'plan',
      label: 'Planning',
    });
    expect(findPhase(next.definition, 'plan')?.label).toBe('Planning');
  });

  it('SET_PHASE_COLOR updates the phase colour', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_PHASE_COLOR',
      phaseId: 'plan',
      color: '#8b5cf6',
    });
    expect(findPhase(next.definition, 'plan')?.color).toBe('#8b5cf6');
  });

  it('SET_NAME updates the display name without touching the definition', () => {
    const state = makeState();
    const next = workflowEditorReducer(state, { type: 'SET_NAME', name: 'my-flow' });
    expect(next.name).toBe('my-flow');
    expect(next.definition).toBe(state.definition);
  });

  it('SELECT_STEP updates the selection', () => {
    const next = workflowEditorReducer(makeState(), { type: 'SELECT_STEP', stepId: 'verify' });
    expect(next.selectedStepId).toBe('verify');
  });

  it('SET_DEFINITION re-seeds and selects the first step', () => {
    const fresh: WorkflowDefinition = {
      id: 'planner',
      phases: [
        {
          id: 'refine',
          label: 'Refine',
          color: '#5a4ad6',
          steps: [{ id: 'epics', name: 'Epics', agent: 'task-refiner', mcps: [], retries: 0 }],
        },
      ],
    };
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_DEFINITION',
      definition: fresh,
      name: 'planner',
    });
    expect(next.definition).toBe(fresh);
    expect(next.name).toBe('planner');
    expect(next.selectedStepId).toBe('epics');
  });
});
