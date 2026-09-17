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
 *
 * ## Subscription self-healing
 *
 * Both subscriptions are opened through {@link openResilientSubscription}: a
 * subscription the SERVER ends (`stopped`/`complete` — trpc-electron aborts
 * every subscription of a frame on its `did-start-navigation`, and a
 * main-side generator that returns ends the same way) or that errors is
 * reopened after a short backoff instead of being left dead. Before this, a
 * server-side stop was completely silent (`onStopped`/`onComplete` were not
 * even observed): the assistant's replies and fresh proposals then never
 * reached the rail until the whole window was reloaded, while the composer's
 * `sending` flag — driven by the mutation promise, not the subscription —
 * kept behaving normally. Belt-and-braces, `sendMessage` also forces one
 * transcript + proposals refetch when its turn settles, so a reply can never
 * be stranded behind a subscription gap however short.
 */
import { create } from 'zustand';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../trpc/client';
import type { AppRouter } from '../../../shared/types/trpc';
import type {
  AgentThread,
  AgentProposal,
  AgentThreadImageAttachment,
} from '../../../shared/types/agentThread';

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** onProposalUpdate's yielded payload, inferred from the router (same rule) —
 *  a subscription's inferred output is its AsyncGenerator, so unwrap the yield. */
type AgentProposalUpdateEvent =
  RouterOutputs['cyboflow']['agentThread']['onProposalUpdate'] extends AsyncIterable<infer T>
    ? T
    : never;

/** AppRouter-inferred result shapes — these discriminated unions live only on
 *  the router (main/src/orchestrator/trpc/routers/agentThread.ts), not in
 *  shared/types, so they are pulled in via inference rather than a hand
 *  mirror (CODE-PATTERNS.md IPC rule). */
export type ConfirmProposalResult = RouterOutputs['cyboflow']['agentThread']['confirmProposal'];

/** Debounce window for the onThreadEvent-driven refetch (messages signal + proposals). */
const LIVE_TAIL_DEBOUNCE_MS = 150;

/** Backoff before reopening a subscription the server ended or that errored. */
const RESUBSCRIBE_DELAY_MS = 1_000;

/** The subset of tRPC's subscription observer this store wires. */
interface SubscriptionHandlers<T> {
  onData: (value: T) => void;
}

/**
 * Open `subscribe` and keep it open: whenever the subscription ends for any
 * reason other than the returned `close()` (server `stopped`, link `complete`,
 * or an error), log why and reopen it after {@link RESUBSCRIBE_DELAY_MS}.
 * `subscribe` is invoked afresh on every (re)open so it can read current
 * state (e.g. the thread id) each time.
 */
export function openResilientSubscription<T>(
  label: string,
  subscribe: (handlers: {
    onData: (value: T) => void;
    onError: (err: unknown) => void;
    onStopped: () => void;
    onComplete: () => void;
  }) => { unsubscribe: () => void },
  handlers: SubscriptionHandlers<T>,
): { close: () => void } {
  let closed = false;
  let current: { unsubscribe: () => void } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReopen = (reason: string): void => {
    if (closed || retryTimer !== null) return;
    console.warn(`[agentThreadStore] ${label} subscription ended (${reason}); reopening`);
    current = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, RESUBSCRIBE_DELAY_MS);
  };

  const open = (): void => {
    if (closed) return;
    // Identity guard: a callback from a superseded subscription (one that was
    // already replaced) must not schedule a second reopen.
    let self: { unsubscribe: () => void } | null = null;
    const isLive = (): boolean => !closed && current === self;
    self = subscribe({
      onData: (value) => {
        if (isLive()) handlers.onData(value);
      },
      onError: (err) => {
        if (isLive()) scheduleReopen(`error: ${err instanceof Error ? err.message : String(err)}`);
      },
      onStopped: () => {
        if (isLive()) scheduleReopen('stopped by server');
      },
      onComplete: () => {
        if (isLive()) scheduleReopen('completed');
      },
    });
    current = self;
  };

  open();

  return {
    close: () => {
      closed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      current?.unsubscribe();
      current = null;
    },
  };
}

export interface AgentThreadState {
  /** The single 'global' thread row. Null until `init()`'s bootstrap resolves. */
  thread: AgentThread | null;
  /** This thread's proposals (all statuses), oldest-first. */
  proposals: AgentProposal[];
  /** True while the initial bootstrap (getThread + listProposals) is in flight. */
  loading: boolean;
  /** True while a turn (sendMessage) is in flight — the composer's disable signal. */
  sending: boolean;
  /**
   * Bumped on every debounced onThreadEvent tick. {@link useUnifiedAgentThreadMessages}
   * watches this as its live-tail refetch trigger — a monotonic counter rather
   * than the envelope itself, since the hook only needs "something changed",
   * mirroring how useUnifiedRunMessages watches `streamEvents.length`.
   */
  liveTailTick: number;

  /**
   * A one-shot pre-fill for the composer (Custom Views §7.1's authoring
   * kickoff — `startAuthoring` sets it, `AgentComposer`/`AgentThreadView`
   * apply it once via `onPrefillConsumed` and it is expected to be cleared
   * back to `null` right after). `null` the rest of the time.
   */
  composerDraft: string | null;
  /** Set (or clear with `null`) the composer's one-shot pre-fill text. */
  setComposerDraft: (text: string | null) => void;

  /**
   * A `contextHint` envelope queued for the NEXT `sendMessage` call (Custom
   * Views §7.1) — `startAuthoring` sets this so the turn the user actually
   * sends carries the `[custom-widget-session]` envelope, without the
   * composer or its caller having to thread it through explicitly.
   * `sendMessage` consumes and clears it automatically; an explicit
   * `opts.contextHint` on the call still wins over it.
   */
  pendingContextHint: string | null;
  /** Set (or clear with `null`) the pending `contextHint` for the next `sendMessage`. */
  setPendingContextHint: (hint: string | null) => void;

  /**
   * Bootstrap: fetch getThread + listProposals, then wire the two
   * subscriptions above. Idempotent (closure-guarded); returns an unsubscribe
   * that tears down both subscriptions and any pending debounce timer.
   */
  init: () => (() => void);

  /** Send one turn on the global thread. Swallows failures (console.error) —
   *  the composer has no dedicated error-surfacing slot yet (S1.5 polish).
   *  `opts.contextHint` is optional prompt-only priming text (e.g. onboarding
   *  context) prepended to what the model sees — never part of the recorded
   *  transcript turn. */
  sendMessage: (
    text: string,
    opts?: { contextHint?: string; images?: AgentThreadImageAttachment[] },
  ) => Promise<void>;
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
    composerDraft: null,
    pendingContextHint: null,

    setComposerDraft: (text) => set({ composerDraft: text }),
    setPendingContextHint: (hint) => set({ pendingContextHint: hint }),

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;
      set({ loading: true });

      let threadEventSub: { close: () => void } | null = null;
      let refetchTimer: ReturnType<typeof setTimeout> | null = null;
      // Set by `unsubscribe` so a bootstrap that resolves after teardown does
      // not open a subscription nothing will ever close.
      let tornDown = false;

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
          if (tornDown) return;
          threadEventSub = openResilientSubscription(
            'onThreadEvent',
            (handlers) =>
              trpc.cyboflow.agentThread.onThreadEvent.subscribe({ threadId: thread.id }, handlers),
            { onData: () => scheduleLiveTailRefresh(thread.id) },
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
      const proposalEventSub = openResilientSubscription<AgentProposalUpdateEvent>(
        'onProposalUpdate',
        (handlers) => trpc.cyboflow.agentThread.onProposalUpdate.subscribe(undefined, handlers),
        {
          onData: (event) => {
            const threadId = get().thread?.id;
            if (threadId !== undefined && event.threadId === threadId) {
              void refreshProposals(threadId);
            }
          },
        },
      );

      const unsubscribe = (): void => {
        tornDown = true;
        if (refetchTimer !== null) {
          clearTimeout(refetchTimer);
          refetchTimer = null;
        }
        threadEventSub?.close();
        proposalEventSub.close();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },

    sendMessage: async (
      text: string,
      opts?: { contextHint?: string; images?: AgentThreadImageAttachment[] },
    ) => {
      const threadId = get().thread?.id;
      if (threadId === undefined) {
        console.warn('[agentThreadStore] sendMessage called before the thread loaded — dropped');
        return;
      }
      // An explicit opts.contextHint wins; otherwise a queued authoring
      // kickoff hint (§7.1) rides this turn — one-shot, cleared regardless
      // of whether the mutation succeeds (a failed send does not owe a
      // second attempt at the same hint; the user can just try again).
      const pendingHint = get().pendingContextHint;
      const contextHint = opts?.contextHint ?? pendingHint ?? undefined;
      if (pendingHint !== null) set({ pendingContextHint: null });
      set({ sending: true });
      try {
        await trpc.cyboflow.agentThread.sendMessage.mutate({
          threadId,
          text,
          ...(contextHint !== undefined ? { contextHint } : {}),
          // Omitted on a text-only turn so the mutation payload is unchanged
          // for every existing caller.
          ...(opts?.images !== undefined && opts.images.length > 0 ? { images: opts.images } : {}),
        });
      } catch (err: unknown) {
        console.error('[agentThreadStore] sendMessage failed:', err);
      } finally {
        // The turn has settled either way (the mutation resolves at the result
        // boundary, or the spawn failed and an error event was recorded).
        // Force one transcript + proposals refetch here rather than trusting
        // the live tail alone — see "Subscription self-healing" above.
        set((s) => ({ sending: false, liveTailTick: s.liveTailTick + 1 }));
        void refreshProposals(threadId);
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
