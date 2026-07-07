/**
 * monitorRehydration — LAZY monitor revival after an app restart.
 *
 * The on-demand monitor (`DefaultMonitorSession`, monitor.ts) is registered in the
 * in-process `MonitorRegistry` singleton at run start and deliberately NEVER
 * unregistered when a walk ends — chat-at-rest lets the human keep querying the
 * monitor about a run resting in awaiting_review, or one that failed / was
 * paused / canceled. That registry is memory-only: after an app restart it is
 * empty. Boot recovery (runRecovery.ts) only re-drives `starting` / `running` /
 * `awaiting_review` runs, which incidentally re-registers their monitors as a side
 * effect of re-entering `DefaultProgrammaticRunner.run`. A run that is already
 * FAILED / PAUSED / CANCELED / COMPLETED at boot is never re-driven, so its
 * monitor chat is silently dead post-restart — `monitor.isActive` reports
 * `{ active: false }` and the composer never lights up.
 *
 * The monitor itself is STATELESS per call — each triage/answer/converse re-reads
 * the WHOLE run history fresh (`HistoryReader.read`, backed by `raw_events` +
 * `step_results`). There is no monitor-owned table to restore; the only thing lost
 * on restart is the `MonitorSession` OBJECT and its `injectEvent` rendering
 * bridge. This module rebuilds both from durable state: the `workflow_runs` /
 * `workflows` row (for `MonitorContext`) and the caller-supplied `ensureInjectBridge`
 * + `buildSession` hooks (which reuse the SAME construction the run used at start,
 * so a rehydrated session is byte-identical in shape to a freshly-started one).
 *
 * Wired into the tRPC monitor router (monitor.ts's `setMonitorRehydrator`) so a
 * registry MISS there transparently attempts revival before falling back to the
 * legacy "no monitor" response.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from './monitor';

/** The injectEvent shape threaded through the monitor construction seam. */
type InjectEvent = (event: ClaudeStreamEvent) => void;

/**
 * Structural contract consumed by the tRPC monitor router
 * (`trpc/routers/monitor.ts`) on a `MonitorRegistry` miss.
 */
export interface MonitorRehydrator {
  /**
   * Attempt to revive the monitor session for `runId` from durable state.
   * Registers the revived session in `MonitorRegistry` as a side effect (mirrors
   * the registry's own register-on-create contract at run start) and returns it.
   * Returns `null` when the run is not a live rehydration candidate — see
   * `createMonitorRehydrator`'s refusal matrix — WITHOUT registering anything.
   */
  rehydrate(runId: string): MonitorSession | null;
}

/** The `workflow_runs` ⋈ `workflows` row read by `rehydrate` (aliased to camelCase). */
interface RehydrationRow {
  projectId: number;
  worktreePath: string | null;
  substrate: string | null;
  executionModel: string | null;
  workflowName: string;
}

export interface CreateMonitorRehydratorDeps {
  db: DatabaseLike;
  /**
   * Ensure (idempotently) a persisting inject bridge exists for `runId` and
   * return its `injectEvent` fn — production wiring points this at
   * `RunExecutor.ensureMonitorInjectBridge`, which reuses a live run's existing
   * bridge or lazily builds one so rehydrated `converse` turns still render into
   * the run's Chat pane and persist to `raw_events`. Returning `null` (no bridge
   * available) is tolerated: the rehydrated session still works, it just falls
   * back to a non-rendering `answer()` for `converse` (mirrors an unwired
   * `injectEvent` in `DefaultMonitorSessionDeps`).
   */
  ensureInjectBridge: (runId: string) => InjectEvent | null;
  /**
   * Build the `MonitorSession` for a revived run. Production wiring points this
   * at the SAME closure `DefaultProgrammaticRunner.run` uses at fresh-run start
   * (index.ts's `monitorFactory`), so a rehydrated session has identical query
   * fns / actuator / model config to one built at run start.
   */
  buildSession: (ctx: MonitorContext, injectEvent: InjectEvent | undefined) => MonitorSession;
  logger?: LoggerLike;
}

/**
 * Build a `MonitorRehydrator` over the given deps.
 *
 * Refusal matrix (returns `null`, registers nothing):
 *   - no `workflow_runs` row for `runId` (unknown / deleted / dismissed run).
 *   - `substrate !== 'sdk'` (the monitor is an SDK-substrate-only concept).
 *   - `execution_model !== 'programmatic'` (orchestrated runs have no monitor).
 *   - `worktree_path` is null/empty (defensive: `MonitorContext.worktreePath` is a
 *     required `string` — a run with no worktree cannot back read-only
 *     inspection tools).
 *
 * Run STATUS is deliberately NOT part of the refusal matrix: chat-at-rest is the
 * whole point, so a failed / paused / canceled / completed / awaiting_review
 * programmatic sdk run is EQUALLY eligible. A dismissed/deleted run fails the row
 * lookup naturally (no `workflow_runs` row survives dismissal).
 */
export function createMonitorRehydrator(deps: CreateMonitorRehydratorDeps): MonitorRehydrator {
  const { db, ensureInjectBridge, buildSession, logger } = deps;

  return {
    rehydrate(runId: string): MonitorSession | null {
      const row = db
        .prepare(
          `SELECT r.project_id AS projectId,
                  r.worktree_path AS worktreePath,
                  r.substrate AS substrate,
                  r.execution_model AS executionModel,
                  w.name AS workflowName
             FROM workflow_runs r
             JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as RehydrationRow | undefined;

      if (!row) {
        logger?.debug('[monitorRehydration] no workflow_runs row; refusing', { runId });
        return null;
      }
      if (row.substrate !== 'sdk') {
        logger?.debug('[monitorRehydration] non-sdk substrate; refusing', {
          runId,
          substrate: row.substrate,
        });
        return null;
      }
      if (row.executionModel !== 'programmatic') {
        logger?.debug('[monitorRehydration] non-programmatic execution_model; refusing', {
          runId,
          executionModel: row.executionModel,
        });
        return null;
      }
      if (!row.worktreePath) {
        logger?.warn('[monitorRehydration] run has no worktree_path; refusing', { runId });
        return null;
      }

      const ctx: MonitorContext = {
        runId,
        projectId: row.projectId,
        workflowName: row.workflowName,
        worktreePath: row.worktreePath,
      };

      let injectEvent: InjectEvent | undefined;
      try {
        injectEvent = ensureInjectBridge(runId) ?? undefined;
      } catch (err) {
        logger?.warn('[monitorRehydration] ensureInjectBridge threw; rehydrating without a render bridge', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        injectEvent = undefined;
      }
      if (!injectEvent) {
        logger?.warn(
          '[monitorRehydration] no inject bridge available; converse will fall back to a non-rendering answer',
          { runId },
        );
      }

      const session = buildSession(ctx, injectEvent);
      MonitorRegistry.getInstance().register(runId, session);
      return session;
    },
  };
}
