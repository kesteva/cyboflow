/**
 * SprintBatchScheduler — orchestrates a parallel-sprint BATCH: a set of tasks
 * executed with bounded concurrency over ONE shared integration branch, with a
 * single human review at finalize (feat/parallel-sprint).
 *
 * Lifecycle (this phase — P3 — covers planning + drain; integration-merge is P4,
 * finalize is P5, both TODO-stubbed):
 *   1. createBatch  — insert sprint_batches (planning) + one sprint_batch_tasks
 *                     per task (queued); create the integration branch off the
 *                     project main branch; launch the single `sprint-init` run
 *                     (dependency analysis) tagged with batch_id.
 *   2. onRunStatusChanged — the runStatusEvents hook. When the init run drains
 *                     clean (awaiting_review) → batch planning→running + drain().
 *                     When a `task` run drains clean → mark its batch_task
 *                     integrated (TODO(P4): integration merge here), unblock
 *                     dependents, drain(). When all tasks integrated → finalizing
 *                     (TODO(P5): launch finalize).
 *   3. drain        — compute READY batch tasks from the in-batch blocking DAG
 *                     (task_dependencies), launch up to `concurrency` ready
 *                     tasks as standalone `task` runs.
 *   4. start        — boot rehydration: re-attach non-terminal batches and
 *                     resume draining (mirrors runRecovery.ts).
 *
 * Standalone-typecheck invariant: NO 'electron' / 'better-sqlite3' / services/*
 * import. All collaborators are injected as narrow interfaces. State writes to
 * the scheduler-owned tables (sprint_batches / sprint_batch_tasks /
 * workflow_runs.batch_id) go DIRECTLY through DatabaseLike (the same way
 * RunLauncher writes workflow_runs); board-stage derivation of the underlying
 * tasks flows through the injected chokepoint (taskStageDeriver). Per-batch
 * serialization is provided by a single-slot async queue so two events for the
 * same batch never interleave.
 */
import { randomUUID } from 'crypto';
import type { DatabaseLike, LoggerLike } from './types';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type {
  SprintBatchRow,
  SprintBatchTaskRow,
  SprintBatchProgress,
} from '../../../shared/types/sprintBatch';
import {
  SPRINT_BATCH_CAP,
  SPRINT_BATCH_MAX_TASKS,
  TERMINAL_BATCH_STATUSES,
} from '../../../shared/types/sprintBatch';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Injected collaborators (narrow interfaces)
// ---------------------------------------------------------------------------

/** Narrow slice of RunLauncher the scheduler needs to launch init/task runs. */
export interface BatchRunLauncherLike {
  /**
   * Launch a workflow run. The scheduler always passes the resolved workflow id
   * (`wf-<projectId>-<name>`) and forwards the batch substrate as the per-run
   * choice. `baseBranch` (when supplied) cuts the run's worktree branch off the
   * current integration tip so dependents see their prereqs' changes.
   */
  launch(
    workflowId: string,
    projectPath: string,
    substrate?: CliSubstrate,
    taskId?: string,
    ideaId?: string,
    sessionId?: string,
    baseBranch?: string,
  ): Promise<{ runId: string; worktreePath: string; branchName: string }>;
}

/** Narrow slice of WorktreeManager the scheduler needs for the integration branch. */
export interface BatchWorktreeManagerLike {
  getProjectMainBranch(projectPath: string): Promise<string>;
  createBranchRef(
    projectPath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<{ sha: string }>;
}

/**
 * Narrow slice of TaskChangeRouter — board-stage derivation through the single
 * write chokepoint. The scheduler NEVER raw-UPDATEs ideas/epics/tasks.
 */
export interface BatchTaskStageDeriverLike {
  recomputeTaskExecutionStage(taskId: string): Promise<void>;
}

/** Resolves the project path from its id (mirrors SessionManagerLike). */
export interface BatchProjectResolverLike {
  getProjectById(projectId: number): { path: string } | undefined;
}

/**
 * Minimal run-status event source. The concrete `runStatusEvents` EventEmitter
 * (declared in trpc/routers/events.ts, emitted from index.ts on every executor
 * transition) satisfies this shape structurally. Injected at start() so the
 * orchestrator layer never imports the trpc router barrel (standalone-typecheck
 * invariant) and tests can drive a fake emitter.
 */
export interface RunStatusEventSource {
  on(event: 'changed', listener: (e: { runId: string; status: WorkflowRunStatus }) => void): unknown;
  off(event: 'changed', listener: (e: { runId: string; status: WorkflowRunStatus }) => void): unknown;
}

export interface SprintBatchSchedulerDeps {
  db: DatabaseLike;
  runLauncher: BatchRunLauncherLike;
  worktreeManager: BatchWorktreeManagerLike;
  taskStageDeriver: BatchTaskStageDeriverLike;
  projectResolver: BatchProjectResolverLike;
  logger: LoggerLike;
}

export interface CreateBatchInput {
  projectId: number;
  substrate: CliSubstrate;
  taskIds: string[];
  /** Bounded concurrency; defaults to SPRINT_BATCH_CAP. */
  concurrency?: number;
}

export class SprintBatchSchedulerError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'SprintBatchSchedulerError';
  }
}

const TERMINAL_BATCH_SQL_IN = `('${TERMINAL_BATCH_STATUSES.join("','")}')`;
const TERMINAL_RUN_SQL_IN = `('${TERMINAL_RUN_STATUSES.join("','")}')`;

export class SprintBatchScheduler {
  private readonly db: DatabaseLike;
  private readonly runLauncher: BatchRunLauncherLike;
  private readonly worktreeManager: BatchWorktreeManagerLike;
  private readonly taskStageDeriver: BatchTaskStageDeriverLike;
  private readonly projectResolver: BatchProjectResolverLike;
  private readonly logger: LoggerLike;

  /**
   * One serialization chain per batch id. Every batch mutation (drain, the
   * runStatusEvents handler) runs on this chain so two events for the SAME batch
   * never interleave and drain decisions never race. Distinct batches proceed in
   * parallel. A thin promise-chain stands in for a PQueue(concurrency:1) to keep
   * the orchestrator layer dependency-free.
   */
  private readonly batchQueues = new Map<string, Promise<void>>();

  private boundHandler: ((event: { runId: string; status: WorkflowRunStatus }) => void) | null = null;
  private eventSource: RunStatusEventSource | null = null;

  constructor(deps: SprintBatchSchedulerDeps) {
    this.db = deps.db;
    this.runLauncher = deps.runLauncher;
    this.worktreeManager = deps.worktreeManager;
    this.taskStageDeriver = deps.taskStageDeriver;
    this.projectResolver = deps.projectResolver;
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // Per-batch serialization
  // -------------------------------------------------------------------------

  /**
   * Enqueue `fn` on the batch's single-slot chain. Errors are caught + logged so
   * one failing step never breaks the chain for later events.
   */
  private enqueue(batchId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.batchQueues.get(batchId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => fn())
      .catch((err) => {
        this.logger.error('[SprintBatchScheduler] batch step failed', {
          batchId,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      });
    this.batchQueues.set(batchId, next);
    return next;
  }

  /**
   * Await all currently-enqueued per-batch work to settle. Used by tests (and
   * available to a graceful-shutdown path) to flush the event-driven drain chain
   * — the runStatusEvents handler enqueues asynchronously, so callers that need
   * to observe the post-event state await this.
   */
  async whenSettled(): Promise<void> {
    await Promise.all([...this.batchQueues.values()].map((p) => p.catch(() => undefined)));
  }

  // -------------------------------------------------------------------------
  // createBatch
  // -------------------------------------------------------------------------

  async createBatch(input: CreateBatchInput): Promise<{ batchId: string }> {
    const { projectId, substrate, taskIds } = input;
    const concurrency = input.concurrency ?? SPRINT_BATCH_CAP;

    if (taskIds.length === 0) {
      throw new SprintBatchSchedulerError('bad_request', 'a batch needs at least one task');
    }
    const max = SPRINT_BATCH_MAX_TASKS[substrate];
    if (taskIds.length > max) {
      throw new SprintBatchSchedulerError(
        'bad_request',
        `too many tasks for the ${substrate} substrate: ${taskIds.length} > ${max}`,
      );
    }
    const uniqueTaskIds = [...new Set(taskIds)];

    const project = this.projectResolver.getProjectById(projectId);
    if (!project) {
      throw new SprintBatchSchedulerError('not_found', `project ${projectId} not found`);
    }

    const batchId = randomUUID().replace(/-/g, '');
    const integrationBranch = `sprint/${batchId.slice(0, 8)}`;

    // Create the integration branch off the project main branch (best-effort —
    // if the git create fails we still persist the batch so the user sees the
    // failure surfaced rather than a silent no-op).
    let baseBranch: string | null = null;
    let baseSha: string | null = null;
    try {
      baseBranch = await this.worktreeManager.getProjectMainBranch(project.path);
      const { sha } = await this.worktreeManager.createBranchRef(
        project.path,
        integrationBranch,
        baseBranch,
      );
      baseSha = sha;
    } catch (err) {
      this.logger.error('[SprintBatchScheduler] failed to create integration branch', {
        batchId,
        integrationBranch,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Insert sprint_batches (planning) + one sprint_batch_tasks per task (queued)
    // in a single transaction.
    const insertBatch = this.db.prepare(
      `INSERT INTO sprint_batches
         (id, project_id, substrate, status, integration_branch, base_branch, base_sha, concurrency)
       VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)`,
    );
    const insertTask = this.db.prepare(
      `INSERT OR IGNORE INTO sprint_batch_tasks (batch_id, task_id, status)
       VALUES (?, ?, 'queued')`,
    );
    const tx = this.db.transaction(() => {
      insertBatch.run(
        batchId,
        projectId,
        substrate,
        integrationBranch,
        baseBranch,
        baseSha,
        concurrency,
      );
      for (const taskId of uniqueTaskIds) {
        insertTask.run(batchId, taskId);
      }
    });
    tx();

    // Launch the single sprint-init run (dependency analysis). Tagged with
    // batch_id so onRunStatusChanged can route its terminal/awaiting_review event
    // back to this batch.
    const workflowId = this.workflowIdFor(projectId, 'sprint-init');
    try {
      const { runId } = await this.runLauncher.launch(
        workflowId,
        project.path,
        substrate,
      );
      this.tagRunWithBatch(runId, batchId);
      this.db
        .prepare('UPDATE sprint_batches SET init_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(runId, batchId);
      this.logger.info('[SprintBatchScheduler] batch created + init run launched', {
        batchId,
        runId,
        taskCount: uniqueTaskIds.length,
      });
    } catch (err) {
      // Init launch failed — mark the batch failed so it does not hang in planning.
      this.markBatchFailed(batchId, `init launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { batchId };
  }

  // -------------------------------------------------------------------------
  // runStatusEvents hook
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the injected run-status event source and rehydrate non-terminal
   * batches. Wired at boot in main/src/index.ts, which passes the module-level
   * `runStatusEvents` emitter. Idempotent — a second start() is a no-op.
   */
  start(eventSource: RunStatusEventSource): void {
    if (this.boundHandler) return;
    this.boundHandler = (event) => this.onRunStatusChanged(event);
    this.eventSource = eventSource;
    eventSource.on('changed', this.boundHandler);
    this.rehydrate();
  }

  stop(): void {
    if (!this.boundHandler || !this.eventSource) return;
    this.eventSource.off('changed', this.boundHandler);
    this.boundHandler = null;
    this.eventSource = null;
  }

  /**
   * The runStatusEvents handler. Routes a status change for a batch-member run
   * onto that batch's serialization chain. Non-batch runs are ignored.
   */
  onRunStatusChanged(event: { runId: string; status: WorkflowRunStatus }): void {
    const row = this.db
      .prepare(
        `SELECT r.batch_id AS batch_id, r.task_id AS task_id, w.name AS workflow_name
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(event.runId) as
      | { batch_id: string | null; task_id: string | null; workflow_name: string }
      | undefined;
    if (!row || !row.batch_id) return; // not a batch run

    const batchId = row.batch_id;
    void this.enqueue(batchId, async () => {
      switch (row.workflow_name) {
        case 'sprint-init':
          await this.handleInitStatus(batchId, event.status);
          break;
        case 'task':
          await this.handleTaskStatus(batchId, event.runId, row.task_id, event.status);
          break;
        case 'sprint-finalize':
          await this.handleFinalizeStatus(batchId, event.status);
          break;
        default:
          break;
      }
    });
  }

  private async handleInitStatus(batchId: string, status: WorkflowRunStatus): Promise<void> {
    const batch = this.getBatch(batchId);
    if (!batch || batch.status !== 'planning') return; // status-guarded idempotency

    if (status === 'awaiting_review') {
      // Init drained clean: dependencies are written. Flip planning → running.
      const changed = this.db
        .prepare(
          `UPDATE sprint_batches SET status = 'running', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'planning'`,
        )
        .run(batchId) as { changes: number };
      if (changed.changes > 0) {
        this.logger.info('[SprintBatchScheduler] init drained → batch running', { batchId });
        await this.drain(batchId);
      }
    } else if (this.isTerminalRunStatus(status)) {
      this.markBatchFailed(batchId, 'sprint-init run failed');
    }
  }

  private async handleTaskStatus(
    batchId: string,
    runId: string,
    taskId: string | null,
    status: WorkflowRunStatus,
  ): Promise<void> {
    const batch = this.getBatch(batchId);
    if (!batch || batch.status !== 'running') return;

    if (status === 'awaiting_review') {
      // Clean Phase-1 drain → this task is ready to integrate.
      //
      // TODO(P4): perform the integration MERGE here —
      //   worktreeManager.mergeWorktreeToBranch(projectPath, run.worktree, integration_branch)
      //   on conflict: mark batch_task 'failed' (do NOT crash the batch).
      // For THIS phase the merge is stubbed; we mark the task integrated and
      // derive its board stage to 8 (Ready to merge) WHILE the run is still
      // awaiting_review (so recomputeTaskExecutionStage lands stage 8, not a
      // revert). The actual run close-out / outcome='integrated' stamping is P4.
      const marked = this.db
        .prepare(
          `UPDATE sprint_batch_tasks
              SET status = 'integrated', integrated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE batch_id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(batchId, runId) as { changes: number };
      if (marked.changes > 0 && taskId) {
        try {
          await this.taskStageDeriver.recomputeTaskExecutionStage(taskId);
        } catch (err) {
          this.logger.warn('[SprintBatchScheduler] stage derivation failed after integrate', {
            batchId,
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await this.drain(batchId);
    } else if (this.isTerminalRunStatus(status)) {
      // Per-task run failed/canceled → mark the batch_task failed, free the slot,
      // keep draining other ready tasks (the batch does NOT crash).
      this.db
        .prepare(
          `UPDATE sprint_batch_tasks
              SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
            WHERE batch_id = ? AND run_id = ? AND status = 'running'`,
        )
        .run(`run ${status}`, batchId, runId);
      await this.drain(batchId);
    }
  }

  private async handleFinalizeStatus(batchId: string, status: WorkflowRunStatus): Promise<void> {
    // TODO(P5): finalize lifecycle (sprint-verify → sprint-review → human gate →
    // merge integration→main → batch 'completed'). For now, a failed finalize run
    // fails the batch; awaiting_input/awaiting_review are no-ops handled by P5.
    if (this.isTerminalRunStatus(status)) {
      this.markBatchFailed(batchId, 'sprint-finalize run failed');
    }
  }

  // -------------------------------------------------------------------------
  // drain — the core scheduler step
  // -------------------------------------------------------------------------

  /**
   * Launch up to `concurrency` READY queued tasks. A task is READY when every
   * in-batch blocking prerequisite has reached `integrated`. Out-of-batch
   * prereqs are ignored (the user is responsible for a closed selection set).
   * When all tasks are integrated, the batch flips running → finalizing.
   */
  async drain(batchId: string): Promise<void> {
    const batch = this.getBatch(batchId);
    if (!batch || batch.status !== 'running') return;

    const tasks = this.getBatchTasks(batchId);
    if (tasks.length === 0) return;

    if (tasks.every((t) => t.status === 'integrated')) {
      // All integrated → finalize. P5 launches the sprint-finalize run; here we
      // only flip the state so the batch leaves `running`.
      const flipped = this.db
        .prepare(
          `UPDATE sprint_batches SET status = 'finalizing', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'`,
        )
        .run(batchId) as { changes: number };
      if (flipped.changes > 0) {
        this.logger.info('[SprintBatchScheduler] all tasks integrated → batch finalizing', { batchId });
        // TODO(P5): launch the single sprint-finalize run over the integration branch.
      }
      return;
    }

    const project = this.projectResolver.getProjectById(batch.project_id);
    if (!project) {
      this.logger.error('[SprintBatchScheduler] project gone during drain', {
        batchId,
        projectId: batch.project_id,
      });
      return;
    }

    const running = tasks.filter((t) => t.status === 'running').length;
    let slots = batch.concurrency - running;
    if (slots <= 0) return;

    const integratedTaskIds = new Set(
      tasks.filter((t) => t.status === 'integrated').map((t) => t.task_id),
    );
    const inBatchTaskIds = new Set(tasks.map((t) => t.task_id));
    const blockingPrereqs = this.loadBlockingPrereqs([...inBatchTaskIds]);

    const ready = tasks.filter((t) => {
      if (t.status !== 'queued') return false;
      const prereqs = blockingPrereqs.get(t.task_id);
      if (!prereqs) return true;
      // Only in-batch prereqs gate readiness; drop edges to out-of-batch tasks.
      return [...prereqs].every(
        (dep) => !inBatchTaskIds.has(dep) || integratedTaskIds.has(dep),
      );
    });

    const workflowId = this.workflowIdFor(batch.project_id, 'task');
    for (const t of ready) {
      if (slots <= 0) break;
      try {
        const { runId } = await this.runLauncher.launch(
          workflowId,
          project.path,
          batch.substrate,
          t.task_id,
          undefined,
          undefined,
          batch.integration_branch ?? undefined,
        );
        this.tagRunWithBatch(runId, batchId);
        const claimed = this.db
          .prepare(
            `UPDATE sprint_batch_tasks
                SET status = 'running', run_id = ?, updated_at = CURRENT_TIMESTAMP
              WHERE batch_id = ? AND task_id = ? AND status = 'queued'`,
          )
          .run(runId, batchId, t.task_id) as { changes: number };
        if (claimed.changes > 0) {
          slots -= 1;
          this.logger.info('[SprintBatchScheduler] launched task run', {
            batchId,
            taskId: t.task_id,
            runId,
          });
        }
      } catch (err) {
        this.db
          .prepare(
            `UPDATE sprint_batch_tasks
                SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE batch_id = ? AND task_id = ? AND status = 'queued'`,
          )
          .run(
            `launch failed: ${err instanceof Error ? err.message : String(err)}`,
            batchId,
            t.task_id,
          );
        this.logger.error('[SprintBatchScheduler] task launch failed', {
          batchId,
          taskId: t.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // rehydrate — boot recovery
  // -------------------------------------------------------------------------

  /**
   * Re-attach non-terminal batches on boot and resume draining. Runs AFTER
   * recoverActiveStateOrphans (which has already failed any in-flight run), so a
   * `running` batch_task whose run is now terminal-without-integration is
   * reconciled to `failed` before we re-drain.
   *
   * v1 marks a crashed in-flight task `failed` rather than auto-restarting it
   * (its half-done worktree is gone). The user can re-select it into a new batch.
   */
  rehydrate(): void {
    const batches = this.db
      .prepare(`SELECT id FROM sprint_batches WHERE status NOT IN ${TERMINAL_BATCH_SQL_IN}`)
      .all() as Array<{ id: string }>;

    for (const { id } of batches) {
      void this.enqueue(id, async () => {
        // Reconcile any batch_task still marked 'running' whose run died at boot.
        this.reconcileCrashedTasks(id);
        const batch = this.getBatch(id);
        if (!batch) return;
        if (batch.status === 'running') {
          await this.drain(id);
        } else if (batch.status === 'planning') {
          // Init run is gone (failed at boot) → fail the batch; the user re-launches.
          if (this.initRunTerminal(batch)) {
            this.markBatchFailed(id, 'sprint-init run did not survive restart');
          }
        }
        // 'finalizing' rehydration is P5 (re-launch finalize idempotently).
      });
    }
    if (batches.length > 0) {
      this.logger.info('[SprintBatchScheduler] rehydrated non-terminal batches', {
        count: batches.length,
      });
    }
  }

  /**
   * Mark every batch_task still `running` whose linked run has gone terminal
   * (failed/canceled) WITHOUT integrating as `failed`. Called on rehydrate.
   */
  private reconcileCrashedTasks(batchId: string): void {
    const stale = this.db
      .prepare(
        `SELECT sbt.id AS sbt_id
           FROM sprint_batch_tasks sbt
           JOIN workflow_runs r ON r.id = sbt.run_id
          WHERE sbt.batch_id = ?
            AND sbt.status = 'running'
            AND r.status IN ${TERMINAL_RUN_SQL_IN}`,
      )
      .all(batchId) as Array<{ sbt_id: number }>;
    for (const { sbt_id } of stale) {
      this.db
        .prepare(
          `UPDATE sprint_batch_tasks
              SET status = 'failed', error_message = 'run did not survive restart', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'running'`,
        )
        .run(sbt_id);
    }
  }

  private initRunTerminal(batch: SprintBatchRow): boolean {
    if (!batch.init_run_id) return true; // no init run recorded → treat as gone
    const row = this.db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(batch.init_run_id) as { status: WorkflowRunStatus } | undefined;
    if (!row) return true;
    return this.isTerminalRunStatus(row.status);
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  batchProgress(batchId: string): SprintBatchProgress | null {
    const batch = this.getBatch(batchId);
    if (!batch) return null;
    const tasks = this.getBatchTasks(batchId);
    return {
      status: batch.status,
      total: tasks.length,
      queued: tasks.filter((t) => t.status === 'queued').length,
      running: tasks.filter((t) => t.status === 'running').length,
      integrated: tasks.filter((t) => t.status === 'integrated').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private getBatch(batchId: string): SprintBatchRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, substrate, status, integration_branch, base_branch, base_sha,
                concurrency, init_run_id, finalize_run_id, error_message, created_at, updated_at, completed_at
           FROM sprint_batches WHERE id = ?`,
      )
      .get(batchId) as SprintBatchRow | undefined;
    return row ?? null;
  }

  private getBatchTasks(batchId: string): SprintBatchTaskRow[] {
    return this.db
      .prepare(
        `SELECT id, batch_id, task_id, status, run_id, error_message, integrated_at, created_at, updated_at
           FROM sprint_batch_tasks WHERE batch_id = ? ORDER BY id`,
      )
      .all(batchId) as SprintBatchTaskRow[];
  }

  /**
   * Map taskId → set of its `blocking` prerequisite task ids, restricted to the
   * given candidate task ids. (A row `(task_id=A, depends_on_task_id=B)` means A
   * is blocked by B.) Only `blocking` edges participate; `related` is advisory.
   */
  private loadBlockingPrereqs(taskIds: string[]): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT task_id, depends_on_task_id
           FROM task_dependencies
          WHERE kind = 'blocking' AND task_id IN (${placeholders})`,
      )
      .all(...taskIds) as Array<{ task_id: string; depends_on_task_id: string }>;
    for (const row of rows) {
      let set = result.get(row.task_id);
      if (!set) {
        set = new Set<string>();
        result.set(row.task_id, set);
      }
      set.add(row.depends_on_task_id);
    }
    return result;
  }

  private tagRunWithBatch(runId: string, batchId: string): void {
    this.db
      .prepare('UPDATE workflow_runs SET batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(batchId, runId);
  }

  private markBatchFailed(batchId: string, reason: string): void {
    const changed = this.db
      .prepare(
        `UPDATE sprint_batches
            SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status NOT IN ${TERMINAL_BATCH_SQL_IN}`,
      )
      .run(reason, batchId) as { changes: number };
    if (changed.changes > 0) {
      this.logger.error('[SprintBatchScheduler] batch failed', { batchId, reason });
    }
  }

  private workflowIdFor(projectId: number, name: string): string {
    return `wf-${projectId}-${name}`;
  }

  private isTerminalRunStatus(status: WorkflowRunStatus): boolean {
    return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
  }
}
