/**
 * cyboflow.tasks sub-router.
 *
 * Provides the typed tRPC contract for the renderer's backlogStore:
 *   - list           : query        -> BacklogTaskItem[] (project backlog, epic-nested + on-read overlays)
 *   - get            : query        -> BacklogTaskItem | null (single task, epic-nested)
 *   - boardsForProject : query      -> Board[] (board + ordered stages, so the UI gets its columns)
 *   - create         : mutation     -> { taskId } (TaskChangeRouter.applyChange, no taskId)
 *   - update         : mutation     -> { taskId } (TaskChangeRouter.applyChange, field updates)
 *   - setStage       : mutation     -> { taskId } (TaskChangeRouter.applyChange, stage move)
 *   - onTaskChanged  : subscription -> TaskChangedEvent (project-scoped, bridges taskChangeEvents)
 *
 * AUTHORITY + active-run guard + parent validation + optimistic concurrency all
 * live ENTIRELY in the chokepoint (TaskChangeRouter.applyChange). This router is
 * a thin wrapper: the mutations forward {actor:'user', ...} and surface
 * TaskChangeError.code to the client — it does NOT re-implement validation
 * (foundation note #6). Derived stages (positions 7/8) reject any non-orchestrator
 * actor, so a user setStage onto an execution stage maps to code:'forbidden_stage'.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { BacklogTaskItem, Board, TaskChangedEvent } from '../../../../../shared/types/tasks';
import {
  TaskChangeRouter,
  TaskChangeError,
  taskChangeEvents,
  taskProjectChannel,
} from '../../taskChangeRouter';
import { selectProjectBacklog, selectTaskById, boardsForProject } from '../../taskListing';
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

export const tasksRouter = router({
  /**
   * List the full backlog for a project — top-level items with epics nesting
   * their child tasks, each carrying on-read overlays (inFlow / awaitingReview /
   * isDone). Delegates to selectProjectBacklog in taskListing.ts so the query is
   * shared with the parity test — no inline SQL here.
   *
   * Returns BacklogTaskItem[] so the inferred AppRouter type carries the full
   * UI-visible shape (including the derived overlays) to the renderer.
   */
  list: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
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
   * List the project's boards with their ordered stages, so the UI can render
   * one Kanban column per stage. SQLite booleans are normalized to real
   * booleans inside boardsForProject.
   */
  boardsForProject: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
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
        priority: prioritySchema.optional(),
        repo: z.string().nullable().optional(),
        parentEpicId: z.string().nullable().optional(),
        boardId: z.string().optional(),
        initialStageId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ taskId: string }> => {
      try {
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          type: input.type,
          title: input.title,
          summary: input.summary,
          priority: input.priority,
          repo: input.repo,
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
        priority: prioritySchema.optional(),
        repo: z.string().nullable().optional(),
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
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.repo !== undefined ? { repo: input.repo } : {}),
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
   * Subscribe to task-changed notifications for a single project.
   *
   * Bridges the module-level `taskChangeEvents` EventEmitter (exported from
   * taskChangeRouter.ts, NOT events.ts) on the project-scoped channel
   * taskProjectChannel(projectId) = 'task-project-<projectId>'. The chokepoint
   * emits a TaskChangedEvent on that channel after every committed change
   * (created / updated / stageMoved). The store applies the event to its
   * in-memory backlog without a full re-fetch.
   *
   * No throttle: task mutations are user/orchestrator-gated and each must surface.
   */
  onTaskChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<TaskChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<TaskChangedEvent>(
        taskChangeEvents,
        taskProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
