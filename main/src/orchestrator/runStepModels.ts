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
 * PRECEDENCE (per step) — the SPAWN SEAM's, not a restatement of it:
 *   1. Resolve the step's `agentKey`, then its `EffectiveAgent` (project
 *      overrides + workflow agentConfigs + variant deltas — the SAME layering
 *      `agentOverlayWriter.resolveRunEffectiveAgents` materializes to disk).
 *      A step with no effective-agent entry is treated as fully inheriting
 *      (no pin) — a missing row is not a broken row.
 *   2. Apply the spawn-time gates `main/src/index.ts`'s `resolveStepAgent`
 *      applies (when injected): a runtime pin on a provider switched off in
 *      Settings is dropped ({@link gateRuntimePin}), and an unavailable guarded
 *      model alias is swapped for its fallback ({@link usableModelAlias}).
 *   3. Reduce pin + run provider/model through {@link resolveStepSpawnTarget}
 *      — the very function `programmatic/spawnStepRunner.ts` spawns with — and
 *      label the result: a `'pin'` via the Claude alias label or the verbatim
 *      provider model id, a `'run'` inherit via {@link runModelLabel}, and a
 *      `'provider-default'` (the step flipped provider with no pin for the new
 *      one) as that provider's default.
 *
 * DEPENDENCY INJECTION, NOT A DIRECT IMPORT. This file lives under
 * `main/src/orchestrator/`, which `__tests__/standaloneInvariant.test.ts`
 * forbids from importing `main/src/services/*` at runtime (the tree is meant
 * to lift out of Electron as a plain Node service — see
 * docs/ARCHITECTURE.md -> "Team-tier v2"). The collaborators this module
 * needs from outside that boundary — `resolveRunEffectiveAgents` and the
 * spawn gates — are declared as structural contracts in
 * `trpc/contracts/effectiveAgents.ts` and bound once, from `main/src/index.ts`,
 * onto `ContextDeps` (mirrors the existing `gitDiff` closure in
 * `trpc/context.ts`).
 *
 * No caching layer: this resolves fresh on every call (already invoked at
 * most once per tRPC request).
 */
import type { DatabaseLike } from './types';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import { resolveWorkflowDefinition, type WorkflowDefinition } from '../../../shared/types/workflows';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import {
  isAgentProvider,
  WORKFLOW_AGENT_RUNTIME_LABELS,
  type AgentProvider,
  type WorkflowAgentRuntime,
} from '../../../shared/types/agentRuntime';
import {
  AGENT_MODEL_LABELS,
  claudeModelFamily,
  claudeModelIdLabel,
  runModelLabel,
  isAgentModelAlias,
  type ModelFamily,
} from '../../../shared/types/agents';
import type { EffectiveAgent } from './agents/effectiveAgents';
import type { EffectiveAgentsResolver, StepModelGates } from './trpc/contracts/effectiveAgents';
import { gateRuntimePin, resolveStepSpawnTarget, usableModelAlias } from './stepSpawnTarget';

export type { EffectiveAgentsResolver, StepModelGates } from './trpc/contracts/effectiveAgents';

/** One flattened step's resolved model. Never carries agent internals
 * (systemPrompt/tools/mcp*) — this is the wire shape `runs.getStepModels`
 * returns verbatim. `WorkflowStep.id` is unique only WITHIN its phase, so
 * consumers key on `(phaseId, stepId[, fanOutStepId])` — see `stepModelKey` in
 * `shared/types/agents.ts`. `agentKey` is the resolved step agent identifier
 * (from `resolveStepAgentKey`) — not an internal, since it names nothing
 * about the agent's configuration, only which one ran.
 *
 * `fanOutStepId` is set ONLY on an entry produced from a `fanOut.inner` step
 * (the owning outer fan-out step's own `id`) — absent/undefined on every
 * OUTER-step entry. This is the discriminator a consumer keys on to tell the
 * two kinds of entry apart: an inner step's `id` can legally collide with an
 * outer step's `id` within the same phase, so the plain `(phaseId, stepId)`
 * pair is not enough to disambiguate. */
export interface StepModelInfo {
  stepId: string;
  stepName: string;
  phaseId: string;
  agentKey: string;
  label: string;
  family: ModelFamily;
  fanOutStepId?: string;
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
 * Derive the {@link ModelFamily} for an INHERITED (run-level) model: a Claude
 * alias is its own family; an unset/empty/`'auto'` model is `'auto'` regardless
 * of provider (a non-Claude run with no model pinned reads as "auto", not
 * "other"); a concrete Claude snapshot id on a Claude run (a launch-picker
 * "Other models" pick, e.g. `claude-opus-4-8[1m]`) buckets by its family; and
 * any other concrete id (a verbatim Codex/OMP model id) is `'other'`.
 */
function inheritedFamily(model: string | null, provider: AgentProvider): ModelFamily {
  if (model !== null && isAgentModelAlias(model)) return model;
  if (model === null || model === '' || model === 'auto') return 'auto';
  return provider === 'claude' ? (claudeModelFamily(model) ?? 'other') : 'other';
}

/** Label + family for a step's resolved Claude PIN (an alias, or a concrete id). */
function claudePinLabel(model: string): { label: string; family: ModelFamily } {
  if (isAgentModelAlias(model)) return { label: AGENT_MODEL_LABELS[model], family: model };
  return { label: claudeModelIdLabel(model) ?? model, family: claudeModelFamily(model) ?? 'other' };
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
 * Shape the per-step resolution helper is called with — the step's resolved
 * `agentKey` plus the exact triple `resolveStepSpawnTarget` reduces (already
 * gated by {@link gateRuntimePin} / {@link usableModelAlias} when `gates` is
 * supplied). `agentKey` is not read by the resolution itself; it is carried
 * here so both call sites (the outer-step loop and the fan-out inner-step
 * loop) pass ONE shape, matching the effective-agent lookup each performs
 * before calling in.
 */
interface StepModelResolutionInput {
  agentKey: string;
  runtime: WorkflowAgentRuntime | undefined;
  model: string | null;
  providerModel: string | null;
}

/**
 * The per-step label/family resolution body — steps 2-3 of the module doc's
 * PRECEDENCE list, reduced through the exact same {@link resolveStepSpawnTarget}
 * the spawn seam uses. Factored out so the outer-step loop and the fan-out
 * inner-step loop (`fanOut.inner`) can never drift from one another's
 * precedence.
 */
function resolveStepModelLabel(
  input: StepModelResolutionInput,
  runProvider: AgentProvider,
  runModel: string | null,
): { label: string; family: ModelFamily } {
  const { runtime, model, providerModel } = input;
  const target = resolveStepSpawnTarget({ runtime, model, providerModel }, runProvider, runModel);

  let label: string;
  let family: ModelFamily;
  if (target.source === 'run') {
    label = runModelLabel(runModel, runProvider);
    family = inheritedFamily(runModel, runProvider);
  } else if (
    target.source === 'pin' &&
    target.model !== undefined &&
    // A non-Claude pin of '' or 'auto' is not a pin at all — the same
    // "no concrete model" values `inheritedFamily` treats as unpinned.
    // Route those to the unpinned/provider-default branch below instead
    // of labeling the literal string 'auto' as a family:'other' model.
    (target.provider === 'claude' || (target.model !== '' && target.model !== 'auto'))
  ) {
    ({ label, family } =
      target.provider === 'claude' ? claudePinLabel(target.model) : { label: target.model, family: 'other' });
  } else {
    // Flipped provider with no pin for it — that provider's own default:
    // 'Auto' for Claude (the CLI default, as runModelLabel names it), else
    // the runtime's label ("Codex SDK") — no single model id to name.
    label = target.provider === 'claude' || !runtime ? 'Auto' : WORKFLOW_AGENT_RUNTIME_LABELS[runtime];
    family = 'auto';
  }
  return { label, family };
}

/**
 * Resolve, for every non-human step of `runId`'s flattened workflow
 * definition, the model it actually runs on. See the module doc for the full
 * resolution path and precedence.
 *
 * @param resolveEffectiveAgents Injected `agentOverlayWriter.resolveRunEffectiveAgents`
 *   (see the module doc's "DEPENDENCY INJECTION" note) — called exactly once.
 * @param gates Injected spawn-seam gates. Omitted (unit tests) ⇒ every provider
 *   is treated as enabled and every model as usable.
 */
export function resolveRunStepModels(
  db: DatabaseLike,
  runId: string,
  resolveEffectiveAgents: EffectiveAgentsResolver,
  gates?: StepModelGates,
): StepModelInfo[] {
  const { definition, runModel: rawRunModel, runProvider: rawRunProvider } = resolveEffectiveDefinition(db, runId);
  const runProvider: AgentProvider = isAgentProvider(rawRunProvider) ? rawRunProvider : 'claude';
  // The run-level spawn applies the same guarded-model fallback to a Claude run.
  const runModel =
    gates && runProvider === 'claude' ? usableModelAlias(rawRunModel, gates.isModelUsable) : rawRunModel;

  const effectiveByKey = new Map<string, EffectiveAgent>(
    resolveEffectiveAgents(db, runId).map((a) => [a.agentKey, a] as const),
  );

  const out: StepModelInfo[] = [];
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      const agentKey = resolveStepAgentKey(step.id, step.agent);
      // Human gate — never fabricate a model for a step no agent runs. The
      // `human` flag is honored too, so a custom spec that sets it without
      // `agent: 'human'` is still treated as a gate (the canvas card keys off
      // the flag, the backend off the agent key — both must agree). This only
      // omits the OUTER step's own entry: a step can legally be BOTH a human
      // gate AND a fan-out (a trailing checkpoint after fanning out real
      // agent work — `workflowController.ts`'s `hasTrailingGate`), so the
      // fan-out inner-step walk below always runs regardless of this skip.
      const skipOuter = agentKey === null || step.human === true;
      if (!skipOuter) {
        const effective = effectiveByKey.get(agentKey);
        const runtime = gates
          ? gateRuntimePin(effective?.runtime, gates.isProviderEnabled)
          : effective?.runtime ?? undefined;
        const claudeModel = effective?.model ?? null;
        const { label, family } = resolveStepModelLabel(
          {
            agentKey,
            runtime,
            model: gates ? usableModelAlias(claudeModel, gates.isModelUsable) : claudeModel,
            providerModel: effective?.providerModel ?? null,
          },
          runProvider,
          runModel,
        );

        out.push({ stepId: step.id, stepName: step.name, phaseId: phase.id, agentKey, label, family });
      }

      // Fan-out inner chain (IDEA-061 sprint-lane coverage): the sprint swimlane
      // strip's per-lane step cards come from `fanOut.inner`, not `phase.steps`.
      // Runs unconditionally whenever the outer step declares
      // `fanOut`, even when the outer step itself was just skipped above (a
      // human-gated fan-out step still ran real agent work in its inner
      // steps). Each inner step is resolved exactly like an outer step
      // (same agentKey resolution, same gates, same `resolveStepModelLabel`
      // precedence) and keyed with the owning fan-out step's own id
      // (`fanOutStepId`) so an inner id colliding with an outer id in the same
      // phase never clobbers the other's entry (see `stepModelKey`'s 3-arg
      // form, `shared/types/agents.ts`).
      if (step.fanOut !== undefined) {
        for (const inner of step.fanOut.inner) {
          const innerAgentKey = resolveStepAgentKey(inner.id, inner.agent);
          // Mirrors the outer human-gate omission above — defensive: today
          // `FanOutInnerStep.agent` is a required non-null string, so this
          // branch may never trigger in practice, but the check stays for
          // parity with the outer loop and future-proofing.
          if (innerAgentKey === null) continue;

          const innerEffective = effectiveByKey.get(innerAgentKey);
          const innerRuntime = gates
            ? gateRuntimePin(innerEffective?.runtime, gates.isProviderEnabled)
            : innerEffective?.runtime ?? undefined;
          const innerClaudeModel = innerEffective?.model ?? null;
          const innerResolved = resolveStepModelLabel(
            {
              agentKey: innerAgentKey,
              runtime: innerRuntime,
              model: gates ? usableModelAlias(innerClaudeModel, gates.isModelUsable) : innerClaudeModel,
              providerModel: innerEffective?.providerModel ?? null,
            },
            runProvider,
            runModel,
          );

          out.push({
            stepId: inner.id,
            stepName: inner.name ?? inner.id,
            phaseId: phase.id,
            agentKey: innerAgentKey,
            fanOutStepId: step.id,
            label: innerResolved.label,
            family: innerResolved.family,
          });
        }
      }
    }
  }

  return out;
}
