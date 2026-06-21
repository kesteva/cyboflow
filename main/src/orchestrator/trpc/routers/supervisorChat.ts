/**
 * cyboflow.supervisorChat sub-router — the typed tRPC contract for the renderer's
 * supervisor chat panel (Stage 3 human seam). Lets the user converse with the
 * long-lived supervisor of a PROGRAMMATIC run:
 *   - getTranscript : query        → SupervisorChatMessage[] (current transcript)
 *   - send          : mutation     → relay a user message to the run's supervisor
 *   - onMessage     : subscription → SupervisorChatChanged (per-run transcript deltas)
 *
 * All routed through SupervisorChatRegistry (per-run sessions); a run with no
 * active chat session (default review-queue supervisor, terminal run) resolves
 * fail-soft (empty transcript / no-op send).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import {
  SupervisorChatRegistry,
  supervisorChatEvents,
  supervisorChatChannel,
  type SupervisorChatMessage,
  type SupervisorChatChanged,
} from '../../programmatic/supervisorChat';
import { eventToAsyncIterable } from './events';

export const supervisorChatRouter = router({
  /**
   * Whether a supervisor chat session is active for a run — drives whether the
   * renderer shows the chat panel at all (only programmatic runs with the SDK
   * supervisor have one). Cheap registry lookup.
   */
  isActive: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }): { active: boolean } => {
      return { active: SupervisorChatRegistry.getInstance().get(input.runId) !== undefined };
    }),

  /** The current transcript for a run's supervisor chat ([] when none active). */
  getTranscript: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ input }): SupervisorChatMessage[] => {
      return SupervisorChatRegistry.getInstance().get(input.runId)?.getTranscript() ?? [];
    }),

  /**
   * Relay a user message to the run's supervisor (the human seam). No-op (returns
   * { delivered: false }) when no chat session is active for the run.
   */
  send: protectedProcedure
    .input(z.object({ runId: z.string(), text: z.string() }))
    .mutation(({ input }): { delivered: boolean } => {
      const session = SupervisorChatRegistry.getInstance().get(input.runId);
      if (!session) return { delivered: false };
      session.sendUserMessage(input.text);
      return { delivered: true };
    }),

  /**
   * Subscribe to a run's supervisor-chat transcript deltas. Each event carries one
   * appended (or growing assistant) message; the renderer appends / replaces the
   * last assistant message in place. Filtered to the requested run via the channel.
   */
  onMessage: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<SupervisorChatChanged> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<SupervisorChatChanged>(
        supervisorChatEvents,
        supervisorChatChannel(input.runId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
