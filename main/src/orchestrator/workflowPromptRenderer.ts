import type { AgentProvider, WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowPrompt } from './workflowPromptReader';

export type WorkflowPromptTurnKind = 'launch' | 'nudge' | 'resume' | 'programmatic-step';

export interface WorkflowPromptRenderContext {
  provider: AgentProvider;
  runtime: WorkflowAgentRuntime;
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
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. On Codex, never pass a \`cyboflow-*\` name as \`agent_type\`: use built-in \`worker\` for \`implement\`, \`write-tests\`, and \`ui-prototype\`; use built-in \`explorer\` for \`context\`, \`research\`, \`epics\`, \`tasks\`, \`architecture\`, \`dependency-analyzer\`, \`code-review\`, \`task-verify\`, \`visual-verify\`, \`sprint-verify\`, \`sprint-review\`, and \`compounder\`. For an unlisted role, use \`worker\` when it must modify files and \`explorer\` when it is read-only. If native delegation is unavailable, perform that role's work directly in this turn while preserving the same returned sections and persistence contract.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

export function renderWorkflowPromptForRuntime(
  prompt: WorkflowPrompt,
  context: WorkflowPromptRenderContext = DEFAULT_RENDER_CONTEXT,
): WorkflowPrompt {
  if (context.provider !== 'codex') {
    return prompt;
  }
  if (context.turnKind === 'nudge' || context.turnKind === 'resume') {
    return prompt;
  }

  return {
    prompt: `${CODEX_WORKFLOW_ENVELOPE}\n\n${prompt.prompt}`,
    systemPromptAppend: prompt.systemPromptAppend,
  };
}
