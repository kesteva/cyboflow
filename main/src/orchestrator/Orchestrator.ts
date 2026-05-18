/**
 * Orchestrator — single lifecycle entry point for the cyboflow main process.
 *
 * Standalone-typecheck invariant (ROADMAP-001 §6.3):
 * This module and the entire main/src/orchestrator/ subtree must compile
 * without transitive imports from 'electron', 'better-sqlite3', or any
 * concrete service in main/src/services/*. All collaborators are injected
 * via OrchestratorDeps so the orchestrator is extractable to a standalone
 * Node process for the team-tier v2 target without touching business logic.
 *
 * See also: docs/ARCHITECTURE.md §Orchestrator, ROADMAP-001 §6.3.
 */
import { EventEmitter } from 'node:events';
import type { OrchestratorDeps } from './types';
import { StuckDetector, type ClaudeManagerLike } from './stuckDetector';

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private running = false;

  /** Periodic stuck-state scanner — constructed in start(), stopped in stop(). */
  private detector?: StuckDetector;

  /**
   * Construct an Orchestrator with all collaborators provided by the caller.
   * No globals, no top-level singletons, no Electron imports.
   *
   * @param deps - Injected dependencies: db, logger, runQueues.
   */
  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Start the orchestrator.
   *
   * Idempotent: if already running, emits a warning log and returns
   * immediately without re-initializing state.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.deps.logger.warn('orchestrator.start: already running, skipping');
      return;
    }
    this.running = true;
    this.deps.logger.info('orchestrator.start');

    // Construct and start the stuck detector.  When claudeManager is not
    // provided in deps, supply a no-op adapter that treats every run as alive
    // (orphan_pty classification disabled but all other variants still work).
    const claudeManager: ClaudeManagerLike =
      this.deps.claudeManager ?? { hasActiveRunForId: () => true };

    this.detector = new StuckDetector({
      db: this.deps.db,
      claudeManager,
      permissionServer: this.deps.permissionServer,
      emitter: new EventEmitter(),
      logger: this.deps.logger,
    });

    this.detector.start();
  }

  /**
   * Stop the orchestrator.
   *
   * Drains all per-run queues via RunQueueRegistry.drainAll() before
   * resolving, ensuring in-flight state mutations complete cleanly.
   * If not running, returns immediately.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.deps.logger.info('orchestrator.stop.begin');

    // Stop the stuck detector before draining queues.
    if (this.detector) {
      this.detector.stop();
      this.detector = undefined;
    }

    await this.deps.runQueues.drainAll();
    this.deps.logger.info('orchestrator.stop.complete');
  }

  /**
   * Returns true when the orchestrator has been started and not yet stopped.
   * Intended for observability and health-check surfaces.
   */
  isRunning(): boolean {
    return this.running;
  }
}

export type { OrchestratorDeps };
