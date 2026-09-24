/**
 * Narrow structural contracts for the collaborators `runs.getStepModels`
 * (`orchestrator/runStepModels.ts`, IDEA-061's per-step model rail) needs from
 * outside the orchestrator tree. Declared here — the tRPC subtree's home for
 * "structural mirror of a `services/*` collaborator" (see `sessionOps.ts`) —
 * rather than importing the concrete functions, so the standalone-typecheck
 * invariant holds. Both are bound once, in `main/src/index.ts`, onto
 * `ContextDeps`.
 */
import type { DatabaseLike, LoggerLike } from '../../types';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';

/**
 * Structural mirror of
 * `services/panels/claude/agentOverlayWriter.resolveRunEffectiveAgents`: a
 * run's FULL effective agent set (project overrides + workflow agentConfigs +
 * variant deltas).
 */
export type EffectiveAgentsResolver = (
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
) => EffectiveAgent[];

/**
 * The spawn-seam gates `main/src/index.ts`'s `resolveStepAgent` applies before
 * a per-agent pin reaches the spawner, exposed so the model rail reports what
 * actually spawns:
 *   - `isProviderEnabled` — `configManager.isAgentProviderEnabled` (a runtime
 *     pin on a switched-off provider is dropped);
 *   - `isModelUsable` — `modelAvailabilityService.isModelUsable` (a guarded
 *     model, e.g. Fable, that is unavailable falls back to its fallback alias).
 */
export interface StepModelGates {
  isProviderEnabled(provider: AgentProvider): boolean;
  isModelUsable(concreteId: string): boolean;
}
