/**
 * useWorkflowEditorState — pure reducer hook over a `WorkflowDefinition` plus a
 * `selectedStepId`, backing the blueprint editor (WorkflowEditorCanvas +
 * WorkflowStepInspector).
 *
 * Design constraints:
 *   - The reducer and `initWorkflowEditorState` are exported and PURE so they
 *     can be unit-tested without React.
 *   - INVARIANTS the reducer maintains on every transition:
 *       * new step / phase ids are unique kebab-case
 *       * REMOVE_STEP also clears any loopback in the SAME phase that pointed at
 *         the removed step (loopback is intra-phase only — v1 invariant)
 *       * loopback targets are restricted to OTHER step ids within the same
 *         phase (the inspector only offers same-phase ids; the reducer trusts
 *         the caller here but never writes a self-loopback via SET_LOOPBACK)
 *   - No zod (frontend has no zod dep). Authoritative validation is the
 *     server-side schema; this reducer only keeps the in-flight graph coherent.
 *
 * FEATURE: user-editable workflow blueprint editor.
 */
import { useReducer } from 'react';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../shared/types/workflows';
import { PHASE_COLORS } from '../components/cyboflow/workflowEditorOptions';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface WorkflowEditorState {
  /** The (display) name the flow will be saved under — separate from definition.id. */
  name: string;
  /** The working definition graph. */
  definition: WorkflowDefinition;
  /** Currently-selected step id (drives the inspector), or null. */
  selectedStepId: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Scalar step fields editable via a single typed action. */
export type StepFieldAction =
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'name'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'agent'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'desc'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'retries'; value: number };

export type WorkflowEditorAction =
  | { type: 'SET_DEFINITION'; definition: WorkflowDefinition; name?: string }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SELECT_STEP'; stepId: string | null }
  | StepFieldAction
  | { type: 'TOGGLE_OPTIONAL'; phaseId: string; stepId: string }
  | { type: 'TOGGLE_HUMAN'; phaseId: string; stepId: string }
  | { type: 'TOGGLE_MCP'; phaseId: string; stepId: string; mcp: string }
  | { type: 'SET_LOOPBACK'; phaseId: string; stepId: string; loopback: string | null }
  | { type: 'ADD_STEP'; phaseId: string }
  | { type: 'REMOVE_STEP'; phaseId: string; stepId: string }
  | { type: 'MOVE_STEP'; phaseId: string; stepId: string; dir: 'up' | 'down' }
  | { type: 'ADD_PHASE' }
  | { type: 'REMOVE_PHASE'; phaseId: string }
  | { type: 'MOVE_PHASE'; phaseId: string; dir: 'up' | 'down' }
  | { type: 'SET_PHASE_LABEL'; phaseId: string; label: string }
  | { type: 'SET_PHASE_COLOR'; phaseId: string; color: string };

// ---------------------------------------------------------------------------
// Id helpers — kebab-case + uniqueness
// ---------------------------------------------------------------------------

/** Collect every step id across all phases (for global-ish uniqueness checks). */
function allStepIds(def: WorkflowDefinition): Set<string> {
  const ids = new Set<string>();
  for (const phase of def.phases) {
    for (const step of phase.steps) ids.add(step.id);
  }
  return ids;
}

/** Collect every phase id. */
function allPhaseIds(def: WorkflowDefinition): Set<string> {
  return new Set(def.phases.map((p) => p.id));
}

/**
 * Produce a kebab-case id with `base` as the stem that is unique against `taken`.
 * Appends `-2`, `-3`, … until free. `base` is assumed already kebab-safe.
 */
function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// Immutable per-phase / per-step update helpers
// ---------------------------------------------------------------------------

/** Replace one phase (matched by id) via `fn`, returning a new definition. */
function mapPhase(
  def: WorkflowDefinition,
  phaseId: string,
  fn: (phase: WorkflowPhase) => WorkflowPhase,
): WorkflowDefinition {
  return {
    ...def,
    phases: def.phases.map((p) => (p.id === phaseId ? fn(p) : p)),
  };
}

/** Replace one step within a phase (matched by id) via `fn`. */
function mapStep(
  phase: WorkflowPhase,
  stepId: string,
  fn: (step: WorkflowStep) => WorkflowStep,
): WorkflowPhase {
  return {
    ...phase,
    steps: phase.steps.map((s) => (s.id === stepId ? fn(s) : s)),
  };
}

/** Swap two array entries by index, returning a new array (no-op if out of range). */
function swap<T>(arr: readonly T[], i: number, j: number): T[] {
  if (i < 0 || j < 0 || i >= arr.length || j >= arr.length) return arr.slice();
  const next = arr.slice();
  const tmp = next[i];
  next[i] = next[j];
  next[j] = tmp;
  return next;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function workflowEditorReducer(
  state: WorkflowEditorState,
  action: WorkflowEditorAction,
): WorkflowEditorState {
  switch (action.type) {
    case 'SET_DEFINITION': {
      const firstStepId = action.definition.phases[0]?.steps[0]?.id ?? null;
      return {
        name: action.name ?? state.name,
        definition: action.definition,
        selectedStepId: firstStepId,
      };
    }

    case 'SET_NAME':
      return { ...state, name: action.name };

    case 'SELECT_STEP':
      return { ...state, selectedStepId: action.stepId };

    case 'SET_STEP_FIELD': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (action.field === 'retries') {
            // Clamp to a non-negative integer (write-path schema requires int >= 0).
            const v = Number.isFinite(action.value) ? Math.max(0, Math.floor(action.value)) : 0;
            return { ...step, retries: v };
          }
          return { ...step, [action.field]: action.value };
        }),
      );
      return { ...state, definition };
    }

    case 'TOGGLE_OPTIONAL': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => ({ ...step, optional: step.optional !== true })),
      );
      return { ...state, definition };
    }

    case 'TOGGLE_HUMAN': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => ({ ...step, human: step.human !== true })),
      );
      return { ...state, definition };
    }

    case 'TOGGLE_MCP': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          const has = step.mcps.includes(action.mcp);
          const mcps = has
            ? step.mcps.filter((m) => m !== action.mcp)
            : [...step.mcps, action.mcp];
          return { ...step, mcps };
        }),
      );
      return { ...state, definition };
    }

    case 'SET_LOOPBACK': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          // Restrict to OTHER same-phase step ids; ignore self-loopback and ids
          // not present in this phase (intra-phase invariant).
          if (
            action.loopback === null ||
            action.loopback === action.stepId ||
            !phase.steps.some((s) => s.id === action.loopback)
          ) {
            // Drop the loopback key entirely when cleared.
            const rest = { ...step };
            delete rest.loopback;
            return rest;
          }
          return { ...step, loopback: action.loopback };
        }),
      );
      return { ...state, definition };
    }

    case 'ADD_STEP': {
      const taken = allStepIds(state.definition);
      const newId = uniqueId('step', taken);
      const newStep: WorkflowStep = {
        id: newId,
        name: 'New step',
        agent: 'executor',
        mcps: [],
        retries: 0,
      };
      const definition = mapPhase(state.definition, action.phaseId, (phase) => ({
        ...phase,
        steps: [...phase.steps, newStep],
      }));
      return { ...state, definition, selectedStepId: newId };
    }

    case 'REMOVE_STEP': {
      const phase = state.definition.phases.find((p) => p.id === action.phaseId);
      // Guard: never remove the last step of a phase (a phase must keep >= 1 step).
      if (!phase || phase.steps.length <= 1) return state;

      const definition = mapPhase(state.definition, action.phaseId, (p) => ({
        ...p,
        steps: p.steps
          .filter((s) => s.id !== action.stepId)
          // Clear any same-phase loopback that pointed at the removed step.
          .map((s) => {
            if (s.loopback === action.stepId) {
              const rest = { ...s };
              delete rest.loopback;
              return rest;
            }
            return s;
          }),
      }));

      // Reselect a sensible neighbour if the removed step was selected.
      let selectedStepId = state.selectedStepId;
      if (selectedStepId === action.stepId) {
        const remaining = definition.phases.flatMap((p) => p.steps.map((s) => s.id));
        selectedStepId = remaining[0] ?? null;
      }
      return { ...state, definition, selectedStepId };
    }

    case 'MOVE_STEP': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) => {
        const idx = phase.steps.findIndex((s) => s.id === action.stepId);
        if (idx === -1) return phase;
        const target = action.dir === 'up' ? idx - 1 : idx + 1;
        return { ...phase, steps: swap(phase.steps, idx, target) };
      });
      return { ...state, definition };
    }

    case 'ADD_PHASE': {
      const takenPhaseIds = allPhaseIds(state.definition);
      const newPhaseId = uniqueId('phase', takenPhaseIds);
      const takenStepIds = allStepIds(state.definition);
      const newStepId = uniqueId('step', takenStepIds);
      const newPhase: WorkflowPhase = {
        id: newPhaseId,
        label: 'New phase',
        color: PHASE_COLORS[0],
        steps: [
          {
            id: newStepId,
            name: 'New step',
            agent: 'executor',
            mcps: [],
            retries: 0,
          },
        ],
      };
      const definition: WorkflowDefinition = {
        ...state.definition,
        phases: [...state.definition.phases, newPhase],
      };
      return { ...state, definition, selectedStepId: newStepId };
    }

    case 'REMOVE_PHASE': {
      // Guard: never remove the last phase (a definition must keep >= 1 phase).
      if (state.definition.phases.length <= 1) return state;

      const definition: WorkflowDefinition = {
        ...state.definition,
        phases: state.definition.phases.filter((p) => p.id !== action.phaseId),
      };

      // Reselect if the removed phase held the selected step.
      const remaining = definition.phases.flatMap((p) => p.steps.map((s) => s.id));
      const selectedStepId =
        state.selectedStepId !== null && remaining.includes(state.selectedStepId)
          ? state.selectedStepId
          : (remaining[0] ?? null);
      return { ...state, definition, selectedStepId };
    }

    case 'MOVE_PHASE': {
      const idx = state.definition.phases.findIndex((p) => p.id === action.phaseId);
      if (idx === -1) return state;
      const target = action.dir === 'up' ? idx - 1 : idx + 1;
      const definition: WorkflowDefinition = {
        ...state.definition,
        phases: swap(state.definition.phases, idx, target),
      };
      return { ...state, definition };
    }

    case 'SET_PHASE_LABEL': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) => ({
        ...phase,
        label: action.label,
      }));
      return { ...state, definition };
    }

    case 'SET_PHASE_COLOR': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) => ({
        ...phase,
        color: action.color,
      }));
      return { ...state, definition };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Initial-state builder
// ---------------------------------------------------------------------------

/**
 * Build the initial editor state from a definition + display name. Selects the
 * first step of the first phase (or null when the graph is empty).
 */
export function initWorkflowEditorState(
  definition: WorkflowDefinition,
  name: string,
): WorkflowEditorState {
  return {
    name,
    definition,
    selectedStepId: definition.phases[0]?.steps[0]?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseWorkflowEditorStateResult {
  state: WorkflowEditorState;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

/**
 * React binding over the pure reducer. Seed with a definition + name; callers
 * re-seed via `dispatch({ type: 'SET_DEFINITION', … })` once the async fetch
 * resolves.
 */
export function useWorkflowEditorState(
  definition: WorkflowDefinition,
  name: string,
): UseWorkflowEditorStateResult {
  const [state, dispatch] = useReducer(
    workflowEditorReducer,
    { definition, name },
    (init) => initWorkflowEditorState(init.definition, init.name),
  );
  return { state, dispatch };
}
