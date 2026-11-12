/**
 * stepSpawnTarget — the ONE pure reduction from "a step's per-agent pin + the
 * run's provider/model" to "the provider + model that step actually spawns
 * on". Two consumers must agree on it byte-for-byte:
 *
 *   - `programmatic/spawnStepRunner.ts` — the spawn seam itself;
 *   - `runStepModels.ts` — the per-step model rail / "Models used" summary
 *     (IDEA-061), which exists to REPORT that same answer.
 *
 * Before this module each restated the precedence independently and they had
 * drifted (a Claude-runtime pin on a Codex run inherited the Codex model id on
 * the rail but the Claude default at spawn; a Claude alias pin on a Codex run
 * was painted on the rail but ignored at spawn; …). Keep every rule here.
 *
 * The spawn-time GATES `programmaticRunnerComposition.ts`'s `resolveStepAgent`
 * applies before handing a pin to the spawner live here too
 * ({@link gateStepAgentPin}, {@link usableModelAlias}) so the rail can apply
 * them with the same code.
 */
import { providerForRuntime, type AgentProvider, type WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';
import { guardedModelByAlias } from '../../../shared/types/modelAvailability';

/** The per-agent pin fields the spawn precedence reads. */
export interface StepAgentPin {
  runtime?: WorkflowAgentRuntime | null;
  /** Claude model (alias or concrete id) — consulted only for a Claude spawn. */
  model?: string | null;
  /** Non-Claude provider model id — consulted only for a non-Claude spawn. */
  providerModel?: string | null;
  /** @deprecated read-compat alias of {@link providerModel}. */
  codexModel?: string | null;
}

export interface StepSpawnTarget {
  /** The provider the step spawns under. */
  provider: AgentProvider;
  /** The model passed to the spawn, or `undefined` for that provider's default. */
  model: string | undefined;
  /**
   * Where {@link model} came from: the per-agent `'pin'`, the run-level model
   * (`'run'` — the step stayed on the run's provider and had no matching pin),
   * or `'provider-default'` (the step FLIPPED provider with no pin for the new
   * one — the run's model belongs to the other provider and is never carried
   * across).
   */
  source: 'pin' | 'run' | 'provider-default';
}

/**
 * Resolve the provider + model a step spawns on. `runModel` is the run-level
 * model (`workflow_runs.model`), passed through as-is on the `'run'` arm.
 *
 * Which pin FIELD a provider reads is keyed on the CLAUDE branch, never the
 * non-Claude one: Claude keeps its own alias field (`model`), and EVERY other
 * provider shares the generic `providerModel` field.
 */
export function resolveStepSpawnTarget(
  pin: StepAgentPin | undefined,
  runProvider: AgentProvider,
  runModel: string | null | undefined,
): StepSpawnTarget {
  const stepRuntime = pin?.runtime ?? undefined;
  const provider = stepRuntime ? providerForRuntime(stepRuntime) : runProvider;
  const perAgentModel =
    provider === 'claude' ? pin?.model : pin?.providerModel ?? pin?.codexModel;
  if (perAgentModel) return { provider, model: perAgentModel, source: 'pin' };
  if (provider === runProvider) return { provider, model: runModel ?? undefined, source: 'run' };
  return { provider, model: undefined, source: 'provider-default' };
}

/**
 * Provider-access gate for a PER-AGENT runtime pin: a pin naming a provider the
 * user switched off (Settings → Integrations) is dropped, so the step falls back
 * to the run-level provider (which createRun already resolved onto an ENABLED
 * provider). Returns the pin to honor, or `undefined` when it is dropped/absent.
 */
export function gateRuntimePin(
  runtime: WorkflowAgentRuntime | null | undefined,
  isProviderEnabled: (provider: AgentProvider) => boolean,
): WorkflowAgentRuntime | undefined {
  if (!runtime) return undefined;
  return isProviderEnabled(providerForRuntime(runtime)) ? runtime : undefined;
}

/**
 * A pin's `providerModel` once a spawn-time gate DROPPED its runtime. The id names a model of the dropped runtime's
 * provider, so it survives only when the step falls back onto that same provider (a `codex-pty` pin on a Codex
 * run). On any other fallback it would be handed to a provider that does not know it (an OMP model id on a Codex
 * run, failing the step) — dropped, so the step takes the run's model.
 */
export function providerModelAfterRuntimeDrop(
  droppedRuntime: WorkflowAgentRuntime,
  runProvider: AgentProvider,
  providerModel: string | null | undefined,
): string | undefined {
  if (!providerModel) return undefined;
  return providerForRuntime(droppedRuntime) === runProvider ? providerModel : undefined;
}

/** The one runtime of each provider a remote environment can host (mirrors hostsBridge's HostLaunchRuntime). */
const REMOTE_RUNTIME_BY_PROVIDER: Partial<Record<AgentProvider, WorkflowAgentRuntime>> = {
  claude: 'claude-sdk',
  codex: 'codex-sdk',
};

/**
 * The runtime a REMOTE run uses for a per-agent runtime pin: the pin itself when the environment can host it, else
 * the SAME provider's SDK runtime (Claude CLI → Claude SDK), else `undefined` — that provider has no runtime there
 * (Pi, OMP), so the pin is dropped and the step falls back to the run's own runtime. The launch gate vets only the
 * run's stamped runtime; an unmoved local-only pin would dispatch to a local-only manager with the remote worktree
 * path as cwd.
 */
export function remoteRuntimeForPin(runtime: WorkflowAgentRuntime): WorkflowAgentRuntime | undefined {
  return REMOTE_RUNTIME_BY_PROVIDER[providerForRuntime(runtime)];
}

/** Why a per-agent runtime pin is not honored as written, or null when it is (or there is none). */
export type StepPinChange = 'provider-disabled' | 'remote';

/**
 * The spawn-time gates over a per-agent pin, as ONE reduction: the provider-access gate ({@link gateRuntimePin}),
 * then the remote-run gate ({@link remoteRuntimeForPin}). A pin whose runtime is DROPPED takes its `providerModel`
 * with it unless the step falls back onto the same provider ({@link providerModelAfterRuntimeDrop}); a pin MOVED to
 * its provider's SDK runtime keeps both models. The Claude `model` alias and the effort are not gated here.
 */
export function gateStepAgentPin(
  pin: Pick<StepAgentPin, 'runtime' | 'providerModel'>,
  ctx: { isProviderEnabled: (provider: AgentProvider) => boolean; runIsRemote: boolean; runProvider: AgentProvider },
): { runtime: WorkflowAgentRuntime | undefined; providerModel: string | undefined; changed: StepPinChange | null } {
  const pinned = pin.runtime ?? undefined;
  let runtime = gateRuntimePin(pinned, ctx.isProviderEnabled);
  let changed: StepPinChange | null = pinned !== undefined && runtime === undefined ? 'provider-disabled' : null;
  if (runtime !== undefined && ctx.runIsRemote) {
    const remote = remoteRuntimeForPin(runtime);
    if (remote !== runtime) {
      runtime = remote;
      changed = 'remote';
    }
  }
  const providerModel = pinned !== undefined && runtime === undefined
    ? providerModelAfterRuntimeDrop(pinned, ctx.runProvider, pin.providerModel)
    : pin.providerModel ?? undefined;
  return { runtime, providerModel, changed };
}

/**
 * Alias-level mirror of the spawn seam's guarded-model fallback
 * (`modelContext.applyModelAvailabilityFallback`): a guarded alias (Fable) whose
 * concrete model the availability guard reports unusable is swapped for its
 * `fallbackAlias`; every other value passes through unchanged. Used where the
 * caller needs the ALIAS back (to label it), not the concrete spawn id.
 */
export function usableModelAlias(
  model: string | null,
  isModelUsable: (concreteId: string) => boolean,
): string | null {
  const guarded = guardedModelByAlias(model);
  if (!guarded || isModelUsable(guarded.concreteId)) return model;
  return guarded.fallbackAlias;
}
