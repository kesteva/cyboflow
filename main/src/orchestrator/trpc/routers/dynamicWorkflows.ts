/**
 * cyboflow.dynamicWorkflows sub-router.
 *
 * Provides the typed tRPC contract for the renderer's dynamic-workflow
 * progress UI (passive detection of Claude Code's in-session Workflow tool /
 * ultracode runs — see shared/types/dynamicWorkflows.ts):
 *   - list      : query        → DynamicWorkflowRunState[] (all runs, or one session's)
 *   - onChanged : subscription → DynamicWorkflowChangedEvent (full-snapshot replace)
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type {
  DynamicWorkflowRunState,
  DynamicWorkflowChangedEvent,
} from '../../../../../shared/types/dynamicWorkflows';
import { DynamicWorkflowTracker, dynamicWorkflowEvents } from '../../dynamicWorkflows';
import { eventToAsyncIterable } from './events';

export const dynamicWorkflowsRouter = router({
  /**
   * List tracked dynamic-workflow runs, optionally filtered to one session.
   *
   * Fail-soft: returns [] when the tracker singleton has not been initialized
   * (early boot / unit tests) — the renderer simply renders nothing.
   */
  list: protectedProcedure
    .input(z.object({ sessionId: z.string().optional() }))
    .query(({ input }): DynamicWorkflowRunState[] => {
      return DynamicWorkflowTracker.tryGetInstance()?.list(input.sessionId) ?? [];
    }),

  /**
   * Subscribe to dynamic-workflow state changes (all sessions).
   *
   * Emitted by the tracker on every state change (launch detected, agent
   * started/finished, completion observed). Each event carries the FULL
   * state snapshot — receivers replace, never merge.
   *
   * No throttle: state changes are journal-line-grained and infrequent.
   */
  onChanged: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<DynamicWorkflowChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<DynamicWorkflowChangedEvent>(
        dynamicWorkflowEvents,
        'changed',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
