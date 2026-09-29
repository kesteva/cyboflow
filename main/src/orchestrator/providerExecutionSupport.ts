/**
 * providerExecutionSupport — which providers can host an ORCHESTRATED run.
 *
 * An orchestrated run is ONE agent process that walks the whole DAG itself: it
 * receives the workflow prompt envelope, calls the `cyboflow_*` MCP tools, and
 * answers human gates through the question bridge. A programmatic run is the
 * opposite shape — host code (WorkflowController) walks the DAG and spawns each
 * step as its own short-lived process, so a provider only needs to run a single
 * scoped turn.
 *
 * Those are genuinely different integration surfaces, and a provider can ship
 * the second without the first. OMP does exactly that today: its lane is
 * per-step programmatic, and the orchestrator envelope and question bridge are
 * explicitly deferred. (`task`, the sub-agent tool an orchestrator leans on, is
 * no longer denied by the policy gate — see ompGateConfigBuilder's
 * `denyTaskTool` — but that alone is not the orchestrated contract.) A
 * whole-run OMP request under the orchestrated
 * model would therefore start a main orchestrator with none of the machinery it
 * assumes — outside the shipped contract, and silently so.
 *
 * Stated as a capability SET rather than tested with a `!== 'omp'` literal, for
 * the same reason `effectiveSetPinsNonClaudeRuntime` reads the runtime registry
 * instead of comparing to `'codex-sdk'`: the next provider lands in the
 * programmatic lane first too, and a literal would silently let it through.
 * Adding a provider to `AGENT_PROVIDERS` without naming it here leaves it
 * OUT of the set — the safe default, since a provider is refused rather than
 * launched into an integration nobody wrote.
 *
 * Deliberately main-side and NOT in `shared/types`: nothing in the renderer
 * decides this, and both consumers (`workflowRegistry.createRun`'s launch guard
 * and `runExecutor`'s orchestrated-fallback guard) live here. Move it to shared
 * only when a renderer surface needs to pre-empt the launch (e.g. to disable the
 * execution-model toggle for a provider) rather than react to the refusal.
 */
import { AGENT_PROVIDER_LABELS, type AgentProvider } from '../../../shared/types/agentRuntime';

/**
 * Providers with a working ORCHESTRATED integration.
 *
 * - `claude` — the original and reference implementation.
 * - `codex`  — prompt envelope + question bridge both exist (Phase 2 T2).
 * - `omp`    — absent: programmatic-only, see this module's header.
 */
export const SUPPORTS_ORCHESTRATED: ReadonlySet<AgentProvider> = new Set<AgentProvider>([
  'claude',
  'codex',
]);

/** True when `provider` may host a single-process orchestrated run. */
export function providerSupportsOrchestrated(provider: AgentProvider): boolean {
  return SUPPORTS_ORCHESTRATED.has(provider);
}

/** The vendor label for a refusal sentence — never a raw provider id. */
export function providerLabel(provider: AgentProvider): string {
  return AGENT_PROVIDER_LABELS[provider];
}
