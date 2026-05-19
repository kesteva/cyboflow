/**
 * runEventBridge — Self-contained bridge between ClaudeCodeManager 'output' events
 * and the renderer's `cyboflow:stream:<runId>` channel.
 *
 * Integration contract for TASK-640 (RunExecutor):
 *   After ClaudeCodeManager.spawnCliProcess(options) succeeds, call
 *   `bridgeEvents({ runId, source: claudeCodeManager, publisher, db, logger })` once.
 *   Hold the returned RunEventBridge until 'exit' (TASK-644 will call bridge.dispose() in its
 *   status-transition handler) or cancel.
 *
 *   INVARIANT: panelId === runId === sessionId across the orchestrator surface.
 *   RunExecutor.execute() passes panelId = runId (no prefix), and the `p.panelId !== runId` guard
 *   keys on raw runId — so every 'output' event whose panelId matches runId is forwarded.
 *   ApprovalRouter's workflow_runs UPDATE and RawEventsSink.run_id all rely on the same invariant.
 *
 * Per-event sequence (synchronous):
 *   1. TypedEventNarrowing.narrow(data)  — validate/narrow the raw SDK payload
 *   2. router.emitForRun(runId, typed)   — synchronously fires RawEventsSink INSERT via router listener
 *   3. publisher.publish(runId, envelope) — forward to renderer IPC channel
 *
 * The INSERT step is fail-soft: a DB error is logged at WARN level and publish
 * still fires for that event. The publish step is also fail-soft for the same reason.
 */

import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../services/streamParser';
import { deriveEventType } from '../services/streamParser/derivers';
import type { ClaudeStreamEvent } from '../../../shared/types/claudeStream';
import type { StreamEventPublisher } from './runLauncher';
import type { LoggerLike } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BridgeEventsOptions {
  /** The run ID to filter on — only 'output' events whose panelId === runId are processed. */
  runId: string;
  /** The EventEmitter that emits 'output' events (typically ClaudeCodeManager). */
  source: EventEmitter;
  /** Delivers the wrapped envelope to the renderer via IPC. */
  publisher: StreamEventPublisher;
  /** better-sqlite3 database handle used by RawEventsSink for inserts. */
  db: Database.Database;
  /** Optional structured logger; if omitted, warn messages are silently swallowed. */
  logger?: LoggerLike;
  /**
   * Injection seam for testing: supply a pre-constructed EventRouter.
   * If omitted, a new EventRouter is created internally.
   */
  router?: EventRouter;
  /**
   * Injection seam for testing: supply a pre-constructed RawEventsSink.
   * If omitted, a new RawEventsSink is created and attached internally.
   */
  sink?: RawEventsSink;
  /**
   * Injection seam for testing: supply a pre-constructed TypedEventNarrowing.
   * If omitted, a new TypedEventNarrowing is created internally.
   */
  narrowing?: TypedEventNarrowing;
  /**
   * When true, the bridge does NOT construct an EventRouter or RawEventsSink;
   * only the renderer-IPC publish path and onFirstMessage are active.
   *
   * Use this when a parallel pipeline (e.g. ClaudeCodeManager.runSdkQuery)
   * already owns raw_events persistence for this run. Without this flag, both
   * the bridge's own EventRouter+RawEventsSink AND the CCM pipeline would
   * INSERT the same event, causing double-INSERTs (FIND-SPRINT-021-5).
   *
   * `db` remains required in the options type for back-compat; its value is
   * simply unused when skipPersistence === true.
   */
  skipPersistence?: boolean;
  /**
   * Optional single-shot callback fired on the first narrowed JSON output event.
   * Fires AFTER INSERT + publish complete so the running transition cannot race
   * ahead of event delivery.  Fail-soft: a throwing callback is logged at warn
   * level and does not affect the rest of the pipeline.
   */
  onFirstMessage?: (firstTyped: ClaudeStreamEvent) => void;
}

export interface RunEventBridge {
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 'output' event payload shape emitted by ClaudeCodeManager (claudeCodeManager.ts:338-344)
// ---------------------------------------------------------------------------

interface OutputPayload {
  panelId: string;
  sessionId: string;
  type: string;
  data: unknown;
  timestamp: Date | string;
}

// ---------------------------------------------------------------------------
// Envelope published to the renderer
// ---------------------------------------------------------------------------

interface StreamEnvelope {
  type: string;
  payload: ClaudeStreamEvent;
  timestamp: string;
}

// Re-exported as deriveEnvelopeType for local readability — same mapping as
// RawEventsSink uses for the event_type storage column.
const deriveEnvelopeType = deriveEventType;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach a bridge listener to `opts.source` that:
 *   1. Filters 'output' events to those where panelId === runId AND type === 'json'
 *   2. Narrows the raw `data` payload via TypedEventNarrowing
 *   3. INSERTs a raw_events row via RawEventsSink (through EventRouter)
 *   4. Publishes a `{ type, payload, timestamp }` envelope to the renderer
 *
 * Returns a `RunEventBridge` whose `dispose()` removes the listener and tears
 * down the per-run RawEventsSink subscription. `dispose()` is idempotent.
 */
export function bridgeEvents(opts: BridgeEventsOptions): RunEventBridge {
  const {
    runId,
    source,
    publisher,
    db,
    logger,
  } = opts;

  // narrowing is always needed (used unconditionally in the publish envelope path).
  const narrowing: TypedEventNarrowing = opts.narrowing ?? new TypedEventNarrowing();

  // When skipPersistence is true, skip EventRouter + RawEventsSink construction
  // entirely. The opts.router / opts.sink injection seams (used by tests) are
  // still honoured if present, but in normal skipPersistence usage both are null.
  let router: EventRouter | null;
  let sink: RawEventsSink | null;

  if (opts.skipPersistence === true) {
    // Persistence disabled — renderer-IPC publish and onFirstMessage still fire.
    // If test seams are supplied, respect them; otherwise leave null.
    router = opts.router ?? null;
    sink = opts.sink ?? null;
  } else {
    // Default legacy behaviour: construct router + sink and wire INSERT pipeline.
    router = opts.router ?? new EventRouter();
    sink = opts.sink ?? new RawEventsSink(db, logger);
    // Attach the sink to the router so emitForRun triggers INSERT synchronously.
    sink.attachToRouter(router, runId);
  }

  // Idempotent-dispose guard.
  let disposed = false;

  // Single-shot guard for onFirstMessage.
  let firstMessageFired = false;

  // ---------------------------------------------------------------------------
  // 'output' listener
  // ---------------------------------------------------------------------------

  const onOutput = (payload: unknown): void => {
    // Type-guard the payload shape.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('panelId' in payload) ||
      !('type' in payload) ||
      !('data' in payload)
    ) {
      return;
    }

    const p = payload as OutputPayload;

    // Filter: only handle events for our runId and only JSON payloads.
    if (p.panelId !== runId || p.type !== 'json') {
      return;
    }

    // Step 1: Narrow the raw SDK data to a typed ClaudeStreamEvent.
    let typed: ClaudeStreamEvent;
    try {
      typed = narrowing.narrow(p.data);
    } catch (err) {
      logger?.warn('[runEventBridge] narrowing threw unexpectedly (should never happen)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Step 2: Emit through the EventRouter — this synchronously fires the
    // RawEventsSink listener which INSERTs the raw_events row.
    // Skipped when skipPersistence === true (router is null in that mode).
    // The sink itself is fail-soft, but we wrap in try/catch as a final safety net.
    if (router) {
      try {
        router.emitForRun(runId, typed);
      } catch (err) {
        logger?.warn('[runEventBridge] router.emitForRun threw unexpectedly', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Step 3: Build the renderer envelope and publish — always fires regardless
    // of whether the INSERT succeeded (fail-soft contract).
    const envelope: StreamEnvelope = {
      type: deriveEnvelopeType(typed),
      payload: typed,
      timestamp: new Date().toISOString(),
    };

    try {
      publisher.publish(runId, envelope);
    } catch (err) {
      logger?.warn('[runEventBridge] publisher.publish threw unexpectedly', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 4: Fire onFirstMessage exactly once, AFTER INSERT + publish complete.
    // This ordering ensures the running transition cannot race ahead of event delivery.
    if (!firstMessageFired && opts.onFirstMessage) {
      firstMessageFired = true;
      try {
        opts.onFirstMessage(typed);
      } catch (err) {
        logger?.warn('[runEventBridge] onFirstMessage threw', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // Attach the listener.
  source.on('output', onOutput);

  // ---------------------------------------------------------------------------
  // dispose
  // ---------------------------------------------------------------------------

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;

      // Remove the 'output' listener from the source EventEmitter.
      source.off('output', onOutput);

      // Detach the RawEventsSink from the EventRouter for this runId.
      // Guarded: sink is null when skipPersistence === true.
      if (sink) {
        sink.dispose(runId);
      }
    },
  };
}
