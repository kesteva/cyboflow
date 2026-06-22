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
 * GROUNDING (taskScope): each programmatic step runs in its OWN fresh SDK session
 * (no memory of prior steps), and — unlike the orchestrated `getPrompt` path — the
 * step prompt does NOT otherwise carry the sprint's task set. A step agent with no
 * task list cannot tell its subagent WHAT to analyze, so it falls back to probing
 * the worktree, finds no task files (cyboflow is DB-canonical — it keeps NO task
 * files on disk), and concludes "no tasks → No dependencies". That dropped the
 * blocking edges on a real sprint, so the dependents ran concurrently with their
 * prerequisite and failed (verified 2026-06-22). When `taskScope` is supplied the
 * host injects the SAME `# Sprint tasks` block the orchestrated path uses, so the
 * agent never has to discover scope on disk. The prose also pins the agent to the
 * installed `cyboflow-<agent>` subagent (no `general-purpose` fallback) and to
 * faithfully persisting EVERY item the subagent returns (a recurring failure mode:
 * collapsing real dependency edges to "none").
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
  /**
   * The sprint's task scope — the pre-rendered `# Sprint tasks` block BODY (the
   * SAME text the orchestrated `getPrompt` path prepends), resolved by the host
   * from the DB. Present ONLY for a seeded sprint-style run; absent (or empty) for
   * planner / non-sprint steps, in which case no task block is added. Grounds the
   * step agent in the real task set so it never has to DISCOVER scope on disk.
   */
  taskScope?: string;
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
  const taskScope =
    args.taskScope !== undefined && args.taskScope.trim().length > 0
      ? `\n\n# Sprint tasks\n\n${args.taskScope.trim()}\n\nThese are the EXACT tasks in scope for this sprint — the cyboflow database is their source of truth. When this step needs the task set (e.g. dependency analysis or per-task work), use THIS list and pass it to your subagent; do NOT hunt for task files in the worktree to discover scope (cyboflow keeps no task files on disk, so you will find none and wrongly conclude there is nothing to do).`
      : '';

  return `You are executing **one step** of the "${workflowName}" workflow in this git worktree.

Step: **${step.name}** (id: \`${step.id}\`)${desc}${itemNote}${taskScope}

Do ONLY this step:

1. **Do the work.** Delegate to the \`cyboflow-${step.agent}\` subagent via the Task tool, using that EXACT \`subagent_type\` — it is installed in this worktree's \`.claude/agents/\`, so do NOT fall back to \`general-purpose\`. Pass it the context it needs (including the task scope above when relevant) and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools, recording EVERY item the subagent returns — e.g. call \`cyboflow_add_task_dependency\` for each edge it reports; never collapse a non-empty result to "none". You are the single writer; subagents are edit-only.
2. **Commit atomically.** Make ONE git commit for this step (\`<type>: <what changed>\`), staging only the files this step touched.
3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn.

The cyboflow database is the single source of truth: never read on-disk or worktree state files (e.g. a plugin state directory) to decide the task set or a task's status — any such file is NOT cyboflow's source of truth and may be stale or absent.${retryNote}`;
}
