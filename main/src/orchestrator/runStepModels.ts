/**
 * runStepModels — resolve, per step of a run's flattened workflow definition,
 * which MODEL that step actually runs on (IDEA-061 — "Workflow summary should
 * show which model is running at each stage"). Backs `runs.getStepModels`
 * (the sibling tRPC procedure in `trpc/routers/runs.ts`); TASK-274's
 * live workflow-canvas rail and TASK-275's post-run summary panel both read
 * this module's output (via the procedure) and must not re-derive the
 * label/family precedence themselves.
 *
 * RESOLUTION PATH — deliberately identical to `runs.getPhaseState`: the same
 * `resolveRunFrozenSpec` -> live-JOIN-fallback -> `resolveWorkflowDefinition`
 * chain, and the same phases-in-declaration-order flattening, so every
 * `stepId` this emits lines up 1:1 with what the canvas/`getPhaseState`
 * already renders. A human-gate step (`resolveStepAgentKey` -> null) is
 * OMITTED entirely — never fabricate a model for a step nobody's agent runs.
 *
 * PRECEDENCE (per step):
 *   1. Resolve the step's `agentKey`, then its `EffectiveAgent` (project
 *      overrides + workflow agentConfigs + variant deltas — the SAME layering
 *      `agentOverlayWriter.resolveRunEffectiveAgents` materializes to disk).
 *      A step with no effective-agent entry is treated as fully inheriting
 *      (no pin) — a missing row is not a broken row.
 *   2. INHERIT the run-level model when every one of
 *      `{runtime, model, providerModel}` is unset, OR when `runtime` is a
 *      CLAUDE-family runtime but `model` is unset (an agent that only pins a
 *      Claude transport, not a specific model, still inherits the run's model
 *      choice) -> `workflow_runs.model` / `.agent_provider` via
 *      {@link runModelLabel}.
 *   3. Otherwise the step is PINNED -> {@link agentRunTargetLabel}.
 *
 * DEPENDENCY INJECTION, NOT A DIRECT IMPORT. This file lives under
 * `main/src/orchestrator/`, which `__tests__/standaloneInvariant.test.ts`
 * forbids from importing `main/src/services/*` at runtime (the tree is meant
 * to lift out of Electron as a plain Node service — see
 * docs/ARCHITECTURE.md -> "Team-tier v2"). The one collaborator this module
 * needs from outside that boundary —
 * `services/panels/claude/agentOverlayWriter.resolveRunEffectiveAgents` — is
 * therefore threaded in as `resolveEffectiveAgents`, exactly the shape that
 * function already has. The concrete function is bound once, from
 * `main/src/index.ts`, onto `ContextDeps.resolveRunEffectiveAgents` (mirrors
 * the existing `gitDiff` closure in `trpc/context.ts`).
 *
 * No caching layer: this resolves fresh on every call (already invoked at
 * most once per tRPC request).
 */
import type { DatabaseLike, LoggerLike } from './types';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import { resolveWorkflowDefinition, type WorkflowDefinition } from '../../../shared/types/workflows';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import { providerForRuntime } from '../../../shared/types/agentRuntime';
import {
  agentRunTargetLabel,
  runModelLabel,
  isAgentModelAlias,
  type AgentModelAlias,
  type ModelFamily,
} from '../../../shared/types/agents';
import type { EffectiveAgent } from './agents/effectiveAgents';
import type { WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';

/**
 * The shape of `agentOverlayWriter.resolveRunEffectiveAgents` — declared here
 * (not imported) so this file never takes a runtime edge into `services/*`.
 * See the module doc's "DEPENDENCY INJECTION" note.
 */
export type EffectiveAgentsResolver = (
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
) => EffectiveAgent[];

/** One flattened step's resolved model. Never carries agent internals
 * (systemPrompt/tools/mcp*) — this is the wire shape `runs.getStepModels`
 * returns verbatim. */
export interface StepModelInfo {
  stepId: string;
  stepName: string;
  phaseId: string;
  agentKey: string;
  label: string;
  family: ModelFamily;
}

/**
 * Thrown when the run row itself does not exist. The router maps this to
 * `TRPCError({ code: 'NOT_FOUND' })`, mirroring `getPhaseState`'s message.
 */
export class RunNotFoundError extends Error {}

/**
 * Thrown when the run resolves to no workflow definition (frozen spec absent,
 * live spec malformed, and the workflow name is not a built-in). Also mapped
 * to `NOT_FOUND` — same code `getPhaseState` uses for this case.
 */
export class RunDefinitionNotFoundError extends Error {}

interface RunRow {
  workflow_name: string;
  spec_json: string | null;
  run_model: string | null;
  run_provider: string | null;
}

/**
 * Derive the {@link ModelFamily} for an INHERITED (run-level) model.
 *
 * Provider is NOT consulted first: a recognized Claude-family alias always
 * wins regardless of `agent_provider`, an unset/empty/`'auto'` model is
 * always `'auto'` regardless of provider (so an inherited non-Claude run
 * with no model pinned still reads as "auto", not "other"), and only a
 * concrete non-Claude model string (e.g. a verbatim Codex model id) falls
 * through to `'other'`.
 */
function inheritedFamily(model: string | null): ModelFamily {
  if (model !== null && isAgentModelAlias(model)) return model;
  if (model === null || model === '' || model === 'auto') return 'auto';
  return 'other';
}

/** Derive the {@link ModelFamily} for a PINNED (per-agent) model. */
function pinnedFamily(runtime: WorkflowAgentRuntime | null, model: AgentModelAlias | null): ModelFamily {
  if (runtime !== null && providerForRuntime(runtime) !== 'claude') return 'other';
  if (model !== null && isAgentModelAlias(model)) return model;
  return 'auto';
}

/**
 * Resolve the run's effective workflow definition the SAME way `getPhaseState`
 * does: the frozen spec (its variant graph, else the live spec) with a
 * fallback to the live `workflow_runs`/`workflows` JOIN. Throws
 * {@link RunNotFoundError} / {@link RunDefinitionNotFoundError} on the same
 * two failure modes `getPhaseState` signals as `NOT_FOUND`.
 */
function resolveEffectiveDefinition(
  db: DatabaseLike,
  runId: string,
): { definition: WorkflowDefinition; runModel: string | null; runProvider: string | null } {
  const row = db
    .prepare(
      `SELECT wr.model AS run_model, wr.agent_provider AS run_provider,
              w.name AS workflow_name, w.spec_json AS spec_json
         FROM workflow_runs wr
         JOIN workflows w ON wr.workflow_id = w.id
        WHERE wr.id = ?`,
    )
    .get(runId) as RunRow | undefined;

  if (row === undefined) {
    throw new RunNotFoundError(`Run ${runId} not found`);
  }

  const frozen = resolveRunFrozenSpec(db, runId);
  const effectiveWorkflowName = frozen?.workflowName ?? row.workflow_name;
  const effectiveSpecJson = frozen ? frozen.specJson : row.spec_json;
  const definition = resolveWorkflowDefinition(effectiveWorkflowName, effectiveSpecJson);
  if (definition === null) {
    throw new RunDefinitionNotFoundError(
      `No workflow definition for run ${runId} (workflow name '${effectiveWorkflowName}')`,
    );
  }

  return { definition, runModel: row.run_model, runProvider: row.run_provider };
}

/**
 * Resolve, for every non-human step of `runId`'s flattened workflow
 * definition, the model it actually runs on. See the module doc for the full
 * resolution path and precedence.
 *
 * @param resolveEffectiveAgents Injected `agentOverlayWriter.resolveRunEffectiveAgents`
 *   (see the module doc's "DEPENDENCY INJECTION" note) — called exactly once.
 */
export function resolveRunStepModels(
  db: DatabaseLike,
  runId: string,
  resolveEffectiveAgents: EffectiveAgentsResolver,
  logger?: LoggerLike,
): StepModelInfo[] {
  const { definition, runModel, runProvider } = resolveEffectiveDefinition(db, runId);

  const effectiveByKey = new Map<string, EffectiveAgent>(
    resolveEffectiveAgents(db, runId, logger).map((a) => [a.agentKey, a] as const),
  );

  const out: StepModelInfo[] = [];
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      const agentKey = resolveStepAgentKey(step.id, step.agent);
      // Human gate — never fabricate a model for a step no agent runs.
      if (agentKey === null) continue;

      // Coalesce "no effective-agent row at all" and "a row with this field
      // left unset" to the SAME null — both mean "no pin" for that field.
      const effective = effectiveByKey.get(agentKey);
      const runtime: WorkflowAgentRuntime | null = effective?.runtime ?? null;
      const model: AgentModelAlias | null = effective?.model ?? null;
      const providerModel: string | null = effective?.providerModel ?? null;

      const isInherit =
        (runtime === null && model === null && providerModel === null) ||
        (runtime !== null && providerForRuntime(runtime) === 'claude' && model === null);

      const label = isInherit
        ? runModelLabel(runModel, runProvider)
        : agentRunTargetLabel({ runtime, model, providerModel });
      const family = isInherit ? inheritedFamily(runModel) : pinnedFamily(runtime, model);

      out.push({
        stepId: step.id,
        stepName: step.name,
        phaseId: phase.id,
        agentKey,
        label,
        family,
      });
    }
  }

  return out;
}
