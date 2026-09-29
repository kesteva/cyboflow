/**
 * TaskToolHandlers — the run-bound backlog tool family (task writes via the
 * TaskChangeRouter chokepoint, idea-component writes via IdeaComponentRouter,
 * and the read-only list/get projections), split out of mcpQueryHandler.ts
 * (issue #19).
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import.
 */
import * as net from 'net';
import * as path from 'path';
import type { DatabaseLike, LoggerLike } from '../../types';
import { handleEntityWrite } from '../../autoMintArtifacts';
import { TaskChangeError, TaskChangeRouter } from '../../taskChangeRouter';
import type { TaskActor, TaskChange } from '../../taskChangeRouter';
import {
  resolveBacklogRef,
  selectIdeaAttachments,
  selectProjectBacklog,
  selectTaskById,
} from '../../taskListing';
import { getCurrentApprovedDesign } from '../../design/approvedDesigns';
import { resolveIdeaComponents } from '../../ideaComponents/resolveIdeaComponents';
import { IdeaComponentError, IdeaComponentRouter } from '../../ideaComponents/ideaComponentRouter';
import { toCompactTask, toFullTask, toMcpAttachments } from '../backlogProjection';
import type { BacklogTaskItem, TaskType } from '../../../../../shared/types/tasks';
import type { ExperimentArm } from '../../../../../shared/types/experiments';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` and
 * `resolveTaskRunContext` are private methods on the handler (the sprint and
 * workflow-config families share the latter), handed over as closures so the
 * moved bodies keep calling them as `this.<name>(...)` unchanged.
 */
export interface TaskToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  /** Serialize one reply onto the requesting socket. */
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** Non-terminal run → (projectId, agent actor); the guard every run-bound task tool shares. */
  resolveTaskRunContext(runId: string): { ok: true; projectId: number; actor: TaskActor } | { ok: false; error: string };
}

/**
 * The run-bound backlog MCP tool family: `cyboflow_create_task`,
 * `cyboflow_update_task`, `cyboflow_set_task_stage`, `cyboflow_add_task_dependency`,
 * `cyboflow_set_idea_component`, `cyboflow_list_tasks` and `cyboflow_get_task`.
 * Split out of McpQueryHandler (issue #19) with every method body verbatim; the
 * handler routes the seven message types here and supplies the shared readers.
 */
export class TaskToolHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: TaskToolContext['writeResponse'];
  private readonly resolveTaskRunContext: TaskToolContext['resolveTaskRunContext'];

  constructor(ctx: TaskToolContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveTaskRunContext = ctx.resolveTaskRunContext;
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

  /**
   * Resolve a ref-or-id into the OPAQUE id of an existing entity of `type`
   * within `projectId`, or null when it does not exist / is the wrong type /
   * belongs to another project. Used by the global agent's
   * create-backlog-items propose path to validate + normalize the
   * parentEpicId / originatingIdeaId links a proposed batch points at
   * (resolveBacklogRef round-trips an opaque id unchanged, so one call covers
   * both input forms).
   */
  private resolveExistingEntity(projectId: number, refOrId: string, type: TaskType): string | null {
    const id = resolveBacklogRef(this.db, projectId, refOrId) ?? refOrId;
    const table = type === 'idea' ? 'ideas' : type === 'epic' ? 'epics' : 'tasks';
    const row = this.db
      .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`)
      .get(id, projectId);
    return row !== undefined ? id : null;
  }

  async handleCreateTask(
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
      executor: msg.executor,
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

  async handleUpdateTask(
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
        executor: msg.executor,
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

  async handleSetTaskStage(
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
  async handleAddTaskDependency(
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

  /**
   * Set one idea's component ledger state (cyboflow_set_idea_component) via
   * IdeaComponentRouter's 'set-component-state' op, source:'flow'. Resolves
   * `ideaId` id-then-ref exactly like handleGetTask (an opaque id wins; on a
   * miss, resolveBacklogRef scoped to this run's project), and rejects
   * 'not_found' when the resolved entity is missing, cross-project, or not an
   * idea (epics/tasks carry no ledger) — the same "indistinguishable from a
   * genuine miss" posture handleGetTask uses for its cross-project guard.
   *
   * `sourceRunId` and `builtAgainstVersion` are resolved HERE, never accepted
   * from the calling agent (per the brief: "the tool resolves those, never the
   * calling agent") — sourceRunId is this run's own id, and
   * builtAgainstVersion is the idea's CURRENT `version` at call time (the
   * version this component is being stamped AGAINST).
   */
  async handleSetIdeaComponent(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-idea-component' }>,
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

    let item = selectTaskById(this.db, msg.ideaId);
    if (!item) {
      const resolvedId = resolveBacklogRef(this.db, ctx.projectId, msg.ideaId);
      if (resolvedId) {
        item = selectTaskById(this.db, resolvedId);
      }
    }

    if (!item || item.project_id !== ctx.projectId || item.type !== 'idea') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    try {
      const { states } = await IdeaComponentRouter.getInstance().applyChange(ctx.projectId, {
        op: 'set-component-state',
        ideaId: item.id,
        component: msg.component,
        state: msg.state,
        source: 'flow',
        sourceRunId: msg.runId,
        builtAgainstVersion: item.version,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          idea_id: item.id,
          ref: item.ref,
          component: msg.component,
          state: msg.state,
          // The fresh merged hybrid snapshot (all five) — lets the calling
          // agent confirm staleness cleared without a separate get_task round
          // trip (setComponentState always clears stale_at/stale_reason as a
          // side effect; see ideaComponentRouter.ts).
          components: states,
        },
      });
    } catch (err) {
      this.writeIdeaComponentError(client, msg.requestId, err);
    }
  }

  /**
   * Surface an IdeaComponentRouter chokepoint failure as an ok:false response.
   * Mirrors writeTaskChangeError's shape for the sibling ledger chokepoint.
   */
  private writeIdeaComponentError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof IdeaComponentError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] idea component change failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'idea_component_change_failed',
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
  handleListTasks(
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

    const tasks = filtered.map((item) => toCompactTask(item));

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
  handleGetTask(
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

    const task = toFullTask(item);
    // Ideas-only (migration 028 / IDEA-006): epics/tasks carry no attachments
    // column at all, so they get no `attachments` key; an idea with none gets
    // the empty array (a stable, documented shape either way).
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = toMcpAttachments(attachments);

      // Design Mode v0 (design-mode.md "Idea-bound artifact + read path"): the
      // zero-export handoff's prototype half. The '## Design spec' half is
      // already folded into `item.body` (Approve Step 2), so this is the other
      // half — the current approved prototype snapshot, when one exists. Absent
      // (never approved, or the only approval was superseded with no
      // replacement — which the Approve transaction prevents) omits the key
      // entirely, matching this handler's existing optional-field style.
      const approvedDesign = getCurrentApprovedDesign(this.db, item.id);
      if (approvedDesign) {
        task['approved_design'] = {
          approved_at: approvedDesign.approvedAt,
          draft_revision: approvedDesign.draftRevision,
          prototype_revision: approvedDesign.prototypeRevision,
          // RESOLVED absolute on-disk path (mirrors toMcpAttachments below) so a
          // planner/sprint agent can Read the file directly with no export step.
          // Host-written only (Approve's snapshot step OR flowDesignBinding's,
          // never agent-supplied), so no containment check is needed here —
          // snapshotBaseDir is already an absolute CYBOFLOW_DIR path
          // (main/src/index.ts).
          snapshot_path: path.resolve(approvedDesign.snapshotPath),
          // Provenance (migration 134): 'design-mode' is a Design Mode Approve;
          // 'flow' is a Launch/Planner/Ship run whose design gate cleared, with
          // `source_run_id` naming that run. A reading agent uses it to tell a
          // hand-refined design from a flow's generated concept mockup — and the
          // flow binder uses it to leave a design-mode approval alone.
          source: approvedDesign.source,
          source_run_id: approvedDesign.sourceRunId,
        };
      }

      // Idea component ledger (migration 101 / shared/types/ideaComponents.ts):
      // the hybrid read model, resolved fresh on every get_task rather than
      // trusted from the listing-path overlay so a same-turn stamp is never
      // stale. Always all FIVE components — never omitted for an idea (unlike
      // attachments/approved_design, there is no "component with none" case:
      // resolveIdeaComponents backfills every component via derivation when no
      // ledger row exists). Each entry carries `staleAt`, which is the field a
      // reading agent MUST check, not just `state`: `state: 'incomplete'` alone
      // is ambiguous between "never started" (staleAt: null) and "needs
      // review" (staleAt non-null — prior work exists and should be
      // re-verified against the diff, not redone from scratch). See
      // planner.md's "component ledger" section for how a flow is expected to
      // read and act on this.
      task['components'] = resolveIdeaComponents(this.db, item.id);
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
}
