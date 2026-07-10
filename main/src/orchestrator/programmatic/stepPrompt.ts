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
 * ARTIFACT FOLLOW-UP: on the orchestrated plane, `workflows/planner.md` tells the
 * top-level agent what to do with a step's deliverable AFTER its subagent returns
 * (e.g. "read the prototype URL and call `cyboflow_report_artifact`") — but that
 * prose lives in the top-level flow file, which the programmatic plane never
 * loads (each step here is its own fresh, narrowly-scoped agent turn with no
 * access to the flow's full prose). Without an equivalent instruction inlined
 * into the step prompt itself, a step whose `outputArtifact` needs an explicit
 * follow-up (ui-prototype, arch-design) silently never produces one on
 * programmatic runs: the subagent returns its section faithfully, but nothing
 * ever reports it, so the artifact tab stays empty forever (2026-07-06,
 * empty-ui-prototype-tab incident). `composeStepPrompt` now owns mirroring that
 * per-step follow-up via `artifactFollowUp` below — see its doc comment for which
 * atypes need one and why most don't.
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
  /**
   * Operator GUIDANCE for this step (RunDirectives live steering) — free-text the
   * operator added mid-run via the monitor to steer this step, appended as a tail
   * section when non-empty. Absent / empty ⇒ no guidance section (output
   * unchanged). Unlike `taskScope`/`item` this is per-STEP, not per-run.
   */
  userGuidance?: string;
}

/**
 * Per-atype "report the artifact yourself" addendum for steps whose
 * `outputArtifact` needs an explicit agent follow-up once its subagent returns.
 * Mirrors the equivalent prose in `workflows/planner.md` written for the
 * orchestrated top-level agent — there is no top-level agent on the
 * programmatic plane, so `composeStepPrompt` inlines the same instruction into
 * the scoped step prompt instead.
 *
 * NOT every `outputArtifact` atype needs one: 'idea-spec' and
 * 'decomposed-stories' mint automatically by re-deriving from the entity DB
 * once the step's own `cyboflow_*` writes land as part of "do the work" (step
 * 1 of the numbered list above) — no separate reporting action exists for
 * those, so adding an addendum would just be prompt noise. 'ui-prototype',
 * 'arch-design', and 'compound-recommendations' have a deliverable that lives
 * OUTSIDE that entity write (a served localhost URL; a subagent-returned section
 * that must be folded into the idea body by hand; a payload-backed markdown doc
 * the agent composes from its subagent's learnings) — those need to be told
 * explicitly. Any future atype defaults to no addendum (the `default` branch)
 * unless it is proven to need one and added here deliberately.
 */
function artifactFollowUp(outputArtifact: NonNullable<WorkflowStep['outputArtifact']>): string {
  switch (outputArtifact.atype) {
    case 'ui-prototype':
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-ui-prototype\` subagent returns its \`## Prototype\` section, it includes a \`URL: http://localhost:<port>/\` line. Extract that URL and call \`cyboflow_report_artifact\` yourself with \`atype: 'ui-prototype'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"url": "<the url>"}\` — that call is the ONLY thing that mints this run's UI-prototype tab. Skipping it leaves the tab permanently empty.`;
    case 'arch-design':
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-architecture\` subagent returns its \`## Architecture design\` section, fold it into the IDEA's body yourself via \`cyboflow_update_task\`: if the body already has an \`## Architecture design\` section, REPLACE that section (never stack a second copy); otherwise append it. The arch-design deliverable tab derives from the body automatically, so you do not report an artifact for this step.`;
    case 'compound-recommendations':
      return `\n\n## Artifact to report\n\nAfter your \`cyboflow-compounder\` subagent returns its \`## Learnings\` and \`## Discarded\` lists, compose ONE summary-of-recommendations markdown doc — the single thing the human reads at the approve-learnings gate — with TWO top-level sections:\n\n- \`## Act on\` — the learnings that cleared the bar, grouped as \`### Quick fixes\` / \`### Doc edits\` / \`### Tasks\`, one entry per learning with its general rule, evidence (recurrence + run ids, files), computed impact, and the proposed change.\n- \`## Discarded\` — the candidates the compounder considered and set aside, one line each with its reason. This is the "here's what I discarded" half of the review. Omit the section only if the compounder returned no discarded list.\n\nThen call \`cyboflow_report_artifact\` yourself with \`atype: 'compound-recommendations'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the doc>"}\`. That call is the ONLY thing that mints this run's recommendations tab; skipping it leaves the gate with nothing to review.\n\nHard limits on what becomes a review-queue item: do NOT emit \`cyboflow_report_finding\` with \`kind:'finding'\` (a finding is Compound's input, not its output), and do NOT emit a \`cyboflow_report_finding\` \`decision\` — or any review item — for a DISCARDED candidate. Discarded candidates live in the \`## Discarded\` section of THIS doc and nowhere else; filing one per drop is exactly the sequential-gate spam this flow must not produce. The only \`decision\` this flow emits is the ONE batched final-review gate at the write-back step (listing every APPLIED change) — never one here, and never one per edit.`;
    default:
      return '';
  }
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
  const artifactNote = step.outputArtifact !== undefined ? artifactFollowUp(step.outputArtifact) : '';
  // Compound review-queue discipline — applies to EVERY compound step, not just
  // the one that reports the artifact. The compounder surfaces below-bar
  // candidates in a `## Discarded` list; a step agent that faithfully "records
  // every item the subagent returns" used to file one blocking `decision` per
  // drop, spamming the review queue with sequential approve/resume gates
  // (observed on load-sprint, which has no outputArtifact so the addendum above
  // never reaches it). This guard reaches all steps and pins the single-review
  // contract: drops go in the doc; the only `decision` is the ONE batched
  // final-review gate at write-back, never per-edit and never per-drop.
  const compoundGuard =
    workflowName === 'compound'
      ? `\n\n## Compound review-queue discipline\n\nThe \`cyboflow-compounder\` subagent may return a \`## Discarded\` list of candidates it considered and set aside. These are CONTEXT, not actions: NEVER file a discarded candidate as a \`cyboflow_report_finding\` (\`decision\` or \`finding\`) or any other review-queue item. Discarded candidates belong ONLY in the \`## Discarded\` section of the \`compound-recommendations\` doc (composed at the \`extract\` step). Compound has exactly TWO human gates and everything is batched: the \`approve-learnings\` question, and — at \`write-back\`, AFTER you apply every approved change in-place — exactly ONE batched blocking \`decision\` review item (the final-review gate) listing all applied changes. NEVER a \`decision\` per doc edit and NEVER one per drop; per-item gates are the sequential-gate spam this flow must never produce.`
      : '';
  const userGuidance =
    args.userGuidance !== undefined && args.userGuidance.trim().length > 0
      ? `\n\n## Operator guidance\n\nThe operator added mid-run guidance for this step — follow it:\n\n${args.userGuidance.trim()}`
      : '';

  return `You are executing **one step** of the "${workflowName}" workflow in this git worktree.

Step: **${step.name}** (id: \`${step.id}\`)${desc}${itemNote}${taskScope}

Do ONLY this step:

1. **Do the work.** Delegate to the \`cyboflow-${step.agent}\` subagent via the Task tool, using that EXACT \`subagent_type\` — it is installed in this worktree's \`.claude/agents/\`, so do NOT fall back to \`general-purpose\`. Pass it the context it needs (including the task scope above when relevant) and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools, recording EVERY item the subagent returns that is an ACTION to persist — e.g. call \`cyboflow_add_task_dependency\` for each edge it reports; never collapse a non-empty result to "none". This does NOT mean filing context-only sections the subagent returns for the operator's or a doc's benefit (e.g. a Compound \`## Discarded\` list) as review items — follow any workflow-specific review-queue discipline below. You are the single writer; subagents are edit-only.
2. **Commit atomically.** Make ONE git commit for this step (\`<type>: <what changed>\`), staging only the files this step touched.
3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn.

The cyboflow database is the single source of truth: never read on-disk or worktree state files (e.g. a plugin state directory) to decide the task set or a task's status — any such file is NOT cyboflow's source of truth and may be stale or absent.${compoundGuard}${artifactNote}${userGuidance}${retryNote}`;
}
