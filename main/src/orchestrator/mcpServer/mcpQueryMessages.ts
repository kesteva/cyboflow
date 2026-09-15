/**
 * mcpQueryMessages — the wire/type contract for the MCP query socket.
 *
 * Extracted from mcpQueryHandler.ts (GitHub issue #19, the god-file split):
 * this module carries only the pure type declarations that define what a
 * cyboflowMcpServer subprocess sends over the Cyboflow Unix IPC socket and
 * what it gets back, plus the handler's own dependency-injection surfaces.
 * No behavior lives here. mcpQueryHandler.ts re-exports every name below, so
 * existing importers may keep importing from either './mcpQueryHandler' or
 * './mcpQueryMessages' unchanged.
 */

import type { PermissionMode, WorkflowDefinition, WorkflowRow } from '../../../../shared/types/workflows';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';
import type { IdeaComponentKey, IdeaComponentStateValue } from '../../../../shared/types/ideaComponents';
import type { ArtifactType } from '../../../../shared/types/artifacts';
import type { Priority, TaskType, IdeaScope, EntityCategory } from '../../../../shared/types/tasks';
import type { WorkflowVariantRow, WorkflowVariantStatus } from '../../../../shared/types/experiments';
import type { QuestionPayload } from '../../../../shared/types/questions';
import type { ReviewItemEntityType, ReviewItemKind, ReviewItemSeverity } from '../../../../shared/types/reviews';
import type { SprintBatchTaskStatus, SprintMaxTasksOverrides } from '../../../../shared/types/sprintBatch';
import type { VerificationType, ResolvedVisualVerifyConfig } from '../../../../shared/types/visualVerification';
import type { TaskDependencyKind } from '../taskChangeRouter';
import type { AgentThreadDbStore } from '../agentThread/agentThreadDbStore';
import type { AdHocSnapshotResult } from '../eval/snapshotRunForEval';
import type { VerifyRunbookStore } from '../verify/runbookStore';

export type McpQueryMessage =
  | { type: 'mcp-list-pending-approvals'; requestId: string; runId: string }
  | { type: 'mcp-get-run'; requestId: string; runId: string; targetRunId: string }
  | { type: 'mcp-submit-checkpoint'; requestId: string; runId: string; label: string; note?: string }
  | { type: 'mcp-report-step'; requestId: string; runId: string; stepId: string; status?: 'running' | 'done' }
  | {
      type: 'mcp-request-user-input';
      requestId: string;
      runId: string;
      questions: QuestionPayload[];
    }
  | {
      type: 'mcp-create-task';
      requestId: string;
      runId: string;
      title: string;
      taskType?: TaskType;
      summary?: string;
      /** Full markdown body — the canonical rich detail (idea spec / task description + ACs). */
      body?: string;
      priority?: Priority;
      /**
       * Entity CLASSIFICATION — feature/bug/chore (migration 059). Distinct from
       * the free-text finding-grouping `category` on 'mcp-report-finding'.
       */
      category?: EntityCategory;
      repo?: string;
      parentEpicId?: string;
      boardId?: string;
      initialStageId?: string;
      /** Idea size hint — only meaningful for taskType='idea' (ignored on epic/task entities). */
      scope?: IdeaScope;
      /**
       * Project-scoped idea ref-or-id this epic/task originates from — only
       * meaningful for taskType='epic'|'task' (ignored on idea creates, mirroring
       * how scope is dropped on epic/task creates rather than rejected).
       */
      originatingIdeaId?: string;
    }
  | {
      type: 'mcp-update-task';
      requestId: string;
      runId: string;
      taskId: string;
      /** Entity-table discriminator (idea|epic|task). Optional — falls back to a 3-table id lookup. */
      entityType?: TaskType;
      title?: string;
      summary?: string;
      /** Full markdown body — the canonical rich detail (idea spec / task description + ACs). */
      body?: string;
      priority?: Priority;
      /**
       * Entity CLASSIFICATION — feature/bug/chore (migration 059). Distinct from
       * the free-text finding-grouping `category` on 'mcp-report-finding'.
       */
      category?: EntityCategory;
      repo?: string;
      parentEpicId?: string;
      expectedVersion?: number;
      /** Idea size hint — only meaningful for idea entities (ignored on epic/task entities). */
      scope?: IdeaScope;
    }
  | {
      type: 'mcp-set-task-stage';
      requestId: string;
      runId: string;
      taskId: string;
      /** Entity-table discriminator (idea|epic|task). Optional — falls back to a 3-table id lookup. */
      entityType?: TaskType;
      stageId: string;
      expectedVersion?: number;
    }
  | {
      type: 'mcp-add-task-dependency';
      requestId: string;
      runId: string;
      /** The BLOCKED task id. */
      taskId: string;
      /** The PREREQUISITE task id that must finish first. */
      dependsOnTaskId: string;
      /** Edge kind; defaults to 'blocking' at the chokepoint. */
      dependencyKind?: TaskDependencyKind;
    }
  | {
      /**
       * WRITE: set one idea component's ledger state via
       * IdeaComponentRouter.applyChange's 'set-component-state' op
       * (source:'flow'). `ideaId` is an opaque idea id OR its display ref
       * (e.g. 'IDEA-009') — resolved the same way as mcp-get-task
       * (selectTaskById-by-id first, then resolveBacklogRef-by-ref), scoped to
       * THIS run's project. `sourceRunId` (this run's id) and
       * `builtAgainstVersion` (the idea's CURRENT `version` at call time) are
       * resolved by handleSetIdeaComponent itself — the calling agent never
       * supplies either.
       */
      type: 'mcp-set-idea-component';
      requestId: string;
      runId: string;
      /** Opaque idea id OR display ref (e.g. 'IDEA-009'). */
      ideaId: string;
      component: IdeaComponentKey;
      state: IdeaComponentStateValue;
    }
  | {
      /**
       * READ-ONLY: list the backlog (ideas/epics/tasks) for THIS run's project.
       * Run-bound (no project argument — derived from CYBOFLOW_RUN_ID). Filters
       * apply after flattening selectProjectBacklog's tree (see handleListTasks).
       */
      type: 'mcp-list-tasks';
      requestId: string;
      runId: string;
      /** Optional filter to one entity type; omitted = all three. */
      taskType?: TaskType;
      /** Include archived items (archived_at set). Defaults to false. */
      includeArchived?: boolean;
      /** Include done/retired items (isDone or decomposed_at set). Defaults to false. */
      includeDone?: boolean;
    }
  | {
      /**
       * READ-ONLY: fetch ONE backlog entity (with its full body) by opaque id OR
       * display ref (e.g. 'TASK-014'). Run-bound project-scoped — see
       * handleGetTask for the id/ref resolution order and the cross-project guard.
       */
      type: 'mcp-get-task';
      requestId: string;
      runId: string;
      /** Opaque backlog id OR display ref (e.g. 'TASK-014', 'IDEA-009'). */
      taskId: string;
    }
  | {
      type: 'mcp-update-sprint-task';
      requestId: string;
      runId: string;
      /** The lane's task id (sprint_batch_tasks.task_id). */
      taskId: string;
      /** New lane status; at least one of status/currentStepId must be set. */
      status?: SprintBatchTaskStatus;
      /**
       * New lane step id; at least one of status/currentStepId must be set.
       * NOT narrowed to SprintLaneStepId — the MCP tool now accepts any non-empty
       * string (cyboflowMcpServer.ts's CallTool check) and this handler validates
       * it against the CALLING RUN's resolved chain-derived vocabulary
       * (resolveRunFanOutInner), falling back to SPRINT_LANE_STEP_IDS. A narrower
       * type here would misrepresent the wire contract this handler enforces.
       */
      currentStepId?: string;
      /** 1-based attempt counter (integer >= 1) — reported when implement is re-delegated after a verify failure. */
      attempt?: number;
    }
  | {
      type: 'mcp-create-sprint-batch';
      requestId: string;
      runId: string;
      /**
       * OPTIONAL human-approved task subset to materialize into the batch (the
       * approve-plan selection). Each id is intersected with the run's
       * created-task projection; ids the run did not create are dropped. When
       * omitted, ALL run-created tasks are materialized.
       */
      taskIds?: string[];
    }
  | {
      type: 'mcp-report-finding';
      requestId: string;
      runId: string;
      title: string;
      body: string;
      /** Only meaningful for findings; stored on the row as given. */
      severity?: ReviewItemSeverity;
      /**
       * Item kind; the MCP tool excludes 'permission' (folded via the approval
       * path) AND 'notification' (orchestrator-minted only — agents cannot file
       * a notification). Defaults to 'finding'.
       */
      kind?: Exclude<ReviewItemKind, 'permission' | 'notification'>;
      /** Whether this item gates run resume; defaults to false (findings are non-blocking). */
      blocking?: boolean;
      /** Soft polymorphic entity link — both must be set together or both omitted. */
      entityType?: ReviewItemEntityType;
      entityId?: string;
      /**
       * Structured finding extras (camelCase wire). Each is `unknown` because the
       * MCP tool passes them through unvalidated; handleReportFinding unknown-guards
       * the shape and DROPS any malformed member rather than failing the write.
       *
       * NOTE: `category` here is the FREE-TEXT review-queue grouping tag (e.g.
       * 'security'/'perf') — NOT the typed EntityCategory classification enum
       * (feature|bug|chore) on the create/update-task messages above.
       */
      category?: unknown;
      locations?: unknown;
      suggestedFix?: unknown;
      proposedTarget?: unknown;
      impact?: unknown;
      /** Per-kind payload JSON; its discriminant must equal `kind`. */
      payloadJson?: string;
    }
  | {
      type: 'mcp-get-selected-findings';
      requestId: string;
      runId: string;
    }
  | {
      /** Read the code-review eval's full verdict + jury reasoning for a run. */
      type: 'mcp-get-eval';
      requestId: string;
      runId: string;
      /**
       * Which run to read. Optional: absent means "this session's runs", which
       * is what a chat turn wants, since its own runId is a `__quick__`
       * sentinel that was never graded.
       */
      targetRunId?: string;
    }
  | {
      /** Read THIS session's still-open findings, with their resolve handles. */
      type: 'mcp-list-run-findings';
      requestId: string;
      runId: string;
    }
  | {
      type: 'mcp-resolve-finding';
      requestId: string;
      runId: string;
      /** The review_items.id of the finding the run consumed. */
      reviewItemId: string;
      /** How the finding was resolved — maps to the matching resolution prefix. */
      resolutionKind: 'fixed' | 'triaged' | 'promoted';
      /** Optional free-text note appended to the resolution (e.g. 'compound'). */
      note?: string;
      /** Optional minted task id; recorded when resolutionKind='promoted'. */
      taskId?: string;
    }
  | {
      /** Create (or idempotently re-derive) a run artifact via the ArtifactRouter
       *  chokepoint. UPSERTS by (run, atype); replies with the artifact id. */
      type: 'mcp-report-artifact';
      requestId: string;
      runId: string;
      atype: ArtifactType;
      label: string;
      payloadJson?: string;
    }
  | {
      /** Commit a run artifact (flip committed). Replies with the artifact id. */
      type: 'mcp-commit-artifact';
      requestId: string;
      runId: string;
      artifactId: string;
      payloadJson?: string;
    }
  | {
      /**
       * Design Mode v0 (design-mode.md) — return the design session's linked
       * idea (ref/title/body/version). No args beyond the run; the idea is
       * resolved from the session's design_idea_id and re-validated every call.
       */
      type: 'mcp-design-get-idea';
      requestId: string;
      runId: string;
    }
  | {
      /**
       * Design Mode v0 — persist the current design-spec draft for the session
       * with a monotonic draft_revision bound to the CURRENT ui-prototype
       * artifact revision. Replies { draftRevision, boundArtifactRevision }.
       */
      type: 'mcp-design-update-draft';
      requestId: string;
      runId: string;
      specMarkdown: string;
    }
  | {
      /**
       * Design Mode v1 (design-mode.md "Design feedback v1 — acknowledged
       * durable outbox") — the agent's acknowledgement of a delivered feedback
       * batch, echoing the batch + attempt ids the revision turn carried plus the
       * prototype revision that addressed it. Routed through FeedbackRouter's
       * one-result CAS: replies { applied: true } for the winner and
       * { applied: false, note } for a duplicate/late ack (never an error).
       */
      type: 'mcp-design-ack-feedback';
      requestId: string;
      runId: string;
      batchId: string;
      attemptId: string;
      prototypeRevision: number;
    }
  | {
      /**
       * FIRE-AND-CONTINUE visual-verification request. Resolves the run's stamped
       * verify posture (migration 055), enqueues a verification_requests row, and
       * replies { requestId } synchronously — the lane NEVER blocks on the verdict.
       * A disabled run replies { skipped:true } (never an error). typeOverride only
       * NARROWS within the run's resolved chain; it cannot enable a disabled run.
       */
      type: 'mcp-request-verification';
      requestId: string;
      runId: string;
      /** Natural-language acceptance the VlmJudge checks (required). */
      intent: string;
      /**
       * PREFERRED dual-format form (redesign §5.2): the composed VerificationTaskV1
       * fence object, UNVALIDATED at the wire (loose — strict validation happens
       * here via parseVerificationTaskV1). When present it is authoritative for the
       * deliverable — the handler derives the legacy `input` FROM the task
       * (deriveLegacyInputFromTask) rather than from `intent`/`url`/`htmlPath`, and
       * both `deliverable_json` AND `task_json` are persisted (dual-write). Absent
       * ⇒ behavior is byte-identical to the pre-redesign legacy path.
       */
      task?: unknown;
      /** Agent-declared verification type. Narrows only — invalid/out-of-chain is dropped. */
      typeOverride?: VerificationType;
      url?: string;
      htmlPath?: string;
      /** Responsive viewport list (camelCase wire); passed through UNVALIDATED — narrowed by the handler. */
      viewports?: unknown;
      baselineKey?: string;
      /**
       * The lane's display ref (e.g. "TASK-008") or opaque task id — verdict→lane
       * attribution for the visual merge-gate (locked decision #2). Carried into
       * deliverable_json so the async verdict can be driven onto the right lane in a
       * multi-lane sprint batch. Optional (single-lane batches attribute by being
       * the only lane; non-sprint runs have no gate).
       */
      taskRef?: string;
      /**
       * §3.6 (docs/proposals/verification-setup-flow.md) — this request is the
       * phase-2 setup flow's PROOF run, not ordinary lane traffic: exempt from the
       * project's lifetime judge budget, drained at lower priority, allowed to
       * execute an UNPROVEN draft (proving it is how a project stops being
       * unproven), and — when it PASSES with a pin — the trigger for the engine's
       * own `markProven` flip. Defaults to false.
       */
      setupProof?: boolean;
      /**
       * §5.2 seam 3 — the caller-supplied PIN: the portable half's content hash
       * and the machine-local record's CAS version, as returned by
       * `mcp-register-verify-runbook`. Only a setup proof supplies these (it pins
       * the DRAFT it is trying to prove); an ordinary request leaves them absent
       * and the handler resolves the project's PROVEN revision instead. Both must
       * be present together — half a pin is not a pin.
       */
      runbookHash?: string;
      runbookLocalVersion?: number;
    }
  | {
      /**
       * BLOCKING (§5.2 seam 2): wait until a previously-enqueued verification
       * request settles and return its verdict inline. `verificationRequestId` is
       * the id `mcp-request-verification` replied with; `requestId` is this
       * message's own wire correlation id (the two are unrelated). Run-bound like
       * every other tool: a request belonging to a DIFFERENT run is rejected.
       */
      type: 'mcp-await-verification';
      requestId: string;
      runId: string;
      /** The verification_requests.id to wait on. */
      verificationRequestId: string;
      /** Wait budget in ms; defaults to 15 min and is clamped to a 20-min ceiling. */
      timeoutMs?: number;
    }
  | {
      /**
       * NON-BLOCKING COLD READ: list THIS run's verification requests and their
       * outcomes. The complement to `mcp-await-verification`, which can only
       * answer for an id the caller is still holding — after a context compaction
       * there is otherwise no way to enumerate what a run has already verified.
       * Run-bound like every other tool on this socket.
       */
      type: 'mcp-get-verifications';
      requestId: string;
      runId: string;
      /** Optional verification_requests.id to narrow to a single row. Still run-scoped. */
      verificationRequestId?: string;
    }
  | {
      /**
       * §5.2 seam 1 — register (or refresh) the MACHINE-LOCAL half of this
       * project's verification runbook from the portable file committed in THIS
       * run's worktree. Replies { hash, version } (the content-addressed portable
       * hash + the record's CAS version) or the store's error verbatim.
       */
      type: 'mcp-register-verify-runbook';
      requestId: string;
      runId: string;
      /** One of the three declarable modalities; validated server-side. */
      modality: string;
      /** Host-stable resolved lever bindings (binary paths, data-dir lever name, ABI facts). */
      bindingsJson?: string;
    }
  | {
      /**
       * FIRE-AND-CONTINUE ad-hoc code-review eval request (cyboflow_run_eval).
       * No parameters beyond the transport envelope: the run is the CALLER's own
       * run (CYBOFLOW_RUN_ID) and the graded artifact is its current working-tree
       * diff. Replies { status, rubricVersion } synchronously; the 3-slot jury
       * grades asynchronously and posts its verdict to the review queue.
       */
      type: 'mcp-run-eval';
      requestId: string;
      runId: string;
    }
  // -------------------------------------------------------------------------
  // Workflow + variant configuration writes (cyboflow_*_workflow / _variant).
  //
  // These reach the WorkflowRegistry through the injected `workflowConfig` dep
  // (McpQueryHandlerDeps) rather than a direct import — the ORCHESTRATOR
  // LAYERING RULE forbids main/src/services imports, and the deps-injection
  // pattern (mirroring onInteractiveTurnEnd + the experiments router) keeps the
  // handler decoupled + unit-testable. When the dep is absent every handler
  // returns 'workflow_config_unavailable' (documented no-op fallback).
  //
  // Scope note: workflows are GLOBAL (a built-in edit touches the single
  // `wf-global-<name>` row shared across every project) — unlike task writes,
  // which are project-scoped. Only mcp-list-workflows needs the run's projectId
  // (for the built-in reconcile + union); the id-keyed writes operate on global
  // handles. All still reject the 'orchestrator' sentinel / terminal runs via
  // resolveTaskRunContext for parity with the task writes.
  // -------------------------------------------------------------------------
  | {
      /** READ-ONLY: list this run's project workflows (built-ins reconciled). */
      type: 'mcp-list-workflows';
      requestId: string;
      runId: string;
    }
  | {
      /** READ-ONLY: one workflow's resolved definition + meta + baseline rotation. */
      type: 'mcp-get-workflow';
      requestId: string;
      runId: string;
      workflowId: string;
    }
  | {
      /** Persist an edited definition onto the workflow's spec_json ("Save").
       *  `definitionJson` is a JSON-encoded WorkflowDefinition, re-validated by
       *  workflowDefinitionSchema in the handler (parity with the tRPC input). */
      type: 'mcp-update-workflow';
      requestId: string;
      runId: string;
      workflowId: string;
      definitionJson: string;
    }
  | {
      /** Reset a BUILT-IN workflow's spec to its static default. */
      type: 'mcp-reset-workflow';
      requestId: string;
      runId: string;
      workflowId: string;
    }
  | {
      /** Create a new custom workflow. `scope` chooses global (product default)
       *  vs a project-scoped copy; `definitionJson` (optional) is a JSON-encoded
       *  WorkflowDefinition validated in the handler. */
      type: 'mcp-create-workflow';
      requestId: string;
      runId: string;
      name: string;
      definitionJson?: string;
      permissionMode?: PermissionMode;
      scope?: 'global' | 'project';
    }
  | {
      /** Delete a workflow (refused for reserved built-ins / flows with runs). */
      type: 'mcp-delete-workflow';
      requestId: string;
      runId: string;
      workflowId: string;
    }
  | {
      /** READ-ONLY: a workflow's variants (newest-first). */
      type: 'mcp-list-variants';
      requestId: string;
      runId: string;
      workflowId: string;
    }
  | {
      /** Create a variant snapshotting the workflow's resolved definition at
       *  `tuningLevel` (migration 126 — the level the variant challenges;
       *  omitted = the workflow's saved stamp) — or, when `definitionJson` is
       *  supplied (a JSON-encoded WorkflowDefinition, validated in the handler
       *  like update_workflow), that edited graph instead. Status stays 'draft'
       *  either way. */
      type: 'mcp-create-variant';
      requestId: string;
      runId: string;
      workflowId: string;
      label: string;
      tuningLevel?: TuningLevel;
      definitionJson?: string;
    }
  | {
      /** Patch a variant in place. `definitionJson` (JSON-encoded
       *  WorkflowDefinition) is validated in the handler; `agentOverridesJson`
       *  (JSON string or null) is stored verbatim; the rest map 1:1 to the
       *  registry patch. Every field optional. */
      type: 'mcp-update-variant';
      requestId: string;
      runId: string;
      variantId: string;
      definitionJson?: string;
      agentOverridesJson?: string | null;
      model?: string | null;
      executionModel?: 'orchestrated' | 'programmatic' | null;
      weight?: number;
      label?: string;
    }
  | {
      /** Transition a variant's rotation status. */
      type: 'mcp-set-variant-status';
      requestId: string;
      runId: string;
      variantId: string;
      status: WorkflowVariantStatus;
    }
  | {
      /** Delete a variant (refused when workflow_runs reference it). */
      type: 'mcp-delete-variant';
      requestId: string;
      runId: string;
      variantId: string;
    }
  | {
      /** Opt the workflow's live baseline into/out of rotation + set its weight. */
      type: 'mcp-set-baseline-rotation';
      requestId: string;
      runId: string;
      workflowId: string;
      inRotation?: boolean;
      weight?: number;
    }
  // -------------------------------------------------------------------------
  // Global-agent tool family (S0.4). runId carries the 'agent:<threadId>'
  // sentinel (see resolveGlobalAgentContext), NEVER a workflow_runs row — a
  // run-scoped runId is rejected by every handler below. Every read is
  // cross-project (no CYBOFLOW_RUN_ID project binding, unlike the run-scoped
  // tools above); mcp-propose-action is the ONLY write, and it only ever
  // inserts a proposal row — it never reaches TaskChangeRouter /
  // ReviewItemRouter / WorkflowRegistry directly.
  // -------------------------------------------------------------------------
  | {
      /** READ-ONLY, cross-project: sessions + runs digest + blocked-gate/question counts per project. */
      type: 'mcp-overview';
      requestId: string;
      runId: string;
    }
  | {
      /** READ-ONLY, cross-project backlog listing. Omitted projectId = every project merged. */
      type: 'mcp-backlog';
      requestId: string;
      runId: string;
      projectId?: number;
      taskType?: TaskType;
      includeArchived?: boolean;
      includeDone?: boolean;
    }
  | {
      /**
       * READ-ONLY: one entity's full body by opaque id or display ref. A ref
       * (e.g. 'TASK-014') is unique only WITHIN a project — pass projectId to
       * disambiguate; omitted, the first cross-project match wins.
       */
      type: 'mcp-entity';
      requestId: string;
      runId: string;
      taskId: string;
      projectId?: number;
    }
  | {
      /** READ-ONLY, cross-project review_items inbox. Defaults to pending items only. */
      type: 'mcp-queue';
      requestId: string;
      runId: string;
      projectId?: number;
      includeResolved?: boolean;
    }
  | {
      /** READ-ONLY, cross-project workflow listing. Omitted projectId = every workflow row. */
      type: 'mcp-workflows';
      requestId: string;
      runId: string;
      projectId?: number;
    }
  | {
      /** READ-ONLY: one workflow's effective definition + a server-computed spec_hash (propose-action CAS material). */
      type: 'mcp-workflow';
      requestId: string;
      runId: string;
      workflowId: string;
    }
  | {
      /**
       * THE ONLY write-shaped global-agent tool. payloadJson is a JSON-encoded
       * AgentProposalPayload (shared/types/agentThread.ts) — validated + narrowed
       * server-side by kind; preconditions (spec hash / task versions) are ALWAYS
       * captured server-side, never trusted from the caller. Inserts an
       * agent_proposals row via AgentThreadDbStore and appends a
       * 'proposal-created' transcript marker event. NEVER executes anything —
       * confirmation is a separate human-gated flow (proposalExecutor, S0.5).
       */
      type: 'mcp-propose-action';
      requestId: string;
      runId: string;
      payloadJson: string;
    }
  | {
      /**
       * READ-ONLY, cross-project ad-hoc SQL diagnostic query. Executed on a
       * DEDICATED readonly better-sqlite3 connection (opened `{ readonly:
       * true }` against the same on-disk file the orchestrator db already
       * points at) — read-only is enforced BY CONSTRUCTION, not merely by the
       * statement-shape validation the handler also applies as
       * defense-in-depth. A single SELECT/WITH/EXPLAIN statement only;
       * results capped at 200 rows / ~100KB serialized.
       */
      type: 'mcp-db-query';
      requestId: string;
      runId: string;
      sql: string;
    }
  | {
      /**
       * READ-ONLY, FOLDER-SCOPED file read. Scoped to the registered project
       * folders + user-configured extras (assistantFolderAccess); the target is
       * canonicalized with realpathSync and required to sit inside one of those
       * roots (symlink escapes are defeated by resolving first). Secret files
       * (.env / private keys / credential stores) are refused even in-scope;
       * binary files (NUL in the first 8KB) are refused; content is capped at
       * FS_READ_MAX_BYTES with optional 1-based offsetLine/limitLines paging.
       */
      type: 'mcp-fs-read';
      requestId: string;
      runId: string;
      path: string;
      /** 1-based line to start from (with limitLines) for large-file paging. */
      offsetLine?: number;
      limitLines?: number;
    }
  | {
      /**
       * READ-ONLY, FOLDER-SCOPED directory listing. Same scope guard as
       * mcp-fs-read. Unlike read/grep, listing is NOT secret-filtered — a
       * secret file's NAME is metadata, so it still appears in the entries (its
       * content is unreachable via read/grep). Capped at FS_LIST_MAX_ENTRIES.
       */
      type: 'mcp-fs-list';
      requestId: string;
      runId: string;
      path: string;
    }
  | {
      /**
       * READ-ONLY, FOLDER-SCOPED recursive regex grep. Same scope guard. The
       * walk never follows symlinks and skips GREP_SKIP_DIRS (.git/node_modules/
       * dist/build/.venv/__pycache__); secret + binary files are skipped;
       * optional basename `glob` (e.g. *.ts) narrows the file set. Caps:
       * FS_GREP_MAX_RESULTS matches, FS_GREP_MAX_FILES scanned, per-line text
       * truncated to FS_GREP_MAX_LINE_LEN. Invalid regex → 'invalid_regex'.
       */
      type: 'mcp-fs-grep';
      requestId: string;
      runId: string;
      pattern: string;
      path: string;
      glob?: string;
      /** Case-insensitive by default; set true for a case-sensitive match. */
      caseSensitive?: boolean;
      /** Clamped to [1, FS_GREP_MAX_RESULTS]. */
      maxResults?: number;
    }
  | {
      /**
       * READ-ONLY search/paging over the CALLING assistant thread's own durable
       * transcript (`agent_thread_events`) — the assistant's LONG-TERM MEMORY.
       * Its live SDK context is reset daily, but every turn it ever exchanged
       * with the user persists in that table forever, and this is the only way
       * back to it.
       *
       * THREAD-SCOPED, always: the thread comes from
       * resolveGlobalAgentContext(runId), never from a caller argument, so one
       * assistant thread can never read another's transcript.
       *
       * `query` is a case-insensitive PLAIN-TEXT substring — deliberately NOT a
       * regex, unlike mcp-fs-grep: the pattern is model-authored and this
       * handler runs synchronously on the Electron main thread, so a
       * backtracking blowup in a caller regex would wedge the whole app
       * (measured: one pathological 15-char pattern froze it for ~110s against
       * a 61-char turn). indexOf is O(n) unconditionally. Omitted, the tool
       * BROWSES newest-first instead. `beforeId` is the id-descending paging
       * cursor (`id < beforeId`) returned as nextBeforeId. Rows are paged in
       * batches — the table is never loaded whole — under a hard scan cap, a
       * limit clamped to [1, HISTORY_MAX_LIMIT], and a ~100KB
       * serialized-payload ceiling.
       */
      type: 'mcp-history';
      requestId: string;
      runId: string;
      /** Case-insensitive plain-text substring; omitted/empty = browse mode (no filtering). */
      query?: string;
      /** Narrow to one side of the conversation. */
      role?: 'user' | 'assistant';
      /** Only turns newer than N days ago (bound into datetime('now', ?)). */
      daysBack?: number;
      /** Id-descending cursor: return only turns with id < beforeId. */
      beforeId?: number;
      /** Matches to return; clamped to [1, HISTORY_MAX_LIMIT], default HISTORY_DEFAULT_LIMIT. */
      limit?: number;
    }
  | {
      type: 'shell-approval-request';
      requestId: string;
      runId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      /**
       * Which substrate is asking. The interactive-Claude hook omits it; the OMP
       * gate extension stamps 'omp'. Read ONLY by the socket-died disposition —
       * see {@link McpQueryHandler.registerInFlightShellApproval}.
       */
      substrate?: 'omp';
    }
  | {
      /**
       * Deterministic turn-end signal from the INTERACTIVE substrate's Stop
       * hook (stopShellHook.ts, IDEA-030 turn-end-detection fix). Fire-and-ack
       * — unlike shell-approval-request, this ALWAYS writeResponses
       * synchronously; there is no verdict to defer.
       */
      type: 'interactive-turn-end';
      requestId: string;
      runId: string;
    }
  | {
      /**
       * "Parked on an AskUserQuestion gate" signal from the INTERACTIVE
       * substrate's PreToolUse(AskUserQuestion) notify hook (questionShellHook.ts).
       * Fire-and-ack — like interactive-turn-end, ALWAYS writeResponses
       * synchronously; there is no verdict to defer (the hook never gates the
       * question). Flips the run's quick-session board state to `blocked`.
       */
      type: 'interactive-question-open';
      requestId: string;
      runId: string;
    };

export interface McpQueryResponse {
  type: 'mcp-query-response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Callback deps this handler needs from main/src/services — ORCHESTRATOR
 * LAYERING RULE: mcpQueryHandler must NOT import from main/src/services, so
 * every such dependency is injected as a plain function rather than a
 * concrete class import. All members optional: a caller (test or a stripped-
 * down OrchSocketServer) that omits a dep gets the handler's documented
 * "unavailable" fallback for that message type, never a crash.
 */
export interface McpQueryHandlerDeps {
  /**
   * Deliver a Stop-hook turn-end notification (IDEA-030) to the live
   * InteractiveClaudeManager. Returns true if a tracked interactive run for
   * `runId` was found and notified, false otherwise. Wired in main/src/index.ts
   * to `interactiveCliManager.notifyTurnEnd`.
   */
  onInteractiveTurnEnd?: (runId: string) => boolean;

  /**
   * Deliver a "parked on an AskUserQuestion gate" notification from the
   * interactive PreToolUse(AskUserQuestion) notify hook (questionShellHook.ts) to
   * the live InteractiveClaudeManager. Wired in main/src/index.ts to
   * `interactiveCliManager.notifyQuestionOpen`. Absent → the PTY session simply
   * won't show `blocked` on the quick-session board (best-effort).
   */
  onInteractiveQuestionOpen?: (runId: string) => void;

  /**
   * WorkflowRegistry surface for the workflow/variant configuration tools
   * (cyboflow_*_workflow / _variant). Injected as a narrow STRUCTURAL type
   * (never the concrete WorkflowRegistry class) in main/src/index.ts so this
   * handler stays decoupled + unit-testable. Absent → every config tool returns
   * 'workflow_config_unavailable'. Method contracts mirror the workflows /
   * variants tRPC routers exactly; distinguishable Error messages ('not found' /
   * 'reserved' / 'run history' / 'already exists' / 'unresolvable') are mapped to
   * ok:false error codes by writeWorkflowConfigError.
   */
  workflowConfig?: WorkflowConfigLike;

  /**
   * Persistence for the global-agent chat thread (agent_threads /
   * agent_thread_events / agent_proposals — migration 071). Concrete class
   * import (NOT a structural WorkflowConfigLike-style interface): unlike
   * workflowConfig, AgentThreadDbStore lives under main/src/orchestrator/
   * agentThread/ — orchestrator layer, not main/src/services — so the
   * ORCHESTRATOR LAYERING RULE does not require an injected structural
   * surface here. Injected via the deps bag anyway (mirroring the
   * workflowConfig precedent) purely for test ergonomics: a test can hand in
   * a store built against an in-memory fixture DB without constructing the
   * whole McpQueryHandler's `db`. Absent → cyboflow_propose_action returns
   * 'agent_thread_store_unavailable'; every other handler is unaffected.
   */
  agentThreadStore?: AgentThreadDbStore;

  /**
   * Extra absolute folder paths the global-agent filesystem tools
   * (cyboflow_fs_read / _list / _grep) may read, BEYOND the always-included
   * registered project paths. Wired in main/src/index.ts to
   * `configManager.getAssistantFolderAccess()`. Absent (or returning []) ⇒ only
   * project folders are readable — keeps existing tests compiling without
   * declaring the dep. Never trusted as canonical: the handler realpathSync's
   * every entry and drops any that don't exist.
   */
  getAssistantFolderAccess?: () => string[];

  /**
   * Registered project folders the user has EXCLUDED from the fs tools (each an
   * exact `projects.path`). Subtracted from the always-included project roots in
   * resolveFsAllowedRoots, so a toggled-off project becomes unreadable. Wired in
   * main/src/index.ts to `configManager.getAssistantExcludedProjectPaths()`.
   * Absent (or returning []) ⇒ every project folder stays readable (the
   * default). Only affects PROJECT roots — configured extras are never excluded.
   */
  getAssistantExcludedProjectPaths?: () => string[];

  /**
   * Request an AD-HOC code-review eval of a run's current diff (the
   * `cyboflow_run_eval` tool). Wired in main/src/index.ts to
   * `EvalWorker.getInstance().runAdHoc` — a CALLBACK rather than the worker
   * itself because EvalWorker's boot wiring reaches main/src/services
   * (GitDiffManager, ConfigManager, ReviewItemRouter) and the ORCHESTRATOR
   * LAYERING RULE forbids importing those from here. The result TYPE is imported
   * (type-only, from the orchestrator-layer eval module) purely so the mapping
   * below is exhaustively checked.
   *
   * FIRE-AND-CONTINUE: the callback resolves as soon as the snapshot lands and
   * the jury is enqueued — never after the verdict. Absent ⇒ 'eval_unavailable'
   * (the documented degrade pattern shared with workflowConfig / agentThreadStore).
   */
  runAdHocEval?: (runId: string) => Promise<AdHocSnapshotResult>;

  /**
   * The MACHINE-LOCAL verification-runbook store (§5.2 seam 1), backing
   * `cyboflow_register_verify_runbook`. Concrete class rather than a structural
   * surface, for the same reason as `agentThreadStore` above: VerifyRunbookStore
   * lives under main/src/orchestrator/verify/ — orchestrator layer, not
   * main/src/services — so the ORCHESTRATOR LAYERING RULE does not demand an
   * injected interface, and the deps bag is used purely so a test can hand in a
   * store built over its own fixture DB.
   *
   * It MUST be the same instance the VerificationScheduler was initialized with
   * (main/src/index.ts wires one `verifyRunbookStore` into both): the setup flow
   * registers a draft through this tool and the ENGINE proves that exact record
   * on a passing setup-proof run, so two stores over the same table would still
   * work but two stores over different DBs would silently never agree.
   *
   * Absent ⇒ the register tool returns 'runbook_store_unavailable'; nothing else
   * is affected.
   */
  verifyRunbookStore?: VerifyRunbookStore;

  /**
   * The GLOBAL visual-verification config (the master switch + default type),
   * read LIVE — the same `configManager.getVisualVerifyConfig()` the
   * WorkflowRegistry injects into `createRun`.
   *
   * Needed because a `__quick__` chat sentinel's verify posture cannot come from
   * its run stamp. The sentinel is minted ONCE on the session's first chat turn
   * and reused for the session's whole life, and `verify_chain` has no UPDATE
   * path by design (visualVerificationResolver.ts:5-7) — so a session that
   * existed before the master switch was turned on would be stamped disabled
   * forever. Quick runs therefore resolve posture at CALL time through this dep;
   * every other run keeps reading its frozen stamp, untouched.
   *
   * Absent ⇒ the quick branch falls back to the frozen stamp (i.e. the
   * pre-existing behavior), so the dozens of fixtures that build a deps bag
   * without it keep passing unchanged.
   */
  getVisualVerifyConfig?(): ResolvedVisualVerifyConfig;

  /**
   * The user's per-substrate sprint task-cap override
   * (ConfigManager.getSprintMaxTasks), already clamped — read LIVE for the same
   * reason getVisualVerifyConfig is: the cap is a Settings value, not something
   * frozen onto the run at launch, so `cyboflow_create_sprint_batch` must honor
   * what the setting says NOW rather than what it said when the run started.
   *
   * Absent ⇒ resolveSprintMaxTasks falls back to the built-in per-substrate
   * defaults (the pre-setting behavior), so every fixture that builds a deps bag
   * without it keeps passing unchanged.
   */
  getSprintMaxTasks?(): SprintMaxTasksOverrides;
}

/**
 * Narrow structural surface over WorkflowRegistry — exactly the methods the
 * workflow/variant MCP tools call. Kept in lockstep with the registry by the
 * wiring in main/src/index.ts (which forwards the real methods). Every method
 * may throw a distinguishable Error the handler maps to an ok:false code.
 */
export interface WorkflowConfigLike {
  getById(workflowId: string): WorkflowRow | null;
  /**
   * `includeArchived` (migration 078) is optional and defaults to `true` at
   * the registry — every existing caller here omits it, so behavior is
   * unchanged (archived rows still surface over MCP for now).
   */
  listByProject(projectId: number, includeArchived?: boolean): WorkflowRow[];
  /** Reconcile the in-repo built-ins as global rows (mirrors the tRPC list). */
  ensureGlobalBuiltIns(): void;
  getBaselineRotation(workflowId: string): { inRotation: boolean; weight: number } | null;
  /**
   * The workflow's EFFECTIVE definition (migration 122): the tuning level's
   * materialized graph, or the custom slot at level `'custom'`.
   */
  getEffectiveDefinition(workflowId: string): WorkflowDefinition | null;
  /** Writes the custom slot AND stamps `tuning_level = 'custom'` atomically. */
  updateSpec(workflowId: string, definition: WorkflowDefinition): void;
  /** Clears the custom slot AND flips a `'custom'` level back to `'standard'`. */
  resetSpec(workflowId: string): void;
  createCustom(params: {
    projectId: number | null;
    name: string;
    specJson?: string;
    permissionMode?: PermissionMode;
  }): WorkflowRow;
  deleteWorkflow(workflowId: string): void;
  listVariants(workflowId: string, opts?: { includeArchived?: boolean }): WorkflowVariantRow[];
  createVariantFromCurrent(
    workflowId: string,
    label: string,
    opts?: { definition?: WorkflowDefinition; tuningLevel?: TuningLevel },
  ): WorkflowVariantRow;
  updateVariant(
    variantId: string,
    patch: {
      specJson?: string;
      agentOverridesJson?: string | null;
      model?: string | null;
      executionModel?: 'orchestrated' | 'programmatic' | null;
      weight?: number;
      label?: string;
    },
  ): void;
  setVariantStatus(variantId: string, status: WorkflowVariantStatus): void;
  deleteVariant(variantId: string): void;
  setBaselineRotation(workflowId: string, patch: { inRotation?: boolean; weight?: number }): void;
}
