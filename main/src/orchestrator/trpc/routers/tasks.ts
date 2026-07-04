/**
 * cyboflow.tasks sub-router.
 *
 * Provides the typed tRPC contract for the renderer's backlogStore:
 *   - list           : query        -> BacklogTaskItem[] (backlog, epic-nested + on-read overlays;
 *                                       projectId null = ALL projects)
 *   - get            : query        -> BacklogTaskItem | null (single task, epic-nested)
 *   - boardsForProject : query      -> Board[] (board + ordered stages; projectId null = ALL boards)
 *   - create         : mutation     -> { taskId } (TaskChangeRouter.applyChange, no taskId)
 *   - update         : mutation     -> { taskId } (TaskChangeRouter.applyChange, field updates)
 *   - setStage       : mutation     -> { taskId } (TaskChangeRouter.applyChange, stage move)
 *   - archive        : mutation     -> { taskId } (TaskChangeRouter.applyChange, archived toggle —
 *                                       stamps/clears archived_at IN PLACE, no stage move)
 *   - delete         : mutation     -> { taskId } (TaskChangeRouter.applyDelete, hard delete + cascade)
 *   - onTaskChanged  : subscription -> TaskChangedEvent (projectId null bridges TASK_ALL_CHANNEL,
 *                                       a number bridges that project's channel)
 *
 * AUTHORITY + active-run guard + parent validation + optimistic concurrency all
 * live ENTIRELY in the chokepoint (TaskChangeRouter.applyChange / applyDelete).
 * This router is a thin wrapper: the mutations forward {actor:'user', ...} and
 * surface TaskChangeError.code to the client — it does NOT re-implement
 * validation (foundation note #6). Derived stages (positions 7/8) reject any
 * non-orchestrator actor, so a user setStage onto an execution stage maps to
 * code:'forbidden_stage'.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { BacklogTaskItem, Board, IdeaAttachment, TaskChangedEvent } from '../../../../../shared/types/tasks';
import {
  TaskChangeRouter,
  TaskChangeError,
  taskChangeEvents,
  taskProjectChannel,
  TASK_ALL_CHANNEL,
} from '../../taskChangeRouter';
import {
  selectProjectBacklog,
  selectTaskById,
  selectIdeaDecomposition,
  boardsForProject,
  selectIdeaAttachments,
} from '../../taskListing';
import { eventToAsyncIterable } from './events';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a TaskChangeError's discriminated code to a TRPCError so the renderer can
 * branch on `error.data.code` (e.g. 'CONFLICT' for a stale-version write,
 * 'FORBIDDEN' for an attempt to assert a derived execution stage).
 *
 * Re-throws non-TaskChangeError errors unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof TaskChangeError) {
    const codeMap: Record<TaskChangeError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_parent: 'BAD_REQUEST',
      invalid_lineage: 'BAD_REQUEST',
      forbidden_stage: 'FORBIDDEN',
      active_runs: 'CONFLICT',
      concurrency: 'CONFLICT',
      invalid_dependency: 'BAD_REQUEST',
      dependency_cycle: 'CONFLICT',
      experiment_sandboxed: 'CONFLICT',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      // Prefix the discriminated code so the client can branch on it without a
      // separate channel — mirrors how the chokepoint codes are surfaced.
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

const taskTypeSchema = z.enum(['idea', 'epic', 'task']);
const prioritySchema = z.enum(['P0', 'P1', 'P2']);
const scopeSchema = z.enum(['small', 'large']);

/**
 * One idea image attachment (migration 028). Mirrors the IdeaAttachment shared
 * type; `path` is the absolute on-disk path returned by the ideas:save-attachments
 * IPC. Ideas-only — the chokepoint ignores it on epics/tasks.
 */
const attachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  path: z.string().min(1),
  type: z.string(),
  size: z.number().int().nonnegative(),
});

export const tasksRouter = router({
  /**
   * List the full backlog — top-level items with epics nesting their child
   * tasks, each carrying on-read overlays (inFlow / awaitingReview / isDone).
   * `projectId: null` lists ALL projects (the cross-project board); a number
   * scopes to that project. Delegates to selectProjectBacklog in taskListing.ts
   * so the query is shared with the parity test — no inline SQL here. Archived
   * items are always included (visibility is a client concern).
   *
   * Returns BacklogTaskItem[] so the inferred AppRouter type carries the full
   * UI-visible shape (including the derived overlays) to the renderer.
   */
  list: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive().nullable() }))
    .query(async ({ input, ctx }): Promise<BacklogTaskItem[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[tasks.list] db not wired into tRPC context',
        });
      }
      return selectProjectBacklog(ctx.db, input.projectId);
    }),

  /**
   * Fetch a single task by id (with epic children + rollups when it is an epic).
   * Returns null when the task does not exist.
   */
  get: protectedProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<BacklogTaskItem | null> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[tasks.get] db not wired into tRPC context',
        });
      }
      return selectTaskById(ctx.db, input.taskId);
    }),

  /**
   * Fetch an IDEA together with its full decomposition tree — the idea as the
   * root, its epics under `children` (WHERE originating_idea_id = ideaId), and
   * each epic's tasks under that epic's `children` (WHERE parent_epic_id). Returns
   * null when the id is not an idea.
   *
   * Dedicated read for the `decomposed-stories` artifact tab: `get` only nests
   * children for an epic, so an idea id there yields children===undefined and the
   * renderer shows its empty state even for a fully-decomposed idea. This query
   * fills that gap without changing `get`'s shape for its other consumers.
   */
  ideaDecomposition: protectedProcedure
    .input(z.object({ ideaId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<BacklogTaskItem | null> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[tasks.ideaDecomposition] db not wired into tRPC context',
        });
      }
      return selectIdeaDecomposition(ctx.db, input.ideaId);
    }),

  /**
   * Fetch the image attachments (migration 028) for a single idea. Kept OUT of
   * the BacklogTaskItem read model (attachments are only needed when the idea
   * editor opens), so the editor fetches them on demand. Returns [] for a
   * non-idea / missing id / no attachments. The image BYTES are loaded
   * separately via the ideas:load-attachments IPC (renderer → dataURL).
   */
  getAttachments: protectedProcedure
    .input(z.object({ ideaId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<IdeaAttachment[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[tasks.getAttachments] db not wired into tRPC context',
        });
      }
      return selectIdeaAttachments(ctx.db, input.ideaId);
    }),

  /**
   * List boards with their ordered stages, so the UI can render one Kanban
   * column per stage. `projectId: null` returns EVERY project's boards
   * (ordered project_id, is_default DESC) for the cross-project board; a number
   * scopes to that project. SQLite booleans are normalized to real booleans
   * inside boardsForProject.
   */
  boardsForProject: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive().nullable() }))
    .query(async ({ input, ctx }): Promise<Board[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[tasks.boardsForProject] db not wired into tRPC context',
        });
      }
      return boardsForProject(ctx.db, input.projectId);
    }),

  /**
   * Create a new task. Forwards to TaskChangeRouter.applyChange with no taskId
   * (create path) as actor='user'. The chokepoint mints the ref, inserts at the
   * idea stage (or initialStageId), validates authority + parent, and emits a
   * 'created' TaskChangedEvent. Surfaces TaskChangeError.code to the client.
   */
  create: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        type: taskTypeSchema.optional(),
        title: z.string().optional(),
        summary: z.string().nullable().optional(),
        /** Single markdown body column (present on every entity). Lets the planner free-text path seed the injectable idea body. */
        body: z.string().nullable().optional(),
        priority: prioritySchema.optional(),
        repo: z.string().nullable().optional(),
        /** Image attachments — only meaningful on type='idea' (chokepoint ignores it otherwise). */
        attachments: z.array(attachmentSchema).nullable().optional(),
        parentEpicId: z.string().nullable().optional(),
        boardId: z.string().optional(),
        initialStageId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          entityType: input.type,
          title: input.title,
          summary: input.summary,
          body: input.body,
          priority: input.priority,
          repo: input.repo,
          attachments: input.attachments,
          parentEpicId: input.parentEpicId,
          boardId: input.boardId,
          initialStageId: input.initialStageId,
        });
        return { taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Update an existing task's mutable fields and/or its parent epic. Forwards to
   * TaskChangeRouter.applyChange with the given taskId as actor='user'.
   *
   * `expectedVersion` (optional) drives optimistic concurrency — a stale value
   * surfaces as code:'concurrency' (TRPCError 'CONFLICT'). Re-parenting and
   * field edits are validated entirely by the chokepoint.
   */
  update: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        taskId: z.string().min(1),
        title: z.string().optional(),
        summary: z.string().nullable().optional(),
        /** Single markdown body column (present on every entity). */
        body: z.string().nullable().optional(),
        priority: prioritySchema.optional(),
        repo: z.string().nullable().optional(),
        /** Idea size hint — only meaningful on type='idea' (chokepoint ignores it otherwise). */
        scope: scopeSchema.nullable().optional(),
        /** Image attachments — whole-array replace; only meaningful on type='idea'. */
        attachments: z.array(attachmentSchema).nullable().optional(),
        parentEpicId: z.string().nullable().optional(),
        expectedVersion: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          taskId: input.taskId,
          fields: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.repo !== undefined ? { repo: input.repo } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
          },
          ...(input.parentEpicId !== undefined ? { parentEpicId: input.parentEpicId } : {}),
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        });
        return { taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Move a task to a different stage. Forwards to TaskChangeRouter.applyChange
   * with the stageId as actor='user'.
   *
   * The chokepoint enforces:
   *   - AUTHORITY: asserting a DERIVED execution stage (positions 7/8) by a
   *     non-orchestrator actor -> code:'forbidden_stage' (TRPCError 'FORBIDDEN').
   *   - ACTIVE-RUN GUARD: asserting any stage on a task with a non-terminal run
   *     -> code:'active_runs' (TRPCError 'CONFLICT').
   *   - optimistic concurrency via expectedVersion -> code:'concurrency'.
   */
  setStage: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        taskId: z.string().min(1),
        stageId: z.string().min(1),
        expectedVersion: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          taskId: input.taskId,
          stageId: input.stageId,
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        });
        return { taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Toggle archive-in-place on an entity (migration 024). Forwards to
   * TaskChangeRouter.applyChange with the `archived` flag as actor='user':
   * true stamps `archived_at = now`, false clears it — the item KEEPS its
   * current stage/column (no stage move; the terminal "Archived" stage no
   * longer exists). The chokepoint guards archiving on a task with a
   * non-terminal run -> code:'active_runs' (TRPCError 'CONFLICT'); unarchive
   * is never guarded. `expectedVersion` drives optimistic concurrency.
   */
  archive: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        taskId: z.string().min(1),
        archived: z.boolean(),
        expectedVersion: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          taskId: input.taskId,
          archived: input.archived,
          ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        });
        return { taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * PERMANENTLY delete an entity and its cascade (idea -> epics + tasks;
   * epic -> child tasks). Forwards to TaskChangeRouter.applyDelete as
   * actor='user'; the chokepoint owns the cascade computation, entity_events
   * purge, best-effort review_items dismissal, and the 'deleted' emits. Any
   * cascade task with a non-terminal run rejects the whole delete ->
   * code:'active_runs' (TRPCError 'CONFLICT'). Deliberately NOT exposed to MCP
   * agents — this tRPC procedure (GUI) and the orchestrator are the only callers.
   */
  delete: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        taskId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyDelete(input.projectId, {
          actor: 'user',
          taskId: input.taskId,
        });
        return { taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Subscribe to task-changed notifications.
   *
   * Bridges the module-level `taskChangeEvents` EventEmitter (exported from
   * taskChangeRouter.ts, NOT events.ts). `projectId: null` bridges the
   * cross-project TASK_ALL_CHANNEL ('task-all') — the all-projects board
   * subscribes ONCE and filters client-side; a number bridges the
   * project-scoped channel taskProjectChannel(projectId) =
   * 'task-project-<projectId>' (unchanged). The chokepoint emits every
   * committed change (created / updated / stageMoved / deleted) on BOTH
   * channels; the per-event projectId is carried on the TaskChangedEvent
   * payload, so a TASK_ALL_CHANNEL consumer can still scope per event.
   *
   * No throttle: task mutations are user/orchestrator-gated and each must surface.
   */
  onTaskChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive().nullable() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<TaskChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const channel =
        input.projectId === null ? TASK_ALL_CHANNEL : taskProjectChannel(input.projectId);
      const source = eventToAsyncIterable<TaskChangedEvent>(
        taskChangeEvents,
        channel,
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
