/**
 * switchRunAgentsHandler — "Switch runtime & retry" on a limit-paused
 * PROGRAMMATIC run: re-target the blocked agents onto another runtime/model and
 * resume at once, instead of waiting for the limit window to roll over.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * The mechanism
 * ───────────────────────────────────────────────────────────────────────────
 * A programmatic step resolves its agent target PER SPAWN through
 * `resolveRunEffectiveAgents` (builtin → project overrides → the frozen spec's
 * `agentConfigs` → variant deltas → RUN agent-target overrides). This handler is
 * the SOLE writer of that last, highest-precedence layer
 * (workflow_runs.agent_target_overrides_json, migration 144 — explicitly MUTABLE,
 * unlike the launch stamps). Writing it and then resolving the run's pending
 * systemic-pause item (which the ReviewQueueSystemicPauseGate settles as
 * 'retry') makes the retried step spawn on the new target. It also re-targets
 * the visual verifier, which reads the same effective set.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * VALIDATE EVERYTHING BEFORE WRITING
 * ───────────────────────────────────────────────────────────────────────────
 * Every refusal (`noOp`) is decided before the single write. After the write
 * the handler never reports a refusal or throws: the one post-write step —
 * resolving the pause item — can lose a race against the auto-resume timer
 * (the router reports `invalid_status`), which is reported as
 * `delivered: true, retried: false` with a note, because the override IS in
 * place and applies from the next spawn.
 *
 * Order:
 *   1. the run exists and is programmatic;
 *   2. the target is non-empty and valid for its provider, that provider is
 *      enabled (Settings → Integrations) AND ready (installed + signed in —
 *      an enabled-but-missing CLI would fail non-systemically and burn budgets);
 *   3. the pending pause matches the caller's `reviewItemId` (when given);
 *   4. the agent key set resolves non-empty;
 *   5. write (read-modify-write inside one transaction; each covered agent's
 *      entry is REPLACED wholesale by the normalized target);
 *   6. resolve the pending pause (retry);
 *   7. return.
 *
 * Standalone-typecheck invariant: reads/writes through the narrow `DatabaseLike`
 * surface and pure shared types only — no 'electron' / 'better-sqlite3' /
 * services import. Provider checks, the effective-agent listing and the pause
 * adapters arrive as injected seams (index.ts wires them).
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { DecisionPayload } from '../../../shared/types/reviews';
import {
  PROVIDER_DEFAULT_RUNTIME,
  isAgentProvider,
  isWorkflowLaunchableRuntime,
  providerForRuntime,
  providerForRuntimeValue,
  type AgentProvider,
  type WorkflowLaunchableRuntime,
} from '../../../shared/types/agentRuntime';
import { isAgentModelAlias } from '../../../shared/types/agents';
import { effortLevelsForProvider, type ReasoningEffort } from '../../../shared/types/reasoningEffort';
import {
  parseRunAgentTargetOverrides,
  serializeRunAgentTargetOverrides,
  type RunAgentTarget,
  type RunAgentTargetOverrides,
} from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Input / result / deps
// ---------------------------------------------------------------------------

/**
 * 'provider' — every agent currently resolving onto the blocked provider (plus
 * the pause's own `agentKeys`); 'step' — exactly the pause's `agentKeys`
 * (single-step pauses only: a fan-out retry replays every inner agent).
 */
export type SwitchScope = 'provider' | 'step';

/**
 * The operator's requested target as it arrives over tRPC: a {@link RunAgentTarget}
 * whose `effort` is still an unvalidated string (its valid scale depends on the
 * target provider, so it is narrowed in {@link validateTarget}).
 */
export type RunAgentTargetInput = Omit<RunAgentTarget, 'effort'> & { effort?: string | null };

export interface SwitchRunAgentsInput {
  runId: string;
  /** The pause item the operator is acting on; checked against the run's pending pause. */
  reviewItemId?: string;
  scope: SwitchScope;
  target: RunAgentTargetInput;
}

export interface ClearRunAgentsInput {
  runId: string;
}

export type SwitchRunAgentsNoOpReason =
  | 'not_found'
  | 'not_programmatic'
  | 'no_target'
  | 'invalid_target'
  | 'provider_disabled'
  | 'provider_unavailable'
  | 'item_not_pending'
  | 'item_mismatch'
  | 'no_agents'
  | 'step_scope_unavailable';

export type SwitchRunAgentsResult =
  | { delivered: true; agentKeys: string[]; target: RunAgentTarget; retried: boolean; note?: string }
  | { noOp: SwitchRunAgentsNoOpReason };

export type ClearRunAgentTargetsResult = { delivered: true } | { noOp: 'not_found' | 'not_programmatic' };

/** The run's pending systemic-pause item (systemicPauseGateWiring.findPendingSystemicPause). */
export interface PendingPauseRef {
  reviewItemId: string;
  projectId: number;
  payload: DecisionPayload | null;
}

export interface SwitchRunAgentsDeps {
  db: DatabaseLike;
  /** Settings → Integrations toggle (shared/agents/agentProviderGuard.isAgentProviderAllowed). */
  isProviderEnabled: (provider: AgentProvider) => boolean;
  /** Installed + signed in (the provider detection probe's `state === 'detected'`). */
  isProviderReady: (provider: AgentProvider) => Promise<boolean>;
  /** Every effective agent of the run + the provider it resolves onto (agentOverlayWriter.listRunAgentTargets). */
  listRunAgentTargets: (runId: string) => Array<{ agentKey: string; provider: AgentProvider }>;
  findPendingPause: (runId: string) => Promise<PendingPauseRef | null>;
  /** Human-actor resolve; `'already_settled'` when the item is no longer pending. */
  resolveItem: (args: {
    projectId: number;
    reviewItemId: string;
    resolution: string;
  }) => Promise<'resolved' | 'already_settled'>;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The visual verifier's agent key — only the claude/codex verify runtimes exist. */
const VISUAL_VERIFY_AGENT_KEY = 'visual-verify';
const VERIFY_CAPABLE_PROVIDERS: ReadonlySet<AgentProvider> = new Set<AgentProvider>(['claude', 'codex']);

interface RunRow {
  execution_model: string | null;
  agent_provider: string | null;
  agent_runtime: string | null;
}

function readRun(db: DatabaseLike, runId: string): RunRow | undefined {
  return db
    .prepare('SELECT execution_model, agent_provider, agent_runtime FROM workflow_runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
}

function isNoSuchColumn(err: unknown): boolean {
  return err instanceof Error && /no such column/i.test(err.message);
}

/**
 * The run's agent-target overrides, or null (none / column absent on a pre-144
 * DB / malformed). Backs `runs.runAgentTargets` and the handler's
 * read-modify-write.
 */
export function readRunAgentTargets(db: DatabaseLike, runId: string): RunAgentTargetOverrides | null {
  try {
    const row = db
      .prepare('SELECT agent_target_overrides_json AS json FROM workflow_runs WHERE id = ?')
      .get(runId) as { json?: unknown } | undefined;
    return parseRunAgentTargetOverrides(typeof row?.json === 'string' ? row.json : null);
  } catch (err) {
    if (isNoSuchColumn(err)) return null;
    throw err;
  }
}

/** The run's own launchable runtime (a non-launchable stamp falls back to its provider's SDK lane). */
function runLaunchableRuntime(run: RunRow): WorkflowLaunchableRuntime {
  if (isWorkflowLaunchableRuntime(run.agent_runtime)) return run.agent_runtime;
  return PROVIDER_DEFAULT_RUNTIME[providerForRuntimeValue(run.agent_runtime, 'switchRunAgents')];
}

type ValidatedTarget =
  | { ok: true; target: RunAgentTarget; provider: AgentProvider }
  | { ok: false; reason: 'no_target' | 'invalid_target' };

/**
 * Validate + normalize the operator's target (step 2, minus the provider
 * checks). The persisted target ALWAYS names a runtime (the requested one, else
 * the run's), so the provider the effort/model were validated against is the
 * provider the covered agents actually spawn on — and a `providerModel` can
 * never be dropped by a missing runtime. The OTHER provider family's model field
 * is explicitly cleared (claude ⇒ `providerModel: null`; otherwise
 * `model: null`) so a lower layer's pin cannot ride along onto the wrong vendor.
 */
function validateTarget(target: RunAgentTargetInput, run: RunRow): ValidatedTarget {
  const hasAny =
    target.runtime !== undefined ||
    target.model !== undefined ||
    target.providerModel !== undefined ||
    target.effort !== undefined;
  if (!hasAny) return { ok: false, reason: 'no_target' };
  if (target.runtime !== undefined && !isWorkflowLaunchableRuntime(target.runtime)) {
    return { ok: false, reason: 'invalid_target' };
  }
  if (target.model !== undefined && target.model !== null && !isAgentModelAlias(target.model)) {
    return { ok: false, reason: 'invalid_target' };
  }
  if (
    target.providerModel !== undefined &&
    target.providerModel !== null &&
    (typeof target.providerModel !== 'string' || target.providerModel.trim().length === 0)
  ) {
    return { ok: false, reason: 'invalid_target' };
  }
  const runtime = target.runtime ?? runLaunchableRuntime(run);
  const provider = providerForRuntime(runtime);
  let effort: ReasoningEffort | null | undefined;
  if (target.effort === null || target.effort === undefined) {
    effort = target.effort;
  } else {
    const requested = target.effort;
    effort = effortLevelsForProvider(provider).find((level) => level === requested);
    if (effort === undefined) return { ok: false, reason: 'invalid_target' };
  }

  const normalized: RunAgentTarget = { runtime };
  if (provider === 'claude') {
    if (target.model !== undefined) normalized.model = target.model;
    normalized.providerModel = null;
  } else {
    normalized.model = null;
    if (target.providerModel !== undefined) {
      normalized.providerModel = target.providerModel === null ? null : target.providerModel.trim();
    }
  }
  if (effort !== undefined) normalized.effort = effort;
  return { ok: true, target: normalized, provider };
}

/** `retry: switched 2 agent(s) (implement, code-review) → codex-sdk / gpt-x · effort high`. */
function describeSwitch(keys: readonly string[], target: RunAgentTarget): string {
  const shown = keys.length > 6 ? `${keys.slice(0, 6).join(', ')}, +${keys.length - 6} more` : keys.join(', ');
  const model = target.model ?? target.providerModel ?? null;
  return (
    `retry: switched ${keys.length} agent(s) (${shown}) → ${target.runtime ?? 'run runtime'}` +
    (model ? ` / ${model}` : '') +
    (target.effort ? ` · effort ${target.effort}` : '')
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Re-target the blocked agents of a (usually limit-paused) programmatic run and
 * retry its pending systemic pause. See the header for the validate-before-write
 * order. With no pending pause and no `reviewItemId` it is an override-only
 * write that applies from the next spawn (`retried: false`).
 */
export async function switchRunAgentsHandler(
  input: SwitchRunAgentsInput,
  deps: SwitchRunAgentsDeps,
): Promise<SwitchRunAgentsResult> {
  const { db, logger } = deps;

  // ── 1. A programmatic run ────────────────────────────────────────────────
  const run = readRun(db, input.runId);
  if (!run) return { noOp: 'not_found' };
  if (run.execution_model !== 'programmatic') return { noOp: 'not_programmatic' };

  // ── 2. A valid target on an enabled, ready provider ──────────────────────
  const validated = validateTarget(input.target, run);
  if (!validated.ok) return { noOp: validated.reason };
  const { target, provider: targetProvider } = validated;
  if (!deps.isProviderEnabled(targetProvider)) return { noOp: 'provider_disabled' };
  let ready = false;
  try {
    ready = await deps.isProviderReady(targetProvider);
  } catch (err) {
    logger?.warn('[switchRunAgents] provider readiness probe failed; treating as unavailable', {
      runId: input.runId,
      provider: targetProvider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!ready) return { noOp: 'provider_unavailable' };

  // ── 3. The pause the operator is looking at is the pending one ───────────
  const pending = await deps.findPendingPause(input.runId);
  if (input.reviewItemId !== undefined) {
    if (!pending) return { noOp: 'item_not_pending' };
    if (pending.reviewItemId !== input.reviewItemId) return { noOp: 'item_mismatch' };
  }
  const payload = pending?.payload ?? null;

  // ── 4. The agents to re-target ───────────────────────────────────────────
  let keys: string[];
  if (input.scope === 'step') {
    const stepKeys = payload?.agentKeys ?? [];
    if (!pending || payload?.fanOut === true || stepKeys.length === 0) {
      return { noOp: 'step_scope_unavailable' };
    }
    keys = [...stepKeys];
  } else {
    const blockedProvider: AgentProvider =
      payload?.blockedProvider ?? (isAgentProvider(run.agent_provider) ? run.agent_provider : 'claude');
    keys = deps
      .listRunAgentTargets(input.runId)
      .filter((a) => a.provider === blockedProvider)
      .map((a) => a.agentKey);
    for (const k of payload?.agentKeys ?? []) if (!keys.includes(k)) keys.push(k);
  }
  let note: string | undefined;
  if (!VERIFY_CAPABLE_PROVIDERS.has(targetProvider) && keys.includes(VISUAL_VERIFY_AGENT_KEY)) {
    keys = keys.filter((k) => k !== VISUAL_VERIFY_AGENT_KEY);
    note = `visual-verify was left on its current provider: ${targetProvider} has no visual-verification runtime.`;
  }
  if (keys.length === 0) return { noOp: 'no_agents' };

  // ── 5. Write (the only write) ────────────────────────────────────────────
  db.transaction(() => {
    const current = readRunAgentTargets(db, input.runId) ?? {};
    for (const k of keys) current[k] = { ...target };
    db.prepare('UPDATE workflow_runs SET agent_target_overrides_json = ? WHERE id = ?').run(
      serializeRunAgentTargetOverrides(current),
      input.runId,
    );
  })();
  logger?.info('[switchRunAgents] run agent targets written', {
    runId: input.runId,
    agentKeys: keys,
    runtime: target.runtime,
  });

  // ── 6. Retry the pending pause (never an error after the write) ──────────
  let retried = false;
  if (pending) {
    try {
      const outcome = await deps.resolveItem({
        projectId: pending.projectId,
        reviewItemId: pending.reviewItemId,
        resolution: describeSwitch(keys, target),
      });
      if (outcome === 'resolved') {
        retried = true;
      } else {
        note = joinNotes(note, 'The pause had already cleared; the switch applies from the next spawn.');
      }
    } catch (err) {
      logger?.warn('[switchRunAgents] pause resolve failed after the switch was written', {
        runId: input.runId,
        reviewItemId: pending.reviewItemId,
        error: err instanceof Error ? err.message : String(err),
      });
      note = joinNotes(
        note,
        'The switch was saved, but the pause could not be resolved — use Retry now on the pause item.',
      );
    }
  }

  // ── 7. Done ──────────────────────────────────────────────────────────────
  return { delivered: true, agentKeys: keys, target, retried, ...(note !== undefined ? { note } : {}) };
}

function joinNotes(a: string | undefined, b: string): string {
  return a === undefined ? b : `${a} ${b}`;
}

/**
 * Revert: clear every run-level agent-target override (the chip's "Revert").
 * Takes effect at the next spawn; a step already running is not touched.
 */
export function clearRunAgentTargets(
  input: ClearRunAgentsInput,
  deps: Pick<SwitchRunAgentsDeps, 'db' | 'logger'>,
): ClearRunAgentTargetsResult {
  const run = readRun(deps.db, input.runId);
  if (!run) return { noOp: 'not_found' };
  if (run.execution_model !== 'programmatic') return { noOp: 'not_programmatic' };
  deps.db
    .prepare('UPDATE workflow_runs SET agent_target_overrides_json = NULL WHERE id = ?')
    .run(input.runId);
  deps.logger?.info('[switchRunAgents] run agent targets cleared', { runId: input.runId });
  return { delivered: true };
}
