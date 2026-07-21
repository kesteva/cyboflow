/**
 * McpQueryHandler — orchestrator-side handler for MCP query messages arriving
 * over the Cyboflow Unix IPC socket.
 *
 * Handles these message types dispatched by the cyboflowMcpServer subprocess:
 *   - mcp-list-pending-approvals  (SELECT from approvals)
 *   - mcp-get-run                 (SELECT from workflow_runs)
 *   - mcp-submit-checkpoint       (INSERT into raw_events with event_type='cyboflow_checkpoint')
 *   - mcp-report-step             (observational workflow-step transition)
 *   - mcp-create-task / -update-task / -set-task-stage (entity-aware task writes
 *                                  via the TaskChangeRouter chokepoint)
 *   - mcp-report-finding          (NON-BLOCKING review-item create via the
 *                                  ReviewItemRouter chokepoint; replies ok:true
 *                                  immediately and never pauses the run)
 *   - mcp-get-task                (READ-ONLY; an idea's `attachments` — migration
 *                                  028 image metadata — is threaded onto the
 *                                  response, RESOLVED to an absolute on-disk path
 *                                  via the same containment guard as
 *                                  ideas:load-attachments, IDEA-006. Epics/tasks
 *                                  get no `attachments` key at all.)
 *
 * Plus the INTERACTIVE-substrate PreToolUse gate (IDEA-013 S5 / TASK-810):
 *   - shell-approval-request      (ASYNC-DEFERRED — the first handler that does
 *                                  NOT respond synchronously; it holds the socket
 *                                  open across the human-decision window and
 *                                  writes the verdict via ApprovalRouter's
 *                                  socketReply closure, possibly minutes later).
 *
 * Plus the INTERACTIVE-substrate Stop turn-end signal (IDEA-030):
 *   - interactive-turn-end        (fire-and-ack — replies synchronously and
 *                                  invokes the injected `onInteractiveTurnEnd`
 *                                  dep, which routes to
 *                                  InteractiveClaudeManager.notifyTurnEnd via
 *                                  main/src/index.ts wiring; this file may NOT
 *                                  import main/src/services directly).
 *
 * Unknown message types produce a structured error response — they never throw,
 * so a malformed subprocess message cannot crash the orchestrator socket.
 *
 * IMPORTANT: This handler is purely additive. The existing permission-request /
 * permission-response flow (owned by ApprovalRouter) is untouched. Checkpoint
 * writes do NOT transition workflow_runs.status; they are observational markers
 * only.
 *
 * Column names are verified against migration 006_cyboflow_schema.sql:
 *   approvals  — id, run_id, tool_name, tool_input_json, tool_use_id,
 *                status, created_at
 *   workflow_runs — all columns selected via *
 *   raw_events — id (AUTOINCREMENT), run_id, event_type, payload_json, created_at
 *
 * Quick-session invariant (IDEA-024 / TASK-743):
 *   This handler reads from `approvals` and `workflow_runs` only — it does NOT
 *   JOIN or SELECT from `sessions`.  Therefore it is already NULL-tolerant with
 *   respect to the TASK-743 nullable sessions.run_id column: quick sessions
 *   (sessions with run_id IS NULL) have no corresponding workflow_runs row, so
 *   any mcp-get-run request for a quick-session id will take the existing
 *   'not_found' branch and return ok:false — the intended behaviour.  No logic
 *   changes are required here for quick-session support.
 */
import * as net from 'net';
import * as path from 'path';
import { existsSync, lstatSync, statSync, realpathSync } from 'fs';
// Only cyboflow_db_query's readonly sibling connection needs a real
// better-sqlite3 handle — every other query in this file goes through the
// injected DatabaseLike `this.db`. This file carries no standalone-typecheck
// invariant (unlike orchSocketServer.ts, which must stay import-clean of
// 'better-sqlite3'/'electron' so runLauncher.ts's structural boundary holds).
import BetterSqlite3Database from 'better-sqlite3';
import type { DatabaseLike, LoggerLike } from '../types';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import { resolveWorkflowDefinition, isPermissionMode, isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import { resolveRunFrozenSpec } from '../runFrozenSpec';
import type { PermissionMode, WorkflowDefinition, WorkflowRow } from '../../../../shared/types/workflows';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';
import { buildStepTransitionEvent } from '../stepTransitionBridge';
import { handleEntityWrite } from '../autoMintArtifacts';
import { listRunDecomposedIdeaIds, listRunCreatedTaskIds } from '../runEntityOwnership';
import { ApprovalRouter, RunNotRunningError } from '../approvalRouter';
import type { ApprovalDecision } from '../../../../shared/types/approval';
import { isToolAllowed, loadMergedPermissionRules } from '../permissionRules';
import { isAcceptEditsAutoApprovable } from '../permissionModeMapper';
import { TaskChangeRouter, TaskChangeError } from '../taskChangeRouter';
import type { TaskChange, TaskActor, TaskDependencyKind } from '../taskChangeRouter';
import { ReviewItemRouter, ReviewItemError } from '../reviewItemRouter';
import type { ReviewActor, ReviewItemCreate, ReviewItemTriage, ReviewItemDbRow } from '../reviewItemRouter';
import { selectFindingForSeed } from '../reviewItemListing';
import { selectProjectBacklog, selectTaskById, resolveBacklogRef, selectIdeaAttachments } from '../taskListing';
import { ArtifactRouter, ArtifactError } from '../artifactRouter';
import type { ArtifactActor } from '../artifactRouter';
import type { ArtifactType } from '../../../../shared/types/artifacts';
import { PROTOTYPE_HTML_RELPATH, MAX_PROTOTYPE_HTML_BYTES } from '../../../../shared/types/artifacts';
import { QUICK_WORKFLOW_NAME, LEGACY_DROPPED_WORKFLOW_NAMES } from '../workflowRegistry';
import { AgentThreadDbStore } from '../agentThread/agentThreadDbStore';
import { computeSpecHash } from '../agentThread/specHash';
import {
  AGENT_PROPOSAL_KINDS,
  AGENT_THREAD_SPAWN_PREFIX,
  isAgentThreadSpawnId,
  type AgentNavigationTarget,
  type AgentProposalKind,
  type AgentProposalPayload,
  type AgentProposalPreconditions,
  type EditWorkflowProposalPayload,
  type LaunchRunProposalPayload,
  type OpenSessionProposalPayload,
  type ReprioritizeBacklogItem,
  type ReprioritizeBacklogProposalPayload,
} from '../../../../shared/types/agentThread';
import { VerificationScheduler } from '../verify/verificationScheduler';
import {
  FALLBACK_CHAINS,
  isVerificationType,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationType,
  VerificationRequestInput,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import { SprintLaneStore, SprintLaneError } from '../sprintLaneStore';
import { SPRINT_BATCH_MAX_TASKS, AWAITING_VERIFY_STEP } from '../../../../shared/types/sprintBatch';
import type { SprintBatchTaskStatus } from '../../../../shared/types/sprintBatch';
import { resolveRunFanOutInner } from '../laneChainResolution';
import { isCliSubstrate, type CliSubstrate } from '../../../../shared/types/substrate';
import { runStatusEvents } from '../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../shared/types/cyboflow';
import type { BacklogTaskItem, EntityCategory, IdeaAttachment, IdeaScope, Priority, TaskType } from '../../../../shared/types/tasks';
import type { ExperimentArm, WorkflowVariantRow, WorkflowVariantStatus } from '../../../../shared/types/experiments';
import type { QuestionPayload } from '../../../../shared/types/questions';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { QuestionRouter } from '../questionRouter';
import type {
  FindingPayload,
  FindingProposedTarget,
  ReviewItemEntityType,
  ReviewItemKind,
  ReviewItemPayload,
  ReviewItemSeverity,
} from '../../../../shared/types/reviews';
import {
  RESOLUTION_PREFIX_FIXED,
  RESOLUTION_PREFIX_TRIAGED,
  RESOLUTION_PREFIX_PROMOTED,
} from '../../../../shared/types/reviews';

/**
 * The workflow step id whose Approve answer flips a plan-gated run's drafted
 * epics/tasks visible + sprint-eligible (stamping plan_approved_at). Mirrors the
 * same-named constant in questionRouter.ts — duplicated as a bare literal to keep
 * this module free of a questionRouter import for one string. Used by the
 * approve-plan silent-pass guard in handleReportStep.
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
      /** Entity category — feature/bug/chore (migration 059). */
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
      /** Entity category — feature/bug/chore (migration 059). */
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
      /** Create a variant snapshotting the workflow's current resolved definition. */
      type: 'mcp-create-variant';
      requestId: string;
      runId: string;
      workflowId: string;
      label: string;
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
      type: 'shell-approval-request';
      requestId: string;
      runId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
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
 * Parse the global-agent sentinel form 'agent:<threadId>' out of a
 * CYBOFLOW_RUN_ID. Accepts ONLY this exact shape — a bare workflow_runs id (or
 * the 'orchestrator' health-check sentinel) is rejected. The reverse also
 * holds with NO code change required on the run-scoped side:
 * resolveTaskRunContext / resolveReviewItemRunContext do a strict
 * `SELECT ... FROM workflow_runs WHERE id = ?` lookup, and an
 * 'agent:<threadId>' string never matches a real run row, so those resolvers
 * fall through to their existing 'run_not_found' branch — see
 * mcpQueryHandler.test.ts for the two-way coverage.
 *
 * A free function (not a class method): it touches no DB/state, so every
 * global-agent handler below calls it directly and every unit test can call
 * it directly too.
 */
export function resolveGlobalAgentContext(
  runId: string,
): { ok: true; threadId: string } | { ok: false; error: string } {
  if (!isAgentThreadSpawnId(runId)) {
    return { ok: false, error: 'not_a_global_agent_run' };
  }
  return { ok: true, threadId: runId.slice(AGENT_THREAD_SPAWN_PREFIX.length) };
}

// ---------------------------------------------------------------------------
// cyboflow_db_query statement-shape validation (S0.4 global-agent) — pure,
// throws nothing. This is DEFENSE-IN-DEPTH: the primary read-only guarantee
// comes from executing on a dedicated `{ readonly: true }` better-sqlite3
// connection (see getGlobalAgentReadonlyDb below), which SQLite itself
// refuses to write through regardless of what slips past this validator.
// ---------------------------------------------------------------------------

const DB_QUERY_MAX_ROWS = 200;
const DB_QUERY_MAX_PAYLOAD_BYTES = 100_000;
const DB_QUERY_MAX_STRING_LEN = 2000;

const READER_KEYWORD_RE = /^(SELECT|WITH|EXPLAIN)\b/i;
const FORBIDDEN_KEYWORD_RE = /\b(ATTACH|PRAGMA)\b/i;

/** Strips leading whitespace and leading `--`/`/* *\/` comments (repeatedly,
 * since a query may open with several comment lines before the keyword). */
function stripLeadingSqlComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

/**
 * True when non-whitespace, non-comment SQL content follows the first
 * top-level `;` — i.e. more than one statement was submitted. Skips over
 * single-quoted string literals (SQL's `''` escape) and comments while
 * scanning so a `;` inside a string literal doesn't false-positive.
 */
function hasTrailingStatement(sql: string): boolean {
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") { inString = true; i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      return stripLeadingSqlComments(sql.slice(i + 1)).length > 0;
    }
    i += 1;
  }
  return false;
}

type DbQueryValidation =
  | { ok: true; sql: string }
  | { ok: false; reason: 'empty_sql' | 'not_a_select' | 'multiple_statements' | 'forbidden_keyword' };

function validateReadonlySql(rawSql: unknown): DbQueryValidation {
  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  const stripped = stripLeadingSqlComments(rawSql);
  if (stripped.length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  if (!READER_KEYWORD_RE.test(stripped)) {
    return { ok: false, reason: 'not_a_select' };
  }
  // Scanned over the WHOLE raw string (not just the stripped head) — ATTACH /
  // PRAGMA are rejected wherever they appear, including mid-statement.
  if (FORBIDDEN_KEYWORD_RE.test(rawSql)) {
    return { ok: false, reason: 'forbidden_keyword' };
  }
  if (hasTrailingStatement(rawSql)) {
    return { ok: false, reason: 'multiple_statements' };
  }
  return { ok: true, sql: rawSql };
}

/** Row-value sanitization shared by the cyboflow_db_query result path. */
function sanitizeDbQueryValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > DB_QUERY_MAX_STRING_LEN
      ? `${value.slice(0, DB_QUERY_MAX_STRING_LEN)}…[truncated]`
      : value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<blob ${value.length} bytes>`;
  }
  return value;
}

function sanitizeDbQueryRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeDbQueryValue(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// cyboflow_propose_action payload validation (S0.4) — narrows an unknown JSON
// value into an AgentProposalPayload, dispatching on `kind`. Every branch
// extracts each field to a local const BEFORE narrowing it so TypeScript's
// control-flow analysis reliably narrows a `Record<string, unknown>` property
// access (narrowing a bare `raw.foo` expression across a guard is fragile;
// binding it to a local first is not). Returns null (never throws) on any
// malformed shape or unrecognized kind — the caller responds ok:false
// 'invalid_payload' rather than propagate a parse exception.
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isAgentPriority(v: unknown): v is Priority {
  return v === 'P0' || v === 'P1' || v === 'P2';
}

function parseAgentNavigationTarget(raw: unknown): AgentNavigationTarget | null {
  if (!isRecord(raw)) return null;
  const target = raw.target;
  if (target === 'run') {
    const runId = raw.runId;
    if (typeof runId !== 'string' || runId.length === 0) return null;
    return { target: 'run', runId };
  }
  if (target === 'quick-session') {
    const sessionId = raw.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const navRunId = raw.runId;
    if (navRunId !== undefined && (typeof navRunId !== 'string' || navRunId.length === 0)) return null;
    return navRunId !== undefined
      ? { target: 'quick-session', sessionId, runId: navRunId }
      : { target: 'quick-session', sessionId };
  }
  return null;
}

function parseAgentProposalPayload(raw: unknown): AgentProposalPayload | null {
  if (!isRecord(raw)) return null;
  const kindRaw = raw.kind;
  if (typeof kindRaw !== 'string' || !(AGENT_PROPOSAL_KINDS as readonly string[]).includes(kindRaw)) {
    return null;
  }
  const kind = kindRaw as AgentProposalKind;

  switch (kind) {
    case 'launch-run': {
      const projectId = raw.projectId;
      const workflowName = raw.workflowName;
      if (typeof projectId !== 'number') return null;
      if (typeof workflowName !== 'string' || !isCyboflowWorkflowName(workflowName)) return null;
      const payload: LaunchRunProposalPayload = { kind: 'launch-run', projectId, workflowName };

      const substrate = raw.substrate;
      if (substrate !== undefined) {
        if (!isCliSubstrate(substrate)) return null;
        payload.substrate = substrate;
      }
      const taskIds = raw.taskIds;
      if (taskIds !== undefined) {
        if (!isStringArray(taskIds)) return null;
        payload.taskIds = taskIds;
      }
      const ideaIds = raw.ideaIds;
      if (ideaIds !== undefined) {
        if (!isStringArray(ideaIds)) return null;
        payload.ideaIds = ideaIds;
      }
      const findingIds = raw.findingIds;
      if (findingIds !== undefined) {
        if (!isStringArray(findingIds)) return null;
        payload.findingIds = findingIds;
      }
      const note = raw.note;
      if (note !== undefined) {
        if (typeof note !== 'string') return null;
        payload.note = note;
      }
      return payload;
    }
    case 'reprioritize-backlog': {
      const projectId = raw.projectId;
      const itemsRaw = raw.items;
      if (typeof projectId !== 'number') return null;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return null;
      const items: ReprioritizeBacklogItem[] = [];
      for (const entryRaw of itemsRaw) {
        if (!isRecord(entryRaw)) return null;
        const taskId = entryRaw.taskId;
        if (typeof taskId !== 'string' || taskId.length === 0) return null;
        const item: ReprioritizeBacklogItem = { taskId };
        const priority = entryRaw.priority;
        if (priority !== undefined) {
          if (!isAgentPriority(priority)) return null;
          item.priority = priority;
        }
        const stageId = entryRaw.stageId;
        if (stageId !== undefined) {
          if (typeof stageId !== 'string' || stageId.length === 0) return null;
          item.stageId = stageId;
        }
        if (item.priority === undefined && item.stageId === undefined) return null; // no-op row
        items.push(item);
      }
      const payload: ReprioritizeBacklogProposalPayload = { kind: 'reprioritize-backlog', projectId, items };
      return payload;
    }
    case 'edit-workflow': {
      const workflowId = raw.workflowId;
      const definitionJson = raw.definitionJson;
      if (typeof workflowId !== 'string' || workflowId.length === 0) return null;
      if (typeof definitionJson !== 'string' || definitionJson.length === 0) return null;
      const payload: EditWorkflowProposalPayload = { kind: 'edit-workflow', workflowId, definitionJson };
      const summary = raw.summary;
      if (summary !== undefined) {
        if (typeof summary !== 'string') return null;
        payload.summary = summary;
      }
      return payload;
    }
    case 'open-session': {
      const navigation = parseAgentNavigationTarget(raw.navigation);
      if (!navigation) return null;
      const payload: OpenSessionProposalPayload = { kind: 'open-session', navigation };
      return payload;
    }
  }
}

// ---------------------------------------------------------------------------
// Structured finding-extras mapping (snake_case wire -> camelCase payload).
//
// The cyboflow_report_finding tool accepts optional category / locations /
// suggested_fix / impact alongside the legacy payload_json. They arrive on the
// query message UNVALIDATED (typed `unknown`); the guards below narrow each shape
// and the builder DROPS any malformed member rather than erroring — an agent typo
// must never fail a non-blocking finding write (the whole point of the inbox).
// ---------------------------------------------------------------------------

/** A non-null object whose own keys can be safely indexed. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow `unknown` to FindingPayload['locations'], keeping only well-formed
 * entries ({ path: string, line?: number }) and dropping malformed ones. Returns
 * undefined when the input is not an array OR no entry survives.
 */
function parseFindingLocations(v: unknown): FindingPayload['locations'] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<FindingPayload['locations']> = [];
  for (const entry of v) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue; // drop malformed
    out.push(typeof entry.line === 'number' ? { path: entry.path, line: entry.line } : { path: entry.path });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Narrow `unknown` to FindingPayload['impact'], keeping only the numeric/string
 * members that are present and well-typed. Returns undefined when the input is
 * not an object OR no member survives.
 */
function parseFindingImpact(v: unknown): FindingPayload['impact'] | undefined {
  if (!isRecord(v)) return undefined;
  const impact: NonNullable<FindingPayload['impact']> = {};
  if (typeof v['ran_count'] === 'number') impact.ranCount = v['ran_count'];
  if (typeof v['caught_regressions'] === 'number') impact.caughtRegressions = v['caught_regressions'];
  if (typeof v['token_delta'] === 'number') impact.tokenDelta = v['token_delta'];
  if (typeof v['note'] === 'string') impact.note = v['note'];
  return Object.keys(impact).length > 0 ? impact : undefined;
}

/**
 * Build the FindingPayload extras from a report-finding message, dropping any
 * malformed member. Returns only the keys that survived narrowing (so the caller
 * can spread them over a base payload without clobbering with undefined).
 */
function buildFindingExtras(
  msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
): Partial<Omit<FindingPayload, 'kind'>> {
  const extras: Partial<Omit<FindingPayload, 'kind'>> = {};
  if (typeof msg.category === 'string') extras.category = msg.category;
  if (typeof msg.suggestedFix === 'string') extras.suggestedFix = msg.suggestedFix;
  // proposedTarget must be one of the four routing literals ('fix' = a quick
  // in-place fix, added with the findings-triage redesign); anything else is
  // DROPPED (same agent-typo-can-never-fail-a-write discipline as the rest).
  if (['backlog', 'docs', 'prompt', 'fix'].includes(msg.proposedTarget as string)) {
    extras.proposedTarget = msg.proposedTarget as FindingProposedTarget;
  }
  const locations = parseFindingLocations(msg.locations);
  if (locations !== undefined) extras.locations = locations;
  const impact = parseFindingImpact(msg.impact);
  if (impact !== undefined) extras.impact = impact;
  return extras;
}

// ---------------------------------------------------------------------------
// Internal row shapes (enough for safe narrowing — not a full ORM mapping)
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input_json: string;
  created_at: string;
}

/**
 * One held-open shell-approval socket awaiting a human verdict.
 *
 * The async-deferred `shell-approval-request` branch retains the client socket
 * (no synchronous response) and registers an in-flight entry here so two
 * cleanup paths can find it later:
 *  - the socket's own 'close'/'error' (orchestrator-down / hook subprocess
 *    died) clears the pending approval so the run does not leak in
 *    awaiting_review; and
 *  - the per-run cancel affordance (denyInFlightShellApprovals) writes a deny
 *    verdict and closes every socket for the run so a torn-down PTY unblocks.
 */
interface InFlightShellApproval {
  client: net.Socket;
  requestId: string;
  /** Set once requestApproval's transaction commits — used by cancel cleanup. */
  approvalId?: string;
  /** Detaches the per-socket 'close'/'error' disconnect listeners. */
  detachListeners: () => void;
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
}

/**
 * Narrow structural surface over WorkflowRegistry — exactly the methods the
 * workflow/variant MCP tools call. Kept in lockstep with the registry by the
 * wiring in main/src/index.ts (which forwards the real methods). Every method
 * may throw a distinguishable Error the handler maps to an ok:false code.
 */
export interface WorkflowConfigLike {
  getById(workflowId: string): WorkflowRow | null;
  listByProject(projectId: number): WorkflowRow[];
  /** Reconcile the in-repo built-ins as global rows (mirrors the tRPC list). */
  ensureGlobalBuiltIns(): void;
  getBaselineRotation(workflowId: string): { inRotation: boolean; weight: number } | null;
  updateSpec(workflowId: string, definition: WorkflowDefinition): void;
  resetSpec(workflowId: string): void;
  createCustom(params: {
    projectId: number | null;
    name: string;
    specJson?: string;
    permissionMode?: PermissionMode;
  }): WorkflowRow;
  deleteWorkflow(workflowId: string): void;
  listVariants(workflowId: string): WorkflowVariantRow[];
  createVariantFromCurrent(workflowId: string, label: string): WorkflowVariantRow;
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

// ---------------------------------------------------------------------------
// McpQueryHandler
// ---------------------------------------------------------------------------

export class McpQueryHandler {
  /**
   * In-flight shell-approval sockets, keyed by runId. The shell transport holds
   * the connection open across the multi-minute human-decision window, so the
   * socket must be reachable by both the disconnect-cleanup path and the cancel
   * affordance the interactive manager calls before killing the PTY.
   */
  private readonly inFlightShellApprovals = new Map<string, Set<InFlightShellApproval>>();

  /**
   * Lazily-opened, cached readonly sibling connection backing
   * cyboflow_db_query (mcp-db-query). Opened once on first use against
   * `this.db.name` (the on-disk file path the injected DatabaseLike wraps)
   * and reused for the process lifetime — mirrors the main db connection's
   * own lifetime, so no explicit dispose path is needed here (this class has
   * no existing close()/dispose() to hook into).
   */
  private globalAgentReadonlyDb: BetterSqlite3Database.Database | null = null;

  /**
   * @param db     Orchestrator DB surface.
   * @param logger Optional structured logger. Passed through for connect /
   *               disconnect / precondition diagnostics on the shell-approval
   *               path (CLAUDE.md optional-logger rule: pass it, don't omit it).
   * @param deps   Optional callback deps otherwise unreachable from this layer
   *               (see McpQueryHandlerDeps). Defaults to `{}` — every member is
   *               individually optional, so omitting this arg entirely (as every
   *               existing test call site does) is equivalent to passing `{}`.
   */
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
    private readonly deps: McpQueryHandlerDeps = {},
  ) {}

  // --------------------------------------------------------------------------
  // Public entry point
  // --------------------------------------------------------------------------

  /**
   * Route a parsed McpQueryMessage to the correct handler and write a
   * JSON response back on `client`.
   *
   * Never throws — all exceptions are caught and surfaced as ok:false responses.
   */
  async handleMessage(msg: McpQueryMessage, client: net.Socket): Promise<void> {
    try {
      switch (msg.type) {
        case 'mcp-list-pending-approvals':
          this.handleListPendingApprovals(msg, client);
          break;
        case 'mcp-get-run':
          this.handleGetRun(msg, client);
          break;
        case 'mcp-submit-checkpoint':
          this.handleSubmitCheckpoint(msg, client);
          break;
        case 'mcp-report-step':
          await this.handleReportStep(msg, client);
          break;
        case 'mcp-request-user-input':
          await this.handleRequestUserInput(msg, client);
          break;
        case 'mcp-create-task':
          await this.handleCreateTask(msg, client);
          break;
        case 'mcp-update-task':
          await this.handleUpdateTask(msg, client);
          break;
        case 'mcp-set-task-stage':
          await this.handleSetTaskStage(msg, client);
          break;
        case 'mcp-add-task-dependency':
          await this.handleAddTaskDependency(msg, client);
          break;
        case 'mcp-list-tasks':
          // Read-only: projects + flattens selectProjectBacklog's tree. Never writes.
          this.handleListTasks(msg, client);
          break;
        case 'mcp-get-task':
          // Read-only: id-then-ref resolution + cross-project guard. Never writes.
          this.handleGetTask(msg, client);
          break;
        case 'mcp-update-sprint-task':
          this.handleUpdateSprintTask(msg, client);
          break;
        case 'mcp-create-sprint-batch':
          this.handleCreateSprintBatch(msg, client);
          break;
        case 'mcp-report-finding':
          // NON-BLOCKING: writes its response synchronously after enqueuing the
          // review-item create — the run is NEVER paused waiting on the inbox.
          this.handleReportFinding(msg, client);
          break;
        case 'mcp-get-selected-findings':
          // Read-only: returns the findings the human seeded into THIS compound
          // run (workflow_runs.seed_finding_ids). Never writes.
          this.handleGetSelectedFindings(msg, client);
          break;
        case 'mcp-resolve-finding':
          // AWAITED (unlike fire-and-forget report-finding) so a failed resolve
          // surfaces to the agent rather than silently leaving the finding pending.
          await this.handleResolveFinding(msg, client);
          break;
        case 'mcp-report-artifact':
          await this.handleReportArtifact(msg, client);
          break;
        case 'mcp-commit-artifact':
          await this.handleCommitArtifact(msg, client);
          break;
        case 'mcp-request-verification':
          // FIRE-AND-CONTINUE: resolves posture + enqueues synchronously, replies
          // { requestId } (or { skipped:true } for a disabled run), then nudges the
          // scheduler — the lane never blocks on the verdict.
          this.handleRequestVerification(msg, client);
          break;
        case 'mcp-list-workflows':
          this.handleListWorkflows(msg, client);
          break;
        case 'mcp-get-workflow':
          this.handleGetWorkflow(msg, client);
          break;
        case 'mcp-update-workflow':
          this.handleUpdateWorkflow(msg, client);
          break;
        case 'mcp-reset-workflow':
          this.handleResetWorkflow(msg, client);
          break;
        case 'mcp-create-workflow':
          this.handleCreateWorkflow(msg, client);
          break;
        case 'mcp-delete-workflow':
          this.handleDeleteWorkflow(msg, client);
          break;
        case 'mcp-list-variants':
          this.handleListVariants(msg, client);
          break;
        case 'mcp-create-variant':
          this.handleCreateVariant(msg, client);
          break;
        case 'mcp-update-variant':
          this.handleUpdateVariant(msg, client);
          break;
        case 'mcp-set-variant-status':
          this.handleSetVariantStatus(msg, client);
          break;
        case 'mcp-delete-variant':
          this.handleDeleteVariant(msg, client);
          break;
        case 'mcp-set-baseline-rotation':
          this.handleSetBaselineRotation(msg, client);
          break;
        case 'mcp-overview':
          this.handleAgentOverview(msg, client);
          break;
        case 'mcp-backlog':
          this.handleAgentBacklog(msg, client);
          break;
        case 'mcp-entity':
          this.handleAgentEntity(msg, client);
          break;
        case 'mcp-queue':
          this.handleAgentQueue(msg, client);
          break;
        case 'mcp-workflows':
          this.handleAgentWorkflows(msg, client);
          break;
        case 'mcp-workflow':
          this.handleAgentWorkflow(msg, client);
          break;
        case 'mcp-propose-action':
          this.handleProposeAction(msg, client);
          break;
        case 'mcp-db-query':
          this.handleAgentDbQuery(msg, client);
          break;
        case 'shell-approval-request':
          // Async-deferred — the FIRST handler that does NOT writeResponse
          // synchronously. It returns after kicking off requestApproval; only
          // the socketReply closure writes the verdict, possibly minutes later.
          this.handleShellApprovalRequest(msg, client);
          break;
        case 'interactive-turn-end':
          // Fire-and-ack: unlike shell-approval-request, there is no verdict to
          // defer — writeResponse happens synchronously either way.
          this.handleInteractiveTurnEnd(msg, client);
          break;
        case 'interactive-question-open':
          // Fire-and-ack: flip the run's board state to `blocked`; no verdict.
          this.handleInteractiveQuestionOpen(msg, client);
          break;
        default: {
          // TypeScript exhaustiveness helper — cast so the switch compiles even
          // if future union members are added without updating this switch.
          const exhaustive = msg as { type: string; requestId: string };
          console.error(
            `[Cyboflow MCP Query] Unknown message type: ${exhaustive.type}`,
          );
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: exhaustive.requestId,
            ok: false,
            error: 'unknown_message_type',
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Cyboflow MCP Query] Unhandled error in handleMessage:`, err);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Message handlers
  // --------------------------------------------------------------------------

  private handleListPendingApprovals(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-pending-approvals' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT id, run_id, tool_name, tool_input_json, created_at
         FROM approvals
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    );
    const rows = stmt.all() as ApprovalRow[];

    const approvals = rows.map((row) => ({
      approval_id: row.id,
      run_id: row.run_id,
      tool_name: row.tool_name,
      input: (() => {
        try {
          return JSON.parse(row.tool_input_json) as unknown;
        } catch {
          console.warn(
            `[Cyboflow MCP Query] tool_input_json parse failed for approval ${row.id} — returning raw string`,
          );
          return row.tool_input_json;
        }
      })(),
      created_at: row.created_at,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { approvals },
    });
  }

  private async handleRequestUserInput(
    msg: Extract<McpQueryMessage, { type: 'mcp-request-user-input' }>,
    client: net.Socket,
  ): Promise<void> {
    const answer = await QuestionRouter.getInstance().requestQuestion(
      msg.runId,
      msg.requestId,
      msg.questions,
      () => undefined,
    );
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: answer,
    });
  }

  private handleGetRun(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-run' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT * FROM workflow_runs WHERE id = ?`,
    );
    const row = stmt.get(msg.targetRunId) as Record<string, unknown> | undefined;

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { run: row },
    });
  }

  private handleSubmitCheckpoint(
    msg: Extract<McpQueryMessage, { type: 'mcp-submit-checkpoint' }>,
    client: net.Socket,
  ): void {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'checkpoint_requires_real_run',
      });
      return;
    }

    const now = new Date().toISOString();
    const payload = JSON.stringify({
      label: msg.label,
      note: msg.note ?? null,
      submitted_via: 'mcp',
    });

    const stmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
       VALUES (?, 'cyboflow_checkpoint', ?, ?)`,
    );
    const result = stmt.run(msg.runId, payload, now);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { checkpoint_id: result.lastInsertRowid },
    });
  }

  /**
   * Record the run's current workflow step (OBSERVATIONAL — drives the Workflow
   * Progress panel; never changes workflow_runs.status).
   *
   * Validation flow (dynamic step-id model, post user-editable-workflows merge):
   *   - orchestrator-sentinel guard mirrors handleSubmitCheckpoint: the
   *     singleton MCP server runs with CYBOFLOW_RUN_ID='orchestrator', which has
   *     no workflow_runs row → reject before any DB touch.
   *   - JOIN workflows for the run's name AND spec_json, then resolve the
   *     EFFECTIVE definition via resolveWorkflowDefinition(name, specJson). This
   *     is the runtime source of truth that fully overrides the static
   *     WORKFLOW_DEFINITIONS seed — an edited/custom step id present only in
   *     spec_json is accepted, a step id absent from (or removed by an edit of)
   *     the resolved def is rejected with 'unknown_step_id' (no write).
   *   - We validate stepId here (returning structured 'unknown_step_id') rather
   *     than relying on buildStepTransitionEvent's null return, which collapses
   *     "bad step" and "row vanished" into a single null and cannot distinguish
   *     them for the response. The bridge call is reached only for already-
   *     validated steps; its `null` there means the row vanished mid-flight.
   *
   * Pass `undefined` for the bridge logger arg — this class holds no LoggerLike
   * and must not fabricate one (CLAUDE.md silent-no-op rule applies only to
   * loggers actually in scope; the bridge falls back to console.warn).
   */
  private async handleReportStep(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-step' }>,
    client: net.Socket,
  ): Promise<void> {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'report_step_requires_real_run',
      });
      return;
    }

    // A/B testing (migration 055): resolve the run's FROZEN effective spec (its
    // variant graph, else the live spec) via resolveRunFrozenSpec (already keyed by
    // runId) instead of a live JOIN read.
    const row = resolveRunFrozenSpec(this.db, msg.runId);

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    const name = row.workflowName;
    const specJson = row.specJson;

    // Validate stepId against the run's RESOLVED definition — NOT the static
    // WORKFLOW_DEFINITIONS constant (which is now only the seed/fallback).
    const def = resolveWorkflowDefinition(name, specJson);
    const allSteps = def === null ? [] : def.phases.flatMap((p) => p.steps);
    const step = allSteps.find((s) => s.id === msg.stepId);

    if (!step) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'unknown_step_id',
      });
      return;
    }

    const status = msg.status ?? 'running';

    // GATE GUARD (silent-pass safety net) — ORCHESTRATED runs only. An
    // orchestrated agent — especially a Codex handover agent that lacks Claude's
    // AskUserQuestion tool — can report a HUMAN gate step 'done' WITHOUT ever
    // surfacing a real gate, asking in plain chat instead. That silent pass
    // skips the human decision entirely; for approve-plan it also skips the
    // reveal (promoteTasksOnPlanApproval), leaving plan_approved_at NULL, the
    // run's drafted tasks unpromoted, and materialize-batch dying with
    // `ship_no_tasks_to_materialize`. Refuse to COMPLETE any human gate that
    // shows no backend trace of having been surfaced-and-answered, forcing the
    // agent to open the gate via `cyboflow_request_user_input` (Codex/MCP) or
    // AskUserQuestion (Claude).
    //
    // Scoped to orchestrated runs: the programmatic plane drives human steps via
    // the deterministic HumanStepManager/openHumanGate, which writes a decision
    // review_item (NOT a `questions` row) and stamps plan_approved_at before its
    // step worker reports done — so the questions-based check below would
    // false-positive there. Two signals, strongest-first:
    //   • approve-plan → plan_approved_at. Bulletproof: the reveal stamps it
    //     SYNCHRONOUSLY (before the agent resumes) iff a gate resolved through
    //     QuestionRouter with an Approve answer.
    //   • every other human gate → a `questions` row created at/after the step's
    //     most-recent 'running' onset (humanGateWasSurfaced). Fail-OPEN whenever
    //     the window can't be bounded, so a legitimately-surfaced gate is never
    //     false-rejected. Both branches fail open on a missing run / pre-schema
    //     DB (never block).
    if (step.human === true && status === 'done') {
      const executionModel = this.readExecutionModel(msg.runId);
      if (executionModel === 'orchestrated') {
        if (msg.stepId === APPROVE_PLAN_STEP_ID) {
          if (!this.isPlanApproved(msg.runId)) {
            this.writeResponse(client, {
              type: 'mcp-query-response',
              requestId: msg.requestId,
              ok: false,
              error:
                'approve_plan_gate_not_resolved: no plan approval was recorded for this run. ' +
                'Surface the approve-plan gate with cyboflow_request_user_input (or AskUserQuestion) ' +
                'and wait for the human to answer "Approve" — do NOT ask in a plain chat message — ' +
                'before reporting approve-plan done.',
            });
            return;
          }
        } else if (!this.humanGateWasSurfaced(msg.runId, msg.stepId)) {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error:
              `human_gate_not_surfaced: no human gate was surfaced for the '${msg.stepId}' step. ` +
              'Open the gate with cyboflow_request_user_input (or AskUserQuestion) and wait for the ' +
              `human to answer — do NOT ask in a plain chat message — before reporting '${msg.stepId}' done.`,
          });
          return;
        }
      }
    }

    const event = buildStepTransitionEvent(msg.runId, msg.stepId, status, this.db, undefined);

    if (event === null) {
      // Row vanished between the JOIN above and the bridge UPDATE — the stepId
      // was already validated, so a null here is a missing-run race, not a typo.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    // Report-step is OBSERVATIONAL: it records the run's current step for the
    // progress rail and never changes the run's lifecycle state. Human steps
    // (approve-idea / approve-plan / human-review) are AGENT-driven — the agent
    // pauses and asks via AskUserQuestion, which QuestionRouter surfaces as a
    // blocking `decision` review_item. The orchestrator must NOT pause the run on
    // a human-step report: doing so blocks the very agent that needs to ask (its
    // own tool calls then fail the status='running' guard → deadlock).
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        step_id: msg.stepId,
        status,
      },
    });
  }

  /**
   * Fail-soft read of a run's execution_model ('orchestrated' | 'programmatic').
   * Returns null on a missing run / vanished row (never throws) — callers treat
   * a non-'orchestrated' result as "no gate guard".
   */
  private readExecutionModel(runId: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT execution_model AS m FROM workflow_runs WHERE id = ?')
        .get(runId) as { m?: unknown } | undefined;
      return typeof row?.m === 'string' ? row.m : null;
    } catch {
      return null;
    }
  }

  /**
   * True iff the run's approve-plan reveal stamped plan_approved_at (a real gate
   * resolved through QuestionRouter with Approve). Fail-OPEN (returns true) on a
   * pre-042 DB lacking the column or a vanished run, so the guard never blocks
   * when it cannot judge.
   */
  private isPlanApproved(runId: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT plan_approved_at AS p FROM workflow_runs WHERE id = ?')
        .get(runId) as { p?: unknown } | undefined;
      return typeof row?.p === 'string' && row.p.length > 0;
    } catch {
      // Pre-042 DB (no plan_approved_at column) — cannot judge, so do not block.
      return true;
    }
  }

  /**
   * True iff a gate question was surfaced for `stepId` on this run — i.e. a
   * `questions` row exists created at/after the step's most-recent 'running'
   * onset (from the step_transition raw_events log). This is the generic
   * silent-pass signal for human gates OTHER than approve-plan (which has the
   * stronger plan_approved_at check). It catches only the clear failure mode:
   * an orchestrated agent that reported the step running→done without ever
   * opening a gate. Fail-OPEN (returns true) whenever the window can't be
   * bounded — no 'running' onset recorded, or the questions/raw_events tables
   * (or JSON1) are unavailable — so a legitimately-surfaced gate, or a
   * clarifying question the human engaged with, is never false-rejected.
   */
  private humanGateWasSurfaced(runId: string, stepId: string): boolean {
    try {
      const onsetRow = this.db
        .prepare(
          `SELECT created_at AS onset FROM raw_events
             WHERE run_id = ? AND event_type = 'step_transition'
               AND json_extract(payload_json, '$.step_id') = ?
               AND json_extract(payload_json, '$.status') = 'running'
             ORDER BY id DESC LIMIT 1`,
        )
        .get(runId, stepId) as { onset?: unknown } | undefined;
      const onset = typeof onsetRow?.onset === 'string' ? onsetRow.onset : null;
      if (onset === null) {
        // No 'running' onset recorded for this step — the window is unbounded, so
        // do not block (an agent that never reported running is out of scope).
        return true;
      }
      const surfaced = this.db
        .prepare(
          `SELECT 1 FROM questions
             WHERE run_id = ? AND datetime(created_at) >= datetime(?)
             LIMIT 1`,
        )
        .get(runId, onset) as unknown;
      return surfaced !== undefined;
    } catch {
      // questions / raw_events / JSON1 unavailable — fail open.
      return true;
    }
  }

  // --------------------------------------------------------------------------
  // Native task writes (cyboflow_create_task / _update_task / _set_task_stage)
  //
  // All three route through the SINGLE write chokepoint
  // TaskChangeRouter.getInstance().applyChange — they NEVER UPDATE `tasks`
  // directly. The actor is derived from the calling run's current step
  // (agent:LABEL), mirroring TaskChangeRouter.resolveAgentLabel. The
  // orchestrator-derived stage authority, active-run guard, parent validation,
  // and optimistic concurrency are all enforced INSIDE applyChange and surface
  // here as TaskChangeError.code (forbidden_stage | active_runs | invalid_parent
  // | not_found | concurrency) — they are DESIGNED rejections, not bugs.
  // --------------------------------------------------------------------------

  /**
   * Resolve the calling run into the project scope + agent actor needed to apply
   * a task change. Returns a discriminated result so callers branch without any.
   *
   * Guards (parity with handleSubmitCheckpoint / handleReportStep):
   *   - the 'orchestrator' sentinel runId has no workflow_runs row → reject
   *     before any DB touch (task_write_requires_real_run);
   *   - a missing run row → run_not_found;
   *   - a terminal run (completed | failed | canceled) must not mutate tasks →
   *     run_not_active.
   *
   * Actor derivation mirrors TaskChangeRouter.resolveAgentLabel:
   *   label = snapshot[current_step_id] (non-empty string) ?? current_step_id ??
   *           'unknown'; actor = `agent:${label}`.
   */
  private resolveTaskRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: TaskActor } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'task_write_requires_real_run' };
    }

    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, status, current_step_id AS currentStepId,
                steps_snapshot_json AS stepsSnapshotJson
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          projectId?: unknown;
          status?: unknown;
          currentStepId?: unknown;
          stepsSnapshotJson?: unknown;
        }
      | undefined;

    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }

    const status = typeof row.status === 'string' ? row.status : '';
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return { ok: false, error: 'run_not_active' };
    }

    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    const currentStepId = typeof row.currentStepId === 'string' ? row.currentStepId : null;
    const stepsSnapshotJson = typeof row.stepsSnapshotJson === 'string' ? row.stepsSnapshotJson : null;

    let label = 'unknown';
    if (currentStepId && stepsSnapshotJson) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        const agent = snapshot[currentStepId];
        if (typeof agent === 'string' && agent.length > 0) {
          label = resolveStepAgentKey(currentStepId, agent) ?? agent;
        } else {
          label = currentStepId;
        }
      } catch {
        // malformed snapshot — fall back to the step id when present.
        label = currentStepId;
      }
    } else if (currentStepId) {
      label = currentStepId;
    }

    const actor: TaskActor = `agent:${label}`;
    return { ok: true, projectId, actor };
  }

  /**
   * Re-read an entity's identity columns after a chokepoint write so the
   * response carries the canonical ref / stage / version / type. Table identity
   * is the discriminator (migration 015), so we try ideas -> epics -> tasks in
   * turn and return the type of the matching table. Returns undefined only if
   * the row vanished between commit and read (caller surfaces not_found).
   */
  private readTaskIdentity(
    taskId: string,
  ): { ref: string; stage_id: string; version: number; type: TaskType } | undefined {
    const tables: Array<{ table: string; type: TaskType }> = [
      { table: 'ideas', type: 'idea' },
      { table: 'epics', type: 'epic' },
      { table: 'tasks', type: 'task' },
    ];
    for (const { table, type } of tables) {
      const row = this.db
        .prepare(`SELECT ref, stage_id, version FROM ${table} WHERE id = ?`)
        .get(taskId) as { ref?: unknown; stage_id?: unknown; version?: unknown } | undefined;
      if (!row) continue;
      return {
        ref: typeof row.ref === 'string' ? row.ref : '',
        stage_id: typeof row.stage_id === 'string' ? row.stage_id : '',
        version: typeof row.version === 'number' ? row.version : Number(row.version),
        type,
      };
    }
    return undefined;
  }

  private async handleCreateTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-task' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // originating_idea_id is only meaningful for epic/task creates (ideas carry
    // no lineage — describe('idea').hasOriginatingIdea is false); an idea
    // create silently drops a supplied value here rather than letting the
    // chokepoint reject it with invalid_lineage, mirroring how scope is
    // dropped on epic/task creates (desc.hasScope gating in TaskChangeRouter)
    // instead of throwing. When applicable, resolve ref-or-id via the same
    // resolveBacklogRef helper used elsewhere in this file (get_task,
    // create_sprint_batch) — an opaque id has no matching `ref` row so it
    // round-trips unchanged.
    const originatingIdeaId: string | null =
      msg.originatingIdeaId !== undefined && msg.taskType !== undefined && msg.taskType !== 'idea'
        ? (resolveBacklogRef(this.db, ctx.projectId, msg.originatingIdeaId) ?? msg.originatingIdeaId)
        : null;

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      entityType: msg.taskType,
      title: msg.title,
      summary: msg.summary,
      body: msg.body,
      priority: msg.priority,
      category: msg.category,
      repo: msg.repo,
      parentEpicId: msg.parentEpicId ?? null,
      boardId: msg.boardId,
      initialStageId: msg.initialStageId,
      scope: msg.scope,
      originatingIdeaId,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);

      // Content-driven artifact mint: a successful entity create may have just made
      // a templated deliverable non-empty (idea -> idea-spec; epic/task ->
      // decomposed-stories). Fire-and-forget + fail-soft (handleEntityWrite never
      // throws, but a defensive .catch guards a surprise rejection from becoming an
      // unhandled rejection — mirrors the buildStepTransitionEvent .catch posture).
      // The entity type comes from the re-read identity, falling back to the
      // requested taskType (default 'idea' at the chokepoint).
      const createdType: 'idea' | 'epic' | 'task' = identity?.type ?? msg.taskType ?? 'idea';
      void handleEntityWrite(this.db, msg.runId, createdType, this.logger).catch((err) => {
        this.logger?.warn('[Cyboflow MCP Query] entity-write mint rejected (ignored)', {
          runId: msg.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          ref: identity?.ref,
          stage_id: identity?.stage_id,
          type: identity?.type,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  private async handleUpdateTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-task' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      taskId: msg.taskId,
      ...(msg.entityType !== undefined ? { entityType: msg.entityType } : {}),
      fields: {
        title: msg.title,
        summary: msg.summary,
        body: msg.body,
        priority: msg.priority,
        category: msg.category,
        repo: msg.repo,
        scope: msg.scope,
      },
      ...(msg.parentEpicId !== undefined ? { parentEpicId: msg.parentEpicId } : {}),
      expectedVersion: msg.expectedVersion,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);

      // Content-driven artifact mint: an update that filled in the idea body /
      // summary (idea -> idea-spec) or an entity's content (epic/task ->
      // decomposed-stories) may have just made a templated deliverable non-empty.
      // Fire-and-forget + fail-soft (mirrors the create path). Entity type from the
      // re-read identity, falling back to the discriminator the caller supplied.
      const writtenType: 'idea' | 'epic' | 'task' = identity?.type ?? msg.entityType ?? 'idea';
      void handleEntityWrite(this.db, msg.runId, writtenType, this.logger).catch((err) => {
        this.logger?.warn('[Cyboflow MCP Query] entity-write mint rejected (ignored)', {
          runId: msg.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          stage_id: identity?.stage_id,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  private async handleSetTaskStage(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-task-stage' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      taskId: msg.taskId,
      ...(msg.entityType !== undefined ? { entityType: msg.entityType } : {}),
      stageId: msg.stageId,
      expectedVersion: msg.expectedVersion,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          stage_id: identity?.stage_id,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  /**
   * Record a task->task dependency edge via the chokepoint. Routes through the
   * same run-context guards as the other task writes, then applies a
   * `dependsOnTaskId`-carrying TaskChange (the chokepoint's add-dependency
   * branch). Designed rejections surface as TaskChangeError.code
   * (invalid_dependency | dependency_cycle | not_found) via writeTaskChangeError.
   */
  private async handleAddTaskDependency(
    msg: Extract<McpQueryMessage, { type: 'mcp-add-task-dependency' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      entityType: 'task',
      taskId: msg.taskId,
      dependsOnTaskId: msg.dependsOnTaskId,
      ...(msg.dependencyKind !== undefined ? { dependencyKind: msg.dependencyKind } : {}),
    };

    try {
      const { taskId, dependsOnTaskId } = await TaskChangeRouter.getInstance().applyChange(
        ctx.projectId,
        change,
      );
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          // Echo the RESOLVED canonical ids for BOTH endpoints (the caller may
          // have passed display refs, e.g. TASK-001) so the response reflects
          // what was actually stored, not the raw input handles.
          task_id: taskId,
          depends_on_task_id: dependsOnTaskId ?? msg.dependsOnTaskId,
          kind: msg.dependencyKind ?? 'blocking',
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a chokepoint failure as an ok:false response. A TaskChangeError maps
   * to its discriminated .code (mirrors the tasks tRPC router); anything else is
   * logged and collapsed to the opaque 'task_change_failed'.
   */
  private writeTaskChangeError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof TaskChangeError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] task change failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'task_change_failed',
    });
  }

  // --------------------------------------------------------------------------
  // Read-only backlog listing (cyboflow_list_tasks / cyboflow_get_task)
  //
  // Both reuse resolveTaskRunContext for project scoping (the actor it also
  // returns is unused here — these paths never write). Neither ever calls
  // TaskChangeRouter or mutates any table; they read exclusively through the
  // shared taskListing.ts projection so the shape can never drift from the
  // tasks tRPC router's own reads.
  // --------------------------------------------------------------------------

  /**
   * The compact projection cyboflow_list_tasks returns per item — deliberately
   * WITHOUT `body` / `inFlow` / `children` (an agent enumerating the backlog
   * does not need the full markdown spec or the live-run overlay for every
   * row; cyboflow_get_task fetches one item's full body on demand).
   */
  private static toCompactTask(item: BacklogTaskItem): Record<string, unknown> {
    return {
      id: item.id,
      ref: item.ref,
      type: item.type,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      category: item.category,
      stage_id: item.stage_id,
      stage_position: item.stage_position,
      parent_epic_id: item.parent_epic_id,
      originating_idea_id: item.originating_idea_id,
      archived: item.archived_at !== null,
      decomposed: item.decomposed_at !== null,
      approved: item.approved_at !== null,
      is_done: item.isDone,
      awaiting_review: item.awaitingReview,
      // Only tasks carry a computed dependency overlay (selectProjectBacklog
      // applies it to type='task' rows only); ideas/epics are never blocked,
      // so an absent overlay defaults to "ready" rather than "unknown".
      ready_to_work: item.readyToWork ?? true,
      blocked_by: (item.blockedBy ?? []).map((dep) => dep.ref),
      version: item.version,
      updated_at: item.updated_at,
    };
  }

  /**
   * Project a full BacklogTaskItem for cyboflow_get_task, EXCLUDING `inFlow`
   * (an internal live-run overlay with no stable external contract). Every
   * other field — including `body`, `blockedBy`/`relatedTo`/`readyToWork`, and
   * (for an epic) `children`/`childCount`/`pendingTasks` — passes through
   * unchanged.
   */
  private static toFullTask(item: BacklogTaskItem): Record<string, unknown> {
    return {
      id: item.id,
      project_id: item.project_id,
      type: item.type,
      ref: item.ref,
      title: item.title,
      summary: item.summary,
      body: item.body,
      priority: item.priority,
      category: item.category,
      repo: item.repo,
      parent_epic_id: item.parent_epic_id,
      originating_idea_id: item.originating_idea_id,
      scope: item.scope,
      board_id: item.board_id,
      stage_id: item.stage_id,
      archived_at: item.archived_at,
      decomposed_at: item.decomposed_at,
      approved_at: item.approved_at,
      version: item.version,
      stage_position: item.stage_position,
      awaitingReview: item.awaitingReview,
      isDone: item.isDone,
      blockedBy: item.blockedBy,
      relatedTo: item.relatedTo,
      readyToWork: item.readyToWork,
      children: item.children,
      childCount: item.childCount,
      pendingTasks: item.pendingTasks,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  /**
   * Project an idea's image attachments (migration 028) into the MCP read shape
   * for cyboflow_get_task: [{ id, label, mimeType, path }], `path` RESOLVED to
   * an absolute on-disk path — never base64/dataURLs (flow agents fetch bytes
   * themselves via Read). Reuses the EXACT resolution + containment guard the
   * ideas:load-attachments IPC handler applies (main/src/ipc/ideaAttachments.ts)
   * so this read-only surface can never be used to escape the artifacts root:
   * an attachment whose stored path resolves outside CYBOFLOW_DIR/artifacts, or
   * that no longer exists on disk, is silently dropped rather than surfaced.
   */
  private static toMcpAttachments(attachments: IdeaAttachment[]): Array<{
    id: string;
    label: string;
    mimeType: string;
    path: string;
  }> {
    // Common case (an idea with no attachments — and every epic/task, though those
    // never reach here): nothing to resolve or containment-check, so return early
    // WITHOUT touching getCyboflowSubdirectory. Behaviour-preserving (the loop below
    // would yield [] anyway) and it keeps the read path off the CYBOFLOW_DIR
    // resolver for the zero-attachment majority.
    if (attachments.length === 0) return [];
    const artifactsRoot = path.resolve(getCyboflowSubdirectory('artifacts'));
    const result: Array<{ id: string; label: string; mimeType: string; path: string }> = [];
    for (const att of attachments) {
      const resolved = path.resolve(att.path);
      if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) {
        continue;
      }
      if (!existsSync(resolved)) continue;
      result.push({ id: att.id, label: att.name, mimeType: att.type, path: resolved });
    }
    return result;
  }

  /**
   * List the backlog for THIS run's project — read-only, run-bound (no project
   * argument; resolveTaskRunContext derives it from CYBOFLOW_RUN_ID).
   *
   * Reads via selectProjectBacklog (the SAME projection the tasks tRPC router
   * uses), then FLATTENS its one-level tree (top-level items + every epic's
   * `children`) into a single array — the compact shape has no nesting.
   *
   * Filter semantics (applied after flattening):
   *   - archived_at set          -> hidden unless includeArchived.
   *   - isDone===true OR
   *     decomposed_at set        -> hidden unless includeDone (a decomposed
   *                                  idea is retired off the board, which is
   *                                  its own flavor of "done").
   *   - taskType                 -> keep only that entity type.
   * `hidden_count` is the number of items the filters removed (from the flat,
   * pre-filter count) so a caller passing no filters and seeing a smaller list
   * than expected knows to reach for include_archived / include_done.
   */
  private handleListTasks(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-tasks' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const tree = selectProjectBacklog(this.db, ctx.projectId);
    const flat: BacklogTaskItem[] = [];
    for (const item of tree) {
      flat.push(item);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children);
      }
    }

    const includeArchived = msg.includeArchived ?? false;
    const includeDone = msg.includeDone ?? false;

    const filtered = flat.filter((item) => {
      if (item.archived_at !== null && !includeArchived) return false;
      const isDoneOrRetired = item.isDone === true || item.decomposed_at !== null;
      if (isDoneOrRetired && !includeDone) return false;
      if (msg.taskType !== undefined && item.type !== msg.taskType) return false;
      return true;
    });

    const tasks = filtered.map((item) => McpQueryHandler.toCompactTask(item));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        tasks,
        total: tasks.length,
        hidden_count: flat.length - tasks.length,
      },
    });
  }

  /**
   * Fetch ONE backlog entity with its full body, by opaque id OR display ref
   * (e.g. 'TASK-014') — read-only, project-scoped to THIS run.
   *
   * Resolution order: try selectTaskById(taskId) first (an opaque id wins
   * outright); when that misses, resolve taskId as a display ref scoped to
   * this run's project via resolveBacklogRef, then re-select by the resolved
   * id. Either path that still comes back null, OR resolves to an item whose
   * project_id does not match this run's project, replies 'not_found' — the
   * cross-project case is deliberately indistinguishable from a genuine miss
   * so this tool can never be used to probe another project's backlog.
   */
  private handleGetTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-task' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    let item = selectTaskById(this.db, msg.taskId);
    if (!item) {
      const resolvedId = resolveBacklogRef(this.db, ctx.projectId, msg.taskId);
      if (resolvedId) {
        item = selectTaskById(this.db, resolvedId);
      }
    }

    if (!item || item.project_id !== ctx.projectId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    // A/B SANDBOX read scoping (migration 053). A hidden experiment entity must
    // never surface to a by-id/by-ref fetch from outside its OWNING arm — otherwise
    // an arm that learns the sibling arm's id/ref could read (and then, via the
    // write guard's now-arm-scoped denial message, target) the other arm's work.
    // Return it ONLY when this run is the owning arm; else 'not_found', deliberately
    // indistinguishable from a genuine miss so the tool can't probe the sibling
    // sandbox. (list_tasks already hides ALL tagged rows via selectProjectBacklog.)
    if (item.experiment_id !== null) {
      const runCtx = this.runExperimentContext(msg.runId);
      const entityArm = this.entityExperimentArm(item.type, item.id);
      const ownedByThisArm =
        runCtx.experimentId !== null &&
        runCtx.experimentId === item.experiment_id &&
        runCtx.arm !== null &&
        runCtx.arm === entityArm;
      if (!ownedByThisArm) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'not_found',
        });
        return;
      }
    }

    const task = McpQueryHandler.toFullTask(item);
    // Ideas-only (migration 028 / IDEA-006): epics/tasks carry no attachments
    // column at all, so they get no `attachments` key; an idea with none gets
    // the empty array (a stable, documented shape either way).
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = McpQueryHandler.toMcpAttachments(attachments);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { task },
    });
  }

  /**
   * A/B SANDBOX read scoping (migration 053): the (experimentId, arm) THIS run
   * belongs to, or nulls when the run is not an experiment arm. Fail-soft on a
   * pre-048/053 DB (missing columns → nulls). Used only by handleGetTask.
   */
  private runExperimentContext(runId: string): { experimentId: string | null; arm: ExperimentArm | null } {
    try {
      const row = this.db
        .prepare('SELECT experiment_id AS experimentId, experiment_arm AS arm FROM workflow_runs WHERE id = ?')
        .get(runId) as { experimentId?: unknown; arm?: unknown } | undefined;
      const experimentId =
        typeof row?.experimentId === 'string' && row.experimentId.length > 0 ? row.experimentId : null;
      const arm = row?.arm;
      return { experimentId, arm: arm === 'A' || arm === 'B' ? arm : null };
    } catch {
      return { experimentId: null, arm: null };
    }
  }

  /** The experiment_arm tag on one entity row (migration 053), or null. Fail-soft. */
  private entityExperimentArm(type: TaskType, id: string): ExperimentArm | null {
    const table = type === 'idea' ? 'ideas' : type === 'epic' ? 'epics' : 'tasks';
    try {
      const row = this.db.prepare(`SELECT experiment_arm AS arm FROM ${table} WHERE id = ?`).get(id) as
        | { arm?: unknown }
        | undefined;
      const arm = row?.arm;
      return arm === 'A' || arm === 'B' ? arm : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Sprint lane write (cyboflow_update_sprint_task)
  //
  // Per-task progress for the SINGLE session-hosted sprint run: the sprint
  // orchestrator agent reports each task's lane status / current step, which
  // routes through the SprintLaneStore chokepoint (NOT TaskChangeRouter —
  // sprint_batch_tasks is a non-entity table; see migration 022's header).
  // The write is keyed by the calling run's workflow_runs.batch_id, stamped at
  // launch by RunLauncher; a run without a batch (quick session, planner, a
  // sprint launched without seed tasks) is rejected.
  // --------------------------------------------------------------------------

  /**
   * Update one sprint lane's status and/or current step.
   *
   * Guards: resolveTaskRunContext (sentinel / missing / terminal run — reused
   * for parity with the other task-scoped writes), then the run row must carry
   * a non-null batch_id ('sprint_lane_requires_batch_run'). Lane-level
   * validation (step vocabulary, status domain, at-least-one-field, unknown
   * lane) is enforced INSIDE SprintLaneStore.updateLane and surfaces here as
   * SprintLaneError.code (bad_request | lane_not_found) — DESIGNED rejections,
   * mapped by writeSprintLaneError (mirrors writeTaskChangeError).
   */
  private handleUpdateSprintTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-sprint-task' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // The lane substrate is keyed by the run's batch (workflow_runs.batch_id,
    // migration 022 — stamped by RunLauncher when the sprint launches with
    // seed tasks). Read defensively: a NULL/absent batch is a designed reject.
    const runRow = this.db
      .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { batchId?: unknown } | undefined;
    const batchId = typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
    if (!batchId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'sprint_lane_requires_batch_run',
      });
      return;
    }

    // Orchestrated-plane mirror of the programmatic plane's driveLane threading
    // (programmatic/workflowController.ts runFanOut: allowedStepIds = inner ids,
    // widened with AWAITING_VERIFY_STEP for the merge-gate park step). Resolve the
    // CALLING run's chain-derived vocabulary instead of validating against the
    // fixed SPRINT_LANE_STEP_IDS default. Fail-soft: an unresolvable run/definition
    // or a definition with no fanOut step yields `undefined`, so
    // SprintLaneStore.updateLane degrades to today's canonical default — never
    // fail-closed.
    const inner = resolveRunFanOutInner(this.db, msg.runId);
    const allowedStepIds = inner ? [...inner.map((s) => s.id), AWAITING_VERIFY_STEP] : undefined;

    try {
      const lane = SprintLaneStore.getInstance().updateLane({
        runId: msg.runId,
        batchId,
        taskId: msg.taskId,
        ...(msg.status !== undefined ? { status: msg.status } : {}),
        ...(msg.currentStepId !== undefined ? { currentStepId: msg.currentStepId } : {}),
        ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
        ...(allowedStepIds !== undefined ? { allowedStepIds } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          batch_id: lane.batchId,
          task_id: lane.taskId,
          status: lane.status,
          current_step_id: lane.currentStepId,
          attempts: lane.attempts,
          ref: lane.ref,
          title: lane.title,
          updated_at: lane.updatedAt,
        },
      });
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a lane-store failure as an ok:false response. A SprintLaneError
   * maps to its discriminated .code (mirrors writeTaskChangeError); anything
   * else is logged and collapsed to the opaque 'sprint_lane_failed'.
   */
  private writeSprintLaneError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof SprintLaneError) {
      // A createForRun 'no_eligible_tasks' (candidates exist but all failed the
      // eligibility guard) surfaces as the SAME ship-facing code the empty-set path
      // uses, so the ship agent gets one actionable signal. The WHY detail rides in
      // err.message (logged here — the wire response carries only the code string).
      if (err.code === 'no_eligible_tasks') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: no eligible tasks', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_no_tasks_to_materialize',
        });
        return;
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] sprint lane update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'sprint_lane_failed',
    });
  }

  // --------------------------------------------------------------------------
  // Mid-run sprint-batch materialization (cyboflow_create_sprint_batch)
  //
  // The HANDOFF SEAM for the 'ship' workflow: planner decomposition flows
  // directly into sprint execution in ONE continuous run. At the
  // 'materialize-batch' step the orchestrator calls this tool with the
  // human-approved task subset (from the approve-plan gate); the handler mints
  // the sprint batch + per-task lanes and stamps workflow_runs.batch_id MID-RUN
  // (RunLauncher only stamps it at launch for a seed-task sprint). Once batch_id
  // is non-null, the per-lane cyboflow_update_sprint_task writes succeed
  // (handleUpdateSprintTask reads batch_id live) and the swimlane canvas renders
  // (CyboflowRoot keys off activeRun.batch_id).
  //
  // IDEMPOTENT + transactional: a crash/resume re-call must not orphan a second
  // batch or reset lane status. Steps 2-7 (idempotency read → subset resolve →
  // empty/cap guards → createForRun → compare-and-set stamp) run in ONE
  // better-sqlite3 transaction; createForRun mints its own nested transaction
  // (savepoint), which composes safely.
  // --------------------------------------------------------------------------

  /**
   * Mint the sprint batch + lanes from the run's approved tasks and stamp
   * workflow_runs.batch_id, once.
   *
   * Guards (in order):
   *   1. resolveTaskRunContext — sentinel / missing / terminal run reject
   *      (parity with the other run-bound writes).
   *   2. IDEMPOTENCY — a run whose batch_id is already set returns
   *      { ok:true, batch_id, created:false } WITHOUT re-minting.
   *   3. SUBSET — the passed taskIds intersected with listRunCreatedTaskIds
   *      (ids the run did not create are dropped); the full created set when no
   *      subset is passed.
   *   4. EMPTY — no resolvable tasks → ok:false 'ship_no_tasks_to_materialize'.
   *   5. CAP backstop — more tasks than SPRINT_BATCH_MAX_TASKS[substrate] →
   *      ok:false 'ship_batch_too_large' (the human gate is the primary control).
   *   6. createForRun(projectId, substrate, taskIds) → { batchId }.
   *   7. COMPARE-AND-SET — UPDATE workflow_runs SET batch_id WHERE id AND
   *      batch_id IS NULL (a concurrent stamp loses, never double-mints).
   * On success emits a run-status-changed signal so activeRunsStore re-fetches
   * runs.list (now carrying batch_id) and the swimlane canvas mounts.
   */
  private handleCreateSprintBatch(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-sprint-batch' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // Resolve the run's substrate (cap is substrate-keyed). Read defensively —
    // a pre-migration-013 DB lacking the column degrades to the 'sdk' default.
    let substrate: CliSubstrate = 'sdk';
    try {
      const subRow = this.db
        .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
        .get(msg.runId) as { substrate?: unknown } | undefined;
      if (subRow?.substrate === 'interactive') {
        substrate = 'interactive';
      }
    } catch {
      // Pre-migration-013 DB (no substrate column) — keep the 'sdk' default.
    }

    type Outcome =
      | { ok: true; batchId: string; created: boolean }
      | { ok: false; error: string };

    let outcome: Outcome;
    try {
      // Steps 2-7 in ONE transaction so a re-call cannot orphan a batch or
      // reset lane status. createForRun mints a nested savepoint internally.
      const txn = this.db.transaction((): Outcome => {
        // 2. IDEMPOTENCY — already materialized → no re-mint.
        const runRow = this.db
          .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
          .get(msg.runId) as { batchId?: unknown } | undefined;
        const existingBatchId =
          typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
        if (existingBatchId) {
          return { ok: true, batchId: existingBatchId, created: false };
        }

        // 3. SUBSET — intersect the passed ids with the run's created tasks (drop
        // any id the run did not create); fall back to the full created set. The
        // agent may pass DISPLAY REFS (e.g. 'TASK-034'), which never equal the opaque
        // 'tsk_' ids in the created set — so resolve each passed handle ref-or-id →
        // opaque id BEFORE the intersection (parity with add_task_dependency /
        // update_sprint_task ref resolution via resolveBacklogRef). An opaque id that
        // is already in the created set is kept as-is; anything else is resolved as a
        // display ref (project-scoped) and re-tested, so a real ref matches and a
        // bogus handle still drops out.
        const createdTaskIds = listRunCreatedTaskIds(this.db, msg.runId);
        let taskIds: string[];
        if (msg.taskIds && msg.taskIds.length > 0) {
          const createdSet = new Set(createdTaskIds);
          const resolved = [...new Set(msg.taskIds)].map((handle) =>
            createdSet.has(handle) ? handle : (resolveBacklogRef(this.db, ctx.projectId, handle) ?? handle),
          );
          taskIds = resolved.filter((id) => createdSet.has(id));
        } else {
          taskIds = createdTaskIds;
        }

        // 4. EMPTY guard.
        if (taskIds.length === 0) {
          return { ok: false, error: 'ship_no_tasks_to_materialize' };
        }

        // 5. CAP backstop (defense — the human gate is the primary control).
        if (taskIds.length > SPRINT_BATCH_MAX_TASKS[substrate]) {
          return { ok: false, error: 'ship_batch_too_large' };
        }

        // 6. Mint the batch + lanes via the SprintLaneStore chokepoint.
        const { batchId } = SprintLaneStore.getInstance().createForRun(ctx.projectId, substrate, taskIds);

        // 7. COMPARE-AND-SET the stamp (only when still NULL).
        this.db
          .prepare(
            'UPDATE workflow_runs SET batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND batch_id IS NULL',
          )
          .run(batchId, msg.runId);

        return { ok: true, batchId, created: true };
      });
      outcome = (txn as () => Outcome)();
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
      return;
    }

    if (!outcome.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: outcome.error,
      });
      return;
    }

    // Move the materialized batch's tasks to 'In development' (migration 066):
    // capture entry stage + derive execution stage per lane. Idempotent, so both
    // the created:true and idempotent created:false paths recompute. Fire-and-
    // forget + best-effort — a task-side failure (or an uninitialized router) must
    // never invalidate the committed batch or block the synchronous response.
    try {
      void TaskChangeRouter.getInstance()
        .recomputeTasksForBatch(outcome.batchId)
        .catch((err: unknown) => {
          this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation failed', {
            runId: msg.runId,
            batchId: outcome.batchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err: unknown) {
      this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation unavailable', {
        runId: msg.runId,
        batchId: outcome.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 8. Emit a run-row-changed signal so activeRunsStore re-fetches runs.list
    // (now carrying batch_id) and the swimlane canvas mounts. The run stays
    // active; we re-assert its 'running' status. Best-effort — never let an
    // emit failure invalidate the committed batch.
    if (outcome.created) {
      try {
        runStatusEvents.emit('changed', {
          runId: msg.runId,
          status: 'running',
        } satisfies RunStatusChangedEvent);
      } catch (emitErr) {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch run-status emit failed', {
          runId: msg.runId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }

      // Retire the run's owned idea(s) to the Decomposed terminal stage. Ship has
      // no planner-style human Archive gate (its terminal `decompose` step is
      // dropped), so without this a shipped idea lingers forever in its planning
      // stage even though its tasks now carry the flow. Fired here — AFTER the
      // human-approved plan is materialized into sprint lanes — and fire-and-forget
      // + best-effort: a failure must never invalidate the committed batch or block
      // the synchronous response below.
      void this.retireRunOwnedIdeas(ctx.projectId, msg.runId);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { batch_id: outcome.batchId, created: outcome.created },
    });
  }

  /**
   * Retire every idea the run actually DECOMPOSED (via listRunDecomposedIdeaIds —
   * an owned idea with >=1 run-created child carrying its originating_idea_id
   * lineage; a seeded-but-childless idea in a multi-idea run is left on the board)
   * to the Decomposed terminal stage. The ship handoff seam's follow-on — see
   * handleCreateSprintBatch. Best-effort: each retire is idempotent (a no-op when
   * the idea is already at Decomposed) and individually guarded so one failure
   * can't starve the rest, and the whole pass is swallowed so it can never
   * invalidate the already-committed batch.
   */
  private async retireRunOwnedIdeas(projectId: number, runId: string): Promise<void> {
    try {
      const router = TaskChangeRouter.getInstance();
      for (const ideaId of listRunDecomposedIdeaIds(this.db, runId)) {
        await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
          /* per-idea best-effort */
        });
      }
    } catch {
      /* best-effort housekeeping — never disturb the committed batch */
    }
  }

  // --------------------------------------------------------------------------
  // Review-item write (cyboflow_report_finding)
  //
  // Findings (and decisions / human_tasks) emitted by Sprint agents route
  // through the SINGLE review-queue chokepoint ReviewItemRouter.applyReviewItem —
  // they NEVER INSERT review_items directly. The item is NON-BLOCKING by default
  // (a finding never pauses the run): the handler validates the run context +
  // payload SYNCHRONOUSLY (so a bad request surfaces immediately), then enqueues
  // the create and writes the ok:true response WITHOUT awaiting the per-project
  // queue — the agent's run continues regardless of inbox contention. The soft
  // entity-link and per-kind-payload-discriminant validations are enforced INSIDE
  // applyReviewItem and surface as ReviewItemError.code via writeReviewItemError.
  // --------------------------------------------------------------------------

  /**
   * Resolve the calling run into the project scope + agent actor needed to create
   * a review item. Mirrors resolveTaskRunContext exactly:
   *   - the 'orchestrator' sentinel runId has no workflow_runs row → reject
   *     before any DB touch (finding_requires_real_run);
   *   - a missing run row → run_not_found;
   *   - a terminal run (completed | failed | canceled) must not write findings →
   *     run_not_active.
   * Actor derivation mirrors TaskChangeRouter.resolveAgentLabel
   * (agent:<snapshot[step] | step | 'unknown'>).
   */
  private resolveReviewItemRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: ReviewActor } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'finding_requires_real_run' };
    }

    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, status, current_step_id AS currentStepId,
                steps_snapshot_json AS stepsSnapshotJson
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          projectId?: unknown;
          status?: unknown;
          currentStepId?: unknown;
          stepsSnapshotJson?: unknown;
        }
      | undefined;

    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }

    const status = typeof row.status === 'string' ? row.status : '';
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return { ok: false, error: 'run_not_active' };
    }

    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    const currentStepId = typeof row.currentStepId === 'string' ? row.currentStepId : null;
    const stepsSnapshotJson = typeof row.stepsSnapshotJson === 'string' ? row.stepsSnapshotJson : null;

    let label = 'unknown';
    if (currentStepId && stepsSnapshotJson) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        const agent = snapshot[currentStepId];
        if (typeof agent === 'string' && agent.length > 0) {
          label = resolveStepAgentKey(currentStepId, agent) ?? agent;
        } else {
          label = currentStepId;
        }
      } catch {
        label = currentStepId;
      }
    } else if (currentStepId) {
      label = currentStepId;
    }

    const actor: ReviewActor = `agent:${label}`;
    return { ok: true, projectId, actor };
  }

  /**
   * Report a finding/decision/human_task into the unified review queue.
   *
   * NON-BLOCKING contract: the run is never paused on the inbox. This handler
   * validates the run context AND parses/validates payload_json SYNCHRONOUSLY
   * (so a bad request fails fast), then fires ReviewItemRouter.applyReviewItem
   * and writes the ok:true response IMMEDIATELY — it does NOT await the
   * per-project queue. A late chokepoint rejection (e.g. invalid_entity from the
   * soft-link guard) is logged but cannot retroactively block the already-replied
   * run; the synchronous validations below catch the common misuse before reply.
   */
  private handleReportFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // 'notification' is orchestrator-minted only (agents cannot file one), so the
    // MCP report_finding tool excludes it alongside 'permission'.
    const kind: Exclude<ReviewItemKind, 'permission' | 'notification'> = msg.kind ?? 'finding';

    // Soft entity-link guard (both set together or both omitted) — surfaced
    // synchronously through writeReviewItemError so the caller gets the SAME
    // 'invalid_entity' code the chokepoint would have thrown, but BEFORE we reply
    // ok:true (the non-blocking create cannot un-reply the run after the fact).
    if ((msg.entityType === undefined) !== (msg.entityId === undefined)) {
      this.writeReviewItemError(
        client,
        msg.requestId,
        new ReviewItemError('invalid_entity', 'entityType and entityId must be set together or both omitted'),
      );
      return;
    }

    // Parse + validate the per-kind payload BEFORE the async create. The
    // discriminant must equal `kind` (the same check the chokepoint runs); doing
    // it here keeps the malformed-payload rejection synchronous.
    let payload: ReviewItemPayload | null = null;
    if (msg.payloadJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payloadJson);
      } catch {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', 'payload_json is not valid JSON'),
        );
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { kind?: unknown }).kind !== kind
      ) {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', `payload.kind does not match item kind '${kind}'`),
        );
        return;
      }
      payload = parsed as ReviewItemPayload;
    }

    // Fold the structured finding extras (category / locations / suggestedFix /
    // impact) into the FindingPayload. These arrive UNVALIDATED from the MCP tool
    // (typed `unknown`); each shape is guarded and a malformed member is DROPPED
    // rather than erroring — an agent typo must never fail a non-blocking finding
    // write. Extras only apply to kind='finding'; for other kinds they are ignored.
    // An explicit payloadJson (parsed above) is the base; extras override per-field.
    if (kind === 'finding') {
      const extras = buildFindingExtras(msg);
      if (Object.keys(extras).length > 0) {
        const base: FindingPayload =
          payload !== null && payload.kind === 'finding' ? payload : { kind: 'finding' };
        payload = { ...base, ...extras };
      }
    }

    const create: ReviewItemCreate = {
      op: 'create',
      actor: ctx.actor,
      kind,
      title: msg.title,
      body: msg.body,
      blocking: msg.blocking ?? false,
      severity: msg.severity ?? null,
      source: ctx.actor,
      entityType: msg.entityType ?? null,
      entityId: msg.entityId ?? null,
      runId: msg.runId,
      payload,
    };

    // Fire-and-forget: the run is NEVER gated on the inbox. A late failure is
    // logged (it cannot un-reply the run), but the synchronous validations above
    // already caught the common misuse, so this path is for genuine DB faults.
    void ReviewItemRouter.getInstance()
      .applyReviewItem(ctx.projectId, create)
      .catch((err) => {
        this.logger?.error('[Cyboflow MCP Query] review-item create failed (non-blocking)', {
          runId: msg.runId,
          error: err instanceof ReviewItemError ? err.code : err instanceof Error ? err.message : String(err),
        });
      });

    // Reply IMMEDIATELY — do not await the queue.
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { accepted: true, kind, blocking: msg.blocking ?? false },
    });
  }

  // --------------------------------------------------------------------------
  // Compound-run findings (cyboflow_get_selected_findings / _resolve_finding)
  //
  // The triage tray seeds a compound run with the EXACT findings the human
  // selected (workflow_runs.seed_finding_ids, migration 034). These two handlers
  // let the seeded compound agent re-read that set and resolve each finding as it
  // acts on it. get-selected-findings is READ-ONLY; resolve-finding routes the
  // resolve through the SINGLE review-item chokepoint and is AWAITED (so a failed
  // resolve surfaces — diverging from the fire-and-forget report-finding path).
  // Both reuse the run-context guard, so they are callable only mid-run
  // (resolveReviewItemRunContext rejects terminal runs with run_not_active).
  // --------------------------------------------------------------------------

  /**
   * Return the findings the human seeded into THIS compound run, read from
   * workflow_runs.seed_finding_ids and shaped via selectFindingForSeed. Read-only
   * — never writes. Replies { findings: [] } when the column is null/unparseable
   * or no id resolves to a finding (a fail-soft empty set, not an error).
   */
  private handleGetSelectedFindings(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-selected-findings' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const runRow = this.db
      .prepare('SELECT seed_finding_ids AS seedFindingIds FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { seedFindingIds?: unknown } | undefined;
    const seedJson =
      typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
        ? runRow.seedFindingIds
        : null;

    let ids: string[] = [];
    if (seedJson) {
      try {
        const parsed: unknown = JSON.parse(seedJson);
        if (Array.isArray(parsed)) {
          ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
      } catch {
        // Unparseable seed → fail-soft empty set (no error to the agent).
        ids = [];
      }
    }

    const findings = ids
      .map((id) => selectFindingForSeed(this.db, id))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { findings },
    });
  }

  /**
   * Resolve a finding the compound run consumed. Builds the resolution string
   * from resolutionKind using the SHARED prefix consts (never hand-typed, so the
   * parseResolutionKind convention cannot drift), routes the resolve through the
   * ReviewItemRouter chokepoint, and AWAITs it — a failed resolve must surface to
   * the agent rather than silently leave the finding pending.
   *
   * Mid-run-only: resolveReviewItemRunContext returns run_not_active for a
   * terminal run, so the agent must call this immediately after each finding's
   * action lands (NOT batched at run end); the RunExecutor terminal-seam close-out
   * is the safety net for whatever was missed.
   */
  private async handleResolveFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-resolve-finding' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // Build the resolution from the matching prefix const. 'promoted' carries the
    // minted task id (mirrors the promote-to-task path); 'fixed'/'triaged' carry
    // the optional free-text note (e.g. 'compound') when present.
    let resolution: string;
    if (msg.resolutionKind === 'promoted') {
      const tail = msg.taskId ?? msg.note ?? '';
      resolution = `${RESOLUTION_PREFIX_PROMOTED}${tail}`;
    } else if (msg.resolutionKind === 'fixed') {
      resolution = `${RESOLUTION_PREFIX_FIXED}${msg.note ?? ''}`;
    } else {
      resolution = `${RESOLUTION_PREFIX_TRIAGED}${msg.note ?? ''}`;
    }

    const triage: ReviewItemTriage = {
      op: 'resolve',
      actor: ctx.actor,
      reviewItemId: msg.reviewItemId,
      resolution,
      runId: msg.runId,
    };

    try {
      // AWAIT — a failed resolve must surface (diverges from fire-and-forget
      // report-finding so the agent can retry rather than silently move on).
      await ReviewItemRouter.getInstance().applyReviewItem(ctx.projectId, triage);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { resolved: true, review_item_id: msg.reviewItemId },
      });
    } catch (err) {
      this.writeReviewItemError(client, msg.requestId, err);
    }
  }

  /**
   * Create (or idempotently re-derive) a run artifact via the ArtifactRouter
   * chokepoint. Unlike report-finding this AWAITS the write so it can reply with
   * the artifact id (the agent needs it to enrich/commit later). The project +
   * actor are resolved from the run; the artifact is minted isNew so its tab
   * pulses until focused.
   */
  private async handleReportArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const actor: ArtifactActor = ctx.actor === 'linear' ? 'agent:unknown' : ctx.actor;
    try {
      // Content-blesser (IDEA-039 / Approach C). This handler is the SOLE
      // authority on ui-prototype/generic payload content:
      //   - both atypes REJECT any inline top-level `html` key (a static mockup is
      //     an on-disk file, never inline bytes on the artifact row);
      //   - `ui-prototype` additionally validates the on-disk static document and
      //     MINTS the canonical `{ fileName: 'prototype/index.html' }` pointer,
      //     discarding whatever path/payload the producing agent claimed.
      // `generic` keeps its `{ url }` passthrough (html-reject only). The run
      // artifacts dir is derived from the TRUSTED runId — CYBOFLOW_RUN_ARTIFACTS_DIR
      // is never read here.
      let payloadJson: string | null = msg.payloadJson ?? null;
      if (msg.atype === 'ui-prototype' || msg.atype === 'generic') {
        const parsed = this.parseArtifactPayload(msg.payloadJson);
        if (parsed !== null && Object.prototype.hasOwnProperty.call(parsed, 'html')) {
          throw new ArtifactError(
            'invalid_payload',
            `inline 'html' is not accepted for atype '${msg.atype}' — write a self-contained static document to ${PROTOTYPE_HTML_RELPATH} and report a fileName pointer`,
          );
        }
        if (msg.atype === 'ui-prototype') {
          this.validatePrototypeFile(msg.runId);
          payloadJson = JSON.stringify({ fileName: PROTOTYPE_HTML_RELPATH });
        }
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'create',
        runId: msg.runId,
        atype: msg.atype,
        label: msg.label,
        payloadJson,
        isNew: true,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, atype: msg.atype },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  /**
   * Parse an artifact `payload_json` string into a plain object for the
   * content-blesser's `html`-key check. Fail-soft: unparseable / non-object /
   * absent JSON reads as `null` (no `html` key), so a malformed payload never
   * throws here — only an EXPLICIT top-level `html` member is rejected upstream.
   */
  private parseArtifactPayload(payloadJson: string | undefined): Record<string, unknown> | null {
    if (payloadJson === undefined) return null;
    try {
      const parsed = JSON.parse(payloadJson) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate the on-disk static `ui-prototype` document under the run's TRUSTED
   * artifacts dir (`getCyboflowSubdirectory('artifacts','runs',runId)` — NEVER
   * `process.env.CYBOFLOW_RUN_ARTIFACTS_DIR`): the canonical `prototype/index.html`
   * must exist, be a regular file (no symlink), stay inside the run artifacts root
   * (containment + realpath re-verify against an intermediate symlinked dir), and
   * sit at or below the size ceiling. Throws `ArtifactError('invalid_payload',
   * 'prototype_missing|prototype_invalid|prototype_too_large: …')` on any failure
   * so the report tool surfaces a precise reason to the producing agent.
   */
  private validatePrototypeFile(runId: string): void {
    const runRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'runs', runId));
    const target = path.resolve(runRoot, PROTOTYPE_HTML_RELPATH);
    // Containment on the resolved (pre-realpath) path — defense in depth even
    // though PROTOTYPE_HTML_RELPATH is a fixed constant.
    if (target !== runRoot && !target.startsWith(runRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} escapes the run artifacts root`);
    }
    if (!existsSync(target)) {
      throw new ArtifactError('invalid_payload', `prototype_missing: ${PROTOTYPE_HTML_RELPATH} not found for run ${runId}`);
    }
    const lst = lstatSync(target);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    // Realpath re-verify: an intermediate symlinked dir must not let the file
    // escape the run artifacts root (both sides realpath'd so a symlinked temp
    // root — e.g. macOS /tmp → /private/tmp — is not a false escape).
    const realRoot = realpathSync(runRoot);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} resolves outside the run artifacts root`);
    }
    const st = statSync(realTarget);
    if (!st.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    if (st.size > MAX_PROTOTYPE_HTML_BYTES) {
      throw new ArtifactError('invalid_payload', `prototype_too_large: ${st.size} > ${MAX_PROTOTYPE_HTML_BYTES}`);
    }
  }

  /**
   * Commit a run artifact (flip committed) via the ArtifactRouter chokepoint.
   */
  private async handleCommitArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-commit-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const actor: ArtifactActor = ctx.actor === 'linear' ? 'agent:unknown' : ctx.actor;
    try {
      // The tool's optional `payload_json` ("store a final payload alongside the
      // commit") is applied as a SEPARATE `update` FIRST — commit itself is
      // IDENTITY-ONLY so a byte pointer can't be stripped mid-commit right before
      // the durability snapshot (see ArtifactCommit). ui-prototype's required byte
      // is canonical regardless of payload, so this ordering can't lose content.
      if (msg.payloadJson !== undefined) {
        await ArtifactRouter.getInstance().apply(ctx.projectId, {
          op: 'update',
          artifactId: msg.artifactId,
          payloadJson: msg.payloadJson,
          actor,
        });
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'commit',
        artifactId: msg.artifactId,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, committed: true },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Visual verification request (cyboflow_request_verification)
  //
  // FIRE-AND-CONTINUE producer seam (docs/proposals/visual-verification-design.md §"The
  // collision story" #1): resolve the run's IMMUTABLY-stamped verify posture
  // (migration 055 verify_enabled / verify_type / verify_chain), enqueue ONE
  // verification_requests row via the VerificationScheduler chokepoint, and reply
  // { requestId } SYNCHRONOUSLY — the lane is never held on the verdict. The
  // scheduler drains on its OWN setImmediate loop (NOT RunQueueRegistry), captures
  // + judges, and delivers the verdict asynchronously.
  //
  // Two invariants enforced here:
  //  - A run with verify_enabled=0 replies { skipped:true } — NEVER an error (a
  //    disabled run must not wedge a lane; mirrors the resolver's disabled posture).
  //  - typeOverride only NARROWS: the effective chain is intersected with the run's
  //    stamped verify_chain, so an override can neither enable a disabled run nor
  //    introduce a backend the host lacks (the stamped chain is the host-available
  //    set the resolver already filtered).
  // --------------------------------------------------------------------------

  /**
   * Narrow the camelCase viewports wire value to VerificationRequestInput.viewports,
   * keeping only well-formed entries ({ width:number, height:number, label?:string })
   * and dropping malformed ones. Returns undefined when the input is not an array OR
   * no entry survives — an agent typo never fails a fire-and-continue request.
   */
  private parseViewports(v: unknown): VerificationRequestInput['viewports'] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out: NonNullable<VerificationRequestInput['viewports']> = [];
    for (const entry of v) {
      if (!isRecord(entry) || typeof entry.width !== 'number' || typeof entry.height !== 'number') continue;
      out.push(
        typeof entry.label === 'string'
          ? { width: entry.width, height: entry.height, label: entry.label }
          : { width: entry.width, height: entry.height },
      );
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Enqueue a visual-verification request for the run and reply { requestId }, or
   * { skipped:true } when the run has verify disabled. Synchronous (no await on the
   * verdict). Guards mirror the other run-bound writes (sentinel / missing /
   * terminal run reject via resolveReviewItemRunContext). Fully fail-soft: any
   * unexpected error is surfaced as an ok:false reply rather than throwing.
   */
  private handleRequestVerification(
    msg: Extract<McpQueryMessage, { type: 'mcp-request-verification' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // Read the run's IMMUTABLE verify stamp (migration 055). Read defensively — a
    // pre-036 DB lacking the columns degrades to a disabled posture (skipped).
    let enabled = false;
    let stampedType: VerificationType | null = null;
    let stampedChain: VisualBackendId[] = [];
    try {
      const row = this.db
        .prepare(
          `SELECT verify_enabled AS verifyEnabled, verify_type AS verifyType, verify_chain AS verifyChain
             FROM workflow_runs WHERE id = ?`,
        )
        .get(msg.runId) as { verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown } | undefined;
      enabled = row?.verifyEnabled === 1 || row?.verifyEnabled === true;
      stampedType = isVerificationType(row?.verifyType) ? row.verifyType : null;
      stampedChain = this.parseStampedChain(row?.verifyChain);
    } catch {
      // Pre-migration-036 DB (no verify columns) — keep the disabled default.
      enabled = false;
    }

    // Disabled run → no-op SKIP (never an error). A typeOverride cannot enable it.
    if (!enabled || stampedType === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { skipped: true },
      });
      return;
    }

    // Effective type: a valid typeOverride NARROWS to its own type; otherwise the
    // run's stamped type. (Validity is already guaranteed by the wire union, but we
    // re-guard since the field flows in untrusted across the socket.)
    const effectiveType: VerificationType = isVerificationType(msg.typeOverride) ? msg.typeOverride : stampedType;

    // Effective chain = FALLBACK_CHAINS[effectiveType] ∩ the run's stamped chain
    // (the host-available set the resolver already filtered). The intersection is
    // why typeOverride can only NARROW — it can never reach a backend the host lacks.
    // Order follows FALLBACK_CHAINS (easy→hard). An empty intersection still enqueues
    // (the scheduler treats an empty chain as a SKIP, never a fabricated fail).
    const chain = FALLBACK_CHAINS[effectiveType].filter((backend) => stampedChain.includes(backend));

    // Build the deliverable input, dropping any malformed optional members.
    const input: VerificationRequestInput = { intent: msg.intent };
    if (typeof msg.url === 'string') input.url = msg.url;
    if (typeof msg.htmlPath === 'string') input.htmlPath = msg.htmlPath;
    if (typeof msg.baselineKey === 'string') input.baselineKey = msg.baselineKey;
    // taskRef threads the lane attribution into deliverable_json so the async
    // merge-gate verdict can be driven onto the right lane (multi-lane batches).
    // When the agent OMITS it, best-effort default it from the lane context WHEN
    // unambiguous (a single-lane batch) — a belt-and-suspenders mitigation for the
    // gate's strict attribution (locked decision #2). A multi-lane batch CANNOT be
    // defaulted here (the wire carries no itemId), so it stays absent and the
    // gate's single-lane-only rule for a taskRef-less event is the invariant.
    if (typeof msg.taskRef === 'string' && msg.taskRef.length > 0) {
      input.taskRef = msg.taskRef;
    } else {
      const defaulted = this.defaultTaskRefForRun(msg.runId);
      if (defaulted !== undefined) input.taskRef = defaulted;
    }
    const viewports = this.parseViewports(msg.viewports);
    if (viewports !== undefined) input.viewports = viewports;

    try {
      const requestId = VerificationScheduler.getInstance().enqueue({
        runId: msg.runId,
        projectId: ctx.projectId,
        type: effectiveType,
        input,
        chain,
      });
      // Reply SYNCHRONOUSLY (the lane continues), then kick the drain loop. enqueue
      // already nudges; the extra nudge is harmless (coalesced) and makes the
      // fire-and-continue contract explicit.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { requestId, type: effectiveType },
      });
      VerificationScheduler.getInstance().nudge();
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] request-verification enqueue failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_enqueue_failed',
      });
    }
  }

  /**
   * Best-effort default for an OMITTED task_ref (locked decision #2 mitigation):
   * the sole lane's display ref (or opaque task id) when the calling run is a
   * batched sprint run with EXACTLY ONE lane — the only case a taskRef-less
   * request is unambiguous. A non-batch run, a run whose batch has zero or 2+
   * lanes, or any read failure returns undefined (the request stays taskRef-less
   * and the gate's strict attribution applies). Fully fail-soft — a defaulting
   * hiccup never fails a fire-and-continue request.
   */
  private defaultTaskRefForRun(runId: string): string | undefined {
    try {
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return undefined;
      const lanes = SprintLaneStore.getInstance().listLanes(batchId);
      if (lanes.length !== 1) return undefined; // multi-lane cannot be defaulted; non-lane run has none
      const only = lanes[0];
      return typeof only.ref === 'string' && only.ref.length > 0 ? only.ref : only.taskId;
    } catch {
      return undefined;
    }
  }

  /** Parse the run's stamped verify_chain JSON into a VisualBackendId[]; [] on null/malformed. */
  private parseStampedChain(v: unknown): VisualBackendId[] {
    if (typeof v !== 'string' || v.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Surface an ArtifactError code (or a generic message) as an ok:false reply. */
  private writeArtifactError(client: net.Socket, requestId: string, err: unknown): void {
    const error =
      err instanceof ArtifactError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    this.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
  }

  /**
   * Surface a review-item failure as an ok:false response. A ReviewItemError maps
   * to its discriminated .code (mirrors writeTaskChangeError); anything else is
   * logged and collapsed to the opaque 'review_item_failed'.
   *
   * Used by the SYNCHRONOUS pre-create validations on the report-finding path
   * (entity-link + payload-discriminant), which construct ReviewItemError so the
   * codes are single-sourced from the chokepoint's error type. The async create
   * itself is fire-and-forget (the run is already replied to), so a late
   * chokepoint rejection there is logged, not written through this helper.
   */
  private writeReviewItemError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof ReviewItemError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] review item failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'review_item_failed',
    });
  }

  // --------------------------------------------------------------------------
  // shell-approval-request (interactive substrate, IDEA-013 S5 / TASK-810)
  // --------------------------------------------------------------------------

  // OBSERVE-ONLY sprint-lane auto-derive lives in SprintLaneStore
  // .deriveLaneFromTaskDispatch (substrate-agnostic, shared with the SDK
  // PreToolUse seam in preToolUseHookHelper.ts). handleShellApprovalRequest
  // invokes it for the INTERACTIVE substrate; see the call at the top of that
  // method.

  /**
   * Async-deferred PreToolUse gate for the INTERACTIVE substrate.
   *
   * Unlike every other branch in this handler, this one does NOT writeResponse
   * synchronously. The hook subprocess (preToolUseShellHook.ts) blocks on the
   * held-open socket for the FULL human-decision window; we reply only once the
   * verdict is known — via the socketReply closure passed to requestApproval,
   * possibly minutes later. The per-connection socket therefore stays alive
   * across the wait (TASK-798's fire-and-forget dispatch tolerates this).
   *
   * Flow (mirrors the SDK PreToolUse hook at claudeCodeManager.ts:572-587):
   *   (a) reject the 'orchestrator' sentinel runId (parity with the checkpoint /
   *       report-step guards) — a deny with no approvals row;
   *   (a2) acceptEdits fast-path (Step F): when the run's effective mode (from
   *       permission_mode_snapshot) is 'acceptEdits' and the tool is in the
   *       acceptEdits auto-approve surface (Edit/Write/MultiEdit + the widened
   *       read-only surface — safe reads + provably read-only Bash/git, via
   *       isAcceptEditsAutoApprovable), AUTO-ALLOW with ZERO approvals row and NO
   *       folded review_item — SDK-mapper parity, applied BEFORE the allow-list check;
   *   (b) apply isToolAllowed(loadMergedPermissionRules(worktree)) and
   *       short-circuit ALLOW with ZERO approvals row (no double-prompt);
   *   (c) otherwise route through ApprovalRouter.requestApproval, writing the
   *       verdict back on the held-open socket from the socketReply closure.
   *
   * The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
   * interactive settingsWriter opt-out), so this handler is only reached under
   * 'default' (full gate) and 'acceptEdits' (the (a2) fast-path + gate for
   * non-edit tools).
   *
   * P4 fold: requestApproval co-writes a blocking permission review_item into the
   * unified inbox (source 'approval:interactive') inside its own transaction. The
   * socket-held-open contract is UNCHANGED — the review_item is purely additive
   * and the socketReply closure remains the only place a verdict is written.
   *
   * CYBOFLOW_RUN_ID precondition (TASK-800): if runId is not a real
   * workflow_runs.id (e.g. still the Claude session UUID), requestApproval's
   * guarded UPDATE finds changes===0 → RunNotRunningError → we surface a logged
   * precondition failure and reply deny — never a silent swallow.
   *
   * AskUserQuestion is intentionally NOT special-cased here: a shell PreToolUse
   * hook has no `updatedInput` channel, so QuestionRouter is never wired on this
   * substrate (native-TUI-only, Probe A2). It simply routes as a normal gate.
   */
  private handleShellApprovalRequest(
    msg: Extract<McpQueryMessage, { type: 'shell-approval-request' }>,
    client: net.Socket,
  ): void {
    // AUTO-DERIVE sprint lane steps (observe-only). Fire-and-forget side-effect:
    // never writes to the socket, never alters the allow/deny verdict. Runs
    // BEFORE the gating flow so it is independent of the verdict path; the store
    // method is a strict no-op for non-sprint runs / non-Task tools / unknown
    // subagent_types / ambiguous attribution. getInstance() is wrapped because
    // some handler tests never initialize SprintLaneStore — a missing store must
    // not disturb the deny-gating contract below (byte-for-byte unchanged).
    try {
      SprintLaneStore.getInstance().deriveLaneFromTaskDispatch({
        runId: msg.runId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
      });
    } catch {
      // SprintLaneStore not initialized — auto-derive is best-effort.
    }

    // (a) Orchestrator-sentinel guard — mirrors handleSubmitCheckpoint /
    // handleReportStep. The singleton MCP server runs with
    // CYBOFLOW_RUN_ID='orchestrator', which has no workflow_runs row.
    if (msg.runId === 'orchestrator') {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'deny' });
      return;
    }

    // (a2) acceptEdits fast-path (Step F): when the run's effective 4-mode is
    // 'acceptEdits' and the tool is in the acceptEdits auto-approve surface
    // (Edit/Write/MultiEdit + the widened read-only surface), AUTO-ALLOW with
    // ZERO approvals row and NO folded review_item — parity with the SDK mapper's
    // acceptEdits branch (permissionModeMapper.ts shares the SAME
    // isAcceptEditsAutoApprovable predicate). This runs BEFORE the allow-list
    // check so a safe edit/read never needs a permissions.allow entry.
    //
    // The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
    // settingsWriter opt-out — interactiveClaudeManager.ts), so the hook does not
    // fire and this handler is not reached for them; 'default' falls through to
    // the existing allow-list + router gate unchanged.
    const effectiveMode = this.resolveRunPermissionMode(msg.runId);
    if (
      effectiveMode === 'acceptEdits' &&
      isAcceptEditsAutoApprovable(msg.toolName, msg.toolInput)
    ) {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
      return;
    }

    // (b) Resolve runId → worktree (the run cwd) for the allow-list lookup.
    const worktree = this.resolveRunWorktree(msg.runId);
    if (worktree !== null) {
      try {
        const rules = loadMergedPermissionRules(worktree);
        if (isToolAllowed(msg.toolName, msg.toolInput, rules)) {
          // SDK parity: auto-allow with ZERO approvals row, no router round-trip.
          this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
          return;
        }
      } catch (err) {
        // A settings-read failure must not crash the gate — fall through to the
        // router so the human is still asked (conservative, never auto-allow).
        this.logger?.warn(
          '[Cyboflow MCP Query] shell-approval allow-list check failed; routing to ApprovalRouter',
          { runId: msg.runId, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // (c) Route through ApprovalRouter. Register the held-open socket FIRST so a
    // disconnect during the (async) requestApproval transaction is observed.
    const entry = this.registerInFlightShellApproval(msg.runId, msg.requestId, client);

    const router = ApprovalRouter.getInstance();
    void router
      .requestApproval(
        msg.runId,
        msg.toolName,
        msg.toolInput,
        (decision) => {
          // socketReply: the ONLY place a verdict is written for this transport.
          // (Under the SDK path this closure is a no-op; the shell transport uses
          // it — load-bearing, held open across the human-decision window.)
          this.completeInFlightShellApproval(msg.runId, entry);
          this.writeShellVerdict(client, msg.requestId, decision);
        },
        // P4: stamp the folded permission review_item with the interactive
        // substrate provenance. The co-write happens inside requestApproval's
        // transaction (commit 1); the socketReply closure above is unchanged.
        'approval:interactive',
      )
      .then((decision) => {
        // requestApproval resolves with the SAME decision the socketReply got
        // (or a synthetic deny when the run was canceled before the socketReply
        // fired). If the socketReply never ran (cancel/supersede path), settle
        // the held-open socket so the PTY does not hang.
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          this.writeShellVerdict(client, msg.requestId, decision);
        }
      })
      .catch((err) => {
        // Precondition failure (TASK-800): a non-real runId binds a non-existent
        // workflow_runs row → guarded UPDATE changes===0 → RunNotRunningError.
        // Surface it loudly and fail closed (deny) rather than silently swallow.
        if (err instanceof RunNotRunningError) {
          this.logger?.error(
            '[Cyboflow MCP Query] shell-approval precondition failed: runId is not a running workflow_runs.id ' +
              '(is CYBOFLOW_RUN_ID the session UUID instead of workflow_runs.id?) — failing closed (deny)',
            { runId: msg.runId },
          );
        } else {
          this.logger?.error('[Cyboflow MCP Query] shell-approval requestApproval failed — failing closed (deny)', {
            runId: msg.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          this.writeShellVerdict(client, msg.requestId, {
            behavior: 'deny',
            message: 'cyboflow approval precondition failed',
          });
        }
      });
  }

  /**
   * Deny-and-close every in-flight shell-approval socket for `runId`.
   *
   * This is the transport-aware twin of ApprovalRouter.clearPendingForRun,
   * which deliberately does NOT invoke socketReply ("the run is being torn down;
   * the socket is no longer meaningful") — correct for the in-process SDK
   * transport but WRONG for the shell transport, where a real socket is blocking
   * a real PTY. The interactive manager's cleanupCliResources (TASK-808) calls
   * this BEFORE killing the PTY so the blocked hook subprocess unblocks; it then
   * calls clearPendingForRun to settle the router's DB rows.
   *
   * For each in-flight socket: write a deny verdict (so the hook's fail-closed
   * path fires) and end the connection. Idempotent — safe to call when nothing
   * is in flight.
   *
   * @returns the number of sockets denied/closed.
   */
  cancelInFlightShellApprovals(runId: string): number {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || set.size === 0) return 0;

    // Snapshot before mutating — completeInFlightShellApproval deletes entries.
    const entries = [...set];
    for (const entry of entries) {
      if (!this.completeInFlightShellApproval(runId, entry)) continue;
      try {
        this.writeShellVerdict(entry.client, entry.requestId, {
          behavior: 'deny',
          message: 'Run was canceled before approval could be processed',
        });
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] shell-approval cancel write failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        entry.client.end();
      } catch {
        // best-effort close
      }
    }
    this.logger?.debug('[Cyboflow MCP Query] denied in-flight shell-approval sockets on cancel', {
      runId,
      count: entries.length,
    });
    return entries.length;
  }

  // --------------------------------------------------------------------------
  // interactive-turn-end (INTERACTIVE substrate Stop hook, IDEA-030)
  // --------------------------------------------------------------------------

  /**
   * Fire-and-ack: unlike shell-approval-request, there is no verdict to defer
   * — the Stop hook (stopShellHook.ts) does not gate anything, it only reports
   * that a turn ended, and it already applies its OWN bounded wait for this ack.
   * Routes to the injected `onInteractiveTurnEnd` dep (absent in tests/hosts
   * that never wired it — e.g. a bare OrchSocketServer in a unit test), which
   * this layer cannot reach directly (ORCHESTRATOR LAYERING RULE: no
   * main/src/services imports here).
   *
   * `ok:true` iff a live interactive run for `runId` was found and notified;
   * `ok:false` with `error:'turn_end_unavailable'` when the dep is missing OR
   * it reports no matching run — either way the hook script (which exits 0
   * unconditionally regardless of this response) has nothing to act on.
   */
  private handleInteractiveTurnEnd(
    msg: Extract<McpQueryMessage, { type: 'interactive-turn-end' }>,
    client: net.Socket,
  ): void {
    const notified = typeof msg.runId === 'string' && msg.runId.length > 0
      ? (this.deps.onInteractiveTurnEnd?.(msg.runId) ?? false)
      : false;

    if (!notified) {
      this.logger?.debug('[Cyboflow MCP Query] interactive-turn-end had no effect', {
        runId: msg.runId,
        depWired: this.deps.onInteractiveTurnEnd !== undefined,
      });
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: notified,
      ...(notified ? {} : { error: 'turn_end_unavailable' }),
    });
  }

  /**
   * "Parked on an AskUserQuestion gate" signal from the interactive
   * PreToolUse(AskUserQuestion) notify hook. Flips the run's quick-session board
   * state to `blocked` via the injected dep (interactiveClaudeManager
   * .notifyQuestionOpen). Fire-and-ack — the hook never gates the question, so we
   * always reply `ok:true` (the notification is best-effort; a missing dep just
   * means the board won't show `blocked` for this PTY session).
   */
  private handleInteractiveQuestionOpen(
    msg: Extract<McpQueryMessage, { type: 'interactive-question-open' }>,
    client: net.Socket,
  ): void {
    if (typeof msg.runId === 'string' && msg.runId.length > 0) {
      this.deps.onInteractiveQuestionOpen?.(msg.runId);
    }
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
    });
  }

  /**
   * Resolve the run's worktree_path (the session/run cwd) for the allow-list
   * lookup. Returns null when the run row is absent (the precondition check in
   * requestApproval then surfaces the failure loudly).
   */
  private resolveRunWorktree(runId: string): string | null {
    const row = this.db
      .prepare(`SELECT worktree_path FROM workflow_runs WHERE id = ?`)
      .get(runId) as { worktree_path?: unknown } | undefined;
    if (!row || typeof row.worktree_path !== 'string' || row.worktree_path.length === 0) {
      return null;
    }
    return row.worktree_path;
  }

  /**
   * Resolve the run's effective 4-mode agentPermissionMode from its owning
   * SESSION (`sessions.agent_permission_mode`), keyed on the run via the
   * `workflow_runs → sessions` join (permission-mode redesign §3c#3). The
   * session is the execution authority; the `permission_mode_snapshot` column is
   * demoted to audit-only.
   *
   * Returns null when the run row is absent, the join misses (a legacy sentinel
   * whose `session_id` was never backfilled ⇒ LEFT JOIN yields NULL), or the
   * column holds an unrecognized value — the caller then falls through to the
   * existing allow-list + router gate (conservative; never auto-allows on an
   * unknown/absent mode). The join-miss case cannot strand a dontAsk/acceptEdits
   * session in prompt-everything beyond the first mint-on-read turn (the
   * sentinel's `session_id` is stamped at creation). Used by the acceptEdits
   * fast-path; the 'auto'/'dontAsk' modes never reach this handler (no shell hook
   * installed).
   */
  private resolveRunPermissionMode(runId: string): PermissionMode | null {
    const row = this.db
      .prepare(
        `SELECT s.agent_permission_mode AS m
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { m?: unknown } | undefined;
    const m: unknown = row?.m;
    return isPermissionMode(m) ? m : null;
  }

  /**
   * Register a held-open shell-approval socket so the disconnect-cleanup and
   * cancel paths can find it. Attaches one-shot 'close'/'error' listeners that
   * clear the pending approval if the socket dies before a verdict (so the run
   * does not leak in awaiting_review).
   */
  private registerInFlightShellApproval(
    runId: string,
    requestId: string,
    client: net.Socket,
  ): InFlightShellApproval {
    const onDisconnect = (): void => {
      // Socket died before a verdict (orchestrator-down / hook subprocess died).
      if (!this.completeInFlightShellApproval(runId, entry)) return;
      this.logger?.warn(
        '[Cyboflow MCP Query] shell-approval socket disconnected before verdict — clearing pending approval',
        { runId },
      );
      // Clear the pending approval so the run does not leak in awaiting_review.
      // clearPendingForRun is a no-op socketReply path (correct here — the socket
      // is already gone), and idempotently settles the DB row.
      try {
        ApprovalRouter.getInstance().clearPendingForRun(runId);
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] clearPendingForRun on disconnect failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    client.on('close', onDisconnect);
    client.on('error', onDisconnect);

    const entry: InFlightShellApproval = {
      client,
      requestId,
      detachListeners: () => {
        client.off('close', onDisconnect);
        client.off('error', onDisconnect);
      },
    };

    let set = this.inFlightShellApprovals.get(runId);
    if (!set) {
      set = new Set<InFlightShellApproval>();
      this.inFlightShellApprovals.set(runId, set);
    }
    set.add(entry);

    this.logger?.debug('[Cyboflow MCP Query] shell-approval registered (held open)', { runId, requestId });
    return entry;
  }

  /**
   * Remove an in-flight entry and detach its disconnect listeners.
   *
   * @returns true if THIS call removed a live entry (so the caller should write
   *   the verdict); false if the entry was already settled by a concurrent path
   *   (disconnect / cancel / a prior resolve) — the caller must then NOT write,
   *   preserving the exactly-once verdict contract.
   */
  private completeInFlightShellApproval(runId: string, entry: InFlightShellApproval): boolean {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || !set.has(entry)) return false;
    set.delete(entry);
    if (set.size === 0) this.inFlightShellApprovals.delete(runId);
    entry.detachListeners();
    return true;
  }

  /**
   * Write a PreToolUse verdict back to a held-open shell-approval socket. The
   * wire shape mirrors the synchronous branches:
   *   {type:'mcp-query-response',requestId,ok:true,data:{permissionDecision,...}}
   * The hook subprocess correlates the response by requestId on the shared socket.
   */
  private writeShellVerdict(
    client: net.Socket,
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    const data: { permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string } = {
      permissionDecision: decision.behavior,
      ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
    };
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: true,
      data,
    });
  }

  // --------------------------------------------------------------------------
  // Workflow + variant configuration (cyboflow_*_workflow / _variant)
  //
  // All reach the WorkflowRegistry through the injected `workflowConfig` dep
  // (absent → 'workflow_config_unavailable'). Reads/writes are keyed by global
  // workflow/variant ids; only handleListWorkflows uses the run's projectId (for
  // the built-in reconcile + union). Registry guard Errors are mapped to ok:false
  // codes by writeWorkflowConfigError, mirroring the workflows/variants tRPC
  // routers. WARNING: editing a built-in edits the single global row shared by
  // every project — the tool descriptions call this out.
  // --------------------------------------------------------------------------

  /**
   * Shared preamble for the config handlers: require the injected dep AND a real,
   * non-terminal run (resolveTaskRunContext rejects the 'orchestrator' sentinel /
   * missing / terminal runs). Returns the config surface + projectId, or null
   * after writing the appropriate ok:false response.
   */
  private resolveWorkflowConfig(
    msg: Extract<McpQueryMessage, { runId: string; requestId: string }>,
    client: net.Socket,
  ): { cfg: WorkflowConfigLike; projectId: number } | null {
    const cfg = this.deps.workflowConfig;
    if (!cfg) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'workflow_config_unavailable',
      });
      return null;
    }
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return null;
    }
    return { cfg, projectId: ctx.projectId };
  }

  /** Compact workflow projection (no spec_json blob — see get_workflow for the definition). */
  private static toCompactWorkflow(row: WorkflowRow): Record<string, unknown> {
    const specJson = typeof row.spec_json === 'string' ? row.spec_json.trim() : '';
    return {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      scope: row.project_id === null ? 'global' : 'project',
      is_built_in: row.project_id === null && isCyboflowWorkflowName(row.name),
      permission_mode: row.permission_mode,
      // A non-empty, non-'{}' spec_json means the row carries an edited/custom
      // definition (vs falling back to the built-in). The full graph is on
      // get_workflow, not here.
      has_custom_spec: specJson.length > 0 && specJson !== '{}',
      created_at: row.created_at,
    };
  }

  /** Compact variant projection (omits the spec_json / agent_overrides_json blobs). */
  private static toCompactVariant(row: WorkflowVariantRow): Record<string, unknown> {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      label: row.label,
      model: row.model,
      execution_model: row.execution_model,
      weight: row.weight,
      status: row.status,
      has_agent_overrides: row.agent_overrides_json !== null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Parse + validate a JSON-encoded WorkflowDefinition with the SAME strict
   * schema the tRPC write path runs as `.input()`. Returns the parsed definition
   * or null after writing an ok:false response (bad JSON → 'invalid_json',
   * schema violation → 'invalid_definition').
   */
  private parseDefinitionJson(
    definitionJson: string,
    requestId: string,
    client: net.Socket,
  ): WorkflowDefinition | null {
    let raw: unknown;
    try {
      raw = JSON.parse(definitionJson);
    } catch {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: 'invalid_json',
      });
      return null;
    }
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: 'invalid_definition',
      });
      return null;
    }
    return parsed.data;
  }

  /**
   * Map a WorkflowRegistry guard Error to an ok:false code by its distinguishable
   * message substring (parity with the workflows/variants tRPC error mapping):
   *   'not found' → not_found; 'run history' → run_history;
   *   'already exists' → already_exists; 'reserved' → reserved;
   *   otherwise → workflow_config_failed (logged).
   */
  private writeWorkflowConfigError(client: net.Socket, requestId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    let error = 'workflow_config_failed';
    if (message.includes('not found')) error = 'not_found';
    else if (message.includes('run history')) error = 'run_history';
    else if (message.includes('already exists')) error = 'already_exists';
    else if (message.includes('reserved')) error = 'reserved';
    else if (message.includes('unresolvable')) error = 'unresolvable';
    else if (message.includes('cannot reset')) error = 'not_a_builtin';
    else {
      this.logger?.error('[Cyboflow MCP Query] workflow config change failed', { error: message });
    }
    this.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
  }

  private handleListWorkflows(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-workflows' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const { cfg, projectId } = resolved;
    // Reconcile the in-repo built-ins as global rows first (mirrors the tRPC
    // list) so a fresh project sees planner/sprint/compound/ship.
    cfg.ensureGlobalBuiltIns();
    const rows = cfg.listByProject(projectId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflows: rows.map((r) => McpQueryHandler.toCompactWorkflow(r)) },
    });
  }

  private handleGetWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const { cfg } = resolved;
    const row = cfg.getById(msg.workflowId);
    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }
    // The EFFECTIVE definition the editor seeds from (spec_json wins, else the
    // built-in fallback, else null for a broken custom flow).
    const definition = resolveWorkflowDefinition(row.name, row.spec_json);
    const baselineRotation = cfg.getBaselineRotation(msg.workflowId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        workflow: McpQueryHandler.toCompactWorkflow(row),
        definition,
        baseline_rotation: baselineRotation,
      },
    });
  }

  private handleUpdateWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
    if (!definition) return;
    try {
      resolved.cfg.updateSpec(msg.workflowId, definition);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleResetWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-reset-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.resetSpec(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleCreateWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    // Optional definition — omit to seed a default '{}' flow (createCustom's own
    // default). A supplied definition is validated with the strict schema.
    let specJson: string | undefined;
    if (msg.definitionJson !== undefined) {
      const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
      if (!definition) return;
      specJson = JSON.stringify(definition);
    }
    // scope 'project' pins the copy to THIS run's project; 'global' (default,
    // the product default per the tRPC router) mints a cross-project flow.
    const projectId = msg.scope === 'project' ? resolved.projectId : null;
    try {
      const row = resolved.cfg.createCustom({
        projectId,
        name: msg.name,
        ...(specJson !== undefined ? { specJson } : {}),
        ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow: McpQueryHandler.toCompactWorkflow(row) },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleDeleteWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-delete-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.deleteWorkflow(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId, deleted: true },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleListVariants(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-variants' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const rows = resolved.cfg.listVariants(msg.workflowId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variants: rows.map((r) => McpQueryHandler.toCompactVariant(r)) },
    });
  }

  private handleCreateVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      const row = resolved.cfg.createVariantFromCurrent(msg.workflowId, msg.label);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant: McpQueryHandler.toCompactVariant(row) },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleUpdateVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    // A supplied definition is validated + re-serialized; agent_overrides_json is
    // stored verbatim (already a JSON string or explicit null clearing it).
    let specJson: string | undefined;
    if (msg.definitionJson !== undefined) {
      const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
      if (!definition) return;
      specJson = JSON.stringify(definition);
    }
    try {
      resolved.cfg.updateVariant(msg.variantId, {
        ...(specJson !== undefined ? { specJson } : {}),
        ...(msg.agentOverridesJson !== undefined ? { agentOverridesJson: msg.agentOverridesJson } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
        ...(msg.executionModel !== undefined ? { executionModel: msg.executionModel } : {}),
        ...(msg.weight !== undefined ? { weight: msg.weight } : {}),
        ...(msg.label !== undefined ? { label: msg.label } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleSetVariantStatus(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-variant-status' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.setVariantStatus(msg.variantId, msg.status);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId, status: msg.status },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleDeleteVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-delete-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.deleteVariant(msg.variantId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId, deleted: true },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleSetBaselineRotation(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-baseline-rotation' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.setBaselineRotation(msg.workflowId, {
        ...(msg.inRotation !== undefined ? { inRotation: msg.inRotation } : {}),
        ...(msg.weight !== undefined ? { weight: msg.weight } : {}),
      });
      const updated = resolved.cfg.getBaselineRotation(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId, baseline_rotation: updated },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Global-agent tool family (S0.4)
  // --------------------------------------------------------------------------

  /** Read a raw `workflows` row directly (no WorkflowConfigLike dep needed for a read). Null when absent. */
  private readWorkflowRow(workflowId: string): WorkflowRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at
           FROM workflows WHERE id = ?`,
      )
      .get(workflowId) as WorkflowRow | undefined;
    return row ?? null;
  }

  /**
   * Resolve a display ref (e.g. 'TASK-014') to its opaque id in ANY project.
   * Unlike resolveBacklogRef (single-project-scoped — used by the run-write
   * guarded tools to prevent cross-project ref-probing), the global agent has
   * legitimate cross-project visibility, so an unscoped scan is intended, not
   * a leak. Returns the FIRST match across ideas -> epics -> tasks; a ref
   * collision across two projects is NOT disambiguated here (pass an explicit
   * projectId to disambiguate).
   */
  private resolveBacklogRefAnyProject(ref: string): string | null {
    const tables = ['ideas', 'epics', 'tasks'] as const;
    for (const table of tables) {
      const row = this.db.prepare(`SELECT id FROM ${table} WHERE ref = ? LIMIT 1`).get(ref) as
        | { id: string }
        | undefined;
      if (row) return row.id;
    }
    return null;
  }

  private handleAgentOverview(
    msg: Extract<McpQueryMessage, { type: 'mcp-overview' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const projects = this.db
      .prepare('SELECT id, name FROM projects ORDER BY name')
      .all() as Array<{ id: number; name: string }>;

    interface SessionOverviewRow {
      session_id: string;
      session_name: string;
      session_status: string;
      project_id: number;
      is_quick: number;
      updated_at: string;
      run_id: string | null;
      run_status: string | null;
      current_step_id: string | null;
      workflow_name: string | null;
    }
    // Capped at the 200 most-recently-updated non-archived sessions across
    // every project — "active/recent" per the tool contract, not an
    // exhaustive dump. A run can never be session-less (WorkflowRegistry.
    // createRun's hard invariant), so this single LEFT JOIN also covers every
    // running/awaiting-human run — there is no run reachable ONLY off a
    // session-less path.
    const sessionRows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.name AS session_name, s.status AS session_status,
                s.project_id AS project_id, s.is_quick AS is_quick, s.updated_at AS updated_at,
                wr.id AS run_id, wr.status AS run_status, wr.current_step_id AS current_step_id,
                w.name AS workflow_name
           FROM sessions s
           LEFT JOIN workflow_runs wr ON wr.id = s.run_id
           LEFT JOIN workflows w ON w.id = wr.workflow_id
          WHERE s.archived = 0
          ORDER BY s.updated_at DESC
          LIMIT 200`,
      )
      .all() as SessionOverviewRow[];

    const blockedRows = this.db
      .prepare(
        `SELECT project_id, COUNT(*) AS n FROM review_items WHERE blocking = 1 AND status = 'pending' GROUP BY project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const blockedByProject = new Map(blockedRows.map((r) => [r.project_id, r.n]));

    const questionRows = this.db
      .prepare(
        `SELECT wr.project_id AS project_id, COUNT(*) AS n
           FROM questions q JOIN workflow_runs wr ON wr.id = q.run_id
          WHERE q.status = 'pending'
          GROUP BY wr.project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const questionsByProject = new Map(questionRows.map((r) => [r.project_id, r.n]));

    const sessionsByProject = new Map<number, Array<Record<string, unknown>>>();
    for (const row of sessionRows) {
      const bucket = sessionsByProject.get(row.project_id) ?? [];
      bucket.push({
        session_id: row.session_id,
        name: row.session_name,
        status: row.session_status,
        is_quick: row.is_quick === 1,
        updated_at: row.updated_at,
        run:
          row.run_id !== null
            ? {
                run_id: row.run_id,
                workflow_name: row.workflow_name,
                status: row.run_status,
                current_step_id: row.current_step_id,
              }
            : null,
      });
      sessionsByProject.set(row.project_id, bucket);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        projects: projects.map((p) => ({
          project_id: p.id,
          project_name: p.name,
          sessions: sessionsByProject.get(p.id) ?? [],
          blocked_gates_count: blockedByProject.get(p.id) ?? 0,
          pending_questions_count: questionsByProject.get(p.id) ?? 0,
        })),
      },
    });
  }

  private handleAgentBacklog(
    msg: Extract<McpQueryMessage, { type: 'mcp-backlog' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // selectProjectBacklog(db, null) merges EVERY project's backlog into one
    // list — the cross-project read this tool is for. msg.projectId narrows
    // to a single project exactly like cyboflow_list_tasks does.
    const tree = selectProjectBacklog(this.db, msg.projectId ?? null);
    const flat: BacklogTaskItem[] = [];
    for (const item of tree) {
      flat.push(item);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children);
      }
    }

    const includeArchived = msg.includeArchived ?? false;
    const includeDone = msg.includeDone ?? false;
    const filtered = flat.filter((item) => {
      if (item.archived_at !== null && !includeArchived) return false;
      const isDoneOrRetired = item.isDone === true || item.decomposed_at !== null;
      if (isDoneOrRetired && !includeDone) return false;
      if (msg.taskType !== undefined && item.type !== msg.taskType) return false;
      return true;
    });

    // Cross-project rows need project_id on the wire (the run-scoped
    // toCompactTask omits it — a single-project caller already knows its own
    // project); spread + add rather than duplicate the whole projection.
    const tasks = filtered.map((item) => ({
      ...McpQueryHandler.toCompactTask(item),
      project_id: item.project_id,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { tasks, total: tasks.length, hidden_count: flat.length - tasks.length },
    });
  }

  private handleAgentEntity(
    msg: Extract<McpQueryMessage, { type: 'mcp-entity' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    let item = selectTaskById(this.db, msg.taskId);
    if (!item) {
      const resolvedId =
        msg.projectId !== undefined
          ? resolveBacklogRef(this.db, msg.projectId, msg.taskId)
          : this.resolveBacklogRefAnyProject(msg.taskId);
      if (resolvedId) item = selectTaskById(this.db, resolvedId);
    }

    if (!item || (msg.projectId !== undefined && item.project_id !== msg.projectId)) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    // Hide experiment-sandboxed drafts (migration 053): a run-scoped
    // handleGetTask scopes this to the owning arm; the global agent has no
    // arm of its own to scope against, so a tagged row is never safe to
    // surface here — treat it exactly like a genuine miss.
    if (item.experiment_id) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    const task = McpQueryHandler.toFullTask(item);
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = McpQueryHandler.toMcpAttachments(attachments);
    }

    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { task } });
  }

  private handleAgentQueue(
    msg: Extract<McpQueryMessage, { type: 'mcp-queue' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!(msg.includeResolved ?? false)) {
      clauses.push("status = 'pending'");
    }
    if (msg.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(msg.projectId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Capped at 200 — an inbox digest, not an exhaustive dump.
    const rows = this.db
      .prepare(`SELECT * FROM review_items ${where} ORDER BY created_at ASC, id ASC LIMIT 200`)
      .all(...params) as ReviewItemDbRow[];
    const items = rows.map((r) => ReviewItemRouter.shapeRow(r));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { items, total: items.length },
    });
  }

  private handleAgentWorkflows(
    msg: Extract<McpQueryMessage, { type: 'mcp-workflows' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // Same exclusion + "must resolve to a usable definition" filter as
    // WorkflowRegistry.listByProject, but scanning every project at once
    // (or one project when msg.projectId narrows) rather than unioning
    // (project_id = ? OR project_id IS NULL) per-project — there is no
    // per-project repetition to dedupe here.
    const excluded = [QUICK_WORKFLOW_NAME, ...LEGACY_DROPPED_WORKFLOW_NAMES];
    const placeholders = excluded.map(() => '?').join(', ');
    const clauses = [`name NOT IN (${placeholders})`];
    const params: unknown[] = [...excluded];
    if (msg.projectId !== undefined) {
      clauses.push('(project_id = ? OR project_id IS NULL)');
      params.push(msg.projectId);
    }
    const rows = this.db
      .prepare(
        `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at
           FROM workflows
          WHERE ${clauses.join(' AND ')}
          ORDER BY name`,
      )
      .all(...params) as WorkflowRow[];
    const usable = rows.filter((row) => resolveWorkflowDefinition(row.name, row.spec_json) !== null);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflows: usable.map((r) => McpQueryHandler.toCompactWorkflow(r)) },
    });
  }

  private handleAgentWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-workflow' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const row = this.readWorkflowRow(msg.workflowId);
    if (!row) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    const definition = resolveWorkflowDefinition(row.name, row.spec_json);
    const baselineRow = this.db
      .prepare(
        'SELECT baseline_in_rotation AS inRotation, baseline_rotation_weight AS weight FROM workflows WHERE id = ?',
      )
      .get(msg.workflowId) as { inRotation: number; weight: number } | undefined;

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        workflow: McpQueryHandler.toCompactWorkflow(row),
        definition,
        baseline_rotation: baselineRow ? { inRotation: baselineRow.inRotation === 1, weight: baselineRow.weight } : null,
        // CAS material for a future cyboflow_propose_action{kind:'edit-workflow'}
        // call — null only when the row is a broken custom flow with no
        // resolvable definition (definition is also null in that case).
        spec_hash: definition !== null ? computeSpecHash(definition) : null,
      },
    });
  }

  private handleProposeAction(
    msg: Extract<McpQueryMessage, { type: 'mcp-propose-action' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const store = this.deps.agentThreadStore;
    if (!store) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'agent_thread_store_unavailable',
      });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(msg.payloadJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const payload = parseAgentProposalPayload(raw);
    if (!payload) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_payload' });
      return;
    }

    // Preconditions are ALWAYS captured server-side here — the wire payload
    // carries no precondition field for the caller to even attempt to spoof;
    // this re-read is what makes that true rather than merely documented.
    let preconditions: AgentProposalPreconditions | null = null;
    if (payload.kind === 'edit-workflow') {
      const row = this.readWorkflowRow(payload.workflowId);
      if (!row) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'workflow_not_found' });
        return;
      }
      const definition = resolveWorkflowDefinition(row.name, row.spec_json);
      if (definition === null) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'workflow_unresolvable',
        });
        return;
      }
      preconditions = { kind: 'edit-workflow', specHash: computeSpecHash(definition) };
    } else if (payload.kind === 'reprioritize-backlog') {
      const expectedVersions: Record<string, number> = {};
      for (const item of payload.items) {
        const identity = this.readTaskIdentity(item.taskId);
        if (!identity) {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error: `task_not_found:${item.taskId}`,
          });
          return;
        }
        expectedVersions[item.taskId] = identity.version;
      }
      preconditions = { kind: 'reprioritize-backlog', expectedVersions };
    } else if (payload.kind === 'open-session') {
      // No preconditions (shared type contract), but the navigation target IS
      // enriched here with its OWNING project, resolved server-side from the
      // run/session row itself — never trust a caller-supplied projectId
      // (parseAgentNavigationTarget never even copies one out of the wire
      // payload, so this is the only source). The renderer
      // (frontend/src/components/agentRail/proposalNavigation.ts) activates
      // this project before dispatching navigation, since the global agent is
      // cross-project by design and the target run/session may not belong to
      // whatever project happens to be active when the card is confirmed. A
      // target that does not resolve to a real row is an agent mistake, not
      // something to persist as a broken card — reject the proposal outright
      // rather than let it round-trip a stale/typo'd id.
      const nav = payload.navigation;
      if (nav.target === 'run') {
        const row = this.db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(nav.runId) as
          | { project_id?: unknown }
          | undefined;
        if (!row || typeof row.project_id !== 'number') {
          this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'run_not_found' });
          return;
        }
        payload.navigation = { target: 'run', runId: nav.runId, projectId: row.project_id };
      } else {
        const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(nav.sessionId) as
          | { project_id?: unknown }
          | undefined;
        if (!row || typeof row.project_id !== 'number') {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error: 'session_not_found',
          });
          return;
        }
        payload.navigation =
          nav.runId !== undefined
            ? { target: 'quick-session', sessionId: nav.sessionId, runId: nav.runId, projectId: row.project_id }
            : { target: 'quick-session', sessionId: nav.sessionId, projectId: row.project_id };
      }
    }
    // launch-run carries no preconditions (shared type contract).

    const proposal = store.createProposal({ threadId: ctx.threadId, payload, preconditions });
    store.appendEvent(
      ctx.threadId,
      'proposal-created',
      JSON.stringify({ proposalId: proposal.id, kind: proposal.kind }),
    );

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { proposalId: proposal.id },
    });
  }

  /**
   * Returns the cached readonly sibling connection, opening it on first use.
   * Throws (never returns a connection able to write) when `this.db.name` is
   * absent/empty or ':memory:' — an in-memory or adapter-less DatabaseLike
   * has no on-disk file for a sibling connection to point at (this is the
   * common shape in unit tests that don't go through makeDatabaseLike/
   * dbAdapter). Read-only is enforced BY CONSTRUCTION here via `{ readonly:
   * true }` — SQLite itself refuses any write attempted through this handle,
   * independent of validateReadonlySql's statement-shape checks.
   */
  private getGlobalAgentReadonlyDb(): BetterSqlite3Database.Database {
    if (this.globalAgentReadonlyDb) return this.globalAgentReadonlyDb;
    const dbPath = this.db.name;
    if (!dbPath || dbPath === ':memory:') {
      throw new Error('db_query_unavailable: no on-disk database file for this connection');
    }
    this.globalAgentReadonlyDb = new BetterSqlite3Database(dbPath, { readonly: true, fileMustExist: true });
    return this.globalAgentReadonlyDb;
  }

  private handleAgentDbQuery(
    msg: Extract<McpQueryMessage, { type: 'mcp-db-query' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const validation = validateReadonlySql(msg.sql);
    if (!validation.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: validation.reason });
      return;
    }

    // Errors from here (unreachable db file, sqlite syntax errors, unknown
    // tables, or SQLite's own readonly-connection write refusal) are left to
    // propagate — handleMessage's outer try/catch turns them into a
    // structured ok:false response carrying sqlite's message, same as every
    // other handler in this file.
    const readonlyDb = this.getGlobalAgentReadonlyDb();
    const stmt = readonlyDb.prepare(validation.sql);

    if (!stmt.reader) {
      // A non-reader statement (e.g. a write form that slipped past
      // validateReadonlySql, such as `WITH x AS (SELECT 1) INSERT ...`) is
      // NEVER executed — calling .run() is exactly the write attempt the
      // readonly connection exists to prevent, so we simply decline rather
      // than let SQLite throw mid-write.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { columns: [], rows: [], rowCount: 0, truncated: false, note: 'statement returned no rows' },
      });
      return;
    }

    const columns = stmt.columns().map((c) => c.name);
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    let payloadBytes = 0;
    for (const rawRow of stmt.iterate()) {
      if (rows.length >= DB_QUERY_MAX_ROWS) {
        truncated = true;
        break;
      }
      const sanitized = sanitizeDbQueryRow(rawRow as Record<string, unknown>);
      const size = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
      if (rows.length > 0 && payloadBytes + size > DB_QUERY_MAX_PAYLOAD_BYTES) {
        truncated = true;
        break;
      }
      rows.push(sanitized);
      payloadBytes += size;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { columns, rows, rowCount: rows.length, truncated },
    });
  }

  // --------------------------------------------------------------------------
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response) + '\n');
  }
}
