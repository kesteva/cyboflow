/**
 * cyboflow.agentThread sub-router — the renderer's typed contract for the
 * global-agent chat thread (migration 071).
 *
 * Queries / mutations:
 *   - getThread        : query    → AgentThread   (ensures the single 'global' thread exists)
 *   - listMessages     : query    → UnifiedMessage[] (projection over agent_thread_events)
 *   - sendMessage      : mutation → { ok: true }   (one agent turn)
 *   - triggerDigest    : mutation → DigestTriggerResult (server-throttled)
 *   - listProposals    : query    → AgentProposal[]
 *   - confirmProposal  : mutation → ConfirmProposalResult (the user's Confirm click)
 *   - dismissProposal  : mutation → { ok: true; dismissed }
 * Subscriptions:
 *   - onThreadEvent    : per-thread live-tail envelopes, throttled ~60ms (like onStreamEvent)
 *   - onProposalUpdate : proposal-transition notifications (unthrottled — infrequent)
 *
 * The agent PROPOSES (an `agent_proposals` row, minted by the MCP
 * cyboflow_propose_action tool); the user's Confirm here is what EXECUTES,
 * server-side, through the existing chokepoints, stamped actor:'user' — this
 * router owns none of that logic beyond dispatch: executable kinds go to the
 * boot-wired executor (ctx.agentProposalExecutor); open-session is pure renderer
 * navigation, so the router transitions its row directly (CAS-claim → finalize
 * 'executed') and returns the navigation target (plan §2.5).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Everything concrete reaches this file through the narrow
 * structural ctx deps (AgentThreadServiceLike / AgentThreadStoreLike /
 * AgentProposalExecutorLike) or the pure orchestrator projection helper.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { Context } from '../context';
import type { AgentThreadServiceLike, AgentThreadStoreLike } from '../context';
import { eventToAsyncIterable } from './events';
import { throttleAsyncIterator } from '../throttle';
import { selectAgentThreadUnifiedMessages } from '../../agentThreadUnifiedMessagesListing';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type {
  AgentThread,
  AgentProposal,
  AgentProposalStatus,
  AgentNavigationTarget,
  OpenSessionProposalPayload,
} from '../../../../../shared/types/agentThread';
import type { ExecuteProposalResult } from '../../agentThread/proposalExecutor';

// ---------------------------------------------------------------------------
// Event emitters (module-level singletons — the bridge in main/src/index.ts and
// this router share one instance without a circular import, mirroring
// questionEvents in events.ts).
// ---------------------------------------------------------------------------

/**
 * Live-tail bridge for the agent thread. The AgentThreadService's `publish`
 * closure (wired in index.ts) emits `'message'` here IN ADDITION to the raw
 * `cyboflow:stream:<threadId>` IPC send, so the renderer can consume live-tail
 * over a tRPC-native subscription too. Payload: `{ threadId, envelope }`.
 */
export const agentThreadEvents = new EventEmitter();

/**
 * Proposal-transition notifications. This router emits `'update'` after EVERY
 * proposal transition it performs (confirm executed/failed/superseded, the
 * claimed-loser reflecting the winner's state, dismiss). The renderer's store
 * uses it to reconcile optimistic card states.
 */
export const agentThreadProposalEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Event / result payload shapes (exported so the inferred AppRouter type can
// name them — TS4023).
// ---------------------------------------------------------------------------

/** onThreadEvent's pre-filter payload; the subscription yields the bare envelope. */
export interface AgentThreadLiveTailEvent {
  threadId: string;
  envelope: unknown;
}

/** onProposalUpdate payload — a proposal's current (post-transition) status. */
export interface AgentProposalUpdateEvent {
  proposalId: string;
  threadId: string;
  status: AgentProposalStatus;
}

/**
 * confirmProposal result. Executable kinds pass through the executor's
 * {@link ExecuteProposalResult} verbatim; open-session (which the executor rejects
 * by design) resolves to the navigation variant so the client can navigate.
 */
export type ConfirmProposalResult =
  | {
      ok: true;
      kind: 'open-session';
      proposalId: string;
      status: 'executed';
      navigation: AgentNavigationTarget;
    }
  | ExecuteProposalResult;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireService(ctx: Context): AgentThreadServiceLike {
  if (!ctx.agentThreadService) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '[agentThread] AgentThreadService not wired into tRPC context',
    });
  }
  return ctx.agentThreadService;
}

function requireStore(ctx: Context): AgentThreadStoreLike {
  if (!ctx.agentThreadStore) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '[agentThread] AgentThreadDbStore not wired into tRPC context',
    });
  }
  return ctx.agentThreadStore;
}

/** Re-read a proposal's current status and emit it — the single onProposalUpdate seam. */
function emitProposalUpdate(store: AgentThreadStoreLike, proposalId: string): void {
  const proposal = store.getProposal(proposalId);
  if (!proposal) return;
  const event: AgentProposalUpdateEvent = {
    proposalId: proposal.id,
    threadId: proposal.threadId,
    status: proposal.status,
  };
  agentThreadProposalEvents.emit('update', event);
}

/** Filter a live-tail stream to one thread BEFORE throttling (so a busy sibling can't evict this thread's latest). */
async function* filterThread(
  source: AsyncIterable<AgentThreadLiveTailEvent>,
  threadId: string,
): AsyncGenerator<AgentThreadLiveTailEvent> {
  for await (const ev of source) {
    if (ev.threadId === threadId) yield ev;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const agentThreadRouter = router({
  /**
   * Load-or-create the single 'global' thread (and ensure its neutral home dir).
   * Idempotent: repeated calls return the SAME thread row.
   */
  getThread: protectedProcedure.query(async ({ ctx }): Promise<AgentThread> => {
    return requireService(ctx).ensureGlobalThread();
  }),

  /**
   * Reconstruct the thread's chat history as fully-correlated UnifiedMessage[]
   * (tool_use folded with its tool_result) — the SAME rich projection the run +
   * quick-session paths produce, over `agent_thread_events`.
   */
  listMessages: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ ctx, input }): Promise<UnifiedMessage[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[agentThread.listMessages] db not wired into tRPC context',
        });
      }
      return selectAgentThreadUnifiedMessages(ctx.db, input.threadId);
    }),

  /** Send one agent turn (spawn / warm-continue). */
  sendMessage: protectedProcedure
    .input(z.object({ threadId: z.string(), text: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      await requireService(ctx).sendMessage(input.threadId, input.text);
      return { ok: true };
    }),

  /**
   * Trigger a synthetic digest turn. Server-throttled (≥10 min per thread) — a
   * throttled call returns { triggered: false, reason: 'throttled' } WITHOUT
   * sending, so the frontend's first-open-per-launch trigger stays idempotent.
   */
  triggerDigest: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<{ triggered: true } | { triggered: false; reason: 'throttled' }> => {
        return requireService(ctx).triggerDigest(input.threadId);
      },
    ),

  /** List a thread's proposals oldest-first (all statuses). */
  listProposals: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ ctx, input }): Promise<AgentProposal[]> => {
      return requireStore(ctx).listProposals(input.threadId);
    }),

  /**
   * The user's Confirm click. See the module header for the dispatch split.
   * Emits onProposalUpdate on every terminal path.
   */
  confirmProposal: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<ConfirmProposalResult> => {
      const store = requireStore(ctx);
      const proposal = store.getProposal(input.proposalId);
      if (!proposal) return { ok: false, reason: 'not-found' };

      // open-session is pure renderer navigation — the executor rejects it by
      // design, so this router owns its terminal transition. CAS-claim first
      // (double-confirm guard), then finalize 'executed'; hand the client the
      // discriminated navigation target (routing an idle quick session through
      // setActiveRun is the documented stuck-on-"Loading workflow…" trap, §2.5).
      if (proposal.kind === 'open-session') {
        const payload = proposal.payload as OpenSessionProposalPayload;
        if (!store.claimProposal(input.proposalId, randomUUID())) {
          emitProposalUpdate(store, input.proposalId);
          return { ok: false, reason: 'claimed' };
        }
        const resultJson = JSON.stringify({
          kind: 'open-session',
          status: 'executed',
          navigation: payload.navigation,
        });
        store.finalizeProposal(input.proposalId, 'executed', resultJson);
        emitProposalUpdate(store, input.proposalId);
        return {
          ok: true,
          kind: 'open-session',
          proposalId: input.proposalId,
          status: 'executed',
          navigation: payload.navigation,
        };
      }

      // All other kinds run through the boot-wired executor (it owns the CAS
      // claim, per-kind preconditions, side effects, and terminal transition).
      if (!ctx.agentProposalExecutor) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[agentThread.confirmProposal] proposal executor not wired into tRPC context',
        });
      }
      const result = await ctx.agentProposalExecutor.execute(input.proposalId);

      // superseded / validation-failed carry a loopbackTurn — inject it into the
      // thread as the agent's next turn so a stale/invalid edit loops back for
      // revision instead of dead-ending (plan §2.5). Fire-and-forget: the response
      // returns immediately; the agent replies asynchronously.
      if (!result.ok && (result.reason === 'superseded' || result.reason === 'validation-failed')) {
        const service = ctx.agentThreadService;
        if (service) {
          void service.sendMessage(proposal.threadId, result.loopbackTurn).catch((err) => {
            // Best-effort loopback: a failure to inject the revise/refresh turn must
            // not fail the confirm response (no-console is off in main).
            console.error(
              `[agentThread.confirmProposal] loopback turn injection failed for thread ${proposal.threadId}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        }
      }

      // Reflect the executor's terminal transition (executed / failed / superseded,
      // or the winner's state on a claimed loss) to every subscriber.
      emitProposalUpdate(store, input.proposalId);
      return result;
    }),

  /** Dismiss a still-proposed (not yet claimed) proposal. */
  dismissProposal: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true; dismissed: boolean }> => {
      const store = requireStore(ctx);
      const dismissed = store.dismissProposal(input.proposalId);
      emitProposalUpdate(store, input.proposalId);
      return { ok: true, dismissed };
    }),

  /**
   * Per-thread live-tail. Bridges the AgentThreadService's publishes (via
   * `agentThreadEvents`), filtered to the requested thread, throttled to 60Hz
   * before crossing the IPC boundary — same coalescing posture as onStreamEvent
   * (the renderer debounce-refetches the full projection on each signal).
   */
  onThreadEvent: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<unknown> {
      const abortSignal = signal ?? new AbortController().signal;
      const all = eventToAsyncIterable<AgentThreadLiveTailEvent>(
        agentThreadEvents,
        'message',
        abortSignal,
      );
      for await (const ev of throttleAsyncIterator(filterThread(all, input.threadId), 60)) {
        yield ev.envelope;
      }
    }),

  /**
   * Proposal-transition notifications (all threads). No throttle: transitions are
   * infrequent (human-gated) and each must surface. Backed by the module-level
   * `agentThreadProposalEvents` emitter this router writes on every transition.
   */
  onProposalUpdate: protectedProcedure.subscription(async function* ({
    signal,
  }): AsyncGenerator<AgentProposalUpdateEvent> {
    const abortSignal = signal ?? new AbortController().signal;
    const source = eventToAsyncIterable<AgentProposalUpdateEvent>(
      agentThreadProposalEvents,
      'update',
      abortSignal,
    );
    for await (const ev of source) {
      yield ev;
    }
  }),
});
