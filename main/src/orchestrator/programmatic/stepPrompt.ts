/**
 * composeStepPrompt — builds the scoped, single-step prompt that the programmatic
 * runner hands to one agent turn (Stage 2 of the execution-model seam).
 *
 * In the programmatic model the HOST sequences the DAG, so each agent turn is
 * deliberately narrowed to exactly ONE step: do this step's work (delegating to
 * its `cyboflow-<agent>` subagent), commit it atomically, persist state via the
 * `cyboflow_*` MCP tools, and STOP — do not advance the workflow. The controller,
 * not the agent, decides what runs next. The voice/invariants mirror the
 * orchestrated harness (`customFlowPrompt.ts`) so the same subagent bundle +
 * single-writer contract apply unchanged; only the SCOPE differs (one step, not
 * the whole flow).
 *
 * Pure: no fs / DB / Date / randomness — output depends only on its args, so it
 * is trivially testable. Human-gate steps never reach here (the controller
 * resolves them via the host's human-gate path, not the runner).
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';

export interface ComposeStepPromptArgs {
  step: WorkflowStep;
  /** The run's workflow name (e.g. 'planner') — orients the agent. */
  workflowName: string;
  /** 1-based attempt number; >1 means a prior attempt failed and is being retried. */
  attempt: number;
  /**
   * Fan-out item context — present ONLY when this step is one item's inner step
   * of a host-driven fan-out. Absent for every normal single-step invocation, so
   * the single-step prompt output stays byte-identical. When present the agent is
   * scoped to exactly this item (do not touch other items).
   */
  item?: { id: string; over: string };
}

export function composeStepPrompt(args: ComposeStepPromptArgs): string {
  const { step, workflowName, attempt } = args;
  const retryNote =
    attempt > 1
      ? `\n\nThis is **attempt ${attempt}** — a previous attempt at this step did not complete. Diagnose what went wrong and try again.`
      : '';
  const desc = step.desc !== undefined && step.desc.length > 0 ? `\n\n${step.desc}` : '';
  const itemNote = args.item
    ? `\n\nThis step is part of a PARALLEL fan-out over **${args.item.over}**. You are working on item **${args.item.id}** ONLY — do not touch other items.`
    : '';

  return `You are executing **one step** of the "${workflowName}" workflow in this git worktree.

Step: **${step.name}** (id: \`${step.id}\`)${desc}${itemNote}

Do ONLY this step:

1. **Do the work.** Delegate to the \`cyboflow-${step.agent}\` subagent via the Task tool (the bundle is installed in this worktree); pass it the context it needs and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools — you are the single writer; subagents are edit-only.
2. **Commit atomically.** Make ONE git commit for this step (\`<type>: <what changed>\`), staging only the files this step touched.
3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn.${retryNote}`;
}
