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
 * The two spawn-time GATES `main/src/index.ts`'s `resolveStepAgent` applies
 * before handing a pin to the spawner live here too ({@link gateRuntimePin},
 * {@link usableModelAlias}) so the rail can apply them with the same code.
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
