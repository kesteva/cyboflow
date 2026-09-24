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
 *                                  get no `attachments` key at all. An idea with
 *                                  a current approved_designs row (Design Mode
 *                                  v0, migration 085) also gets an
 *                                  `approved_design` block with a RESOLVED
 *                                  absolute path to the approved prototype
 *                                  snapshot — the zero-export handoff read path.
 *                                  An idea also gets `components` — the idea
 *                                  component ledger's full hybrid read model
 *                                  (migration 101, resolveIdeaComponents),
 *                                  always all five, carrying `staleAt` so
 *                                  "needs review" (prior work, re-verify) is
 *                                  never collapsed into "not started".)
 *   - mcp-set-idea-component      (WRITE via IdeaComponentRouter's chokepoint;
 *                                  source:'flow', sourceRunId + the idea's
 *                                  current version stamped by this handler,
 *                                  never by the calling agent.)
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
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scalarSchema, widgetSpecSchema } from '../../../../shared/customViews/validate';
import { WIDGET_LIMITS, type Scalar } from '../../../../shared/types/customViews';
import { CustomViewsStoreError } from '../customViews/types';
import type { DatabaseLike, LoggerLike } from '../types';
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';
import { resolveRunFrozenSpec } from '../runFrozenSpec';
import { buildStepTransitionEvent } from '../stepTransitionBridge';
import { listRunCreatedTaskIds, listRunDecomposedIdeaIds } from '../runEntityOwnership';
import { TaskChangeRouter } from '../taskChangeRouter';
import type { TaskActor } from '../taskChangeRouter';
import {
  resolveBacklogRef,
  selectIdeaAttachments,
  selectProjectBacklog,
  selectTaskById,
} from '../taskListing';
import { SprintLaneError, SprintLaneStore } from '../sprintLaneStore';
import { toCompactTask, toFullTask, toMcpAttachments } from './backlogProjection';
import { AWAITING_VERIFY_STEP, resolveSprintMaxTasks } from '../../../../shared/types/sprintBatch';
import { resolveRunFanOutInner } from '../laneChainResolution';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import { runStatusEvents } from '../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../shared/types/cyboflow';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { QuestionRouter } from '../questionRouter';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from './mcpQueryMessages';
import { resolveGlobalAgentContext } from './globalAgentContext';
import type { WorkflowConfigHandlerContext } from './handlers/workflowConfigHandlers';
import {
  handleCreateVariant,
  handleCreateWorkflow,
  handleDeleteVariant,
  handleDeleteWorkflow,
  handleGetWorkflow,
  handleListVariants,
  handleListWorkflows,
  handleResetWorkflow,
  handleSetBaselineRotation,
  handleSetVariantStatus,
  handleUpdateVariant,
  handleUpdateWorkflow,
} from './handlers/workflowConfigHandlers';
import { GlobalAgentToolHandlers } from './handlers/globalAgentToolHandlers';
import { VerifyToolHandlers } from './handlers/verifyToolHandlers';
import { InteractiveHookHandlers } from './handlers/interactiveHookHandlers';
import { TaskToolHandlers } from './handlers/taskToolHandlers';
import { ReviewItemToolHandlers } from './handlers/reviewItemToolHandlers';
import { ArtifactDesignToolHandlers } from './handlers/artifactDesignToolHandlers';
export type { McpQueryMessage, McpQueryResponse, McpQueryHandlerDeps, WorkflowConfigLike } from './mcpQueryMessages';
export { resolveGlobalAgentContext } from './globalAgentContext';

/**
 * The workflow step id whose Approve answer flips a plan-gated run's drafted
 * epics/tasks visible + sprint-eligible (stamping plan_approved_at). Mirrors the
 * same-named constant in questionRouter.ts — duplicated as a bare literal to keep
 * this module free of a questionRouter import for one string. Used by the
 * approve-plan silent-pass guard in handleReportStep.
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';

// ---------------------------------------------------------------------------
// cyboflow_db_query statement-shape validation + execution (S0.4 global-agent).
//
// The pure pieces now live in `../readOnlyQuery` so the custom-views widget
// engine (docs/proposals/CUSTOM-VIEWS.md §4.1) executes user SQL through
// exactly the same validator, readonly sibling connection and iterate loop
// rather than a second implementation. This handler keeps the observable
// contract: scope check, the unavailable-database path, sanitization, the
// non-reader empty response and the WARN logging.
// ---------------------------------------------------------------------------



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

// ---------------------------------------------------------------------------
// McpQueryHandler
// ---------------------------------------------------------------------------

export class McpQueryHandler {
  /**
   * Built once here and handed to every workflowConfigHandlers free function
   * as its `ctx` — arrow wrappers so `writeResponse` / `resolveTaskRunContext`
   * stay private methods on this class while still binding `this` correctly
   * when called through the context object.
   */
  private readonly workflowConfigCtx: WorkflowConfigHandlerContext;

  /**
   * The global-agent db-query/fs/history tool family — a class (not free
   * functions) because it owns the lazily-opened readonly sibling sqlite
   * connection, which must stay cached for this handler's process lifetime.
   */
  private readonly globalAgentTools: GlobalAgentToolHandlers;

  /**
   * The visual-verification + ad-hoc-eval tool family (request / await / get /
   * register-runbook / run-eval) — VerifyToolHandlers in
   * handlers/verifyToolHandlers.ts (issue #19). Reads the run/project rows
   * through the same private readers this class keeps for the other families,
   * handed over as closures.
   */
  private readonly verifyTools: VerifyToolHandlers;

  /**
   * The INTERACTIVE-substrate hook family — the async-deferred shell
   * PreToolUse gate (plus its OMP deferred-approval twin), the Stop turn-end
   * ack and the AskUserQuestion notify — InteractiveHookHandlers in
   * handlers/interactiveHookHandlers.ts (issue #19). Owns the held-open
   * sockets; `cancelInFlightShellApprovals` on this class forwards to it.
   */
  private readonly interactiveHooks: InteractiveHookHandlers;

  /**
   * The run-bound backlog tool family — task/idea-component writes through the
   * TaskChangeRouter / IdeaComponentRouter chokepoints plus the list/get reads —
   * TaskToolHandlers in handlers/taskToolHandlers.ts (issue #19).
   */
  private readonly taskTools: TaskToolHandlers;

  /**
   * The review-queue tool family — report / list / resolve findings, the
   * compound run's selected findings and the eval readout — ReviewItemToolHandlers
   * in handlers/reviewItemToolHandlers.ts (issue #19).
   */
  private readonly reviewItemTools: ReviewItemToolHandlers;

  /**
   * The run-artifact + Design Mode tool family — report / commit artifacts through
   * the ArtifactRouter chokepoint and the design-scoped get-idea / update-draft /
   * ack-feedback ops — ArtifactDesignToolHandlers in
   * handlers/artifactDesignToolHandlers.ts (issue #19).
   */
  private readonly artifactDesignTools: ArtifactDesignToolHandlers;

  /**
   * @param db     Orchestrator DB surface.
   * @param logger Optional structured logger. Passed through for connect /
   *               disconnect / precondition diagnostics on the shell-approval
   *               path (CODE-PATTERNS.md optional-logger rule: pass it, don't omit it).
   * @param deps   Optional callback deps otherwise unreachable from this layer
   *               (see McpQueryHandlerDeps). Defaults to `{}` — every member is
   *               individually optional, so omitting this arg entirely (as every
   *               existing test call site does) is equivalent to passing `{}`.
   */
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
    private readonly deps: McpQueryHandlerDeps = {},
  ) {
    this.workflowConfigCtx = {
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveTaskRunContext: (runId) => this.resolveTaskRunContext(runId),
    };
    this.globalAgentTools = new GlobalAgentToolHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
    });
    this.verifyTools = new VerifyToolHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveReviewItemRunContext: (runId) => this.resolveReviewItemRunContext(runId),
      resolveRunWorktree: (runId) => this.resolveRunWorktree(runId),
      resolveProjectPath: (projectId) => this.resolveProjectPath(projectId),
      readExecutionModel: (runId) => this.readExecutionModel(runId),
    });
    this.interactiveHooks = new InteractiveHookHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveRunWorktree: (runId) => this.resolveRunWorktree(runId),
    });
    this.taskTools = new TaskToolHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveTaskRunContext: (runId) => this.resolveTaskRunContext(runId),
    });
    this.reviewItemTools = new ReviewItemToolHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveReviewItemRunContext: (runId) => this.resolveReviewItemRunContext(runId),
    });
    this.artifactDesignTools = new ArtifactDesignToolHandlers({
      db: this.db,
      logger: this.logger,
      deps: this.deps,
      writeResponse: (client, response) => this.writeResponse(client, response),
      resolveReviewItemRunContext: (runId) => this.resolveReviewItemRunContext(runId),
    });
  }

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
          await this.taskTools.handleCreateTask(msg, client);
          break;
        case 'mcp-update-task':
          await this.taskTools.handleUpdateTask(msg, client);
          break;
        case 'mcp-set-task-stage':
          await this.taskTools.handleSetTaskStage(msg, client);
          break;
        case 'mcp-add-task-dependency':
          await this.taskTools.handleAddTaskDependency(msg, client);
          break;
        case 'mcp-set-idea-component':
          await this.taskTools.handleSetIdeaComponent(msg, client);
          break;
        case 'mcp-list-tasks':
          // Read-only: projects + flattens selectProjectBacklog's tree. Never writes.
          this.taskTools.handleListTasks(msg, client);
          break;
        case 'mcp-get-task':
          // Read-only: id-then-ref resolution + cross-project guard. Never writes.
          this.taskTools.handleGetTask(msg, client);
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
          this.reviewItemTools.handleReportFinding(msg, client);
          break;
        case 'mcp-get-selected-findings':
          // Read-only: returns the findings the human seeded into THIS compound
          // run (workflow_runs.seed_finding_ids). Never writes.
          this.reviewItemTools.handleGetSelectedFindings(msg, client);
          break;
        case 'mcp-get-eval':
          // Read-only: run_evals + the review_items cross-link. Never writes,
          // and deliberately not gated on a live run — the eval grades AT settle.
          this.reviewItemTools.handleGetEval(msg, client);
          break;
        case 'mcp-list-run-findings':
          // Read-only, but AWAITED: it drains the project's review-item queue
          // first so the run observes its own just-reported findings (the
          // fire-and-forget report path replies before its write commits).
          await this.reviewItemTools.handleListRunFindings(msg, client);
          break;
        case 'mcp-resolve-finding':
          // AWAITED (unlike fire-and-forget report-finding) so a failed resolve
          // surfaces to the agent rather than silently leaving the finding pending.
          await this.reviewItemTools.handleResolveFinding(msg, client);
          break;
        case 'mcp-report-artifact':
          await this.artifactDesignTools.handleReportArtifact(msg, client);
          break;
        case 'mcp-commit-artifact':
          await this.artifactDesignTools.handleCommitArtifact(msg, client);
          break;
        case 'mcp-design-get-idea':
          // Design Mode v0: read-only; re-validates the session's idea link.
          this.artifactDesignTools.handleDesignGetIdea(msg, client);
          break;
        case 'mcp-design-update-draft':
          // Design Mode v0: persists a monotonic design-spec draft bound to the
          // current ui-prototype revision (the CAS material Approve consumes).
          this.artifactDesignTools.handleDesignUpdateDraft(msg, client);
          break;
        case 'mcp-design-ack-feedback':
          // Design Mode v1: AWAITED — the one-result CAS runs through the
          // FeedbackRouter queue, and the agent needs the applied/discarded
          // outcome back before it moves on.
          await this.artifactDesignTools.handleDesignAckFeedback(msg, client);
          break;
        case 'mcp-request-verification':
          // FIRE-AND-CONTINUE on the VERDICT (the lane never blocks on it), but
          // AWAITED here: the enqueue-time runbook resolution (§5.2 seam 3) does
          // filesystem work, and the reply must not be written until the row —
          // pin included — exists.
          await this.verifyTools.handleRequestVerification(msg, client);
          break;
        case 'mcp-await-verification':
          // BLOCKING (§5.2 seam 2) — holds the socket open until the request
          // settles or the caller's bounded deadline expires, exactly like the
          // question gate above. The setup flow's prove→diagnose→re-prove loop
          // needs the verdict IN ITS OWN TURN; fire-and-continue delivery has no
          // channel back to a live turn.
          await this.verifyTools.handleAwaitVerification(msg, client);
          break;
        case 'mcp-get-verifications':
          // NON-BLOCKING cold read — a plain run-scoped SELECT, no waiting.
          this.verifyTools.handleGetVerifications(msg, client);
          break;
        case 'mcp-register-verify-runbook':
          // AWAITED: the store reads + validates the portable runbook file and
          // fingerprints the host, so the reply cannot be written until the
          // record (and its hash + CAS version) actually exists.
          await this.verifyTools.handleRegisterVerifyRunbook(msg, client);
          break;
        case 'mcp-run-eval':
          // FIRE-AND-CONTINUE: awaits only the snapshot + enqueue (never the jury),
          // then replies with the queued/requeued/in_flight status or a reason code.
          await this.verifyTools.handleRunEval(msg, client);
          break;
        case 'mcp-list-workflows':
          handleListWorkflows(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-get-workflow':
          handleGetWorkflow(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-update-workflow':
          handleUpdateWorkflow(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-reset-workflow':
          handleResetWorkflow(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-create-workflow':
          handleCreateWorkflow(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-delete-workflow':
          handleDeleteWorkflow(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-list-variants':
          handleListVariants(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-create-variant':
          handleCreateVariant(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-update-variant':
          handleUpdateVariant(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-set-variant-status':
          handleSetVariantStatus(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-delete-variant':
          handleDeleteVariant(this.workflowConfigCtx, msg, client);
          break;
        case 'mcp-set-baseline-rotation':
          handleSetBaselineRotation(this.workflowConfigCtx, msg, client);
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
          this.globalAgentTools.handleAgentQueue(msg, client);
          break;
        case 'mcp-workflows':
          this.globalAgentTools.handleAgentWorkflows(msg, client);
          break;
        case 'mcp-workflow':
          this.globalAgentTools.handleAgentWorkflow(msg, client);
          break;
        case 'mcp-agents':
          this.globalAgentTools.handleAgentAgents(msg, client);
          break;
        case 'mcp-propose-action':
          this.globalAgentTools.handleProposeAction(msg, client);
          break;
        case 'mcp-db-query':
          this.globalAgentTools.handleAgentDbQuery(msg, client);
          break;
        case 'mcp-fs-read':
          this.globalAgentTools.handleFsRead(msg, client);
          break;
        case 'mcp-fs-list':
          this.globalAgentTools.handleFsList(msg, client);
          break;
        case 'mcp-fs-grep':
          this.globalAgentTools.handleFsGrep(msg, client);
          break;
        case 'mcp-history':
          this.globalAgentTools.handleAgentHistory(msg, client);
          break;
        case 'mcp-db-schema':
          this.handleDbSchema(msg, client);
          break;
        case 'mcp-widget-preview':
          await this.handleWidgetPreview(msg, client);
          break;
        case 'mcp-widget-save':
          this.handleWidgetSave(msg, client);
          break;
        case 'shell-approval-request':
          // Async-deferred — the FIRST handler that does NOT writeResponse
          // synchronously. It returns after kicking off requestApproval; only
          // the socketReply closure writes the verdict, possibly minutes later.
          this.interactiveHooks.handleShellApprovalRequest(msg, client);
          break;
        case 'interactive-turn-end':
          // Fire-and-ack: unlike shell-approval-request, there is no verdict to
          // defer — writeResponse happens synchronously either way.
          this.interactiveHooks.handleInteractiveTurnEnd(msg, client);
          break;
        case 'interactive-question-open':
          // Fire-and-ack: flip the run's board state to `blocked`; no verdict.
          this.interactiveHooks.handleInteractiveQuestionOpen(msg, client);
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
      // NOT "unhandled" — every throw reaching here is converted into the
      // structured ok:false response written immediately below, and several
      // handlers rely on that conversion for EXPECTED input errors. The clearest
      // case is handleAgentDbQuery, whose SQL is AGENT-authored: a bad column
      // name in an ad-hoc cyboflow_db_query is a query error the caller is told
      // about, not an app fault. Reporting those as "Unhandled error" labelled a
      // designed path as a crash — it cost a 2026-08-01 smoke run a false
      // medium-severity app finding before the handler's own source comment
      // reclassified it. This message states what is true of BOTH classes (the
      // handler threw; the client got ok:false) and names the message type so
      // triage knows which handler without decoding the stack.
      //
      // mcp-db-query goes to WARN rather than ERROR: wording alone did not stop
      // the recurrence (the 2026-08-06 smoke re-filed the same false finding off
      // a line that already said "returned to client as ok:false", because log
      // triage keys off the LEVEL, not the prose). Its SQL is agent-authored, so
      // a throw here is by construction a caller error and does not belong on
      // the channel reserved for app faults. Every other message type builds its
      // own SQL and keeps ERROR, where a throw IS ours.
      //
      // mcp-widget-preview extends the same exemption (docs/proposals/
      // CUSTOM-VIEWS.md §7.2): its `sql` sources are agent-authored WidgetSpec
      // content, same caller-error shape as mcp-db-query's raw SQL.
      const logAtWarn = msg.type === 'mcp-db-query' || msg.type === 'mcp-widget-preview';
      const summary = `[Cyboflow MCP Query] ${msg.type} threw; returned to client as ok:false:`;
      if (logAtWarn) {
        console.warn(`${summary} ${error} (agent-authored SQL — caller error, not an app fault)`);
      } else {
        console.error(summary, err);
      }
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
   * and must not fabricate one (CODE-PATTERNS.md silent-no-op rule applies only to
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
      // createForRun's OWN batch-cap enforcement (Item 7) — the handler's step-5
      // pre-check above already returns this same 'ship_batch_too_large' code for
      // the common case, so this branch only fires when something changed the
      // eligible count BETWEEN that pre-check and the transaction (e.g. a
      // concurrent eligibility change) and the store's cap is what actually
      // caught it. Same wire code either way — callers see ONE signal.
      if (err.code === 'batch_too_large') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: batch too large', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_batch_too_large',
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
   *   5. CAP backstop — more tasks than the effective per-substrate cap
   *      (resolveSprintMaxTasks over the user's Settings override) →
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
        if (taskIds.length > resolveSprintMaxTasks(this.deps.getSprintMaxTasks?.(), substrate)) {
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
   *
   * The returned actor is typed as the narrower `` `agent:${string}` `` (NOT the
   * full ReviewActor union it is a subtype of) because the body below only ever
   * constructs `agent:${label}` — a review item minted through THIS run-context
   * seam is always agent-authored, never 'user', 'linear', or 'plane' (a tracker
   * sync writes through TaskChangeRouter/ReviewItemRouter directly with its own
   * provider actor, not through a workflow run's step context). Declaring the
   * true, narrower return type lets callers that need an even narrower actor
   * type (e.g. ArtifactActor) assign `ctx.actor` directly with no coercion.
   */
  private resolveReviewItemRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: `agent:${string}` } | { ok: false; error: string } {
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

    const actor: `agent:${string}` = `agent:${label}`;
    return { ok: true, projectId, actor };
  }

  /**
   * Deny-and-close every in-flight shell-approval socket for `runId` — the
   * per-run cancel affordance OrchSocketServer forwards here before the
   * interactive manager kills the PTY (TASK-808/810). The held-open sockets
   * live on InteractiveHookHandlers (handlers/interactiveHookHandlers.ts,
   * issue #19); this is a pure pass-through so the public surface is unchanged.
   *
   * @returns the number of sockets denied/closed.
   */
  cancelInFlightShellApprovals(runId: string): number {
    return this.interactiveHooks.cancelInFlightShellApprovals(runId);
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
   * Resolve a project's root checkout path. Used as the SECOND rung of the
   * quick-session verify-config lookup, behind the run's own worktree — a run's
   * commands execute in its worktree, so a recipe the branch under verification
   * added must win over the project checkout's copy.
   *
   * Fail-soft to null (absent row, missing column on an older schema): the caller
   * treats "no project config" and "could not read one" identically, falling to
   * the global rung, which is the same posture `createRun` takes when no project
   * config is injected.
   */
  private resolveProjectPath(projectId: number): string | null {
    try {
      const row = this.db
        .prepare('SELECT path FROM projects WHERE id = ?')
        .get(projectId) as { path?: unknown } | undefined;
      const p = row?.path;
      return typeof p === 'string' && p.length > 0 ? p : null;
    } catch {
      return null;
    }
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
        // audience='machine' items (migration 085) are the orchestrator's durable
        // mailbox — never human-actionable, so they must not inflate this
        // human-facing per-project blocked badge. NULL counts as human (pre-085 /
        // defensive; the NOT NULL default makes NULL impossible post-migration).
        `SELECT project_id, COUNT(*) AS n FROM review_items
          WHERE blocking = 1 AND status = 'pending' AND (audience IS NULL OR audience != 'machine')
          GROUP BY project_id`,
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
      ...toCompactTask(item),
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

    const task = toFullTask(item);
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = toMcpAttachments(attachments);
    }

    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { task } });
  }

  // --------------------------------------------------------------------------
  // Custom-widget authoring tools (cyboflow_db_schema / _widget_preview /
  // _widget_save) — docs/proposals/CUSTOM-VIEWS.md §7.2 / §9 row S6. All three
  // fail closed with 'custom_views_unavailable' when the `customViews` dep is
  // absent, mirroring the workflowConfig / agentThreadStore precedent above.
  // --------------------------------------------------------------------------

  private handleDbSchema(
    msg: Extract<McpQueryMessage, { type: 'mcp-db-schema' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }
    const tables = customViews.dbSchema();
    const filtered = msg.table ? tables.filter((t) => t.table === msg.table) : tables;
    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { tables: filtered } });
  }

  private async handleWidgetPreview(
    msg: Extract<McpQueryMessage, { type: 'mcp-widget-preview' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }

    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(msg.specJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const parsedSpec = widgetSpecSchema.safeParse(rawSpec);
    if (!parsedSpec.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_spec',
        data: { detail: parsedSpec.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
      });
      return;
    }

    let settings: Record<string, Scalar> = {};
    if (msg.settingsJson !== undefined) {
      let rawSettings: unknown;
      try {
        rawSettings = JSON.parse(msg.settingsJson);
      } catch {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_settings' });
        return;
      }
      const parsedSettings = z.record(scalarSchema).safeParse(rawSettings);
      if (!parsedSettings.success) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_settings' });
        return;
      }
      settings = parsedSettings.data;
    }

    // Errors from here (e.g. `invalid_spec:<message>` when a setting doesn't
    // resolve against the spec's declared settings) propagate to
    // handleMessage's outer try/catch, which — via the WARN exemption above —
    // logs this as a caller error, not an app fault: the spec is agent-authored.
    const payload = await customViews.runWidget({
      widget: { inline: parsedSpec.data },
      settings,
      refreshSec: WIDGET_LIMITS.minRefreshSec,
      context: { projectId: msg.projectId ?? null },
    });

    // Cap each source's rows to 50 for the transcript — the real page is not
    // capped this way; this only bounds what goes back over the wire to the
    // model.
    const sources: Record<string, unknown> = {};
    for (const [name, outcome] of Object.entries(payload.sources)) {
      if ('error' in outcome) {
        sources[name] = outcome;
        continue;
      }
      const cappedRows = outcome.rows.slice(0, 50);
      sources[name] = {
        columns: outcome.columns,
        rows: cappedRows,
        truncated: outcome.truncated,
        tookMs: outcome.tookMs,
        ...(cappedRows.length < outcome.rows.length ? { truncatedForTranscript: true } : {}),
      };
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { sources, warnings: payload.warnings, plan: payload.plan, paused: payload.paused },
    });
  }

  private handleWidgetSave(
    msg: Extract<McpQueryMessage, { type: 'mcp-widget-save' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }

    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(msg.specJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const parsedSpec = widgetSpecSchema.safeParse(rawSpec);
    if (!parsedSpec.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_spec',
        data: { detail: parsedSpec.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
      });
      return;
    }

    // No authoring session = the user asked from the rail, not from
    // Customize -> Create a custom widget. Publish straight into the library
    // under a throwaway session id: publishDraft clears authoring_session_id,
    // so nothing is left claimed, and the library refresh the draft event
    // triggers on every surface makes it show up under "Mine". A draft-only
    // save has no slot to render in, so it is refused rather than orphaned.
    if (msg.sessionId === undefined && !msg.publish) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'draft_needs_session' });
      return;
    }
    const authoringSessionId = msg.sessionId ?? `library:${randomUUID()}`;

    try {
      const widget = customViews.saveWidget({
        id: msg.widgetId,
        name: msg.name,
        description: msg.description ?? null,
        spec: parsedSpec.data,
        authoringSessionId,
        threadId: ctx.threadId,
        publish: msg.publish,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { widgetId: widget.id, revision: widget.revision },
      });
    } catch (err) {
      const error = err instanceof CustomViewsStoreError ? err.code : err instanceof Error ? err.message : String(err);
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error });
    }
  }

  // --------------------------------------------------------------------------
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response) + '\n');
  }
}
