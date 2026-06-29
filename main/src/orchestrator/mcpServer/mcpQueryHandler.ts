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
 *
 * Plus the INTERACTIVE-substrate PreToolUse gate (IDEA-013 S5 / TASK-810):
 *   - shell-approval-request      (ASYNC-DEFERRED — the first handler that does
 *                                  NOT respond synchronously; it holds the socket
 *                                  open across the human-decision window and
 *                                  writes the verdict via ApprovalRouter's
 *                                  socketReply closure, possibly minutes later).
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
import type { DatabaseLike, LoggerLike } from '../types';
import { resolveWorkflowDefinition, isPermissionMode } from '../../../../shared/types/workflows';
import type { PermissionMode } from '../../../../shared/types/workflows';
import { buildStepTransitionEvent } from '../stepTransitionBridge';
import { handleEntityWrite } from '../autoMintArtifacts';
import { listRunOwnedIdeaIds, listRunCreatedTaskIds } from '../runEntityOwnership';
import { ApprovalRouter, RunNotRunningError } from '../approvalRouter';
import type { ApprovalDecision } from '../../../../shared/types/approval';
import { isToolAllowed, loadMergedPermissionRules } from '../permissionRules';
import { ACCEPT_EDITS_AUTO_APPROVE_TOOLS } from '../permissionModeMapper';
import { TaskChangeRouter, TaskChangeError } from '../taskChangeRouter';
import type { TaskChange, TaskActor, TaskDependencyKind } from '../taskChangeRouter';
import { ReviewItemRouter, ReviewItemError } from '../reviewItemRouter';
import type { ReviewActor, ReviewItemCreate, ReviewItemTriage } from '../reviewItemRouter';
import { selectFindingForSeed } from '../reviewItemListing';
import { ArtifactRouter, ArtifactError } from '../artifactRouter';
import type { ArtifactActor } from '../artifactRouter';
import type { ArtifactType } from '../../../../shared/types/artifacts';
import { SprintLaneStore, SprintLaneError } from '../sprintLaneStore';
import { SPRINT_BATCH_MAX_TASKS } from '../../../../shared/types/sprintBatch';
import type { SprintBatchTaskStatus, SprintLaneStepId } from '../../../../shared/types/sprintBatch';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import { runStatusEvents } from '../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../shared/types/cyboflow';
import type { Priority, TaskType } from '../../../../shared/types/tasks';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type McpQueryMessage =
  | { type: 'mcp-list-pending-approvals'; requestId: string; runId: string }
  | { type: 'mcp-get-run'; requestId: string; runId: string; targetRunId: string }
  | { type: 'mcp-submit-checkpoint'; requestId: string; runId: string; label: string; note?: string }
  | { type: 'mcp-report-step'; requestId: string; runId: string; stepId: string; status?: 'running' | 'done' }
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
      repo?: string;
      parentEpicId?: string;
      boardId?: string;
      initialStageId?: string;
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
      repo?: string;
      parentEpicId?: string;
      expectedVersion?: number;
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
      type: 'mcp-update-sprint-task';
      requestId: string;
      runId: string;
      /** The lane's task id (sprint_batch_tasks.task_id). */
      taskId: string;
      /** New lane status; at least one of status/currentStepId must be set. */
      status?: SprintBatchTaskStatus;
      /** New lane step (SPRINT_LANE_STEP_IDS); at least one of status/currentStepId must be set. */
      currentStepId?: SprintLaneStepId;
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
      /** Item kind; the MCP tool excludes 'permission' (folded via the approval path). Defaults to 'finding'. */
      kind?: Exclude<ReviewItemKind, 'permission'>;
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
      type: 'shell-approval-request';
      requestId: string;
      runId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    };

export interface McpQueryResponse {
  type: 'mcp-query-response';
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * FIX-STAGE-MODEL (C): planner-step -> SEED-IDEA board-stage coupling.
 *
 * When the planner reports a step transition, the run's seed idea
 * (workflow_runs.seed_idea_id) advances to the matching planning stage so the
 * board reflects the run's progress WITHOUT the agent having to call
 * cyboflow_set_task_stage. Positions are verified against database.ts
 * seedDefaultBoard: 1=Idea, 2=Research, 3=Idea spec. Steps not in this map (and
 * the later refine/decompose steps, which are handled by idea->Decomposed via
 * FIX (B)) are intentionally absent — an unmapped step is a no-op.
 *
 * This is the SINGLE source for the coupling so it stays easy to extend.
 */
const PLANNER_STEP_TO_IDEA_POSITION: Readonly<Record<string, number>> = {
  context: 1, // Idea
  research: 2, // Research
  'approve-idea': 3, // Idea spec
};

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
   * @param db     Orchestrator DB surface.
   * @param logger Optional structured logger. Passed through for connect /
   *               disconnect / precondition diagnostics on the shell-approval
   *               path (CLAUDE.md optional-logger rule: pass it, don't omit it).
   */
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
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
        case 'shell-approval-request':
          // Async-deferred — the FIRST handler that does NOT writeResponse
          // synchronously. It returns after kicking off requestApproval; only
          // the socketReply closure writes the verdict, possibly minutes later.
          this.handleShellApprovalRequest(msg, client);
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

    const row = this.db
      .prepare(
        `SELECT w.name AS name, w.spec_json AS specJson
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(msg.runId) as { name?: unknown; specJson?: unknown } | undefined;

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    const name = typeof row.name === 'string' ? row.name : '';
    const specJson = typeof row.specJson === 'string' ? row.specJson : null;

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

    // FIX-STAGE-MODEL (C): advance EVERY idea the run owns (its seed idea AND any
    // ideas it created during the run) to the planning stage that matches this step
    // (context->Idea, research->Research, approve-idea->Idea spec). This covers
    // raw-prompt and multi-idea runs that have no single seed_idea_id. NON-PAUSING —
    // the run stays 'running'; this opens NO gate. Fail-soft: sentinel / unmapped
    // step / no owned ideas → no-op. Awaited so the moves commit before we reply
    // (keeps the board consistent with the rail), but any failure is swallowed so a
    // stage hiccup never breaks the observational report.
    await this.advanceRunIdeasStageForStep(msg.runId, msg.stepId);

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
   * FIX-STAGE-MODEL (C): move EVERY idea the run owns — its seed idea (if any)
   * AND every idea it created during the run (listRunOwnedIdeaIds) — to the board
   * stage mapped to `stepId` via PLANNER_STEP_TO_IDEA_POSITION. This advances the
   * board for raw-prompt and multi-idea runs that have no single seed_idea_id, not
   * only the legacy seed. Each write goes through the TaskChangeRouter chokepoint
   * with actor='orchestrator' (non-pausing — it never touches workflow_runs.status).
   * Fully fail-soft: returns silently when the run is the sentinel, owns no ideas
   * (or the seed_idea_id / entity_events surfaces are absent on an older DB), the
   * step is unmapped, or a given idea/board/stage cannot be resolved; an
   * already-at-target idea is skipped. NEVER throws — the report-step response is
   * unaffected.
   */
  private async advanceRunIdeasStageForStep(runId: string, stepId: string): Promise<void> {
    if (runId === 'orchestrator') return;

    const position = PLANNER_STEP_TO_IDEA_POSITION[stepId];
    if (position === undefined) return; // unmapped step — no-op

    try {
      // Ownership = seed_idea_id (migration 017) UNION ideas created during the
      // run (entity_events). listRunOwnedIdeaIds is itself fail-soft, so a pre-017
      // DB / missing entity_events degrades to [] (a clean no-op) here.
      const ideaIds = listRunOwnedIdeaIds(this.db, runId);
      if (ideaIds.length === 0) return;

      const runRow = this.db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
        .get(runId) as { projectId?: unknown } | undefined;
      if (!runRow) return;
      const projectId = typeof runRow.projectId === 'number' ? runRow.projectId : Number(runRow.projectId);

      const router = TaskChangeRouter.getInstance();

      for (const ideaId of ideaIds) {
        // Resolve THIS idea's board → the stage id at the mapped position.
        const ideaRow = this.db
          .prepare('SELECT board_id AS boardId, stage_id AS stageId FROM ideas WHERE id = ?')
          .get(ideaId) as { boardId?: unknown; stageId?: unknown } | undefined;
        const boardId = typeof ideaRow?.boardId === 'string' ? ideaRow.boardId : null;
        if (!ideaRow || !boardId) continue;

        const stageRow = this.db
          .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
          .get(boardId, position) as { id?: unknown } | undefined;
        const targetStageId = typeof stageRow?.id === 'string' ? stageRow.id : null;
        if (!targetStageId || targetStageId === ideaRow.stageId) continue; // unresolved or already there

        await router.applyChange(projectId, {
          actor: 'orchestrator',
          entityType: 'idea',
          taskId: ideaId,
          stageId: targetStageId,
          runId,
          kind: 'seed-idea-stage',
        });
      }
    } catch (err) {
      this.logger?.debug('[Cyboflow MCP Query] run-ideas stage advance skipped (fail-soft)', {
        runId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
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

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      entityType: msg.taskType,
      title: msg.title,
      summary: msg.summary,
      body: msg.body,
      priority: msg.priority,
      repo: msg.repo,
      parentEpicId: msg.parentEpicId ?? null,
      boardId: msg.boardId,
      initialStageId: msg.initialStageId,
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
        repo: msg.repo,
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

    try {
      const lane = SprintLaneStore.getInstance().updateLane({
        runId: msg.runId,
        batchId,
        taskId: msg.taskId,
        ...(msg.status !== undefined ? { status: msg.status } : {}),
        ...(msg.currentStepId !== undefined ? { currentStepId: msg.currentStepId } : {}),
        ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
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
        // any id the run did not create); fall back to the full created set.
        const createdTaskIds = listRunCreatedTaskIds(this.db, msg.runId);
        let taskIds: string[];
        if (msg.taskIds && msg.taskIds.length > 0) {
          const createdSet = new Set(createdTaskIds);
          taskIds = [...new Set(msg.taskIds)].filter((id) => createdSet.has(id));
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
   * Retire every idea the run owns (seed idea UNION run-created ideas, via
   * listRunOwnedIdeaIds) to the Decomposed terminal stage. The ship handoff
   * seam's follow-on — see handleCreateSprintBatch. Best-effort: each retire is
   * idempotent (a no-op when the idea is already at Decomposed) and individually
   * guarded so one failure can't starve the rest, and the whole pass is swallowed
   * so it can never invalidate the already-committed batch.
   */
  private async retireRunOwnedIdeas(projectId: number, runId: string): Promise<void> {
    try {
      const router = TaskChangeRouter.getInstance();
      for (const ideaId of listRunOwnedIdeaIds(this.db, runId)) {
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

    const kind: Exclude<ReviewItemKind, 'permission'> = msg.kind ?? 'finding';

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
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'create',
        runId: msg.runId,
        atype: msg.atype,
        label: msg.label,
        payloadJson: msg.payloadJson ?? null,
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
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'commit',
        artifactId: msg.artifactId,
        actor,
        ...(msg.payloadJson !== undefined ? { payloadJson: msg.payloadJson } : {}),
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
   *       permission_mode_snapshot) is 'acceptEdits' and the tool is in
   *       ACCEPT_EDITS_AUTO_APPROVE_TOOLS (Edit/Write/MultiEdit), AUTO-ALLOW with
   *       ZERO approvals row and NO folded review_item — SDK-mapper parity, applied
   *       BEFORE the allow-list check;
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
    // 'acceptEdits' and the tool is in the Edit/Write/MultiEdit set, AUTO-ALLOW
    // with ZERO approvals row and NO folded review_item — parity with the SDK
    // mapper's acceptEdits branch (permissionModeMapper.ts auto-approves the same
    // ACCEPT_EDITS_AUTO_APPROVE_TOOLS set). This runs BEFORE the allow-list check
    // so an edit never needs a permissions.allow entry under acceptEdits.
    //
    // The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
    // settingsWriter opt-out — interactiveClaudeManager.ts), so the hook does not
    // fire and this handler is not reached for them; 'default' falls through to
    // the existing allow-list + router gate unchanged.
    const effectiveMode = this.resolveRunPermissionMode(msg.runId);
    if (
      effectiveMode === 'acceptEdits' &&
      (ACCEPT_EDITS_AUTO_APPROVE_TOOLS as readonly string[]).includes(msg.toolName)
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
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response) + '\n');
  }
}
