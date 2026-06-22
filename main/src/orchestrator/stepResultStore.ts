/**
 * StepResultStore — persists per-step results for programmatic runs (Stage 3,
 * migration 033). The host records each step's structured outcome as the
 * WorkflowController settles it; the store backs (a) deterministic queryable
 * per-step results and (b) sharper crash-safe resume (skip individually-completed
 * steps on re-drive, not just the coarse current_step_id pointer).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/*. Uses the narrow DatabaseLike injected at construction.
 */
import type { DatabaseLike } from './types';

/** A persisted per-step result row. */
export interface StepResultRow {
  runId: string;
  stepId: string;
  phaseId: string | null;
  outcome: 'done' | 'skipped' | 'failed' | 'rejected' | 'canceled';
  attempts: number;
  summary: string | null;
  error: string | null;
}

/** The write shape recorded as a step settles (mirrors the controller StepReport). */
export interface StepResultRecord {
  runId: string;
  stepId: string;
  phaseId?: string;
  outcome: StepResultRow['outcome'];
  attempts: number;
  summary?: string;
  error?: string;
}

/** Outcomes that count as "this step does not need to re-run on resume". */
const COMPLETED_OUTCOMES = new Set<StepResultRow['outcome']>(['done', 'skipped']);

function hasStepResultsTable(db: DatabaseLike): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step_results'")
    .get() as { name?: string } | undefined;
  return row?.name === 'step_results';
}

export class StepResultStore {
  private static instance: StepResultStore | null = null;

  constructor(private readonly db: DatabaseLike) {}

  static initialize(db: DatabaseLike): StepResultStore {
    StepResultStore.instance = new StepResultStore(db);
    return StepResultStore.instance;
  }

  /** Returns the singleton, or null when not initialized (early boot / tests). */
  static tryGetInstance(): StepResultStore | null {
    return StepResultStore.instance;
  }

  static _resetForTesting(): void {
    StepResultStore.instance = null;
  }

  /**
   * Record (INSERT OR REPLACE) a step's result. The latest settle for a
   * (runId, stepId) wins — a looped-back step that re-runs overwrites its row.
   * Fail-soft on a missing table (early boot / minimal test DBs).
   */
  record(r: StepResultRecord): void {
    if (!hasStepResultsTable(this.db)) return;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO step_results
           (run_id, step_id, phase_id, outcome, attempts, summary, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(r.runId, r.stepId, r.phaseId ?? null, r.outcome, r.attempts, r.summary ?? null, r.error ?? null);
  }

  /** All persisted results for a run, in stable step order. */
  listForRun(runId: string): StepResultRow[] {
    if (!hasStepResultsTable(this.db)) return [];
    const rows = this.db
      .prepare(
        `SELECT run_id AS runId, step_id AS stepId, phase_id AS phaseId, outcome, attempts, summary, error
           FROM step_results WHERE run_id = ? ORDER BY rowid ASC`,
      )
      .all(runId) as StepResultRow[];
    return rows;
  }

  /** Step ids that completed (done/skipped) — the resume-skip set. */
  completedStepIds(runId: string): string[] {
    return this.listForRun(runId)
      .filter((r) => COMPLETED_OUTCOMES.has(r.outcome))
      .map((r) => r.stepId);
  }
}
