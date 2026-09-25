import type {
  AgentProvider,
  WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowPrompt } from './workflowPromptReader';

export type WorkflowPromptTurnKind = 'launch' | 'nudge' | 'resume' | 'programmatic-step';

export interface WorkflowPromptRenderContext {
  provider: AgentProvider;
  // The runtime the run is EXECUTING on (a run row's value), not a launch
  // choice — a runtime that is storable but not workflow-launchable still
  // renders prompts.
  runtime: WorkflowRunStorableRuntime;
  executionModel?: ExecutionModel;
  turnKind?: WorkflowPromptTurnKind;
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
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. On Codex, never pass a \`cyboflow-*\` name as \`agent_type\`: use built-in \`worker\` for \`implement\`, \`write-tests\`, and \`ui-prototype\`; use built-in \`explorer\` for \`context\`, \`research\`, \`epics\`, \`tasks\`, \`architecture\`, \`dependency-analyzer\`, \`code-review\`, \`task-verify\`, \`visual-verify\`, \`sprint-verify\`, \`sprint-review\`, \`compound-load\`, and \`compounder\`; use built-in \`worker\` for \`address-review\` and \`compound-writeback\` (both edit files). For an unlisted role, use \`worker\` when it must modify files and \`explorer\` when it is read-only. If native delegation is unavailable, perform that role's work directly in this turn while preserving the same returned sections and persistence contract.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

const OMP_WORKFLOW_ENVELOPE = `# Runtime adapter: OMP

You are running the same Cyboflow workflow semantics as the Claude runtime, but through OMP.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, database writes, artifacts, and human gates.
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. **Cyboflow installs no agent files on this runtime**, so the workflow's claim that a \`cyboflow-*\` role "is installed in this worktree's \`.claude/agents/\`" does not hold here — OMP's task-agent discovery loads OMP-native \`.omp\` agent roots only.
- NEVER pass a \`cyboflow-*\` name — or the same name with the prefix stripped — as an OMP task agent type, and NEVER go looking for a matching agent definition on disk, in \`~/.claude\`, or in a plugin cache. An agent that happens to share the role's name is NOT Cyboflow's: adopting one runs a stranger's prompt, under a model pin Cyboflow never chose, on your workflow's step.
- Delegate with OMP's own bundled agents instead: \`task\` for a role that must modify files (\`implement\`, \`write-tests\`, \`ui-prototype\`, \`address-review\`, \`compound-writeback\`), \`reviewer\` for \`code-review\`, and \`scout\` for the read-only roles (\`context\`, \`research\`, \`epics\`, \`tasks\`, \`architecture\`, \`adversarial-review\`, \`dependency-analyzer\`, \`interview\`, \`task-verify\`, \`sprint-verify\`, \`sprint-review\`, \`compound-load\`, \`compounder\`, \`verify-setup\`). For an unlisted role, use \`task\` when it must modify files and \`scout\` when it is read-only. Give the delegate the role's brief in your own words — it has no Cyboflow role prompt of its own.
- If native delegation is unavailable or would not help, perform that role's work directly in this turn while preserving the same returned sections and persistence contract. Doing the step yourself is always preferable to delegating to an agent you did not verify is Cyboflow's.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

const PI_WORKFLOW_ENVELOPE = `# Runtime adapter: pi

You are running the same Cyboflow workflow semantics as the Claude runtime, but through pi. This runtime is more constrained than the others — read these rules before acting on the workflow body, because several of its instructions cannot be followed here literally.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, and human gates.
- **There is no delegation tool on this runtime.** pi registers exactly eight tools — \`read\`, \`grep\`, \`ls\`, \`find\`, \`edit\`, \`write\`, \`bash\`, \`powershell\` — and none of them spawns a subagent. So when the workflow says to delegate to a \`cyboflow-*\` role with the Agent/Task tool, **perform that role's work yourself, in this turn**, preserving the same returned sections and the same contract the role was given. Do not look for a Task tool, and do not treat its absence as a reason to stop.
- **Cyboflow installs no agent files on this runtime**, so the workflow's claim that a \`cyboflow-*\` role "is installed in this worktree's \`.claude/agents/\`" does not hold here. Never go looking for a matching agent definition on disk, in \`~/.claude\`, or in a plugin cache, and never adopt an agent that merely shares the role's name — it is not Cyboflow's, and running a stranger's prompt on your step is worse than doing the step yourself.
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
  codex: CODEX_WORKFLOW_ENVELOPE,
  // OMP's envelope exists because the T1 step prompt is NOT provider-neutral:
  // `composeStepPrompt` tells every step to delegate to its `cyboflow-<agent>`
  // role and asserts that role "is installed in this worktree's
  // `.claude/agents/`". That assertion is Claude-only — the bundle installer
  // (`installWorkflowBundle`) is wired into the Claude managers alone, and OMP's
  // task-agent discovery loads OMP-native `.omp` agent roots, not
  // `.claude/agents/*.md`. So an OMP step agent looking for `cyboflow-compounder`
  // finds nothing, strips the prefix, and resolves whatever `compounder` its
  // roster does carry — on a real run that was a THIRD-PARTY plugin agent whose
  // own frontmatter pinned a model OMP could not route, which killed the step.
  // The envelope closes that specific hole: the `cyboflow-*` name is a role
  // instruction, a same-named agent from the environment is never ours, and OMP
  // delegates through its own bundled agents or does the work in-turn.
  omp: OMP_WORKFLOW_ENVELOPE,
  // pi's envelope carries MORE than OMP's, because pi is missing more. Three of
  // the step prompt's standing instructions are unfollowable here:
  //   1. Delegation — pi registers exactly eight tools (read/grep/ls/find/
  //      edit/write/bash/powershell, verified against the published package in
  //      `piGateExtension.ts`) and NONE spawns a subagent, so "delegate to the
  //      `cyboflow-<agent>` role with the Task tool" has no tool behind it.
  //   2. The agent bundle — `installWorkflowBundle` is wired into the Claude
  //      managers only, so the "installed in this worktree's `.claude/agents/`"
  //      claim is false here exactly as it is on OMP.
  //   3. The MCP surface — unlike claude (in-process), codex (`runConfig.ts`)
  //      and omp (`ompMcpConfigWriter`), NOTHING wires the cyboflow MCP server
  //      for the pi lane, so `cyboflow_*` — including the human-gate redirect
  //      `cyboflow_request_user_input` — is simply absent.
  // Left unaddressed, a pi step burns its turn hunting for a tool and a file
  // that do not exist, then improvises against a state surface it cannot reach.
  // The envelope tells it to do the role's work in-turn, never to adopt a
  // same-named agent from the host, and to return in TEXT what it cannot
  // persist. That last rule is a mitigation, not a fix: pi workflow runs still
  // have no way to write cyboflow state, and closing THAT needs a pi MCP writer.
  pi: PI_WORKFLOW_ENVELOPE,
};

export function renderWorkflowPromptForRuntime(
  prompt: WorkflowPrompt,
  context: WorkflowPromptRenderContext = DEFAULT_RENDER_CONTEXT,
): WorkflowPrompt {
  const envelope = PROVIDER_PROMPT_ENVELOPES[context.provider];
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
