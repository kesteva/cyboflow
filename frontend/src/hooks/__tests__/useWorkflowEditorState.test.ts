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
 *   - workflow-scoped agent config editing (SET_AGENT_MODEL / SET_AGENT_CUSTOM /
 *     SET_AGENT_CUSTOM_FIELD): pruning of empty configs + empty maps, and
 *     preservation of `agentConfigs` across unrelated step/phase edits
 */
import { describe, it, expect } from 'vitest';
import {
  workflowEditorReducer,
  initWorkflowEditorState,
  type WorkflowEditorState,
} from '../useWorkflowEditorState';
import type { WorkflowAgentCustomCopy, WorkflowDefinition } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A two-phase definition with a loopback inside the second phase. */
function makeDefinition(): WorkflowDefinition {
  return {
    id: 'planner',
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
  return initWorkflowEditorState(makeDefinition(), 'planner');
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
    expect(state.name).toBe('planner');
    expect(state.selectedStepId).toBe('context');
    expect(state.selectedFanOutInner).toBeNull();
    expect(state.definition.phases).toHaveLength(2);
  });

  it('selects null when the graph has no steps', () => {
    const empty: WorkflowDefinition = { id: 'empty', phases: [] };
    const state = initWorkflowEditorState(empty, 'empty');
    expect(state.selectedStepId).toBeNull();
    expect(state.selectedFanOutInner).toBeNull();
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
// Fan-out editing
// ---------------------------------------------------------------------------

describe('workflowEditorReducer — fan-out editing', () => {
  it('SET_STEP_FANOUT seeds tasks plus one inner row and disabling deletes fanOut', () => {
    const enabled = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    expect(findStep(enabled.definition, 'implement')?.fanOut).toEqual({
      over: 'tasks',
      inner: [{ id: 'item', agent: 'executor', name: 'Item' }],
    });

    const disabled = workflowEditorReducer(enabled, {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: false,
    });
    expect(findStep(disabled.definition, 'implement')?.fanOut).toBeUndefined();
  });

  it('SET_STEP_FANOUT selects the target outer step so canvas chips and inspector stay in sync', () => {
    const enabled = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    expect(enabled.selectedStepId).toBe('implement');
    expect(enabled.selectedFanOutInner).toBeNull();
  });

  it('preserves unsupported loaded item sources until the user explicitly chooses tasks', () => {
    const definition = makeDefinition();
    definition.phases[1].steps[0].fanOut = {
      over: 'ideas',
      inner: [{ id: 'item', agent: 'executor', name: 'Item' }],
    };
    const loaded = initWorkflowEditorState(definition, 'planner');
    expect(findStep(loaded.definition, 'implement')?.fanOut?.over).toBe('ideas');

    const edited = workflowEditorReducer(loaded, {
      type: 'SET_FANOUT_OVER',
      phaseId: 'execute',
      stepId: 'implement',
    });
    expect(findStep(edited.definition, 'implement')?.fanOut?.over).toBe('tasks');
  });

  it('SELECT_FANOUT_INNER selects the owner step plus row context, and SELECT_STEP clears it', () => {
    const enabled = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    const innerSelected = workflowEditorReducer(enabled, {
      type: 'SELECT_FANOUT_INNER',
      stepId: 'implement',
      innerIndex: 0,
    });
    expect(innerSelected.selectedStepId).toBe('implement');
    expect(innerSelected.selectedFanOutInner).toEqual({ stepId: 'implement', innerIndex: 0 });

    const stepSelected = workflowEditorReducer(innerSelected, { type: 'SELECT_STEP', stepId: 'verify' });
    expect(stepSelected.selectedStepId).toBe('verify');
    expect(stepSelected.selectedFanOutInner).toBeNull();
  });

  it('fan-out inner edits update name, id, agent, optional, and loopback', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, { type: 'ADD_FANOUT_INNER', phaseId: 'execute', stepId: 'implement' });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      field: 'id',
      value: 'verify-inner',
    });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      field: 'name',
      value: 'Verify inner',
    });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      field: 'agent',
      value: 'verifier',
    });
    state = workflowEditorReducer(state, {
      type: 'TOGGLE_FANOUT_INNER_OPTIONAL',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
    });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_LOOPBACK',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      loopback: 'item',
    });

    expect(findStep(state.definition, 'implement')?.fanOut?.inner[1]).toEqual({
      id: 'verify-inner',
      name: 'Verify inner',
      agent: 'verifier',
      optional: true,
      loopback: 'item',
    });
  });

  it('empty inner names are stored as absent so display can fall back to id', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
      field: 'name',
      value: '',
    });

    expect(findStep(state.definition, 'implement')?.fanOut?.inner[0]).toEqual({
      id: 'item',
      agent: 'executor',
    });
  });

  it('inner id edits are kebab-case unique and update sibling loopback references', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, { type: 'ADD_FANOUT_INNER', phaseId: 'execute', stepId: 'implement' });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_LOOPBACK',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      loopback: 'item',
    });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_FIELD',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
      field: 'id',
      value: 'Item 2',
    });

    expect(findStep(state.definition, 'implement')?.fanOut?.inner).toEqual([
      { id: 'item-2-2', agent: 'executor', name: 'Item' },
      { id: 'item-2', agent: 'executor', name: 'Item 2', loopback: 'item-2-2' },
    ]);
  });

  it('inner loopback cannot target self or missing rows', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, { type: 'ADD_FANOUT_INNER', phaseId: 'execute', stepId: 'implement' });

    const self = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_LOOPBACK',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
      loopback: 'item',
    });
    expect(findStep(self.definition, 'implement')?.fanOut?.inner[0].loopback).toBeUndefined();

    const missing = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_LOOPBACK',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
      loopback: 'missing',
    });
    expect(findStep(missing.definition, 'implement')?.fanOut?.inner[0].loopback).toBeUndefined();
  });

  it('removing an inner row keeps at least one row, clears dangling loopbacks, and keeps selection valid', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, { type: 'ADD_FANOUT_INNER', phaseId: 'execute', stepId: 'implement' });
    state = workflowEditorReducer(state, {
      type: 'SET_FANOUT_INNER_LOOPBACK',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 1,
      loopback: 'item',
    });
    state = workflowEditorReducer(state, {
      type: 'SELECT_FANOUT_INNER',
      stepId: 'implement',
      innerIndex: 1,
    });

    const removedFirst = workflowEditorReducer(state, {
      type: 'REMOVE_FANOUT_INNER',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
    });
    expect(findStep(removedFirst.definition, 'implement')?.fanOut?.inner).toEqual([
      { id: 'item-2', agent: 'executor', name: 'Item 2' },
    ]);
    expect(removedFirst.selectedFanOutInner).toEqual({ stepId: 'implement', innerIndex: 0 });

    const stillOne = workflowEditorReducer(removedFirst, {
      type: 'REMOVE_FANOUT_INNER',
      phaseId: 'execute',
      stepId: 'implement',
      innerIndex: 0,
    });
    expect(findStep(stillOne.definition, 'implement')?.fanOut?.inner).toHaveLength(1);
    expect(stillOne.selectedFanOutInner).toEqual({ stepId: 'implement', innerIndex: 0 });
  });

  it('disabling fan-out while an inner row is selected returns to the outer step selection', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: true,
    });
    state = workflowEditorReducer(state, {
      type: 'SELECT_FANOUT_INNER',
      stepId: 'implement',
      innerIndex: 0,
    });
    const disabled = workflowEditorReducer(state, {
      type: 'SET_STEP_FANOUT',
      phaseId: 'execute',
      stepId: 'implement',
      enabled: false,
    });
    expect(disabled.selectedStepId).toBe('implement');
    expect(disabled.selectedFanOutInner).toBeNull();
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

// ---------------------------------------------------------------------------
// Workflow-scoped agent config editing (SET_AGENT_MODEL / SET_AGENT_CUSTOM /
// SET_AGENT_CUSTOM_FIELD)
// ---------------------------------------------------------------------------

/** A minimal, valid custom-agent copy for seeding SET_AGENT_CUSTOM. */
function makeCustomCopy(overrides: Partial<WorkflowAgentCustomCopy> = {}): WorkflowAgentCustomCopy {
  return {
    description: 'A custom agent',
    systemPrompt: 'You are a helpful agent.',
    tools: ['Read', 'Edit'],
    enabledMcps: ['filesystem'],
    ...overrides,
  };
}

describe('workflowEditorReducer — SET_AGENT_MODEL', () => {
  it('sets a model for an agent with no prior config', () => {
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    expect(next.definition.agentConfigs).toEqual({ executor: { model: 'opus' } });
  });

  it('overwrites an existing model', () => {
    const first = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    const second = workflowEditorReducer(first, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'sonnet',
    });
    expect(second.definition.agentConfigs).toEqual({ executor: { model: 'sonnet' } });
  });

  it('clearing the only field prunes the agent entry and the whole map', () => {
    const withModel = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    const cleared = workflowEditorReducer(withModel, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: null,
    });
    expect(cleared.definition.agentConfigs).toBeUndefined();
    expect('agentConfigs' in cleared.definition).toBe(false);
  });

  it('clearing the model leaves a sibling custom copy on the same agent intact', () => {
    const withCustom = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'executor',
      custom: makeCustomCopy(),
    });
    const withBoth = workflowEditorReducer(withCustom, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    const modelCleared = workflowEditorReducer(withBoth, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: null,
    });
    expect(modelCleared.definition.agentConfigs).toEqual({ executor: { custom: makeCustomCopy() } });
  });

  it('does not mutate the input state', () => {
    const state = makeState();
    const before = JSON.stringify(state.definition);
    workflowEditorReducer(state, { type: 'SET_AGENT_MODEL', agentKey: 'executor', model: 'opus' });
    expect(JSON.stringify(state.definition)).toBe(before);
  });
});

describe('workflowEditorReducer — SET_AGENT_CUSTOM', () => {
  it('installs a custom copy for an agent with no prior config', () => {
    const custom = makeCustomCopy();
    const next = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom,
    });
    expect(next.definition.agentConfigs).toEqual({ verifier: { custom } });
  });

  it('replaces an existing custom copy wholesale', () => {
    const first = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: makeCustomCopy({ description: 'v1' }),
    });
    const replaced = workflowEditorReducer(first, {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: makeCustomCopy({ description: 'v2' }),
    });
    expect(replaced.definition.agentConfigs?.verifier.custom?.description).toBe('v2');
  });

  it('reverting to predefined (null) removes the custom key and prunes the empty map', () => {
    const withCustom = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: makeCustomCopy(),
    });
    const reverted = workflowEditorReducer(withCustom, {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: null,
    });
    expect(reverted.definition.agentConfigs).toBeUndefined();
    expect('agentConfigs' in reverted.definition).toBe(false);
  });

  it('reverting to predefined leaves a sibling model override on the same agent intact', () => {
    const withModel = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'verifier',
      model: 'haiku',
    });
    const withBoth = workflowEditorReducer(withModel, {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: makeCustomCopy(),
    });
    const customReverted = workflowEditorReducer(withBoth, {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: null,
    });
    expect(customReverted.definition.agentConfigs).toEqual({ verifier: { model: 'haiku' } });
  });
});

describe('workflowEditorReducer — SET_AGENT_CUSTOM_FIELD', () => {
  it('no-ops when the agent has no custom copy at all', () => {
    const state = makeState();
    const next = workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'description',
      value: 'ignored',
    });
    // True structural AND referential no-op — the definition is untouched.
    expect(next.definition).toBe(state.definition);
    expect(next.definition.agentConfigs).toBeUndefined();
  });

  it('no-ops when the agent has a model override but no custom copy', () => {
    const withModel = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    const next = workflowEditorReducer(withModel, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'description',
      value: 'ignored',
    });
    expect(next.definition).toBe(withModel.definition);
  });

  it('edits description, systemPrompt, tools, and enabledMcps on an existing copy', () => {
    let state = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'executor',
      custom: makeCustomCopy(),
    });
    state = workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'description',
      value: 'Updated description',
    });
    state = workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'systemPrompt',
      value: 'Updated prompt',
    });
    state = workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'tools',
      value: ['Read', 'Bash'],
    });
    state = workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'enabledMcps',
      value: ['git'],
    });

    expect(state.definition.agentConfigs?.executor.custom).toEqual({
      description: 'Updated description',
      systemPrompt: 'Updated prompt',
      tools: ['Read', 'Bash'],
      enabledMcps: ['git'],
    });
  });
});

describe('workflowEditorReducer — agent config pruning + preservation', () => {
  it('a config left with neither model nor custom is dropped (clearing the last field)', () => {
    const withCustom = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'executor',
      custom: makeCustomCopy(),
    });
    const reverted = workflowEditorReducer(withCustom, {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'executor',
      custom: null,
    });
    expect(reverted.definition.agentConfigs).toBeUndefined();
  });

  it('an agentConfigs map left empty is removed entirely, not persisted as {}', () => {
    const withTwo = [
      { agentKey: 'executor', model: 'opus' as const },
      { agentKey: 'verifier', model: 'sonnet' as const },
    ].reduce(
      (state, { agentKey, model }) =>
        workflowEditorReducer(state, { type: 'SET_AGENT_MODEL', agentKey, model }),
      makeState(),
    );
    const clearedOne = workflowEditorReducer(withTwo, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: null,
    });
    // One entry remains — map still present.
    expect(clearedOne.definition.agentConfigs).toEqual({ verifier: { model: 'sonnet' } });

    const clearedBoth = workflowEditorReducer(clearedOne, {
      type: 'SET_AGENT_MODEL',
      agentKey: 'verifier',
      model: null,
    });
    // Last entry removed — the map itself is gone, not `{}`.
    expect(clearedBoth.definition.agentConfigs).toBeUndefined();
    expect(JSON.stringify(clearedBoth.definition)).not.toContain('agentConfigs');
  });

  it('unrelated step edits (SET_STEP_FIELD) preserve an existing agentConfigs map', () => {
    const withConfig = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_MODEL',
      agentKey: 'executor',
      model: 'opus',
    });
    const edited = workflowEditorReducer(withConfig, {
      type: 'SET_STEP_FIELD',
      phaseId: 'plan',
      stepId: 'context',
      field: 'name',
      value: 'Renamed',
    });
    expect(edited.definition.agentConfigs).toEqual({ executor: { model: 'opus' } });
    expect(findStep(edited.definition, 'context')?.name).toBe('Renamed');
  });

  it('unrelated phase edits (ADD_PHASE, SET_PHASE_LABEL) preserve an existing agentConfigs map', () => {
    const withConfig = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'verifier',
      custom: makeCustomCopy(),
    });
    const added = workflowEditorReducer(withConfig, { type: 'ADD_PHASE' });
    expect(added.definition.agentConfigs).toEqual({ verifier: { custom: makeCustomCopy() } });

    const labeled = workflowEditorReducer(added, {
      type: 'SET_PHASE_LABEL',
      phaseId: 'plan',
      label: 'Planning v2',
    });
    expect(labeled.definition.agentConfigs).toEqual({ verifier: { custom: makeCustomCopy() } });
  });

  it('does not mutate the input definition when editing a custom-field on an existing copy', () => {
    const state = workflowEditorReducer(makeState(), {
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'executor',
      custom: makeCustomCopy(),
    });
    const before = JSON.stringify(state.definition);
    workflowEditorReducer(state, {
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'executor',
      field: 'description',
      value: 'mutated?',
    });
    expect(JSON.stringify(state.definition)).toBe(before);
  });
});
