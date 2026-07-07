/**
 * experimentStore — the SINGLE write surface for the `experiments` table
 * (migration 049, slice B). Pure over {@link DatabaseLike} so the experiments
 * router + boot recovery can drive it without electron/better-sqlite3, and unit
 * tests exercise it against an in-memory DB.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/* — it reaches
 * the DB only through the narrow DatabaseLike surface (mirrors experimentStore's
 * sibling runEntityOwnership.ts / stepTransitionBridge.ts).
 *
 * Status lifecycle (experiments.status):
 *   running  -> grading   (both arms settled — reconcileExperimentStatus)
 *   running  -> abandoned  (half-created crash / rollback / abandon)
 *   grading  -> decided    (experiments.decide, in the router)
 *   grading  -> abandoned  (abandon)
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from './types';
import type {
  ExperimentArm,
  ExperimentRow,
  ExperimentSeedTaskRow,
  ExperimentStatus,
} from '../../../shared/types/experiments';
import { isExperimentArmSettled } from '../../../shared/types/experiments';

/** Fields required to seed a new experiments row (status defaults to 'running'). */
export interface InsertExperimentInput {
  projectId: number;
  workflowId: string;
  baseBranch: string;
  baseSha: string;
  variantAId: string;
  variantBId: string;
  sessionAId?: string | null;
  sessionBId?: string | null;
  seedIdeaId?: string | null;
  seedIdeaCloneAId?: string | null;
  seedIdeaCloneBId?: string | null;
  rerunOfExperimentId?: string | null;
}

/** The mutable per-arm links stamped after the arm sessions/runs/clones exist. */
export interface ExperimentRunLinks {
  runAId?: string | null;
  runBId?: string | null;
  sessionAId?: string | null;
  sessionBId?: string | null;
  seedIdeaCloneAId?: string | null;
  seedIdeaCloneBId?: string | null;
}

/** Insert a new experiments row (status='running') and return it. */
export function insertExperiment(db: DatabaseLike, input: InsertExperimentInput): ExperimentRow {
  const id = `exp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare(
    `INSERT INTO experiments (
       id, project_id, workflow_id, kind, base_branch, base_sha,
       variant_a_id, variant_b_id, session_a_id, session_b_id,
       seed_idea_id, seed_idea_clone_a_id, seed_idea_clone_b_id,
       status, rerun_of_experiment_id
     ) VALUES (?, ?, ?, 'side_by_side', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(
    id,
    input.projectId,
    input.workflowId,
    input.baseBranch,
    input.baseSha,
    input.variantAId,
    input.variantBId,
    input.sessionAId ?? null,
    input.sessionBId ?? null,
    input.seedIdeaId ?? null,
    input.seedIdeaCloneAId ?? null,
    input.seedIdeaCloneBId ?? null,
    input.rerunOfExperimentId ?? null,
  );
  const row = getExperiment(db, id);
  if (!row) {
    throw new Error(`experimentStore.insertExperiment: inserted experiment ${id} could not be read back`);
  }
  return row;
}

/** Read one experiment row by id; null when absent. */
export function getExperiment(db: DatabaseLike, experimentId: string): ExperimentRow | null {
  const row = db
    .prepare('SELECT * FROM experiments WHERE id = ?')
    .get(experimentId) as ExperimentRow | undefined;
  return row ?? null;
}

/** All experiments for a project, newest-first. */
export function listExperimentsForProject(db: DatabaseLike, projectId: number): ExperimentRow[] {
  return db
    .prepare('SELECT * FROM experiments WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId) as ExperimentRow[];
}

// ---------------------------------------------------------------------------
// experiment_seed_tasks (migration 051) — per-arm task-clone mapping for a
// SPRINT experiment. NOT an entity table: these direct helpers own its writes
// (the clone ROWS in `tasks` are still minted/swept through TaskChangeRouter).
// ---------------------------------------------------------------------------

/** One (original -> clone) pair for a single arm, inserted at start. */
export interface SeedTaskClonePair {
  originalTaskId: string;
  cloneTaskId: string;
}

/** Insert the (experiment, arm, original -> clone) mapping rows for one arm. */
export function insertExperimentSeedTasks(
  db: DatabaseLike,
  experimentId: string,
  arm: ExperimentArm,
  pairs: readonly SeedTaskClonePair[],
): void {
  if (pairs.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const p of pairs) {
    stmt.run(experimentId, arm, p.originalTaskId, p.cloneTaskId);
  }
}

/**
 * All seed-task mapping rows for an experiment. Fail-soft: a pre-051 DB (no
 * experiment_seed_tasks table) or any thrown query yields [] — an idea-seeded or
 * pre-feature experiment simply has no rows, so the clone-sweep enumeration
 * degrades to "no task clones", never a throw (mirrors recoverExperiments' pattern).
 */
export function listExperimentSeedTasks(db: DatabaseLike, experimentId: string): ExperimentSeedTaskRow[] {
  try {
    return db
      .prepare('SELECT * FROM experiment_seed_tasks WHERE experiment_id = ? ORDER BY arm, original_task_id')
      .all(experimentId) as ExperimentSeedTaskRow[];
  } catch {
    return [];
  }
}

/** The clone task ids for one arm of an experiment (from the mapping table). */
export function seedTaskCloneIdsForArm(
  db: DatabaseLike,
  experimentId: string,
  arm: ExperimentArm,
): string[] {
  return listExperimentSeedTasks(db, experimentId)
    .filter((r) => r.arm === arm)
    .map((r) => r.clone_task_id);
}

/** Drop all seed-task mapping rows for an experiment (decide / discard / abandon close-out). Fail-soft on a pre-051 DB. */
export function deleteExperimentSeedTasks(db: DatabaseLike, experimentId: string): void {
  try {
    db.prepare('DELETE FROM experiment_seed_tasks WHERE experiment_id = ?').run(experimentId);
  } catch {
    // Pre-051 DB (no table) — nothing to delete.
  }
}

/** Stamp the mutable per-arm links (run ids / session ids / clone ids) — only the provided fields. */
export function setExperimentRuns(db: DatabaseLike, experimentId: string, links: ExperimentRunLinks): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: Array<[keyof ExperimentRunLinks, string]> = [
    ['runAId', 'run_a_id'],
    ['runBId', 'run_b_id'],
    ['sessionAId', 'session_a_id'],
    ['sessionBId', 'session_b_id'],
    ['seedIdeaCloneAId', 'seed_idea_clone_a_id'],
    ['seedIdeaCloneBId', 'seed_idea_clone_b_id'],
  ];
  for (const [key, col] of map) {
    if (links[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(links[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`).run(...params, experimentId);
}

/** Extra columns settable alongside a status transition (winner + decision stamps). */
export interface ExperimentStatusExtras {
  winnerRunId?: string | null;
  winnerArm?: ExperimentArm | null;
  mergeSha?: string | null;
  decidedAt?: string | null;
}

/** Transition an experiment's status (optionally stamping winner/decision columns). */
export function updateExperimentStatus(
  db: DatabaseLike,
  experimentId: string,
  status: ExperimentStatus,
  extras?: ExperimentStatusExtras,
): void {
  const sets = ['status = ?'];
  const params: unknown[] = [status];
  if (extras?.winnerRunId !== undefined) {
    sets.push('winner_run_id = ?');
    params.push(extras.winnerRunId);
  }
  if (extras?.winnerArm !== undefined) {
    sets.push('winner_arm = ?');
    params.push(extras.winnerArm);
  }
  if (extras?.mergeSha !== undefined) {
    sets.push('merge_sha = ?');
    params.push(extras.mergeSha);
  }
  if (extras?.decidedAt !== undefined) {
    sets.push('decided_at = ?');
    params.push(extras.decidedAt);
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  db.prepare(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ?`).run(...params, experimentId);
}

/** Stamp the variant-outcome verdict (experiments.promoteVariant). One-way; the router guards against re-promotion. */
export function setExperimentPromotion(
  db: DatabaseLike,
  experimentId: string,
  opts: { promotedVariantId: string; promotedArm: ExperimentArm; promotedAt: string },
): void {
  db.prepare(
    `UPDATE experiments SET promoted_variant_id = ?, promoted_arm = ?, promoted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(opts.promotedVariantId, opts.promotedArm, opts.promotedAt, experimentId);
}

/** Read a workflow run's status (fail-soft: missing run → null). */
function readRunStatus(db: DatabaseLike, runId: string | null): string | null {
  if (!runId) return null;
  try {
    const row = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status?: unknown } | undefined;
    return typeof row?.status === 'string' ? row.status : null;
  } catch {
    return null;
  }
}

/** Outcome of a reconcile pass (returned so callers can log / drive the clone sweep). */
export type ReconcileOutcome =
  | { changed: false; status: ExperimentStatus }
  | { changed: true; status: ExperimentStatus; halfCreated: boolean };

/**
 * Reconcile a single experiment's status against its arm runs.
 *
 * - Only a `running` experiment is reconciled (grading/decided/abandoned are
 *   settled or human-owned).
 * - **Half-created** (either run_a_id or run_b_id NULL on a `running` experiment
 *   — a crash mid-startSideBySide): mark `abandoned`. The caller sweeps clones.
 * - **Both arms settled** (isExperimentArmSettled over both run statuses): flip
 *   `running -> grading`.
 * - Otherwise no change.
 */
export function reconcileExperimentStatus(db: DatabaseLike, experimentId: string): ReconcileOutcome {
  const exp = getExperiment(db, experimentId);
  if (!exp) return { changed: false, status: 'abandoned' };
  if (exp.status !== 'running') return { changed: false, status: exp.status };

  // Half-created: an arm never launched. Both run ids are stamped together at the
  // end of startSideBySide, so a NULL on a running experiment means a crash before
  // both launches settled -> abandon it.
  if (exp.run_a_id === null || exp.run_b_id === null) {
    updateExperimentStatus(db, experimentId, 'abandoned');
    return { changed: true, status: 'abandoned', halfCreated: true };
  }

  const statusA = readRunStatus(db, exp.run_a_id);
  const statusB = readRunStatus(db, exp.run_b_id);
  if (statusA !== null && statusB !== null && isExperimentArmSettled(statusA) && isExperimentArmSettled(statusB)) {
    updateExperimentStatus(db, experimentId, 'grading');
    return { changed: true, status: 'grading', halfCreated: false };
  }
  return { changed: false, status: 'running' };
}

/**
 * Boot recovery: reconcile every non-terminal experiment. Called from the
 * runRecovery boot path (after run recovery re-derives arm run statuses). For a
 * half-created experiment marked `abandoned` here, the optional `sweepClones`
 * callback hard-deletes its per-arm seed clones (injected by index.ts boot so
 * this module keeps its standalone-typecheck invariant).
 */
export async function recoverExperiments(
  db: DatabaseLike,
  sweepClones?: (exp: ExperimentRow) => Promise<void>,
): Promise<void> {
  let rows: ExperimentRow[];
  try {
    rows = db
      .prepare("SELECT * FROM experiments WHERE status IN ('running','grading')")
      .all() as ExperimentRow[];
  } catch {
    // Pre-049 DB (no experiments table) — nothing to recover.
    return;
  }
  for (const exp of rows) {
    try {
      const outcome = reconcileExperimentStatus(db, exp.id);
      if (outcome.changed && outcome.halfCreated && sweepClones) {
        await sweepClones(getExperiment(db, exp.id) ?? exp);
      }
    } catch {
      // Best-effort per experiment — one bad row must not abort the rest.
    }
  }
}

/** Structural collaborators for half-created-experiment boot recovery (injected by index.ts). */
export interface HalfCreatedExperimentRecoveryDeps {
  /** FULL session-delete path (cancels hosted runs + removes the worktree). NEVER a bare worktree-remove. */
  dismissSession: (sessionId: string) => Promise<void>;
  /** Hard-delete a run's experiment-tagged entities + the arm's seed idea clone + seed task clones. */
  deleteExperimentArmEntities: (
    projectId: number,
    opts: {
      experimentId: string;
      runId: string;
      seedCloneId?: string | null;
      seedTaskCloneIds?: string[];
    },
  ) => Promise<void>;
  /** Optional warn logger — a dismissal failure is logged, never silently swallowed. */
  logger?: Pick<LoggerLike, 'warn'>;
}

/**
 * Recover a single half-created experiment (the `recoverExperiments` sweep callback
 * body, extracted so it is unit-testable outside index.ts). reconcileExperimentStatus
 * has already flipped the row to `abandoned` — so recoverExperiments will never
 * revisit it — but the arm SESSIONS + worktrees created before the crash are still
 * live. The in-process startSideBySide rollback ladder dismisses them via the FULL
 * session-delete path; boot recovery MUST match, or an aborted experiment leaks its
 * arm worktrees forever.
 *
 * Order: dismiss session_a then session_b (each wrapped so a failure LOGS and still
 * lets the entity sweep run), THEN sweep both arms' entities (idea seed clone +
 * migration-051 seed TASK clones, enumerated from the mapping table), THEN drop the
 * mapping rows. A null / never-created session id is skipped; an unknown id is
 * tolerated by the per-session catch. Takes `db` so it can read the seed-task
 * mapping (the store's write surface owns experiment_seed_tasks).
 */
export async function dismissAndSweepHalfCreatedExperiment(
  db: DatabaseLike,
  exp: ExperimentRow,
  deps: HalfCreatedExperimentRecoveryDeps,
): Promise<void> {
  for (const sessionId of [exp.session_a_id, exp.session_b_id]) {
    if (!sessionId) continue;
    try {
      await deps.dismissSession(sessionId);
    } catch (err) {
      deps.logger?.warn('[experiments] boot recovery: dismiss arm session failed', {
        experimentId: exp.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await deps
    .deleteExperimentArmEntities(exp.project_id, {
      experimentId: exp.id,
      runId: exp.run_a_id ?? '',
      seedCloneId: exp.seed_idea_clone_a_id,
      seedTaskCloneIds: seedTaskCloneIdsForArm(db, exp.id, 'A'),
    })
    .catch(() => {});
  await deps
    .deleteExperimentArmEntities(exp.project_id, {
      experimentId: exp.id,
      runId: exp.run_b_id ?? '',
      seedCloneId: exp.seed_idea_clone_b_id,
      seedTaskCloneIds: seedTaskCloneIdsForArm(db, exp.id, 'B'),
    })
    .catch(() => {});
  deleteExperimentSeedTasks(db, exp.id);
}
