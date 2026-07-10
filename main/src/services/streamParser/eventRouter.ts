/**
 * EventRouter — Stage 4 of the streamParser pipeline.
 *
 * Provides per-runId fanout for typed provider events. Backed by Node's
 * EventEmitter — runIds are used directly as event names so subscribers
 * only receive events for their own run.
 */

import { EventEmitter } from 'node:events';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { AgentStreamEvent } from '../../../../shared/types/agentStream';

export type RoutableStreamEvent = ClaudeStreamEvent | AgentStreamEvent;

export class EventRouter<TEvent extends RoutableStreamEvent = ClaudeStreamEvent> extends EventEmitter {
  /**
   * Dispatch an event to all handlers registered for the given runId.
   */
  emitForRun(runId: string, event: TEvent): void {
    this.emit(runId, event);
  }

  /**
   * Register a handler for events belonging to a specific runId.
   *
   * Returns a teardown function that removes the handler when called.
   * Use this for clean per-run lifecycle management.
   */
  onRun(runId: string, handler: (event: TEvent) => void): () => void {
    this.on(runId, handler);
    return () => {
      this.off(runId, handler);
    };
  }

  /**
   * Remove ALL handlers registered for a runId.
   *
   * Call this when a run completes or is cancelled to prevent memory leaks.
   * More aggressive than the individual teardown from `onRun` — use when the
   * entire run is being torn down rather than a single subscriber.
   */
  clearRun(runId: string): void {
    this.removeAllListeners(runId);
  }
}
