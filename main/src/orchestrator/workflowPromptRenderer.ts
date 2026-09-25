import type {
  AgentProvider,
  WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowPrompt } from './workflowPromptReader';
import type { StepDispatch } from './programmatic/stepDispatch';

export type WorkflowPromptTurnKind = 'launch' | 'nudge' | 'resume' | 'programmatic-step';

export interface WorkflowPromptRenderContext {
  provider: AgentProvider;
  // The runtime the run is EXECUTING on (a run row's value), not a launch
  // choice — a runtime that is storable but not workflow-launchable still
  // renders prompts.
  runtime: WorkflowRunStorableRuntime;
  executionModel?: ExecutionModel;
  turnKind?: WorkflowPromptTurnKind;
  /**
   * How a `programmatic-step` turn runs its role (programmatic/stepDispatch.ts).
   * Only `direct` changes the rendering, and only for a provider with a
   * {@link DIRECT_STEP_PROMPT_ENVELOPES} entry. Absent ⇒ delegated.
   */
  stepDispatch?: StepDispatch;
}

const DEFAULT_RENDER_CONTEXT: WorkflowPromptRenderContext = {
  provider: 'claude',
  runtime: 'claude-sdk',
  executionModel: 'orchestrated',
  turnKind: 'launch',
};

export function defaultWorkflowPromptRenderContext(): WorkflowPromptRenderContext {
  return DEFAULT_RENDER_CONTEXT;
}

const CODEX_WORKFLOW_ENVELOPE = `# Runtime adapter: Codex

You are running the same Cyboflow workflow semantics as the Claude runtime, but through Codex.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, database writes, artifacts, and human gates.
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. Cyboflow registers each \`cyboflow-*\` role this run uses as a native Codex agent role that carries the role's instructions, so delegate with \`spawn_agent\` using the role's exact name as \`agent_type\` (for example \`agent_type: "cyboflow-code-review"\`). Do not fork your own context into the delegate: its instructions arrive with the agent type, so its message only needs the task-specific context the workflow says to hand it. Never substitute \`worker\`, \`explorer\`, or the name with the \`cyboflow-\` prefix stripped — none of them carries the role's instructions. If \`spawn_agent\` rejects a \`cyboflow-*\` agent type, perform that role's work directly in this turn while preserving the same returned sections and persistence contract.
- A delegate must not write Cyboflow state even though Codex gives it the \`cyboflow_*\` tools — its role instructions already forbid that, and every Cyboflow write stays with you.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

// The Codex adapter for a DIRECT programmatic step: the role's instructions are
// already this thread's developer instructions, so the delegation rules above
// would send the work to a second agent for no reason. `spawn_agent` cannot be
// removed from Codex's tool list, so this instruction is the only thing keeping
// a direct step single-agent.
const CODEX_DIRECT_STEP_ENVELOPE = `# Runtime adapter: Codex

You are running the same Cyboflow workflow semantics as the Claude runtime, but through Codex.

Provider adaptation rules:

- Treat the workflow step below as the source of truth for step ids, required outputs, database writes, artifacts, and human gates.
- This step runs its \`cyboflow-*\` role DIRECTLY: the role's instructions are your developer instructions, and you do the role's work yourself in this turn. Do NOT call \`spawn_agent\` for this step's work, and do not hand it to any other agent.
- Use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

const OMP_WORKFLOW_ENVELOPE = `# Runtime adapter: OMP

You are running the same Cyboflow workflow semantics as the Claude runtime, but through OMP.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, database writes, artifacts, and human gates.
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. Cyboflow installs each \`cyboflow-*\` role this run uses as an OMP project agent at \`.omp/agents/cyboflow-<role>.md\` in this worktree (not in \`.claude/agents/\`, whatever the workflow says), carrying the role's instructions. Delegate with your task tool using the role's exact name as the agent (for example \`cyboflow-code-review\`); its instructions arrive with the agent, so the assignment only needs the task-specific context the workflow says to hand it.
- NEVER pass the role name with the \`cyboflow-\` prefix stripped, NEVER substitute a bundled agent such as \`task\`, \`scout\` or \`reviewer\`, and NEVER go looking for a matching agent definition in \`~/.claude\`, \`.claude/agents/\`, or a plugin cache. An agent that merely shares a role's name is NOT Cyboflow's: adopting one runs a stranger's prompt, under a model pin Cyboflow never chose, on your workflow's step.
- A delegate must not write Cyboflow state even though OMP may expose the \`cyboflow_*\` tools to it — its role instructions already forbid that, and every Cyboflow write stays with you.
- If your task tool does not offer a \`cyboflow-*\` agent the workflow names, or delegation would not help, perform that role's work directly in this turn while preserving the same returned sections and persistence contract. Doing the step yourself is always preferable to delegating to an agent that is not Cyboflow's.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

const PI_WORKFLOW_ENVELOPE = `# Runtime adapter: pi

You are running the same Cyboflow workflow semantics as the Claude runtime, but through pi. This runtime is more constrained than the others — read these rules before acting on the workflow body, because several of its instructions cannot be followed here literally.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, and human gates.
- **There is no delegation tool on this runtime.** pi registers exactly eight tools — \`read\`, \`grep\`, \`ls\`, \`find\`, \`edit\`, \`write\`, \`bash\`, \`powershell\` — and none of them spawns a subagent. So when the workflow says to delegate to a \`cyboflow-*\` role with the Agent/Task tool, **perform that role's work yourself, in this turn**, preserving the same returned sections and the same contract the role was given. Do not look for a Task tool, and do not treat its absence as a reason to stop.
- Cyboflow writes each role's instructions to \`.claude/agents/cyboflow-<role>.md\` in this worktree — the files the workflow refers to. Before doing a role's work, \`read\` that file and follow its body (below the \`---\` frontmatter) as your instructions for that step, including its required output sections and verdict lines. Only those files in this worktree are Cyboflow's: never go looking for a matching agent definition in \`~/.claude\` or a plugin cache, and never adopt an agent that merely shares the role's name. If the file is missing, do the role's work from the workflow's own description of it.
- pi's pattern-search tool is \`find\`, not \`glob\`. A role brief that names Glob means \`find\` here.
- **The \`cyboflow_*\` MCP tools are NOT available on this runtime.** Do not call them, do not wait on them, and do not report a step as blocked because they are missing. Anything the workflow tells you to persist — a created task, a reported step, a resolved finding, an artifact — you instead state plainly in your returned text, clearly enough that the host can act on it: what you would have written, and with what values.
- The same applies to human gates: \`cyboflow_request_user_input\` does not exist here, so you cannot open one. When the workflow reaches a gate, do NOT invent an answer and do NOT proceed past it — say the gate is due, summarize what the human needs to decide, and end your turn. Gates remain host-owned.
- Do not create or read plugin state files, and do not write your own state files to stand in for the missing MCP surface. The Cyboflow database remains the single source of truth; your returned text is how this runtime reaches it.

---`;

/**
 * The runtime-adapter block prepended to a launch / programmatic-step prompt,
 * per provider. `null` = the workflow body needs no adaptation, which is what
 * Claude means (the bodies are written for it) and what a provider that has not
 * yet been taught the orchestrator contract must also mean — an envelope is
 * authored deliberately, never inherited from another vendor.
 *
 * The Record is exhaustive over `AgentProvider`, so a new provider cannot ship
 * without someone deciding which of the two it is.
 */
export const PROVIDER_PROMPT_ENVELOPES: Record<AgentProvider, string | null> = {
  claude: null,
  // Codex and OMP each register the run's `cyboflow-*` roles NATIVELY — Codex as
  // agent roles in the thread config (`codex/appServer/agentRoles.ts`), OMP as
  // project agents in `.omp/agents/` (`omp/ompAgentWriter.ts`) — so their
  // envelopes tell the orchestrator to delegate by the role's exact name. Before
  // that registration existed, both mapped each role onto a generic bundled
  // agent (Codex `worker`/`explorer`, OMP `task`/`scout`/`reviewer`) that carried
  // none of the role's instructions.
  codex: CODEX_WORKFLOW_ENVELOPE,
  // OMP's envelope also exists because the T1 step prompt is NOT provider-neutral:
  // `composeStepPrompt` asserts the `cyboflow-<agent>` role "is installed in this
  // worktree's `.claude/agents/`", while OMP's task-agent discovery loads only
  // OMP-native `.omp` agent roots. An OMP step that went looking by the bare name
  // once stripped the prefix and resolved a THIRD-PARTY plugin `compounder`
  // whose own frontmatter pinned a model OMP could not route, which killed the
  // step. So the envelope names where the roles really are, and forbids the
  // prefix-stripped name and any same-named agent from the environment.
  omp: OMP_WORKFLOW_ENVELOPE,
  // pi's envelope carries MORE than OMP's, because pi is missing more. Two of
  // the step prompt's standing instructions are unfollowable here:
  //   1. Delegation — pi registers exactly eight tools (read/grep/ls/find/
  //      edit/write/bash/powershell, verified against the published package in
  //      `piGateExtension.ts`) and NONE spawns a subagent, so "delegate to the
  //      `cyboflow-<agent>` role with the Task tool" has no tool behind it. The
  //      pi manager writes the role files to `.claude/agents/` (the files the
  //      workflow names), and the envelope tells pi to read the role's file and
  //      do its work in-turn.
  //   2. The MCP surface — unlike claude (in-process), codex (`runConfig.ts`)
  //      and omp (`ompMcpConfigWriter`), NOTHING wires the cyboflow MCP server
  //      for the pi lane, so `cyboflow_*` — including the human-gate redirect
  //      `cyboflow_request_user_input` — is simply absent.
  // The envelope also tells pi never to adopt a same-named agent from the host,
  // and to return in TEXT what it cannot persist. That last rule is a
  // mitigation, not a fix: pi workflow runs still have no way to write cyboflow
  // state, and closing THAT needs a pi MCP writer.
  pi: PI_WORKFLOW_ENVELOPE,
};

/**
 * Envelopes that REPLACE {@link PROVIDER_PROMPT_ENVELOPES} for a direct
 * programmatic step. Claude needs none (its envelope is null either way), and
 * OMP / pi never run direct (stepDispatch.ts), so only Codex has an entry.
 */
export const DIRECT_STEP_PROMPT_ENVELOPES: Partial<Record<AgentProvider, string>> = {
  codex: CODEX_DIRECT_STEP_ENVELOPE,
};

export function renderWorkflowPromptForRuntime(
  prompt: WorkflowPrompt,
  context: WorkflowPromptRenderContext = DEFAULT_RENDER_CONTEXT,
): WorkflowPrompt {
  const directEnvelope =
    context.turnKind === 'programmatic-step' && context.stepDispatch === 'direct'
      ? DIRECT_STEP_PROMPT_ENVELOPES[context.provider]
      : undefined;
  const envelope = directEnvelope ?? PROVIDER_PROMPT_ENVELOPES[context.provider];
  if (envelope === null) {
    return prompt;
  }
  if (context.turnKind === 'nudge' || context.turnKind === 'resume') {
    return prompt;
  }

  return {
    prompt: `${envelope}\n\n${prompt.prompt}`,
    systemPromptAppend: prompt.systemPromptAppend,
  };
}
