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
  FanOutInnerStep,
  WorkflowAgentConfig,
  WorkflowAgentCustomCopy,
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../shared/types/workflows';
import type { AgentModelAlias } from '../../../shared/types/agents';
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
  /** Currently-selected fan-out inner row, scoped by its owning outer step. */
  selectedFanOutInner: { stepId: string; innerIndex: number } | null;
}

const FANOUT_OVER_TASKS = 'tasks';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Scalar step fields editable via a single typed action. */
export type StepFieldAction =
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'name'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'agent'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'desc'; value: string }
  | { type: 'SET_STEP_FIELD'; phaseId: string; stepId: string; field: 'retries'; value: number };

/**
 * One (field, value) pair of `WorkflowAgentCustomCopy`, correlated via a
 * mapped type so the reducer can narrow `action.value`'s type from
 * `action.field` with no cast — mirrors `StepFieldAction`'s per-field
 * discriminated-union approach, generated instead of hand-enumerated since
 * `WorkflowAgentCustomCopy` has a `tools`/`enabledMcps` array-typed field.
 */
type AgentCustomFieldEdit = {
  [K in keyof WorkflowAgentCustomCopy]: { field: K; value: WorkflowAgentCustomCopy[K] };
}[keyof WorkflowAgentCustomCopy];

export type SetAgentCustomFieldAction = { type: 'SET_AGENT_CUSTOM_FIELD'; agentKey: string } & AgentCustomFieldEdit;

export type WorkflowEditorAction =
  | { type: 'SET_DEFINITION'; definition: WorkflowDefinition; name?: string }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SELECT_STEP'; stepId: string | null }
  | { type: 'SELECT_FANOUT_INNER'; stepId: string; innerIndex: number }
  | StepFieldAction
  | { type: 'TOGGLE_OPTIONAL'; phaseId: string; stepId: string }
  | { type: 'TOGGLE_HUMAN'; phaseId: string; stepId: string }
  | { type: 'TOGGLE_MCP'; phaseId: string; stepId: string; mcp: string }
  | { type: 'SET_LOOPBACK'; phaseId: string; stepId: string; loopback: string | null }
  // Fan-out (parallel per-item) editing.
  | { type: 'SET_STEP_FANOUT'; phaseId: string; stepId: string; enabled: boolean }
  | { type: 'SET_FANOUT_OVER'; phaseId: string; stepId: string }
  | { type: 'ADD_FANOUT_INNER'; phaseId: string; stepId: string }
  | { type: 'REMOVE_FANOUT_INNER'; phaseId: string; stepId: string; innerIndex: number }
  | {
      type: 'SET_FANOUT_INNER_FIELD';
      phaseId: string;
      stepId: string;
      innerIndex: number;
      field: 'id' | 'agent' | 'name';
      value: string;
    }
  | { type: 'TOGGLE_FANOUT_INNER_OPTIONAL'; phaseId: string; stepId: string; innerIndex: number }
  | { type: 'SET_FANOUT_INNER_LOOPBACK'; phaseId: string; stepId: string; innerIndex: number; loopback: string | null }
  | { type: 'ADD_STEP'; phaseId: string }
  | { type: 'REMOVE_STEP'; phaseId: string; stepId: string }
  | { type: 'MOVE_STEP'; phaseId: string; stepId: string; dir: 'up' | 'down' }
  | { type: 'ADD_PHASE' }
  | { type: 'REMOVE_PHASE'; phaseId: string }
  | { type: 'MOVE_PHASE'; phaseId: string; dir: 'up' | 'down' }
  | { type: 'SET_PHASE_LABEL'; phaseId: string; label: string }
  | { type: 'SET_PHASE_COLOR'; phaseId: string; color: string }
  // Workflow-scoped agent config editing (keyed by agent key, NOT step id —
  // see `WorkflowAgentConfig` doc comment for the per-workflow-agent scope).
  | { type: 'SET_AGENT_MODEL'; agentKey: string; model: AgentModelAlias | null }
  | { type: 'SET_AGENT_CUSTOM'; agentKey: string; custom: WorkflowAgentCustomCopy | null }
  | SetAgentCustomFieldAction;

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

/**
 * Convert free-text ids into the same kebab-case shape generated ids use.
 * Empty / punctuation-only values fall back to `item`.
 */
function kebabId(value: string, fallback = 'item'): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return id.length > 0 ? id : fallback;
}

/**
 * Derive a human-readable default label from a kebab-case id, e.g.
 * `'write-tests'` → `'Write tests'`. Used to seed a fan-out inner step's `name`
 * so the swimlane strip never shows a raw kebab id by default.
 */
function titleCaseId(id: string): string {
  const spaced = id.replace(/-/g, ' ').trim();
  if (spaced.length === 0) return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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

/**
 * Apply `fn` to one agent's config in `def.agentConfigs`, keyed by agent key
 * (the SAME vocabulary as `WorkflowStep.agent` — scope is per workflow-agent,
 * shared across every step that binds it, not per step). `fn` receives `{}`
 * when the agent has no config yet; returning the SAME reference back (a
 * declined edit — e.g. `SET_AGENT_CUSTOM_FIELD` with no existing custom copy)
 * makes this a true no-op, short-circuiting before any object is rebuilt.
 *
 * Enforces the two prune invariants so the modal's structural (JSON) dirty
 * check never sees a no-op edit as a diff:
 *   - a config left with neither `model` nor `custom` is dropped from the map
 *   - a map left empty is removed entirely (key absent, not `{}`)
 */
function mapAgentConfig(
  def: WorkflowDefinition,
  agentKey: string,
  fn: (config: WorkflowAgentConfig) => WorkflowAgentConfig,
): WorkflowDefinition {
  const current = def.agentConfigs?.[agentKey] ?? {};
  const next = fn(current);
  if (next === current) return def;

  const configs = { ...(def.agentConfigs ?? {}) };
  if (next.model === undefined && next.custom === undefined) {
    delete configs[agentKey];
  } else {
    configs[agentKey] = next;
  }

  const result = { ...def };
  if (Object.keys(configs).length === 0) {
    delete result.agentConfigs;
  } else {
    result.agentConfigs = configs;
  }
  return result;
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
      const definition = action.definition;
      const firstStepId = definition.phases[0]?.steps[0]?.id ?? null;
      return {
        name: action.name ?? state.name,
        definition,
        selectedStepId: firstStepId,
        selectedFanOutInner: null,
      };
    }

    case 'SET_NAME':
      return { ...state, name: action.name };

    case 'SELECT_STEP':
      return { ...state, selectedStepId: action.stepId, selectedFanOutInner: null };

    case 'SELECT_FANOUT_INNER':
      return {
        ...state,
        selectedStepId: action.stepId,
        selectedFanOutInner: { stepId: action.stepId, innerIndex: action.innerIndex },
      };

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

    case 'SET_STEP_FANOUT': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (action.enabled) {
            if (step.fanOut !== undefined) return step;
            // Seed a minimal one-inner-step chain over 'tasks' using the step's
            // own agent. Server zod (fanOutSchema) is authoritative on save.
            const fanOut: NonNullable<WorkflowStep['fanOut']> = {
              over: FANOUT_OVER_TASKS,
              inner: [{ id: 'item', agent: step.agent, name: 'Item' }],
            };
            return { ...step, fanOut };
          }
          // Disable — drop the key entirely.
          const rest = { ...step };
          delete rest.fanOut;
          return rest;
        }),
      );
      return { ...state, definition, selectedStepId: action.stepId, selectedFanOutInner: null };
    }

    case 'SET_FANOUT_OVER': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          return { ...step, fanOut: { ...step.fanOut, over: FANOUT_OVER_TASKS } };
        }),
      );
      return { ...state, definition };
    }

    case 'ADD_FANOUT_INNER': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          const taken = new Set(step.fanOut.inner.map((s) => s.id));
          const newId = uniqueId('item', taken);
          const newInner: FanOutInnerStep = {
            id: newId,
            agent: step.agent,
            // Seed a readable default lane label so user fan-out flows don't show
            // raw kebab ids in the swimlane strip (label falls back to id).
            name: titleCaseId(newId),
          };
          return {
            ...step,
            fanOut: { ...step.fanOut, inner: [...step.fanOut.inner, newInner] },
          };
        }),
      );
      return { ...state, definition };
    }

    case 'REMOVE_FANOUT_INNER': {
      const currentStep = state.definition.phases
        .find((p) => p.id === action.phaseId)
        ?.steps.find((s) => s.id === action.stepId);
      if ((currentStep?.fanOut?.inner.length ?? 0) <= 1) return state;
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          const removedId = step.fanOut.inner[action.innerIndex]?.id;
          const inner = step.fanOut.inner
            .filter((_, i) => i !== action.innerIndex)
            .map((row) => {
              if (row.loopback !== removedId) return row;
              const rest = { ...row };
              delete rest.loopback;
              return rest;
            });
          return { ...step, fanOut: { ...step.fanOut, inner } };
        }),
      );
      let selectedFanOutInner = state.selectedFanOutInner;
      if (selectedFanOutInner?.stepId === action.stepId) {
        if (selectedFanOutInner.innerIndex === action.innerIndex) {
          selectedFanOutInner = null;
        } else if (selectedFanOutInner.innerIndex > action.innerIndex) {
          selectedFanOutInner = {
            ...selectedFanOutInner,
            innerIndex: selectedFanOutInner.innerIndex - 1,
          };
        }
      }
      return { ...state, definition, selectedFanOutInner };
    }

    case 'SET_FANOUT_INNER_FIELD': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          let previousId: string | null = null;
          let nextId: string | null = null;
          const takenIds = new Set(
            step.fanOut.inner
              .map((row, i) => (i === action.innerIndex ? null : row.id))
              .filter((id): id is string => id !== null),
          );
          const inner = step.fanOut.inner.map((row, i) => {
            if (i !== action.innerIndex) return row;
            if (action.field === 'name') {
              const trimmed = action.value.trim();
              if (trimmed.length === 0) {
                const rest = { ...row };
                delete rest.name;
                return rest;
              }
              return { ...row, name: action.value };
            }
            if (action.field !== 'id') return { ...row, [action.field]: action.value };
            previousId = row.id;
            nextId = uniqueId(kebabId(action.value), takenIds);
            return { ...row, id: nextId };
          }).map((row, i) => {
            if (action.field !== 'id' || i === action.innerIndex || previousId === null) return row;
            if (row.loopback !== previousId) return row;
            if (nextId === null || nextId === row.id) {
              const rest = { ...row };
              delete rest.loopback;
              return rest;
            }
            return { ...row, loopback: nextId };
          });
          return { ...step, fanOut: { ...step.fanOut, inner } };
        }),
      );
      return { ...state, definition };
    }

    case 'TOGGLE_FANOUT_INNER_OPTIONAL': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          const inner = step.fanOut.inner.map((row, i) => {
            if (i !== action.innerIndex) return row;
            if (row.optional === true) {
              const rest = { ...row };
              delete rest.optional;
              return rest;
            }
            return { ...row, optional: true };
          });
          return { ...step, fanOut: { ...step.fanOut, inner } };
        }),
      );
      return { ...state, definition };
    }

    case 'SET_FANOUT_INNER_LOOPBACK': {
      const definition = mapPhase(state.definition, action.phaseId, (phase) =>
        mapStep(phase, action.stepId, (step) => {
          if (step.fanOut === undefined) return step;
          const targetIds = step.fanOut.inner
            .map((row, i) => (i === action.innerIndex ? null : row.id))
            .filter((id): id is string => id !== null);
          const inner = step.fanOut.inner.map((row, i) => {
            if (i !== action.innerIndex) return row;
            if (action.loopback === null || !targetIds.includes(action.loopback)) {
              const rest = { ...row };
              delete rest.loopback;
              return rest;
            }
            return { ...row, loopback: action.loopback };
          });
          return { ...step, fanOut: { ...step.fanOut, inner } };
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
        agent: 'implement',
        mcps: [],
        retries: 0,
      };
      const definition = mapPhase(state.definition, action.phaseId, (phase) => ({
        ...phase,
        steps: [...phase.steps, newStep],
      }));
      return { ...state, definition, selectedStepId: newId, selectedFanOutInner: null };
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
      const selectedFanOutInner =
        state.selectedFanOutInner?.stepId === action.stepId ? null : state.selectedFanOutInner;
      return { ...state, definition, selectedStepId, selectedFanOutInner };
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
            agent: 'implement',
            mcps: [],
            retries: 0,
          },
        ],
      };
      const definition: WorkflowDefinition = {
        ...state.definition,
        phases: [...state.definition.phases, newPhase],
      };
      return { ...state, definition, selectedStepId: newStepId, selectedFanOutInner: null };
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
      const phaseRemovedSelectedInner = state.selectedFanOutInner !== null
        && !definition.phases.some((phase) => phase.steps.some((step) => step.id === state.selectedFanOutInner?.stepId));
      return {
        ...state,
        definition,
        selectedStepId,
        selectedFanOutInner: phaseRemovedSelectedInner ? null : state.selectedFanOutInner,
      };
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

    case 'SET_AGENT_MODEL': {
      const definition = mapAgentConfig(state.definition, action.agentKey, (config) => {
        if (action.model === null) {
          if (config.model === undefined) return config;
          const rest = { ...config };
          delete rest.model;
          return rest;
        }
        return { ...config, model: action.model };
      });
      return { ...state, definition };
    }

    case 'SET_AGENT_CUSTOM': {
      const definition = mapAgentConfig(state.definition, action.agentKey, (config) => {
        if (action.custom === null) {
          if (config.custom === undefined) return config;
          const rest = { ...config };
          delete rest.custom;
          return rest;
        }
        return { ...config, custom: action.custom };
      });
      return { ...state, definition };
    }

    case 'SET_AGENT_CUSTOM_FIELD': {
      const definition = mapAgentConfig(state.definition, action.agentKey, (config) => {
        // No-op when there's no existing custom copy to edit — a single field
        // edit never installs one (SET_AGENT_CUSTOM does that explicitly).
        if (config.custom === undefined) return config;
        const custom = config.custom;
        switch (action.field) {
          case 'description':
            return { ...config, custom: { ...custom, description: action.value } };
          case 'systemPrompt':
            return { ...config, custom: { ...custom, systemPrompt: action.value } };
          case 'tools':
            return { ...config, custom: { ...custom, tools: action.value } };
          case 'enabledMcps':
            return { ...config, custom: { ...custom, enabledMcps: action.value } };
        }
      });
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
    selectedFanOutInner: null,
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
