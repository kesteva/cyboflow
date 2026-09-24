/**
 * Run-scope tool family — the 37 `cyboflow_*` tools a workflow run (and any
 * quick chat session hosted by one) sees. The default scope: everything not
 * served by CYBOFLOW_MCP_SCOPE=design or =global-agent.
 *
 * Every entry is a straight port of the hand-written `case` arm it replaced:
 * same checks, same `expected` prose, same envelope, same camelCase params.
 * Where an arm only checked `typeof`, the schema stays `z.string()` /
 * `z.number()` rather than tightening — a stricter registry would start
 * rejecting calls the arm accepted, which is a wire-compat break, not a cleanup.
 *
 * Three kinds of deliberate looseness carried across intact:
 *
 *   - report_finding's `category` / `locations` / `suggested_fix` /
 *     `proposed_target` / `impact`, and request_verification's `task` /
 *     `viewports`, are forwarded UNVALIDATED. The main-process handler narrows
 *     each (buildFindingExtras / parseFindingLocations / parseFindingImpact /
 *     parseViewports / parseVerificationTaskV1) and DROPS malformed members
 *     rather than failing the write, so declaring them strictly here would turn
 *     an agent's typo into a rejected finding — the exact outcome those
 *     narrowers exist to prevent. {@link declareAs} keeps the ADVERTISED schema
 *     rich while validation stays permissive.
 *
 *   - The integer-range fields (`attempt`, `weight`) have always advertised
 *     `type: 'number'`. `z.number().int()` would advertise `'integer'` and
 *     change the wire declaration, so the rule rides {@link integerAtLeast} — a
 *     refine `toInputSchema` looks through — with the arm's `integer >= N`
 *     phrasing restored by an `expected` override.
 *
 *   - The question gate's non-empty check is `.trim().length === 0`, so it is a
 *     REFINE ({@link nonBlank}) and never `.trim()`: trimming would mutate the
 *     value that goes on the wire.
 *
 * The four cross-field rules no object schema can express — update_sprint_task's
 * status-or-step, update_variant's at-least-one-field, set_baseline_rotation's
 * in_rotation-or-weight, and request_verification's intent-or-task.summary —
 * ride `.superRefine` carrying the arm's exact message, which `describeIssue`
 * returns verbatim for a custom issue.
 */
import { z } from 'zod';
import { compact, defineTool, type RegisteredTool } from './defineTool';
import { declareAs } from './toolSchema';
import { TUNING_LEVELS } from '../../../../../shared/tuning/workflowTuning';
import { VERIFY_RUNBOOK_MODALITIES, type VerifyRunbookModality } from '../../../../../shared/types/verifyRunbook';

/**
 * IPC budget for the BLOCKING `cyboflow_await_verification` call
 * (docs/proposals/verification-setup-flow.md §5.2 seam 2). Deliberately larger
 * than the orchestrator handler's own 20-minute clamp: whichever side gives up
 * first owns the answer the agent sees, and the handler's answer ("still
 * queued/running — I stopped waiting") is diagnostic while this transport's
 * ('orchestrator_timeout') is not.
 */
const AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS = 22 * 60_000;

/** `'P0'..'P6'` — the phrasing both priority-taking arms used. */
const PRIORITY_EXPECTED = "priority: 'P0'..'P6' (optional)";

/**
 * The arm's blank check, as a REFINE rather than `.trim()` — trimming would
 * mutate the value that goes on the wire. Takes the already-described base so
 * the description stays on the ZodString, which is where `toInputSchema` reads
 * it from (it looks THROUGH the effects wrapper).
 */
function nonBlank(base: z.ZodString): z.ZodEffects<z.ZodString, string, string> {
  return base.refine((value) => value.trim().length > 0);
}

/**
 * An integer >= `min` that still advertises `type: 'number'`, for the fields
 * whose arms did `Number.isInteger(x) || x < min` by hand. Same
 * description-on-the-base rule as {@link nonBlank}; pair it with an `expected`
 * override to restore the arm's `integer >= N` phrasing.
 */
function integerAtLeast(base: z.ZodNumber, min: number): z.ZodEffects<z.ZodNumber, number, number> {
  return base.refine((value) => Number.isInteger(value) && value >= min);
}

/** The non-empty string the arm accepted, or undefined. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * request_verification's `intent`: the caller's own, else a best-effort stand-in
 * read off `task.summary` (the fan-out prose passes only `task` + `task_ref`).
 * Unvalidated on purpose — the handler validates the task strictly server-side
 * and derives the persisted deliverable from it, so this stand-in never drives
 * judging on the task path.
 */
function resolveVerificationIntent(intent: unknown, task: unknown): string | undefined {
  const direct = nonEmpty(intent);
  if (direct !== undefined) return direct;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) return undefined;
  return nonEmpty((task as { summary?: unknown }).summary);
}

/**
 * ORDER IS OBSERVABLE: this array is the ListTools reply order agents read.
 * Append rather than reshuffle.
 */
export const RUN_SCOPE_TOOLS: readonly RegisteredTool[] = [

  defineTool({
    name: 'cyboflow_list_pending_approvals',
    description:
      'Return all pending TOOL-PERMISSION approvals (canUseTool gates) across every running workflow in this Cyboflow workspace. Read-only. NOTE: this surface does NOT include human question/decision gates — an AskUserQuestion gate (e.g. approve-idea) lives in the questions surface and renders as an inline card in the run chat, so an empty result here does not mean no human gate is pending.',
    input: z.object({}),
    envelope: 'mcp-list-pending-approvals',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_get_run',
    description:
      'Fetch a workflow run\'s state (status, workflow name, timestamps, last 10 events) by ID. Read-only.',
    input: z.object({
      run_id: z.string().describe('The workflow_runs.id to fetch'),
    }),
    envelope: 'mcp-get-run',
    // run_id -> targetRunId: every message on this socket already carries the
    // CALLER's own runId, so the run being READ needs its own key.
    toEnvelope: (args) => ({ targetRunId: args.run_id }),
  }),

  defineTool({
    name: 'cyboflow_submit_checkpoint',
    description:
      'Record a checkpoint marker for the current run. This is an observational marker only — it does not change run status, approve anything, or notify the user.',
    input: z.object({
      label: z.string().describe('Short identifier for the checkpoint'),
      note: z.string().describe('Optional longer description').optional(),
    }),
    envelope: 'mcp-submit-checkpoint',
    toEnvelope: (args) => ({ label: args.label, note: args.note }),
  }),

  defineTool({
    name: 'cyboflow_report_step',
    description:
      'Report the current workflow phase/step for the current run by its step id. This is an OBSERVATIONAL signal that drives the Workflow Progress panel only — it does NOT pause the run, change run status, approve anything, or notify the user (contrast with the PreToolUse approval gate). The run is bound from CYBOFLOW_RUN_ID, so there is no run_id argument.',
    input: z.object({
      step_id: z.string().min(1).describe('The workflow step id to mark as current (must exist in this run\'s workflow definition)'),
      status: z.enum(['running', 'done']).describe('Optional step status; defaults to \'running\'').optional(),
    }),
    envelope: 'mcp-report-step',
    toEnvelope: (args) => ({ stepId: args.step_id, status: args.status }),
  }),

  defineTool({
    name: 'cyboflow_request_user_input',
    description:
      'Ask one or more workflow questions through the Cyboflow Human Review queue. This call BLOCKS until the human answers. Use it whenever a workflow asks for AskUserQuestion or request_user_input; never continue past the gate before this tool returns.',
    input: z.object({
      questions: z.array(z.object({
        header: nonBlank(z.string().describe('Short label for the question.')),
        question: nonBlank(z.string().describe('Full question text.')),
        multi_select: z.boolean().describe('Whether multiple options may be selected. Defaults to false.').optional(),
        options: z.array(z.object({
          label: nonBlank(z.string()),
          description: z.string().optional(),
          preview: z.string().describe('Optional markdown preview shown with this option.').optional(),
        })).min(2).max(4),
      })).min(1).max(4),
    }),
    envelope: 'mcp-request-user-input',
    expected: {
      // The arm answered a bad questions ARRAY and a bad question/option with two
      // different strings; the issue path is what tells them apart.
      questions: (issue) =>
        issue.path.length > 1
          ? 'each question requires header, question, 2-4 valid options, and optional multi_select'
          : 'questions: array (1-4)',
    },
    // Human question gates legitimately block for days (sessions get left open
    // over a weekend), so this is null — "wait forever" — and NOT the transport's
    // 30s default. The only remaining bound is the substrate MCP client's own cap
    // (Codex: tool_timeout_sec in runConfig.buildMcpConfig; Claude has none).
    timeoutMs: null,
    toEnvelope: (args) => ({
      questions: args.questions.map((entry) => ({
        header: entry.header,
        question: entry.question,
        multiSelect: entry.multi_select === true,
        options: entry.options.map((option) => ({
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(option.preview !== undefined ? { preview: option.preview } : {}),
        })),
      })),
    }),
  }),

  defineTool({
    name: 'cyboflow_create_task',
    description:
      'Create a backlog idea/epic/task for THIS run\'s project. The task is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single write chokepoint, and appears on the board. A task may sit directly under an idea (originating_idea_id, no parent_epic_id) ONLY when it is that idea\'s single task; creating a SECOND task-less-of-an-epic under the same idea is rejected with error idea_needs_epic — mint an epic (named after the idea) and pass parent_epic_id on every task.',
    input: z.object({
      title: z.string().min(1).describe('Task title (required)'),
      task_type: z.enum(['idea', 'epic', 'task']).describe('Optional task type; defaults to \'idea\'').optional(),
      summary: z.string().describe('Optional SHORT one-line descriptor shown on the board card (keep it to a sentence). For the rich spec / acceptance criteria, use body.').optional(),
      body: z.string().describe('Optional full markdown body — the canonical rich detail (the idea spec, the task description + acceptance criteria, file/dependency hints). This is what the entity artifact renders, so prefer it for anything multi-line; leave summary as the short caption.').optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']).describe('Optional priority (P0-P6); defaults to \'P2\'').optional(),
      category: z.enum(['feature', 'bug', 'chore']).describe('Optional entity CLASSIFICATION (feature|bug|chore); defaults to \'feature\'. Unrelated to cyboflow_report_finding\'s free-text grouping `category`.').optional(),
      repo: z.string().describe('Optional repo identifier').optional(),
      parent_epic_id: z.string().describe('Optional parent epic id').optional(),
      board_id: z.string().describe('Optional board id; defaults to the project default board').optional(),
      initial_stage_id: z.string().describe('Optional initial stage id; defaults to the board\'s first idea stage').optional(),
      scope: z.enum(['small', 'large']).describe('Optional idea size hint; only meaningful for task_type=\'idea\' (ignored on epic/task entities)').optional(),
      originating_idea_id: z.string().describe('Optional project-scoped idea ref-or-id (e.g. \'IDEA-009\' or its opaque id) this epic/task originates from — only meaningful for task_type=\'epic\'|\'task\' (ignored on idea creates). REQUIRED practice on a multi-idea planner run: an epic/task created without this on a run seeded with more than one idea is left with lineage NULL rather than guessed.').optional(),
      executor: z.enum(['agent', 'human']).describe('Optional EXECUTOR — who performs the work (task_type=\'task\' only; rejected with error invalid_executor on an idea/epic). \'agent\' (the default) means a sprint lane drives it. \'human\' means work only a person can do (accounts, purchases, physical devices, legal sign-off, credentials the agent must not hold); a human task NEVER becomes a sprint lane; agent tasks that need its output still record a blocking edge to it — the edge does not gate the sprint, it surfaces the human work as a standing review item.').optional(),
    }),
    envelope: 'mcp-create-task',
    expected: { priority: PRIORITY_EXPECTED },
    toEnvelope: (args) => ({
      title: args.title,
      taskType: args.task_type,
      summary: args.summary,
      body: args.body,
      priority: args.priority,
      category: args.category,
      repo: args.repo,
      parentEpicId: args.parent_epic_id,
      boardId: args.board_id,
      initialStageId: args.initial_stage_id,
      scope: args.scope,
      originatingIdeaId: args.originating_idea_id,
      executor: args.executor,
    }),
  }),

  defineTool({
    name: 'cyboflow_update_task',
    description:
      'Update editable fields of an existing task. Re-parenting via parent_epic_id is only valid for type=\'task\' (otherwise rejected with error invalid_parent); a stale expected_version is rejected with error concurrency. Re-parenting a task OFF its epic (parent_epic_id=null) or onto an idea that already has another epic-less task is rejected with error idea_needs_epic — a multi-task idea must keep its tasks under an epic.',
    input: z.object({
      task_id: z.string().min(1).describe('The task id to update (required)'),
      title: z.string().describe('Optional new title').optional(),
      summary: z.string().describe('Optional new SHORT one-line descriptor shown on the board card. For the rich spec / acceptance criteria, use body.').optional(),
      body: z.string().describe('Optional new full markdown body — the canonical rich detail rendered in the entity artifact (idea spec, task description + acceptance criteria). Prefer it over summary for anything multi-line.').optional(),
      priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']).describe('Optional new priority (P0-P6)').optional(),
      category: z.enum(['feature', 'bug', 'chore']).describe('Optional new entity CLASSIFICATION (feature|bug|chore). Unrelated to cyboflow_report_finding\'s free-text grouping `category`.').optional(),
      repo: z.string().describe('Optional new repo identifier').optional(),
      parent_epic_id: z.string().describe('Optional parent epic id (re-parent)').optional(),
      expected_version: z.number().describe('Optional expected version for optimistic concurrency').optional(),
      scope: z.enum(['small', 'large']).describe('Optional idea size hint; only meaningful for idea entities (ignored on epic/task entities)').optional(),
      executor: z.enum(['agent', 'human']).describe('Optional new EXECUTOR — who performs the work (task entities only; rejected with error invalid_executor on an idea/epic). \'agent\' (the default) means a sprint lane drives it. \'human\' means work only a person can do (accounts, purchases, physical devices, legal sign-off, credentials the agent must not hold); a human task NEVER becomes a sprint lane; agent tasks that need its output still record a blocking edge to it — the edge does not gate the sprint, it surfaces the human work as a standing review item.').optional(),
    }),
    envelope: 'mcp-update-task',
    expected: { priority: PRIORITY_EXPECTED },
    toEnvelope: (args) => ({
      taskId: args.task_id,
      title: args.title,
      summary: args.summary,
      body: args.body,
      priority: args.priority,
      category: args.category,
      repo: args.repo,
      parentEpicId: args.parent_epic_id,
      expectedVersion: args.expected_version,
      scope: args.scope,
      executor: args.executor,
    }),
  }),

  defineTool({
    name: 'cyboflow_set_task_stage',
    description:
      'Move a task to a planning/terminal stage. Execution stages are orchestrator-derived and will be rejected (error forbidden_stage); a task with active runs will be rejected (error active_runs).',
    input: z.object({
      task_id: z.string().min(1).describe('The task id to move (required)'),
      stage_id: z.string().min(1).describe('The target stage id (required)'),
      expected_version: z.number().describe('Optional expected version for optimistic concurrency').optional(),
    }),
    envelope: 'mcp-set-task-stage',
    toEnvelope: (args) => ({
      taskId: args.task_id,
      stageId: args.stage_id,
      expectedVersion: args.expected_version,
    }),
  }),

  defineTool({
    name: 'cyboflow_add_task_dependency',
    description:
      'Record a task->task dependency edge for THIS run\'s project. task_id is the BLOCKED task; depends_on_task_id is the PREREQUISITE that must finish first. Each may be given as the opaque task id OR the display ref (e.g. TASK-001) — pass the ref straight from the sprint task list, it is resolved automatically. Routes through the single write chokepoint. Both must be real TASKS in this project (rejected with error invalid_dependency otherwise); a self-edge is rejected (invalid_dependency); an edge that would create a cycle among blocking edges is rejected (error dependency_cycle); re-adding an existing edge is an idempotent no-op. Default kind=\'blocking\' participates in sprint ordering; kind=\'related\' is advisory metadata only.',
    input: z.object({
      task_id: z.string().min(1).describe('The BLOCKED task — opaque id or display ref e.g. TASK-001 (required)'),
      depends_on_task_id: z.string().min(1).describe('The PREREQUISITE that must finish first — opaque id or display ref e.g. TASK-001 (required)'),
      kind: z.enum(['blocking', 'related']).describe('Optional edge kind; defaults to \'blocking\'').optional(),
    }),
    envelope: 'mcp-add-task-dependency',
    toEnvelope: (args) => ({
      taskId: args.task_id,
      dependsOnTaskId: args.depends_on_task_id,
      // kind -> dependencyKind: 'kind' is already the review-item discriminator on
      // this socket, so the edge kind travels under its own name.
      dependencyKind: args.kind,
    }),
  }),

  defineTool({
    name: 'cyboflow_set_idea_component',
    description:
      'Set one idea\'s component ledger state (migration 101\'s idea component ledger — idea-spec/prototype/architecture/epics/stories, each complete|incomplete|skipped). Routes through the single IdeaComponentRouter write chokepoint with source:\'flow\'; sourceRunId and the idea\'s builtAgainstVersion are resolved by the tool itself from THIS run, never accepted as input. idea_id may be the opaque idea id OR its display ref (e.g. \'IDEA-009\') — resolved the same way as cyboflow_get_task. Setting a state ALWAYS clears any prior staleness on that component (an explicit stamp is a reviewed judgment, even \'still incomplete\'). Stamp AFTER the body write that completes a component, never before — see cyboflow_get_task\'s description for why order matters.',
    input: z.object({
      idea_id: z.string().min(1).describe('Opaque idea id OR display ref (e.g. \'IDEA-009\') (required)'),
      component: z.enum(['idea-spec', 'prototype', 'architecture', 'epics', 'stories']).describe('Which of the five tracked idea components to set (required)'),
      state: z.enum(['complete', 'incomplete', 'skipped']).describe('The component\'s new state (required). \'skipped\' must only be set deliberately — it is never inferred.'),
    }),
    envelope: 'mcp-set-idea-component',
    toEnvelope: (args) => ({ ideaId: args.idea_id, component: args.component, state: args.state }),
  }),

  defineTool({
    name: 'cyboflow_list_tasks',
    description:
      'List the backlog (ideas/epics/tasks) for THIS run\'s project. Read-only and run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID). Returns COMPACT items WITHOUT their markdown body — use cyboflow_get_task to fetch one item\'s full body by the id or ref this tool returns. By default archived items and done/retired items are hidden; opt in with include_archived / include_done. Use this before cyboflow_create_task to check whether an idea/task already exists and avoid creating a duplicate.',
    input: z.object({
      task_type: z.enum(['idea', 'epic', 'task']).describe('Optional filter to one entity type; omit to list all three').optional(),
      include_archived: z.boolean().describe('Optional; include archived items (archived_at set). Defaults to false.').optional(),
      include_done: z.boolean().describe('Optional; include done/retired items (isDone, or a decomposed idea). Defaults to false.').optional(),
    }),
    envelope: 'mcp-list-tasks',
    toEnvelope: (args) => ({
      taskType: args.task_type,
      includeArchived: args.include_archived,
      includeDone: args.include_done,
    }),
  }),

  defineTool({
    name: 'cyboflow_get_task',
    description:
      'Fetch ONE backlog entity with its FULL markdown body, by opaque id OR display ref (e.g. IDEA-009, EPIC-002, TASK-014) — pass a ref straight from cyboflow_list_tasks, it is resolved automatically. Read-only, scoped to THIS run\'s project: an id/ref that belongs to another project is reported as not_found. For an IDEA, the response also includes an \'attachments\' array — [{ id, label, mimeType, path }], `path` a RESOLVED ABSOLUTE on-disk path (never base64/dataURLs) — read the image bytes yourself via the Read tool; an idea with none returns attachments: []. Epics/tasks carry no \'attachments\' key. For an idea with an approved design, the response also includes \'approved_design\': { approved_at, draft_revision, prototype_revision, snapshot_path, source, source_run_id }, `snapshot_path` a RESOLVED ABSOLUTE on-disk path to the approved prototype snapshot HTML — read it directly via the Read tool, no export step needed. `source` is \'design-mode\' (a human refined and approved this design in Design Mode) or \'flow\' (a Launch/Planner/Ship run\'s prototype, bound when its design gate was approved), and `source_run_id` names that run for a flow-sourced design (null for design-mode). An idea with no approved design omits the key. For an IDEA, the response ALSO includes \'components\' — the idea component ledger, always all FIVE entries (idea-spec, prototype, architecture, epics, stories; see cyboflow_set_idea_component to write one), each `{ component, state, source, sourceRunId, sourceSessionId, builtAgainstVersion, staleAt, staleReason, updatedAt }`. `state` is one of complete|incomplete|skipped. CRITICAL: an `incomplete` component with `staleAt` non-null is NOT the same as one never started — it means prior work exists (from before the idea\'s body changed underneath it) and needs RE-VERIFICATION, not a redo from scratch; `staleAt === null` on an `incomplete` component means truly not started. Epics/tasks carry no \'components\' key.',
    input: z.object({
      task_id: z.string().min(1).describe('Opaque backlog id OR display ref (e.g. TASK-014) to fetch (required)'),
    }),
    envelope: 'mcp-get-task',
    toEnvelope: (args) => ({ taskId: args.task_id }),
  }),

  defineTool({
    name: 'cyboflow_update_sprint_task',
    description:
      'Report per-task progress for THIS sprint run\'s task lanes (the structured per-task progress rail). The lane is run-bound: the batch is derived from CYBOFLOW_RUN_ID\'s workflow_runs.batch_id (a run launched without a sprint task batch is rejected with error sprint_lane_requires_batch_run). At least one of status / current_step is required. status=\'integrated\' means the task is complete AND committed in the session worktree. This does NOT move the task on the board (board stages are orchestrator-derived) and does NOT pause the run.',
    input: z.object({
      task_id: z.string().min(1).describe('The task whose lane to update — opaque id OR display ref e.g. TASK-001 (required; must be in this sprint batch; the ref is resolved automatically, pass it straight from the sprint task list)'),
      status: z.enum(['queued', 'running', 'integrated', 'failed', 'blocked']).describe('Optional new lane status; \'integrated\' = task complete + committed in the session worktree').optional(),
      current_step: z.string().min(1).describe('Optional per-task lane step the executing subagent is on — must be one of this run\'s lane step ids (the fan-out chain listed in the orchestrator\'s instructions; canonical default: implement, write-tests, code-review, task-verify, visual-verify, awaiting-verify), authoritatively validated server-side. Use \'awaiting-verify\' to park the lane at the visual merge-gate after firing cyboflow_request_verification — the verifier drives the lane off it (PASS→integrated, FAIL→implement loopback).').optional(),
      attempt: integerAtLeast(z.number().describe('1-based attempt counter; report when re-delegating implement after a verify failure'), 1).optional(),
    }).superRefine((value, ctx) => {
      if (value.status === undefined && value.current_step === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one of status / current_step' });
      }
    }),
    envelope: 'mcp-update-sprint-task',
    expected: {
      // `current_step` is a NON-EMPTY STRING and deliberately not an enum: a
      // confirmed pre-existing bug had that enum missing 'awaiting-verify' and
      // rejected the very park sprint.md/ship.md tell the orchestrator to make.
      // The lane-step vocabulary is chain-derived (per-run fanOut.inner ids) and
      // validated by SprintLaneStore.updateLane against the CALLING run's
      // resolved chain — the schema here only guards the wire shape.
      current_step: 'current_step: non-empty string (optional) — validated server-side',
      attempt: 'attempt: integer >= 1 (optional)',
    },
    toEnvelope: (args) => ({
      taskId: args.task_id,
      status: args.status,
      currentStepId: args.current_step,
      attempt: args.attempt,
    }),
  }),

  defineTool({
    name: 'cyboflow_create_sprint_batch',
    description:
      'Materialize the approved task plan into a sprint batch for THIS run, stamping the run\'s batch_id MID-RUN (the \'ship\' workflow handoff seam: planner decomposition → sprint execution in one continuous run). Run-bound (no run argument — derived from CYBOFLOW_RUN_ID). Pass task_ids to materialize the human-approved subset from the approve-plan gate; omit it to materialize ALL tasks this run created. IDEMPOTENT: if the batch already exists this returns created:false without re-minting. Each id is intersected with the tasks this run actually created; unknown ids are dropped. After this succeeds, cyboflow_update_sprint_task lane writes work and the swimlane canvas appears. Errors: ship_no_tasks_to_materialize (nothing to batch), ship_batch_too_large (subset exceeds the substrate cap).',
    input: z.object({
      task_ids: z.array(z.string().min(1)).describe('Optional human-approved task id subset to materialize (the approve-plan selection). Omit to materialize ALL tasks this run created.').optional(),
    }),
    envelope: 'mcp-create-sprint-batch',
    expected: { task_ids: 'task_ids: string[] (optional, non-empty strings)' },
    toEnvelope: (args) => ({ taskIds: args.task_ids }),
  }),

  defineTool({
    name: 'cyboflow_report_finding',
    description:
      'Report a NON-BLOCKING observation, decision, or human action item into THIS project\'s unified review queue (the human-attention inbox). The item is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single review-item chokepoint, and surfaces in the review queue. By default findings are NON-BLOCKING (the run is never paused, status is unchanged, the user is not interrupted). For kind:\'finding\', set blocking:true ONLY for a defect that no retry or loopback in the current step chain will fix — e.g. a lane that has exhausted its attempt budget, or a hazard in shared state that must stop the run now. If the step you are on has a loopback that will address the issue (a code-review ## Blocking defect, a failing test, a task-verify FAIL), the loopback IS the response — do NOT also file a finding; a blocking one would park the run and hand a human a defect the chain is about to fix itself. Blocking kind:\'decision\' gates (planner/ship guards, eval verdicts) are unaffected by this guidance. This is OBSERVATIONAL — contrast with the PreToolUse approval gate.',
    input: z.object({
      title: z.string().min(1).describe('Short headline for the item (required)'),
      body: z.string().min(1).describe('Markdown detail / context for the item (required)'),
      severity: z.enum(['info', 'warning', 'error']).describe('Optional severity; only meaningful for findings').optional(),
      kind: z.enum(['finding', 'decision', 'human_task']).describe('Optional item kind; defaults to \'finding\'').optional(),
      blocking: z.boolean().describe('Optional — whether this item gates run resume; defaults to false (non-blocking)').optional(),
      entity_type: z.enum(['idea', 'epic', 'task']).describe('Optional soft entity link type (must be paired with entity_id)').optional(),
      entity_id: z.string().describe('Optional soft entity link id (must be paired with entity_type)').optional(),
      category: declareAs(z.unknown(), { type: 'string', description: 'Optional FREE-TEXT finding category for review-queue grouping (e.g. \'security\', \'perf\', \'post-merge-bug\'). Unrelated to the entity classification enum (feature|bug|chore) on cyboflow_create_task/cyboflow_update_task.' }).optional(),
      locations: declareAs(z.unknown(), {
        type: 'array',
        description: 'Optional file:line locations the finding refers to',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (required within a location)' },
            line: { type: 'number', description: 'Optional 1-based line number' },
          },
          required: ['path'],
        },
      }).optional(),
      suggested_fix: declareAs(z.unknown(), { type: 'string', description: 'Optional prose suggesting how to fix the finding' }).optional(),
      proposed_target: declareAs(z.unknown(), { type: 'string', enum: ['backlog', 'docs', 'prompt', 'fix'], description: 'Optional hint for where accepting the finding should land: backlog = promote to task, docs = a docs/ edit, prompt = a workflow-prompt/CLAUDE.md edit, fix = a quick fix applied in-place' }).optional(),
      impact: declareAs(z.unknown(), {
        type: 'object',
        description: 'Optional verification impact (all members optional)',
        properties: {
          ran_count: { type: 'number', description: 'How many times a regression-guard ran' },
          caught_regressions: { type: 'number', description: 'How many regressions it caught' },
          token_delta: { type: 'number', description: 'Token delta attributable to the finding' },
          note: { type: 'string', description: 'Free-text impact note' },
        },
      }).optional(),
      payload_json: z.string().describe('Optional per-kind payload JSON; its discriminant must equal kind').optional(),
    }),
    envelope: 'mcp-report-finding',
    toEnvelope: (args) => ({
      title: args.title,
      body: args.body,
      severity: args.severity,
      kind: args.kind,
      blocking: args.blocking,
      entityType: args.entity_type,
      entityId: args.entity_id,
      // The structured finding extras cross UNVALIDATED — handleReportFinding
      // unknown-guards each shape and DROPS malformed members so an agent typo can
      // never fail a finding write.
      category: args.category,
      locations: args.locations,
      suggestedFix: args.suggested_fix,
      proposedTarget: args.proposed_target,
      impact: args.impact,
      payloadJson: args.payload_json,
    }),
  }),

  defineTool({
    name: 'cyboflow_get_selected_findings',
    description:
      'Return the findings the human selected to compound for THIS run; read-only; bound from CYBOFLOW_RUN_ID.',
    input: z.object({}),
    envelope: 'mcp-get-selected-findings',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_get_eval',
    description:
      'Return the code-review eval\'s FULL verdict for a run in this session: overall score + band + confidence interval, the per-dimension breakdown, the catastrophic-cap triggers and security / requirements-unmet flags, every sub-check the jury FAILED with its evidence, and every finding it raised — each cross-linked to the review_items.id it was filed as, or null when it never reached the queue. Read-only. USE THIS WHENEVER YOU ARE ASKED TO FIX WHAT AN EVAL FLAGGED: cyboflow_list_run_findings shows only the slice that reached the review queue (net-new or majority-catastrophic findings, deduped, advisory-capped at 10) and NEVER the score, because the one summary review item carrying the rollup is written only for an ad-hoc eval — an automatic or A/B-tagged flow eval posts none. A finding here with reviewItemId null is one nothing else surfaces. run_id is OPTIONAL and normally omitted: your own run id in a chat turn is a `__quick__` sentinel that was never graded, so the default walks the runs your SESSION owns and returns the first graded one, reporting the runScope it searched. Naming a run_id explicitly requires it to be in your project (else run_not_in_project). Not gated on a live run — the eval grades AT settle, so the run it graded is usually already terminal. Replies { runScope, evaluation }, with evaluation null when no run in scope has ever been graded.',
    input: z.object({
      run_id: z
        .string()
        .min(1)
        .describe(
          'Optional run to read the eval for. Omit to search the runs this session owns (the right default in a chat turn); must be in your project when named.',
        )
        .optional(),
    }),
    envelope: 'mcp-get-eval',
    toEnvelope: (args) => compact({ targetRunId: args.run_id }),
  }),

  defineTool({
    name: 'cyboflow_list_run_findings',
    description:
      'Return the still-open findings this SESSION\'s runs filed, each with the review_items.id cyboflow_resolve_finding needs; read-only, no arguments. This is how a run acts on its OWN findings instead of deferring all of them: cyboflow_report_finding is fire-and-forget and never returns the minted id, so the ids only exist here. SCOPE: not just CYBOFLOW_RUN_ID but every run the same session owns — in a flow step those are the same set, but in a CHAT turn your run id is the session\'s `__quick__` sentinel, which filed nothing, so a run-only read would hand you an empty list for a session full of findings. The reply carries `runScope` (the run ids actually covered) alongside `findings`, so an empty list is legible rather than ambiguous. The set spans every task lane\'s code review, the sprint-wide review, AND the code-review EVAL JURY (its findings are source `agent:eval` and are returned here like any reviewer\'s — though only its net-new/catastrophic slice reaches the review queue; call cyboflow_get_eval for the full verdict, the score, and the findings the cap dropped). Oldest first; each row carries { id, runId, title, body, severity, priority, source, category, blocking, proposedTarget, suggestedFix, locations }. Returns ONLY findings an agent reported (source \'agent:<label>\'): anything already resolved or dismissed is excluded (so a re-entered step never re-triages its own disposals), as is everything system-minted — the orchestrator\'s machine-audience mailbox AND the visual merge-gate\'s own verdict findings (loopback records answered by the loopback, and low-confidence/timeout warnings about RENDERED output that no source-code read can refute). Mid-run only: a terminal run is rejected with run_not_active. Distinct from cyboflow_get_selected_findings, which returns the findings a HUMAN seeded into a Compound run.',
    input: z.object({}),
    envelope: 'mcp-list-run-findings',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_resolve_finding',
    description:
      'Resolve a finding the run consumed; records the correct resolution prefix; routes through the review-item chokepoint. Call this immediately after each finding\'s action lands — resolves are rejected once YOUR OWN run reaches a terminal status (a chat turn\'s run is its session\'s live `__quick__` sentinel, so a chat is not blocked by this). You may resolve a finding your run filed, one a human seeded into your Compound run, or one filed by any run in YOUR SESSION — that last arm is what lets a chat close out the findings of the flow run it is sitting on, which it could never have filed itself. Anything else is refused with finding_not_in_run_scope.',
    input: z.object({
      review_item_id: z.string().min(1).describe('The review_items.id of the finding to resolve (required)'),
      resolution_kind: z.enum(['fixed', 'triaged', 'promoted']).describe('How the finding was resolved: fixed = quick fix applied in-place, triaged = reviewed/dispositioned (e.g. a docs edit), promoted = minted a backlog task (pair with task_id)'),
      note: z.string().describe('Optional free-text note appended to the resolution (e.g. compound)').optional(),
      task_id: z.string().describe('Optional minted task id; recorded when resolution_kind=promoted').optional(),
    }),
    envelope: 'mcp-resolve-finding',
    toEnvelope: (args) => ({
      reviewItemId: args.review_item_id,
      resolutionKind: args.resolution_kind,
      note: args.note,
      taskId: args.task_id,
    }),
  }),

  defineTool({
    name: 'cyboflow_report_artifact',
    description:
      'Create or update a run deliverable ("artifact") for THIS run — e.g. a static UI-prototype mockup, a captured screenshot gallery, a generated report, or a custom canvas. The artifact appears as its own tab in the center pane and in the right-rail Artifacts panel. The run is derived from CYBOFLOW_RUN_ID (no run argument). There is one artifact per atype per run: calling again with the same atype ENRICHES the existing one (and returns the same id). The templated deliverables idea-spec, decomposed-stories, arch-design, approve-ideas and approve-designs are auto-created by the orchestrator (arch-design/approve-designs derive from the ideas’ "## Architecture design" sections; approve-ideas/approve-designs render the batch’s idea rows — you do NOT report these gate/spec surfaces, you open their gate via cyboflow_report_finding instead); screenshots, ui-prototype, adversarial-review, and generic are reported BY YOU with this tool. For ui-prototype, first write a self-contained static index.html (inline CSS only, no <script>/JS, no dev server) to $CYBOFLOW_RUN_ARTIFACTS_DIR/prototype/index.html and pass payload_json.fileName — an inline "html" key is rejected. For screenshots, first write the PNG bytes into the run artifacts dir ($CYBOFLOW_RUN_ARTIFACTS_DIR) and pass their BASENAMES in payload_json.fileNames. Returns { artifactId }.',
    input: z.object({
      atype: z.enum(['idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'compound-recommendations', 'project-brief', 'approve-ideas', 'verify-runbook', 'adversarial-review']).describe('Artifact type (required). ui-prototype renders a static HTML+CSS mockup in a sandboxed frame from a file you already wrote (no dev server, no JS; inline html is rejected); interactive-prototype is the JS-enabled design-mode canvas (same on-disk file contract; scripts run, network egress still blocked); generic renders an embedded live canvas from a {url}; screenshots renders an on-disk PNG gallery (you write the files + report their basenames); compound-recommendations renders a markdown doc from payload_json.markdown (the Compound flow’s summary-of-recommendations); verify-runbook renders the same way for the verify-setup flow’s runbook proposal (the surface its approve-runbook gate reviews, enriched in place with the proof outcomes); project-brief renders a markdown doc from payload_json.markdown — the Launch flow’s project brief; approve-ideas / approve-designs are the per-idea Approve/Deny gate surfaces (auto-created — open the gate via cyboflow_report_finding); adversarial-review renders a markdown doc from payload_json.markdown — the Launch/Planner/Ship adversarial reviewer’s critique (its `## Blocking` / `## Findings` entries, each keeping its `#### AR-n` heading), which the approve-design gate summarizes and whose entries Approve logs as accepted-risk findings; idea-spec / decomposed-stories / arch-design are the auto-created templates.'),
      label: z.string().min(1).describe('Short tab/card label for the artifact (required)'),
      payload_json: z.string().describe('Optional JSON payload. For ui-prototype: {"fileName":"prototype/index.html"} pointing at the static HTML+CSS mockup you already wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR (a top-level "html" key is rejected — write the file, don\'t inline it). For generic: {"url":"http://localhost:8081"}. For screenshots: {"fileNames":["home.png","detail.png"]} (BASENAMES of PNGs you wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR).').optional(),
    }),
    envelope: 'mcp-report-artifact',
    expected: {
      // DRIFT RISK, inherited from the port: the arm derived this list (and its
      // advertised enum) from REPORTABLE_ARTIFACT_ATYPES in
      // shared/types/artifacts.ts — the artifact-policy registry's reportable:true
      // entries, in registry order. Both are literals here, so flipping an atype's
      // `reportable` flag no longer reaches this tool. Keep the enum above, this
      // string, and REPORTABLE_ARTIFACT_ATYPES in lockstep.
      atype:
        'atype: idea-spec | decomposed-stories | screenshots | ui-prototype | generic | interactive-prototype | compound-recommendations | project-brief | approve-ideas | verify-runbook | adversarial-review',
    },
    toEnvelope: (args) => ({ atype: args.atype, label: args.label, payloadJson: args.payload_json }),
  }),

  defineTool({
    name: 'cyboflow_commit_artifact',
    description:
      'Persist a run artifact into the repo so it survives session close (session-only artifacts are otherwise dropped when the run closes). The run is derived from CYBOFLOW_RUN_ID. Pass the artifact_id returned by cyboflow_report_artifact. Returns { artifactId }.',
    input: z.object({
      artifact_id: z.string().min(1).describe('The artifact id to commit (from cyboflow_report_artifact)'),
      payload_json: z.string().describe('Optional final payload JSON to store alongside the commit').optional(),
    }),
    envelope: 'mcp-commit-artifact',
    toEnvelope: (args) => ({ artifactId: args.artifact_id, payloadJson: args.payload_json }),
  }),

  defineTool({
    name: 'cyboflow_request_verification',
    description:
      'Request a visual verification of a rendered deliverable for THIS run (derived from CYBOFLOW_RUN_ID — no run argument). FIRE-AND-CONTINUE: this returns { requestId, type, snapshotSha, dirtyWorktree } IMMEDIATELY and the lane NEVER blocks on the verdict — the main-process scheduler deploys the verification agent and delivers the verdict asynchronously (to the screenshots artifact + the review queue). The PREFERRED form is `task`: a composed verification task (the `## Visual verification task` fence object task-verify emits — version/summary/build/serve/target/behaviors, matching VerificationTaskV1) that the agent independently builds, drives, and judges. `intent` + `url`/`html_path` remain the LEGACY degenerate form (a bare acceptance sentence and a pre-live target, no build/behaviors) — still accepted for backward compatibility and simple checks. When the request is not enqueued this is a no-op that returns { skipped: true, reason } (never an error). A sprint/ship LANE request on a project with no proven verification runbook may instead return { requestId: null, deferred: \'runbook-bootstrap\', reason }: a runbook is being derived and proven first, and the request is enqueued automatically when that settles — park the lane at awaiting-verify as usual and do NOT re-fire; the verdict drives the lane like any other. RELAY `reason` VERBATIM and NEVER INFER A CAUSE IT DOES NOT STATE: several unrelated conditions skip a request — the master switch being off, an immutable run stamp, no proven runbook, a capability suppression — they have different fixes, and a guess reads to the user as a diagnosis. `type_override` can only NARROW within the run\'s resolved capability — it cannot enable a disabled run or add a backend the host lacks. QUICK CHAT SESSIONS may fire this too, not just sprint/ship flow lanes — it returns immediately and the chat continues; cyboflow_await_verification is the opt-in in-turn wait, cyboflow_get_verifications is the later-turn cold read once the request_id is gone. COST: firing this spends real per-project verification budget and deploys an SDK agent that runs the project\'s build/serve commands in an isolated snapshot worktree — treat it as a costly action, not a free read. DIRTY-TREE CONTRACT (load-bearing): the verification runs against a DETACHED checkout at `snapshotSha`, so UNCOMMITTED WORK IS INVISIBLE to it — prefer committing before verifying. When `dirtyWorktree` is true you MUST state both the verified sha and the dirty flag alongside ANY verdict you relay: a PASS on a dirty tree certifies the commit, not what the user is looking at, and must never be reported as unqualified. When — and only when — the returned `reason` is "no proven verification runbook for this project (run verification setup)", that is ACTIONABLE rather than a dead end: offer to run the verify-setup flow. Do not volunteer that diagnosis for any other reason string.',
    input: z.object({
      intent: declareAs(z.unknown(), { type: 'string', description: 'Natural-language acceptance the verifier judges against, e.g. "the settings panel shows the new visual-verify toggle, default off" (required unless `task` is passed — a task-form call derives it from task.summary). LEGACY form when passed alone with `url`/`html_path`. When `task` is ALSO passed, `task` is authoritative for the deliverable/behaviors and `intent` may simply repeat task.summary.' }).optional(),
      task: declareAs(z.unknown(), {
        type: 'object',
        description:
          "PREFERRED form: a composed VerificationTaskV1 object ({ version: 1, summary, build?, serve?, target?, behaviors, viewports?, timeoutMs?, taskRef? }) — the task-verify subagent's `## Visual verification task` fence, passed through verbatim. Validated strictly server-side; malformed shapes are rejected with an `invalid_verification_task` error naming the offending field. When present, `task` supersedes `url`/`html_path`/`viewports` for the persisted deliverable.",
      }).optional(),
      type_override: z.enum(['static-render-snapshot', 'interactive-web-behavior', 'responsive-multi-viewport', 'native-desktop', 'mobile-flow']).describe('Optional agent-declared verification type. NARROWS only — an override outside the run\'s resolved chain is dropped; it can never enable a disabled run.').optional(),
      url: z.string().describe('Optional URL of the running deliverable to capture (e.g. http://localhost:5173).').optional(),
      html_path: z.string().describe('Optional path to a static HTML file to render + capture.').optional(),
      viewports: declareAs(z.unknown(), {
        type: 'array',
        description: 'Optional viewport list for responsive-multi-viewport captures.',
        items: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Viewport width in px (required within a viewport)' },
            height: { type: 'number', description: 'Viewport height in px (required within a viewport)' },
            label: { type: 'string', description: 'Optional viewport label (e.g. "mobile", "desktop")' },
          },
          required: ['width', 'height'],
        },
      }).optional(),
      baseline_key: z.string().describe('Optional golden-baseline key to compare against (absent = intent-only judging).').optional(),
      task_ref: z.string().describe('Optional lane ref of the task this verification is for (e.g. "TASK-008"), used by the visual merge-gate to drive the async verdict onto the right lane. Pass YOUR task\'s ref in a multi-task sprint; omit for a single-task run. A request whose ref names a lane is keyed to that lane\'s CURRENT attempt: re-firing within the same attempt returns the existing request instead of deploying a second one, so after a failed verdict re-fire only after the lane\'s attempt has been bumped (the merge gate does this on every FAIL loopback; a manual re-delegate must report `attempt` via cyboflow_update_sprint_task first).').optional(),
      setup_proof: z.boolean().describe('Optional — mark this request as the verify-setup flow\'s PROOF run rather than ordinary lane traffic. VERIFY-SETUP-FLOW-ONLY, SERVER-ENFORCED: the request is rejected with error \'setup_proof_not_authorized\' unless it comes from a run whose FROZEN workflow identity is \'verify-setup\' — no other flow (sprint/ship/compound) can claim this, whatever it passes. It also requires a valid pin (see runbook_hash) or is rejected with \'setup_proof_requires_pin\'; an unpinned setup-proof request is pure budget/gate bypass with no offsetting proof, so it is never allowed through. Authorized, a setup-proof run is EXEMPT from the project\'s lifetime verification budget (and never counted against it), drains at LOWER priority than live sprint lanes (promoted after 5 minutes so it cannot starve), may execute an UNPROVEN runbook draft (being unproven is exactly what it is trying to fix — gating it would deadlock the bootstrap), and, when it PASSES while pinned, causes the ENGINE to mark that runbook revision proven. You never mark a runbook proven yourself. Defaults to false.').optional(),
      runbook_hash: z.string().describe('Optional — the portable-runbook content hash returned by cyboflow_register_verify_runbook. Pin the revision this request must execute (verify-setup flow, paired with setup_proof + runbook_local_version). MEANINGFUL ONLY INSIDE THE SETUP-PROOF ENVELOPE: without setup_proof:true this field is IGNORED — the server drops it before enqueue and the engine resolves and pins the project\'s PROVEN revision itself, so you can neither redirect an ordinary request onto another revision nor suppress the injection by pinning a hash. REQUIRED when setup_proof is true: the hash must resolve to a draft this project actually registered (via cyboflow_register_verify_runbook) or the request is rejected with \'setup_proof_requires_pin\' — see setup_proof.').optional(),
      runbook_local_version: z.number().describe('Optional — the machine-local record CAS version returned alongside runbook_hash. Must be passed WITH runbook_hash (half a pin is ignored): together they let the runner execute exactly that revision or reject with a structured mismatch instead of improvising. IGNORED without setup_proof:true, exactly like runbook_hash — an ordinary request carries no caller-supplied pin at all. REQUIRED when setup_proof is true — see setup_proof.').optional(),
    }).superRefine((value, ctx) => {
      if (resolveVerificationIntent(value.intent, value.task) === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'intent: string (or task.summary)' });
      }
    }),
    envelope: 'mcp-request-verification',
    expected: {
      type_override:
        'type_override: static-render-snapshot | interactive-web-behavior | responsive-multi-viewport | native-desktop | mobile-flow (optional)',
    },
    toEnvelope: (args) => ({
      // The superRefine above is what makes this resolvable; the '' fallback is
      // unreachable and exists only to satisfy the envelope's `intent: string`.
      intent: resolveVerificationIntent(args.intent, args.task) ?? '',
      // `task` and `viewports` cross VERBATIM — parseVerificationTaskV1 /
      // parseViewports validate them server-side, so a malformed shape is rejected
      // (or narrowed) at one site rather than two.
      task: args.task,
      typeOverride: args.type_override,
      url: args.url,
      htmlPath: args.html_path,
      viewports: args.viewports,
      baselineKey: args.baseline_key,
      taskRef: args.task_ref,
      setupProof: args.setup_proof,
      runbookHash: args.runbook_hash,
      runbookLocalVersion: args.runbook_local_version,
    }),
  }),

  defineTool({
    name: 'cyboflow_run_eval',
    description:
      'Request an ad-hoc code-review eval of THIS session\'s current working-tree diff against its base. FIRE-AND-CONTINUE: returns { status, rubricVersion } immediately (\'queued\' | \'requeued\' = replaced a prior ad-hoc verdict | \'in_flight\' = one is already grading); a 3-slot jury (2×Claude + 1×Codex) grades asynchronously and the verdict lands as a non-blocking review-queue item. Errors: adhoc_eval_tagged_run_rejected (A/B-tagged runs auto-grade; ad-hoc would distort arm comparison), adhoc_eval_exists_auto (the run already has its canonical automatic eval), adhoc_eval_no_diff (no diff to grade), run_not_found. Explicit calls bypass the automatic-eval on/off settings.',
    input: z.object({}),
    envelope: 'mcp-run-eval',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_await_verification',
    description:
      'BLOCKS until a verification request you already enqueued reaches a verdict, then returns it inline: { status, failureClass, feedback, errorMessage }. Meaningful for the verify-setup flow, whose derive → prove-by-running → diagnose → re-prove loop needs each outcome inside the same turn; ordinary sprint lanes must NOT use it (they fire cyboflow_request_verification, park at awaiting-verify, and the merge gate drives the verdict onto the lane asynchronously). Run-bound: the request must belong to THIS run. `status` is one of passed | failed | low_confidence | skipped | timeout — or, if your wait budget expires first, the request\'s still-live status (queued/leased/running) with errorMessage \'await timeout\', which means YOU stopped waiting, not that the request failed (it keeps running and still delivers its verdict to the artifacts + review queue). On a failure, `failureClass` is the harness\'s attribution — \'env\' (an environment problem it PROVED: failed preflight, occupied port, lock contention), \'deliverable\' (the commands genuinely do not stand the project up), or \'ambiguous\' (no corroboration either way) — and is the thing to read before deciding what to change.',
    input: z.object({
      request_id: z.string().min(1).describe('The verification request id cyboflow_request_verification returned (required).'),
      timeout_ms: z.number().finite().describe('Optional wait budget in milliseconds. Defaults to 15 minutes and is clamped to the 20-minute ceiling (the longest a verification request may itself run — waiting past it cannot surface a verdict that does not exist).').optional(),
    }),
    envelope: 'mcp-await-verification',
    expected: { request_id: 'request_id: string (the id cyboflow_request_verification returned)' },
    timeoutMs: AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS,
    // request_id -> verificationRequestId: every message on this socket already
    // carries its OWN `requestId` correlation id, and colliding the two would make
    // the handler answer the wrong call.
    toEnvelope: (args) => ({ verificationRequestId: args.request_id, timeoutMs: args.timeout_ms }),
  }),

  defineTool({
    name: 'cyboflow_get_verifications',
    description:
      'Lists THIS run\'s verification requests and their outcomes, newest first — a NON-BLOCKING cold read, never a wait. Each row: id, status, verifyType, attempt, failureClass, feedback, errorMessage, enqueuedAt, endedAt, snapshotSha, screenshotFiles. WHY IT EXISTS: cyboflow_await_verification can only answer for a request_id you are still holding; after a context compaction those ids are gone, and this is how you find out what happened to verifications you already fired. `screenshotFiles` is PER-REQUEST and may be `null` — that means this engine persisted no exact per-request file list (the legacy capture path), NOT that no screenshots exist; distinguish it from `[]`, which means the agent ran and captured nothing. SCOPE CAVEAT: the scope is THIS run — in a quick chat session that means the session\'s own quick sentinel, so it will NOT list verifications fired by structured flow runs the session hosted, even though the artifacts pane does show those; reading an empty list as "no verifications exist" is a mistake without this caveat in mind. `snapshotSha` is what the verdict actually certifies — pair it with `dirtyWorktree` from the enqueue reply before relaying any verdict.',
    input: z.object({
      request_id: z.string().min(1).describe('Optional verification request id to narrow the listing to a single row; omit to list every request for this run.').optional(),
    }),
    envelope: 'mcp-get-verifications',
    expected: { request_id: 'request_id: string (optional; the id cyboflow_request_verification returned)' },
    // NON-BLOCKING cold read — no timeoutMs override. The extended
    // AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS budget exists only for the BLOCKING
    // await tool above; this handler answers from the DB immediately.
    toEnvelope: (args) => ({ verificationRequestId: args.request_id }),
  }),

  defineTool({
    name: 'cyboflow_register_verify_runbook',
    description:
      'Register (or refresh) the MACHINE-LOCAL half of THIS project\'s verification runbook and return { hash, version, committed, warning? } — the content-addressed hash of the committed portable half and the CAS version of the local record. Meaningful for the verify-setup flow. It reads `.cyboflow/verify-runbook.json` from THIS run\'s worktree itself (there is no content argument — COMMIT the file first, then register: the returned hash addresses what you actually committed, which is what a later request is pinned to). `committed: false` is a WARNING, not a blocker on proving: the proof executes the REGISTERED content (this record\'s `portable_json`, fetched by hash), never the snapshot\'s file, so an uncommitted runbook still proves. What it means is that the human-reviewable EXPORT is not present at HEAD — the usual cause is a project that ignores or locally-excludes `.cyboflow/`, which makes a plain `git add` a silent no-op; re-add with `git add -f`, commit, and register again so the committed file matches the record. Registering produces an \'unproven-draft\': new content is by definition unproven, and only a PASSING setup_proof verification promotes it. The one exception: when the file\'s content hash AND the bindings_json you pass both equal those of an existing PROVEN record, registering is a no-op — it returns the existing proven record when unchanged (same hash, same version, still proven), so re-registering identical content never costs a proof. Re-register after every edit — the hash changes, so the old record no longer describes what you are proving. Errors come back verbatim and name the offending file or key (e.g. "portable runbook is not valid JSON: …", "portable runbook declares no \\"cdp-app\\" modality") so you can fix the file and retry.',
    input: z.object({
      modality: z
        .enum(VERIFY_RUNBOOK_MODALITIES as unknown as [VerifyRunbookModality, ...VerifyRunbookModality[]])
        .describe(
          'Which modality\'s record to register; the portable runbook must declare an entry for it. mobile = iOS Simulator on Apple\'s command-line toolchain; the entry declares build[] + app + a bundle-identity attestation and no serve; authored by the verify-setup flow, never auto-derived by a lane.',
        ),
      bindings_json: z.string().describe('Optional JSON object of HOST-STABLE resolved lever bindings — binary paths, the data-dir lever name, ABI facts. NEVER request-scoped values: ports and temp dirs are leased per request by the scheduler, and a persisted one would go stale or collide. Validated as parseable JSON.').optional(),
    }),
    envelope: 'mcp-register-verify-runbook',
    expected: { bindings_json: 'bindings_json: string (optional, JSON object)' },
    // Parseability is re-checked server-side (one validation site); the schema here
    // only keeps a non-string off the wire.
    toEnvelope: (args) => ({ modality: args.modality, bindingsJson: args.bindings_json }),
  }),

  defineTool({
    name: 'cyboflow_list_workflows',
    description:
      'List the workflows available in THIS run\'s project (the built-in launch/planner/sprint/compound/ship plus any custom flows), reconciling the in-repo built-ins first. Read-only, run-bound (no project argument). Returns COMPACT rows (id, name, scope global|project, is_built_in, permission_mode, has_custom_spec, tuning_level, runtime_mix) WITHOUT the full step graph — use cyboflow_get_workflow to fetch one flow\'s definition. `tuning_level` is which definition the flow RESOLVES — \'standard\' (the as-authored built-in), \'efficient\'/\'thorough\' (a calibrated preset applied to the built-in at read time), or \'custom\' (the flow\'s own saved spec). It is orthogonal to `has_custom_spec`: a flow can hold a saved custom definition while running a preset level, in which case the saved one is dormant. `runtime_mix` (migration 127) is the flow\'s second, orthogonal dial — which PROVIDER runs each step: \'claude\' (everything on Claude, the default), \'claude-primary\' (Claude executes, Codex reviews/verifies), \'codex-primary\' (the reverse), or \'codex\' (everything on Codex). The mix is materialized only into a RUN\'s frozen spec at launch, never into the definition this surface serves. Call this first to discover workflow ids before editing.',
    input: z.object({}),
    envelope: 'mcp-list-workflows',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_get_workflow',
    description:
      'Fetch ONE workflow\'s EFFECTIVE definition (the phase/step graph the editor seeds from), plus its metadata and baseline rotation participation, by workflow id. Read-only. WHICH graph comes back is decided by the flow\'s `tuning_level`, reported on the `workflow` object: \'standard\' returns the as-authored built-in, \'efficient\'/\'thorough\' return that built-in with the level\'s calibrated preset applied (dropped steps, per-agent model/effort pins, prompt addenda), and \'custom\' returns the flow\'s own saved spec_json. So a preset-level flow hands you a TRANSFORMED graph — passing it straight back to cyboflow_update_workflow would freeze that transform into the custom slot and flip the flow to \'custom\'. The returned `definition` is the exact shape cyboflow_update_workflow expects back (round-trippable): edit it and pass it as definition_json — including whichever of `providerModel`/`codexModel` it already carries; this call does NOT rewrite the persisted keys for you. Per-agent config lives in an optional `agentConfigs` overlay on the definition — `{ [agentKey]: { model?, runtime?, providerModel?, effort? } }`, keyed by a step\'s `agent` value — which pins a per-agent model, routes an agent onto a non-Claude provider (`runtime: \'codex-sdk\'` + `providerModel` — the model id for that provider, e.g. a Codex model), or sets a per-agent reasoning `effort` (Claude `low..max` / Codex `none..xhigh`; a value outside the resolved provider\'s scale is dropped at spawn); it is absent on unedited built-ins. `codexModel` is a deprecated alias of `providerModel` still accepted on write (an explicit `providerModel` wins when both are set), for a definition an older writer already saved. The flow\'s `runtime_mix` (reported on the `workflow` object) is NOT applied to the returned definition — the mix is materialized only into a run\'s frozen spec at launch, so any `runtime` pins you see here are user-authored, and saving the definition back never bakes a mix in. NOT_FOUND (error \'not_found\') when the id is unknown.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The workflow id (from cyboflow_list_workflows)'),
    }),
    envelope: 'mcp-get-workflow',
    toEnvelope: (args) => ({ workflowId: args.workflow_id }),
  }),

  defineTool({
    name: 'cyboflow_update_workflow',
    description:
      'Save an edited workflow definition onto a workflow\'s spec_json (the editor\'s "Save"). `definition_json` is a JSON-encoded WorkflowDefinition (get the current one from cyboflow_get_workflow, edit, pass it back) — it is re-validated by the same strict schema the UI uses (malformed → error \'invalid_definition\'; bad JSON → \'invalid_json\'). Per-agent model pins and non-Claude-provider routing live in the definition\'s optional `agentConfigs` overlay (`{ [agentKey]: { model?, runtime?, providerModel?, effort? } }`; the deprecated `codexModel` key is still accepted — `providerModel` wins when both are set). This writes the flow\'s CUSTOM SLOT and stamps `tuning_level = \'custom\'` in the same transaction, so the flow starts running the saved definition instead of whatever preset level it was on; cyboflow_reset_workflow clears the slot and returns it to \'standard\'. WARNING: editing a global built-in changes it for EVERY project. Unknown id → error \'not_found\'.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The workflow id to update (required)'),
      definition_json: z.string().min(1).describe('JSON-encoded WorkflowDefinition — the full edited graph (required)'),
    }),
    envelope: 'mcp-update-workflow',
    expected: { definition_json: 'definition_json: string (JSON-encoded WorkflowDefinition)' },
    toEnvelope: (args) => ({ workflowId: args.workflow_id, definitionJson: args.definition_json }),
  }),

  defineTool({
    name: 'cyboflow_reset_workflow',
    description:
      'Reset a BUILT-IN workflow\'s spec back to its static in-repo default (the editor\'s "Reset to default"), discarding any saved edits. This empties the flow\'s CUSTOM SLOT, so a flow sitting on `tuning_level: \'custom\'` is also returned to \'standard\' in the same transaction (an empty slot has nothing for Custom to select); a flow on a preset level keeps that level. Only valid for a built-in flow — resetting a custom flow is rejected (error \'not_a_builtin\'). Unknown id → \'not_found\'. WARNING: resets the global built-in for every project.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The built-in workflow id to reset (required)'),
    }),
    envelope: 'mcp-reset-workflow',
    toEnvelope: (args) => ({ workflowId: args.workflow_id }),
  }),

  defineTool({
    name: 'cyboflow_create_workflow',
    description:
      'Create a brand-new CUSTOM workflow ("Save as new flow"). `name` must not collide with a built-in or an existing flow (collision → error \'already_exists\'; a reserved name → \'reserved\'). `definition_json` (optional JSON-encoded WorkflowDefinition, validated like update) seeds the graph — omit to start empty. `scope` = \'global\' (default; shared across every project) or \'project\' (this run\'s project only).',
    input: z.object({
      name: z.string().min(1).describe('Unique workflow name (required)'),
      definition_json: z.string().describe('Optional JSON-encoded WorkflowDefinition to seed the flow; omit for an empty flow.').optional(),
      permission_mode: z.enum(['default', 'acceptEdits', 'auto', 'dontAsk']).describe('Optional default permission mode; defaults to \'default\'.').optional(),
      scope: z.enum(['global', 'project']).describe('Optional scope; \'global\' (default) shares the flow across projects, \'project\' pins it to this run\'s project.').optional(),
    }),
    envelope: 'mcp-create-workflow',
    expected: { definition_json: 'definition_json: string (optional, JSON-encoded WorkflowDefinition)' },
    toEnvelope: (args) => ({
      name: args.name,
      definitionJson: args.definition_json,
      permissionMode: args.permission_mode,
      scope: args.scope,
    }),
  }),

  defineTool({
    name: 'cyboflow_delete_workflow',
    description:
      'Delete a workflow. Refused for reserved global built-ins (error \'reserved\') and for any flow that has run history (error \'run_history\' — retire/keep it instead, since deleting would cascade its run + Insights history). Unknown id → \'not_found\'. Safe for custom flows with no runs.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The workflow id to delete (required)'),
    }),
    envelope: 'mcp-delete-workflow',
    toEnvelope: (args) => ({ workflowId: args.workflow_id }),
  }),

  defineTool({
    name: 'cyboflow_list_variants',
    description:
      'List a workflow\'s A/B variants (newest-first). Read-only. Returns COMPACT rows (id, label, model, execution_model, weight, status draft|active|paused|retired, tuning_level, has_agent_overrides). VARIANTS ARE SCOPED TO A TUNING LEVEL: `tuning_level` is the level a variant challenges, and it only ever rotates into launches of THAT level (null = the parent flow has no levels, i.e. a non-built-in "save as new" flow). Two variants may share a label at different levels, so read the level before assuming a name is taken or that a variant will affect the launch you have in mind. NOTE: `has_agent_overrides` reflects only the `agent_overrides_json` blob (Claude prompt/model tweaks); a variant can still carry per-agent model pins or Codex routing via its `definition_json` `agentConfigs` and show `has_agent_overrides: false` — fetch the variant\'s definition to see those. ARCHIVED variants (migration 116) are OMITTED — an archived variant still exists, still holds its status and run history, and is still pinnable by id; it is just hidden from this listing, so an empty result is not proof the workflow has no variants. Use before creating/editing variants to see what already exists.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The parent workflow id (required)'),
    }),
    envelope: 'mcp-list-variants',
    toEnvelope: (args) => ({ workflowId: args.workflow_id }),
  }),

  defineTool({
    name: 'cyboflow_create_variant',
    description:
      'Create a new variant of a workflow AT ONE TUNING LEVEL, snapshotting that level\'s resolved definition, seeded status=\'draft\' (opt into rotation later via cyboflow_set_variant_status / cyboflow_update_variant weight). A variant challenges ONE level and only rotates into launches of that level, so `tuning_level` decides which pool it joins — omit it to snapshot (and attach to) the flow\'s currently saved level. On a non-built-in "save as new" flow, which has no levels, passing one is an error. Pass `definition_json` to seed the variant\'s frozen graph with an edited definition instead of snapshotting the level\'s (validated like cyboflow_update_workflow: bad JSON → \'invalid_json\', a graph the schema rejects → \'invalid_definition\'); the parent workflow\'s own spec and level stamp are untouched and the status stays draft either way. `label` must be unique within the workflow AT THAT LEVEL (collision → error \'already_exists\'). Unknown workflow → \'not_found\'.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The parent workflow id (required)'),
      label: z.string().min(1).describe('Variant label, unique within the workflow AT ITS TUNING LEVEL (required)'),
      tuning_level: z.enum(TUNING_LEVELS).describe("Optional tuning level this variant challenges — the pool it rotates in. Defaults to the workflow's currently saved level. Rejected on a flow that has no levels.").optional(),
      definition_json: z.string().describe("Optional JSON-encoded WorkflowDefinition to freeze as the variant's graph, instead of snapshotting the resolved definition of its tuning level. Get a starting definition from cyboflow_get_workflow, edit it, pass it back.").optional(),
    }),
    envelope: 'mcp-create-variant',
    toEnvelope: (args) => ({
      workflowId: args.workflow_id,
      label: args.label,
      ...(args.tuning_level !== undefined ? { tuningLevel: args.tuning_level } : {}),
      ...(args.definition_json !== undefined ? { definitionJson: args.definition_json } : {}),
    }),
  }),

  defineTool({
    name: 'cyboflow_update_variant',
    description:
      'Patch a variant in place. All fields optional: `definition_json` (JSON-encoded WorkflowDefinition, re-snapshots + validated like update_workflow), `agent_overrides_json` (a JSON string of `{ [agentKey]: { systemPrompt?, model? } }`, or null to clear), `model` (alias or null), `execution_model` (\'orchestrated\'|\'programmatic\'|null), `weight` (non-negative integer rotation share), `label`. Past runs are unaffected. Unknown id → \'not_found\'. PER-AGENT NON-CLAUDE-PROVIDER ROUTING does NOT go in `agent_overrides_json` (that carries Claude prompt/model-alias tweaks only) — to run specific agents on Codex (or a future non-Claude provider), put an `agentConfigs` overlay in `definition_json`: `{ ..., "agentConfigs": { "<agentKey>": { "runtime": "codex-sdk", "providerModel": "<that provider\'s model id>" } } }`, where agentKey = the step\'s `agent` value (e.g. implement / write-tests / code-review). The deprecated `codexModel` key is still accepted in place of `providerModel`. A mixed Claude+Codex flow only routes those Codex steps under `execution_model: \'programmatic\'` — set it too. There is no per-agent reasoning-effort field; Codex agents inherit the Codex CLI default effort.',
    input: z.object({
      variant_id: z.string().min(1).describe('The variant id to update (required)'),
      definition_json: z.string().describe('Optional JSON-encoded WorkflowDefinition to re-snapshot. This is where per-agent config lives: an `agentConfigs` overlay `{ [agentKey]: { model?, runtime?, providerModel?, effort? } }` pins a Claude model per agent OR routes an agent onto a non-Claude provider (`runtime: \'codex-sdk\'` + `providerModel` — the deprecated `codexModel` key is still accepted). Get the current definition from cyboflow_get_workflow, add/edit `agentConfigs`, pass it back.').optional(),
      agent_overrides_json: z.string().nullable().describe('Optional JSON string of per-agent CLAUDE overrides `{ [agentKey]: { systemPrompt?, model? } }` (custom prompt + Claude model alias only — NOT Codex runtime/model, which go in definition_json agentConfigs); pass null to clear.').optional(),
      model: z.string().nullable().describe('Optional per-variant model alias; null clears it.').optional(),
      execution_model: z.enum(['orchestrated', 'programmatic']).nullable().describe('Optional per-variant execution model; null clears it.').optional(),
      weight: integerAtLeast(z.number().describe('Optional rotation weight (non-negative integer).'), 0).optional(),
      label: z.string().min(1).describe("Optional new label (must stay unique within the workflow at the variant's tuning level).").optional(),
    }).superRefine((value, ctx) => {
      const untouched =
        value.definition_json === undefined &&
        value.agent_overrides_json === undefined &&
        value.model === undefined &&
        value.execution_model === undefined &&
        value.weight === undefined &&
        value.label === undefined;
      if (untouched) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field to update' });
    }),
    envelope: 'mcp-update-variant',
    expected: {
      definition_json: 'definition_json: string (optional, JSON-encoded WorkflowDefinition)',
      weight: 'weight: integer >= 0 (optional)',
      label: 'label: non-empty string (optional)',
    },
    toEnvelope: (args) => ({
      variantId: args.variant_id,
      definitionJson: args.definition_json,
      // null is a MEANINGFUL clear for these three — compact() strips only
      // undefined, so an explicit null still reaches the registry patch.
      agentOverridesJson: args.agent_overrides_json,
      model: args.model,
      executionModel: args.execution_model,
      weight: args.weight,
      label: args.label,
    }),
  }),

  defineTool({
    name: 'cyboflow_set_variant_status',
    description:
      'Transition a variant\'s rotation status: \'draft\' (pinnable/experiment-usable, never auto-rotated), \'active\' (competes in the randomized rotation), \'paused\' (temporarily out), \'retired\' (permanently out but stats stay resolvable). Unknown id → \'not_found\'.',
    input: z.object({
      variant_id: z.string().min(1).describe('The variant id (required)'),
      status: z.enum(['draft', 'active', 'paused', 'retired']).describe('The target rotation status (required)'),
    }),
    envelope: 'mcp-set-variant-status',
    toEnvelope: (args) => ({ variantId: args.variant_id, status: args.status }),
  }),

  defineTool({
    name: 'cyboflow_delete_variant',
    description:
      'Delete a variant. Refused (error \'run_history\') when any run references it — retire it via cyboflow_set_variant_status instead so per-variant stats stay resolvable. Unknown id → \'not_found\'. Safe for a variant with no runs.',
    input: z.object({
      variant_id: z.string().min(1).describe('The variant id to delete (required)'),
    }),
    envelope: 'mcp-delete-variant',
    toEnvelope: (args) => ({ variantId: args.variant_id }),
  }),

  defineTool({
    name: 'cyboflow_set_baseline_rotation',
    description:
      'Configure a workflow\'s BASELINE (its live definition) participation in the A/B rotation: `in_rotation` opts the baseline in/out, `weight` sets its rotation share (non-negative integer). When in rotation the baseline competes on equal footing with active variants. Returns the updated participation. Unknown workflow → \'not_found\'.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The workflow id (required)'),
      in_rotation: z.boolean().describe('Optional — opt the baseline into/out of rotation.').optional(),
      weight: integerAtLeast(z.number().describe('Optional baseline rotation weight (non-negative integer).'), 0).optional(),
    }).superRefine((value, ctx) => {
      if (value.in_rotation === undefined && value.weight === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one of in_rotation / weight' });
      }
    }),
    envelope: 'mcp-set-baseline-rotation',
    expected: { weight: 'weight: integer >= 0 (optional)' },
    toEnvelope: (args) => ({ workflowId: args.workflow_id, inRotation: args.in_rotation, weight: args.weight }),
  }),
];
