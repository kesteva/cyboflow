/**
 * agentThreadStore — renderer-side state for the global-agent chat thread
 * (migration 071 / docs/proposals/GLOBAL-AGENT-PLAN.md S1.2).
 *
 * There is exactly ONE thread (`scope: 'global'`) in Stage 1, so unlike
 * per-project/per-run stores this carries no id-keyed maps: `thread` is the
 * single row, `proposals` is that thread's proposal list.
 *
 * ## Reactivity strategy
 *
 * `init()` bootstraps by fetching `getThread` then `listProposals`, and wires
 * two tRPC-native subscriptions (mirrors landingStore/reviewQueueStore — no
 * raw-IPC `subscribeToStreamEvents` bridge; S0.6's `onThreadEvent` is
 * ADDITIVE to that raw channel specifically so a tRPC-only consumer can pick
 * ONE live-tail source, see the S0.6 report's deviation 6):
 *
 *   1. `onThreadEvent` (per-thread live-tail, server-throttled ~60ms) is
 *      debounced a further ~150ms client-side before it does anything — a
 *      single agent turn can stream many token deltas, and each debounced
 *      tick both (a) bumps `liveTailTick` (the signal
 *      {@link useUnifiedAgentThreadMessages} watches to refetch the
 *      transcript projection) and (b) refetches this thread's proposals
 *      (a turn can end with a fresh `cyboflow_propose_action` call).
 *   2. `onProposalUpdate` (all-threads, unthrottled — human-gated transitions
 *      are infrequent) triggers a TARGETED proposals-only refetch for this
 *      thread when the event's `threadId` matches — no message refetch, no
 *      debounce (each transition matters and is rare).
 *
 * Failures are caught and `console.warn`/`console.error`-ed, never thrown out
 * of a subscription handler (mirrors every other store's resync path).
 */
import { create } from 'zustand';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';
import type { AgentThread, AgentProposal } from '../../../shared/types/agentThread';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** AppRouter-inferred result shapes — these discriminated unions live only on
 *  the router (main/src/orchestrator/trpc/routers/agentThread.ts), not in
 *  shared/types, so they are pulled in via inference rather than a hand
 *  mirror (CLAUDE.md IPC rule). */
export type ConfirmProposalResult = RouterOutputs['cyboflow']['agentThread']['confirmProposal'];
export type DigestTriggerResult = RouterOutputs['cyboflow']['agentThread']['triggerDigest'];

/** Debounce window for the onThreadEvent-driven refetch (messages signal + proposals). */
const LIVE_TAIL_DEBOUNCE_MS = 150;

export interface AgentThreadState {
  /** The single 'global' thread row. Null until `init()`'s bootstrap resolves. */
  thread: AgentThread | null;
  /** This thread's proposals (all statuses), oldest-first. */
  proposals: AgentProposal[];
  /** True while the initial bootstrap (getThread + listProposals) is in flight. */
  loading: boolean;
  /** True while a turn (sendMessage/triggerDigest) is in flight — the composer's disable signal. */
  sending: boolean;
  /**
   * Bumped on every debounced onThreadEvent tick. {@link useUnifiedAgentThreadMessages}
   * watches this as its live-tail refetch trigger — a monotonic counter rather
   * than the envelope itself, since the hook only needs "something changed",
   * mirroring how useUnifiedRunMessages watches `streamEvents.length`.
   */
  liveTailTick: number;

  /**
   * Bootstrap: fetch getThread + listProposals, then wire the two
   * subscriptions above. Idempotent (closure-guarded); returns an unsubscribe
   * that tears down both subscriptions and any pending debounce timer.
   */
  init: () => (() => void);

  /** Send one turn on the global thread. Swallows failures (console.error) —
   *  the composer has no dedicated error-surfacing slot yet (S1.5 polish). */
  sendMessage: (text: string) => Promise<void>;
  /** Trigger a (server-throttled) digest turn. Swallows failures like sendMessage. */
  triggerDigest: () => Promise<void>;
  /** The user's Confirm click (S1.3 consumes this) — propagates failures so
   *  the proposal card can render them, and refreshes `proposals` afterward. */
  confirmProposal: (proposalId: string) => Promise<ConfirmProposalResult>;
  /** Dismiss a still-proposed card (S1.3) — same propagate + refresh contract. */
  dismissProposal: (proposalId: string) => Promise<{ ok: true; dismissed: boolean }>;
}

export const useAgentThreadStore = create<AgentThreadState>((set, get) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  /** Refetch this thread's proposals and replace the list atomically. */
  const refreshProposals = async (threadId: string): Promise<void> => {
    try {
      const proposals = await trpc.cyboflow.agentThread.listProposals.query({ threadId });
      set({ proposals });
    } catch (err: unknown) {
      console.warn('[agentThreadStore] listProposals failed:', err);
    }
  };

  return {
    thread: null,
    proposals: [],
    loading: false,
    sending: false,
    liveTailTick: 0,

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;
      set({ loading: true });

      let threadEventSub: { unsubscribe: () => void } | null = null;
      let refetchTimer: ReturnType<typeof setTimeout> | null = null;

      /** Debounced onThreadEvent handler: bump the live-tail tick + refetch proposals. */
      const scheduleLiveTailRefresh = (threadId: string): void => {
        if (refetchTimer !== null) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(() => {
          refetchTimer = null;
          set((s) => ({ liveTailTick: s.liveTailTick + 1 }));
          void refreshProposals(threadId);
        }, LIVE_TAIL_DEBOUNCE_MS);
      };

      // onThreadEvent's input is `{ threadId }` (server-side per-thread filter),
      // so it cannot be wired until getThread resolves — bootstrap sequences it.
      const bootstrap = async (): Promise<void> => {
        try {
          const thread = await trpc.cyboflow.agentThread.getThread.query();
          set({ thread });
          await refreshProposals(thread.id);
          threadEventSub = trpc.cyboflow.agentThread.onThreadEvent.subscribe(
            { threadId: thread.id },
            {
              onData: () => scheduleLiveTailRefresh(thread.id),
              onError: (err: unknown) =>
                console.warn('[agentThreadStore] onThreadEvent subscription error:', err),
            },
          );
        } catch (err: unknown) {
          console.error('[agentThreadStore] init bootstrap failed:', err);
        } finally {
          set({ loading: false });
        }
      };
      void bootstrap();

      // onProposalUpdate carries no input — it is the all-threads feed — so it
      // can subscribe immediately; filter to THIS thread once known.
      const proposalEventSub = trpc.cyboflow.agentThread.onProposalUpdate.subscribe(undefined, {
        onData: (event) => {
          const threadId = get().thread?.id;
          if (threadId !== undefined && event.threadId === threadId) {
            void refreshProposals(threadId);
          }
        },
        onError: (err: unknown) =>
          console.warn('[agentThreadStore] onProposalUpdate subscription error:', err),
      });

      const unsubscribe = (): void => {
        if (refetchTimer !== null) {
          clearTimeout(refetchTimer);
          refetchTimer = null;
        }
        threadEventSub?.unsubscribe();
        proposalEventSub.unsubscribe();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },

    sendMessage: async (text: string) => {
      const threadId = get().thread?.id;
      if (threadId === undefined) {
        console.warn('[agentThreadStore] sendMessage called before the thread loaded — dropped');
        return;
      }
      set({ sending: true });
      try {
        await trpc.cyboflow.agentThread.sendMessage.mutate({ threadId, text });
      } catch (err: unknown) {
        console.error('[agentThreadStore] sendMessage failed:', err);
      } finally {
        set({ sending: false });
      }
    },

    triggerDigest: async () => {
      const threadId = get().thread?.id;
      if (threadId === undefined) {
        console.warn('[agentThreadStore] triggerDigest called before the thread loaded — dropped');
        return;
      }
      set({ sending: true });
      try {
        await trpc.cyboflow.agentThread.triggerDigest.mutate({ threadId });
      } catch (err: unknown) {
        console.error('[agentThreadStore] triggerDigest failed:', err);
      } finally {
        set({ sending: false });
      }
    },

    confirmProposal: async (proposalId: string) => {
      const result = await trpc.cyboflow.agentThread.confirmProposal.mutate({ proposalId });
      const threadId = get().thread?.id;
      if (threadId !== undefined) await refreshProposals(threadId);
      return result;
    },

    dismissProposal: async (proposalId: string) => {
      const result = await trpc.cyboflow.agentThread.dismissProposal.mutate({ proposalId });
      const threadId = get().thread?.id;
      if (threadId !== undefined) await refreshProposals(threadId);
      return result;
    },
  };
});
