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
import type { StuckDetectedEvent } from '../../../shared/types/stuckDetection';
import { drainLegacyIdleReviewItems } from './drainLegacyIdleReviewItems';

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private running = false;

  /** Periodic stuck-state scanner — constructed in start(), stopped in stop(). */
  private detector?: StuckDetector;

  /** The detector's own emitter, retained so stop() can detach the bridge. */
  private detectorEvents?: EventEmitter;

  /** The bridge listener, retained for symmetric teardown. */
  private onDetectorStuck?: (event: StuckDetectedEvent) => void;

  /** Periodic idle-quick-session review scanner — constructed in start(), stopped in stop(). */

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

    // Construct and start the stuck detector.  Production supplies a real
    // claudeManager (index.ts wires RunExecutor.hasActiveExecution). The
    // fallback below remains for tests and any embedder that has no executor:
    // it treats every run as alive, which disables orphan_pty rather than
    // misfiring it. Fail-open is deliberate — `() => false` would stamp every
    // stale approval orphaned, which is a worse failure than detecting none.
    // Unlike the permissionServer branch this fallback used to be silent; it
    // now warns, because a silently inert rung is how it went unnoticed from
    // TASK-501 until 2026-08-21.
    let claudeManager: ClaudeManagerLike;
    if (this.deps.claudeManager) {
      claudeManager = this.deps.claudeManager;
    } else {
      this.deps.logger.warn(
        'orchestrator.start: claudeManager not provided — orphan_pty classification disabled',
      );
      claudeManager = { hasActiveRunForId: () => true };
    }

    // The detector's own emitter, bridged below. Keeping it per-instance (as
    // opposed to handing the detector the shared sink directly) keeps the
    // detector's event name its own business and gives stop() something to
    // detach from.
    const detectorEvents = new EventEmitter();

    // THE BRIDGE. events.ts has carried "the emit-source bridge is wired in
    // main/src/index.ts" since the epic landed, and it never was: the detector
    // emitted into an anonymous EventEmitter nobody held, while the tRPC
    // subscription listened on a module-level emitter with zero emitters. So
    // runStatusMap — which is ONLY ever written by that subscription — stayed
    // empty forever, and every consumer downstream of it (StuckBadge, "Why
    // stuck?", "Cancel and restart", useStuckNotifications) was unreachable
    // code. Note the rename across the seam: 'runs:stuck' -> 'detected'.
    const sink = this.deps.stuckEvents;
    if (sink) {
      this.onDetectorStuck = (event: StuckDetectedEvent): void => {
        sink.emit('detected', event);
      };
      detectorEvents.on('runs:stuck', this.onDetectorStuck);
    } else {
      this.deps.logger.warn(
        'orchestrator.start: stuckEvents sink not provided — stuck runs will be persisted but not pushed to the renderer',
      );
    }
    this.detectorEvents = detectorEvents;

    this.detector = new StuckDetector({
      db: this.deps.db,
      claudeManager,
      emitter: detectorEvents,
      logger: this.deps.logger,
    });

    this.detector.start();

    // The idle-session review_item mint was retired in favor of the live
    // QuickSessionsTable (quickSessionListing / sessions:list-quick). Drain any
    // legacy pending `idle-session:<id>` items ONCE at start so stale blocking
    // rows from before the switch self-clear (nothing mints them any more).
    // Fire-and-forget: a cleanup pass must never gate orchestrator start.
    if (this.deps.applyReviewItem) {
      void drainLegacyIdleReviewItems({
        db: this.deps.db,
        applyReviewItem: this.deps.applyReviewItem,
        logger: this.deps.logger,
      });
    }
  }

  /**
   * Stop the orchestrator.
   *
   * Drains all per-run queues via RunQueueRegistry.drainAll() before
   * resolving, so in-flight state mutations complete cleanly. If not running,
   * returns immediately.
   *
   * `shouldWaitForQueue` is passed straight through: it answers false for a run
   * whose queued task cannot finish, so the drain does not wait on it.
   */
  async stop(shouldWaitForQueue?: (runId: string) => boolean): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.deps.logger.info('orchestrator.stop.begin');

    // Stop the stuck detector before draining queues, and detach the bridge so
    // a restarted orchestrator does not stack a second forwarder on the sink.
    if (this.detector) {
      this.detector.stop();
      this.detector = undefined;
    }
    if (this.detectorEvents && this.onDetectorStuck) {
      this.detectorEvents.off('runs:stuck', this.onDetectorStuck);
    }
    this.detectorEvents = undefined;
    this.onDetectorStuck = undefined;

    await this.deps.runQueues.drainAll({ shouldWait: shouldWaitForQueue });
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
