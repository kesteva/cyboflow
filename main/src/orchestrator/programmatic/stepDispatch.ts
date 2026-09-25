/**
 * stepDispatch — decides whether a programmatic step turn does its role's work
 * DIRECTLY or delegates it to a `cyboflow-<key>` child agent, and composes the
 * system instructions a direct turn runs under
 * (docs/proposals/codex-workflow-efficiency.md §8).
 *
 * DELEGATED (the original shape): the step turn is a dispatcher. It hands the
 * work to the role's subagent (Claude Task / Codex `spawn_agent`), reads the
 * result back, and performs the cyboflow writes itself. Two agents, two
 * contexts, and the dispatcher's own share of the tokens.
 *
 * DIRECT: the step turn IS the role. The role's effective system prompt (project,
 * workflow and variant overrides already layered in) rides the spawn's
 * `systemPromptAppend` — Claude's `systemPrompt.append`, Codex's thread
 * `developerInstructions` — followed by a host-written addendum that keeps the
 * single-writer contract: the role still does the role's work, and the turn
 * performs only the persistence the step prompt lists.
 *
 * Direct is the DEFAULT for every eligible step. `CYBOFLOW_DISABLE_DIRECT_STEPS=1`
 * reverts every step to delegated. A step stays delegated when:
 *   - it spawns on a runtime other than `claude-sdk` / `codex-sdk` (OMP keeps its
 *     own adapter; pi already does role work in-turn);
 *   - its role has no resolvable system prompt (a direct turn must never run as a
 *     generic, unscoped agent — delegated keeps today's behavior instead);
 *   - it is on {@link DELEGATED_ONLY_STEPS} or its role is on {@link DELEGATED_ONLY_AGENTS}.
 */
import type { WorkflowRunStorableRuntime } from '../../../../shared/types/agentRuntime';

export type StepDispatch = 'delegated' | 'direct';

/** Kill switch: any non-empty value other than `0` forces every step to delegate. */
export const DIRECT_STEPS_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_DIRECT_STEPS';

/** The runtimes whose spawn seam carries `systemPromptAppend` as the turn's own instructions. */
const DIRECT_CAPABLE_RUNTIMES: ReadonlySet<WorkflowRunStorableRuntime> = new Set(['claude-sdk', 'codex-sdk']);

/**
 * Steps whose contract depends on delegation, keyed `<workflow>/<stepId>`, with
 * the reason each one stays delegated.
 */
export const DELEGATED_ONLY_STEPS: Readonly<Record<string, string>> = {
  // The step prompt's own contract already says "do this YOURSELF": the
  // verify-setup role is a read-only drafter whose instructions forbid writing,
  // committing and registering — exactly what `prove` does. Loading those
  // instructions as the turn's system prompt would contradict the step.
  'verify-setup/prove':
    'the prove contract runs in-turn already, and the read-only verify-setup role would contradict it',
};

/**
 * Roles that stay delegated in every workflow, keyed by agent key. Keyed on the
 * role (not the step) because the step prompt's contract for them is keyed the
 * same way (`step.agent === 'address-review'` in stepPrompt.ts).
 */
export const DELEGATED_ONLY_AGENTS: Readonly<Record<string, string>> = {
  // Address-review's contract is a two-pass loop across agents: delegate the
  // fixes, re-run the full suite as the dispatcher, re-delegate ONCE to repair,
  // then resolve findings. Collapsing it into one agent needs its own contract.
  'address-review': 'its fix → full-suite → re-delegate loop is written for two agents',
};

/**
 * Built-in delegation tools a DIRECT Claude step turn is denied. No cyboflow role
 * grants either, so denying them only removes the path back to delegation.
 * Codex has no equivalent: `spawn_agent` cannot be removed from its tool list, so
 * a direct Codex step relies on its runtime adapter's instruction alone.
 */
export const DIRECT_STEP_DISALLOWED_TOOLS: readonly string[] = ['Task', 'Agent'];

export function directStepsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DIRECT_STEPS_KILL_SWITCH_ENV];
  return value !== undefined && value !== '' && value !== '0';
}

export interface ResolveStepDispatchArgs {
  workflowName: string;
  stepId: string;
  /** The step's canonical agent key. */
  agentKey: string;
  /** The runtime this step actually spawns on (per-step override, else the run's). */
  runtime: WorkflowRunStorableRuntime;
  /** The role's effective system prompt; undefined/blank when it cannot be resolved. */
  roleSystemPrompt: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface StepDispatchDecision {
  dispatch: StepDispatch;
  /** Why the step stays delegated; undefined for a direct step. */
  reason?: string;
}

export function resolveStepDispatch(args: ResolveStepDispatchArgs): StepDispatchDecision {
  if (directStepsDisabled(args.env)) {
    return { dispatch: 'delegated', reason: `${DIRECT_STEPS_KILL_SWITCH_ENV} is set` };
  }
  if (!DIRECT_CAPABLE_RUNTIMES.has(args.runtime)) {
    return { dispatch: 'delegated', reason: `runtime ${args.runtime} keeps its own delegation adapter` };
  }
  const excluded =
    DELEGATED_ONLY_STEPS[`${args.workflowName}/${args.stepId}`] ?? DELEGATED_ONLY_AGENTS[args.agentKey];
  if (excluded !== undefined) {
    return { dispatch: 'delegated', reason: excluded };
  }
  if (args.roleSystemPrompt === undefined || args.roleSystemPrompt.trim().length === 0) {
    return { dispatch: 'delegated', reason: 'the role has no resolvable system prompt' };
  }
  return { dispatch: 'direct' };
}

/**
 * The system instructions for a DIRECT step turn: the role's effective prompt,
 * then the host addendum. The addendum comes LAST so it governs where the two
 * disagree — role prompts are written for a child that returns results to a
 * dispatcher and "never writes cyboflow state", and in a direct turn there is no
 * dispatcher to return to.
 */
export function composeDirectStepSystemPrompt(agentKey: string, roleSystemPrompt: string): string {
  return `# Role instructions: cyboflow-${agentKey}

${roleSystemPrompt.trim()}

# Direct step — how the role instructions above apply

You are running the \`cyboflow-${agentKey}\` role DIRECTLY as this workflow step's only agent. Do the role's work yourself, in this turn.

- Do not spawn, delegate to, or hand off to another agent for this work — no Task or Agent tool, no \`spawn_agent\`.
- Keep the role's scope, test scope, and required output sections and verdict lines exactly as the role instructions state them.
- Where the role instructions say you return results to an orchestrator or parent, or that you never write cyboflow state: for this step YOU are the orchestrator. Perform the cyboflow state writes and the commit/report actions the step prompt lists — and only those.
- Stop after this one step.`;
}
