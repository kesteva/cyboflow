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
 *   1. `onThreadEvent` (per-thread live-tail, server-batched ~60Hz — rate-capped
 *      but LOSSLESS, see the router's own doc) is debounced a further ~150ms
 *      client-side before it does anything — a
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
import type { StreamEvent } from '../utils/cyboflowApi';

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

/**
 * Poll interval for reconciling a `sending` flag that bootstrap HYDRATED from
 * `turnState` (as opposed to one this renderer's own `sendMessage` promise is
 * holding). The subscribe IPC call is async and may not be live server-side
 * by the time `turnState` resolves, so a terminal envelope for that turn can
 * be missed entirely — this poll is the backstop that still notices the turn
 * ended.
 */
const HYDRATED_SENDING_RECONCILE_MS = 2_500;

/** Defensive cap on the `liveEvents` buffer, mirroring MAX_EVENTS_PER_PANEL in
 *  panelLiveEventsStore.ts. Stage 1 has exactly one global thread, so unlike
 *  that store's per-panel map this is a single flat array. */
const MAX_LIVE_EVENTS = 2000;

/**
 * Narrows one element of onThreadEvent's `unknown[]` batch to the
 * `{type, payload, timestamp}` envelope shape `AgentThreadService.toEnvelope`
 * produces (main/src/orchestrator/agentThread/agentThreadService.ts ~666) —
 * the router's `onThreadEvent` subscription is typed `AsyncGenerator<unknown[]>`,
 * so nothing upstream of this guard proves any element's shape. Structural
 * only (the wrapper's own three fields, not `payload`'s per-`type`
 * correlation) — same audited-boundary posture as the `as StreamEnvelope`
 * cast at runEventBridge.ts:237: the producer's contract, not full runtime
 * validation, is what makes the subsequent `StreamEvent` cast safe.
 */
function isThreadStreamEnvelope(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; payload?: unknown; timestamp?: unknown };
  return typeof v.type === 'string' && 'payload' in v && typeof v.timestamp === 'string';
}

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
  /** True while a turn (sendMessage) is in flight — the composer's disable signal.
   *  Also hydrated from the server's `turnState` query at bootstrap, so a
   *  renderer reload mid-turn still shows Stop rather than Send. */
  sending: boolean;
  /**
   * Bumped on every debounced onThreadEvent tick. {@link useUnifiedAgentThreadMessages}
   * watches this as its live-tail refetch trigger — a monotonic counter rather
   * than the envelope itself, since the hook only needs "something changed",
   * mirroring how useUnifiedRunMessages watches `streamEvents.length`.
   */
  liveTailTick: number;

  /**
   * Raw onThreadEvent envelopes for the progressive-render live tail
   * (AgentThreadView reduces this via `reduceLiveTail` / `hasVisibleTailContent`,
   * mirroring RunChatView's `streamEvents` / ClaudePanel's `panelLiveEventsStore`).
   * A FLAT array, not panelLiveEventsStore's per-panel map — Stage 1 has exactly
   * one global thread. Reset to `[]` on a terminal `result` envelope, on a new
   * `sendMessage` call, and on `init()`'s bootstrap (thread re-init); capped at
   * {@link MAX_LIVE_EVENTS}.
   */
  liveEvents: StreamEvent[];

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
  /**
   * The rail's Stop control (TASK-297): abort whatever turn is in flight.
   * `sending` flips false once the interrupted `sendMessage` call settles
   * (see the store doc header) — this action does not touch `sending`
   * itself, it only fires the abort. A no-op call (nothing in flight) is
   * harmless: the server returns `{ interrupted: false }` and `sending` was
   * already false. Swallows failures (console.error) — same posture as
   * `sendMessage`.
   */
  interrupt: () => Promise<void>;

  /**
   * A turn buffered via `queueTurn` (TASK-301), waiting for the in-flight turn
   * to land. Delivered automatically — see `deliverQueuedTurnIfAny` in the
   * store body — the instant `sending` flips back to false, on EVERY path that
   * can flip it (the normal `sendMessage` finally, the live-tail's own
   * terminal-marker detection, and the hydrated-sending reconcile poll), so a
   * turn queued against a turn this renderer never itself started (e.g. after
   * a reload) still delivers. `null` the rest of the time.
   */
  queuedTurn: { text: string; images?: AgentThreadImageAttachment[] } | null;
  /**
   * Buffer `text`/`images` as the next turn. Call ONLY while a turn is
   * in flight (the composer gates its Queue button on `sending`) — queueing
   * while idle would just sit until the NEXT unrelated turn lands, which is
   * never what "Queue" means to the user; callers that need "send now" while
   * idle should call `sendMessage` directly.
   *
   * ACCUMULATES rather than replaces: a second `queueTurn` call while one is
   * already buffered joins the new text onto the existing text (`\n\n`,
   * matching `RunExecutor.queueInput`'s own multi-line join — runExecutor.ts's
   * `drainQueuedInputAtRest`) and appends the new images to the existing ones,
   * instead of silently discarding the first queued message — matching how
   * the flow-run queue and the quick-session queue both already accumulate.
   */
  queueTurn: (text: string, images?: AgentThreadImageAttachment[]) => void;
  /** Cancel a pending queued turn (the composer's "Queued… Cancel" control). */
  cancelQueuedTurn: () => void;
  /**
   * "Interrupt & send" (TASK-301): abort the in-flight turn, wait for it to
   * actually settle, THEN drive `text`/`images` as a fresh turn. Any pending
   * `queuedTurn` is dropped first — an explicit interrupt-and-send supersedes
   * whatever was queued. See the store body for why the settle-wait matters
   * (AgentThreadService has no per-thread send queue of its own).
   */
  interruptAndSend: (text: string, images?: AgentThreadImageAttachment[]) => Promise<void>;
  /** The user's Confirm click (S1.3 consumes this) — propagates failures so
   *  the proposal card can render them, and refreshes `proposals` afterward. */
  confirmProposal: (proposalId: string) => Promise<ConfirmProposalResult>;
  /** Dismiss a still-proposed card (S1.3) — same propagate + refresh contract. */
  dismissProposal: (proposalId: string) => Promise<{ ok: true; dismissed: boolean }>;
}

export const useAgentThreadStore = create<AgentThreadState>((set, get) => {
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  // TASK-297 reload-hydration reconcile: tracked at this outer level (not
  // inside `init()`) so `sendMessage` — a sibling method — can cancel a
  // hydration-driven poll the moment this renderer starts owning `sending`
  // via its own promise + `finally`.
  let hydratedSending = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Bumped by every local `sendMessage`. Bootstrap's `turnState` hydration
  // reads it before the query and drops the answer if it changed: once this
  // renderer has started its own turn, it owns `sending` via that promise, and
  // a `turnState` answer computed before the send reached the server (a stale
  // `inFlight: false`) must not re-enable Send mid-turn.
  let localSendEpoch = 0;
  // TASK-301: the in-flight `trpc...sendMessage.mutate()` promise THIS renderer
  // is holding (if any) — tracked so `interruptAndSend` can await the
  // just-aborted turn's own call fully settling before issuing a new one.
  // `AgentThreadService.sendMessage` has no per-thread queue of its own: two
  // overlapping `spawn()` calls would corrupt its single in-flight-turn
  // bookkeeping (`this.inFlight` — see agentThreadService.ts), so a second
  // send must never race the first's still-unwinding abort.
  let currentSendPromise: Promise<void> | null = null;
  const stopReconcile = (): void => {
    hydratedSending = false;
    if (reconcileTimer !== null) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  };

  /** Refetch this thread's proposals and replace the list atomically. */
  const refreshProposals = async (threadId: string): Promise<void> => {
    try {
      const proposals = await trpc.cyboflow.agentThread.listProposals.query({ threadId });
      set({ proposals });
    } catch (err: unknown) {
      console.warn('[agentThreadStore] listProposals failed:', err);
    }
  };

  /**
   * TASK-301: fire whenever `sending` flips back to false — called from EVERY
   * site that does so (see `queuedTurn`'s doc comment on the state field for
   * why all three matter). Fire-and-forget: `sendMessage` manages its own
   * `sending`/promise bookkeeping, so this must not be awaited here.
   */
  const deliverQueuedTurnIfAny = (): void => {
    const q = get().queuedTurn;
    if (q === null) return;
    set({ queuedTurn: null });
    void get().sendMessage(q.text, q.images !== undefined && q.images.length > 0 ? { images: q.images } : undefined);
  };

  return {
    thread: null,
    proposals: [],
    loading: false,
    sending: false,
    liveTailTick: 0,
    liveEvents: [],
    composerDraft: null,
    pendingContextHint: null,
    queuedTurn: null,

    setComposerDraft: (text) => set({ composerDraft: text }),
    setPendingContextHint: (hint) => set({ pendingContextHint: hint }),
    queueTurn: (text, images) =>
      set((s) => {
        const prior = s.queuedTurn;
        if (prior === null) {
          return { queuedTurn: { text, ...(images !== undefined ? { images } : {}) } };
        }
        // Accumulate onto whatever is already buffered — see the field doc
        // comment above for why this must never silently overwrite.
        const joinedText = prior.text.length > 0 && text.length > 0 ? `${prior.text}\n\n${text}` : prior.text || text;
        const joinedImages =
          images !== undefined || prior.images !== undefined ? [...(prior.images ?? []), ...(images ?? [])] : undefined;
        return {
          queuedTurn: { text: joinedText, ...(joinedImages !== undefined ? { images: joinedImages } : {}) },
        };
      }),
    cancelQueuedTurn: () => set({ queuedTurn: null }),

    init: () => {
      if (initialized) return cachedUnsubscribe!;
      initialized = true;
      // Thread re-init (a fresh bootstrap after a prior teardown) starts the
      // live tail clean — a stale buffer from a torn-down subscription must
      // not bleed into the newly-opened one.
      set({ loading: true, liveEvents: [] });

      let threadEventSub: { close: () => void } | null = null;
      let refetchTimer: ReturnType<typeof setTimeout> | null = null;
      // Set by `unsubscribe` so a bootstrap that resolves after teardown does
      // not open a subscription nothing will ever close.
      let tornDown = false;
      // Bumped by `captureLiveEvents` on every terminal envelope (`result` /
      // `assistant_interrupted`) it sees. Read once before firing the
      // `turnState` query below and compared after it resolves: if a terminal
      // envelope landed WHILE the query was in flight, that query's answer is
      // stale and must not clobber the `sending: false` the envelope already
      // applied.
      let terminalEpoch = 0;

      /** Debounced onThreadEvent handler: bump the live-tail tick + refetch proposals. */
      const scheduleLiveTailRefresh = (threadId: string): void => {
        if (refetchTimer !== null) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(() => {
          refetchTimer = null;
          set((s) => ({ liveTailTick: s.liveTailTick + 1 }));
          void refreshProposals(threadId);
        }, LIVE_TAIL_DEBOUNCE_MS);
      };

      /**
       * Fold one onThreadEvent batch into `liveEvents` for the progressive-
       * render tail (AgentThreadView's `reduceLiveTail`) in a SINGLE `set()` —
       * the server batches (never drops) events per tick specifically so the
       * reducer sees every intermediate delta it needs to reconstruct
       * in-flight text, mirroring panelLiveEventsStore.appendEvent's
       * reset-on-`result` + cap behavior applied across the whole batch (a
       * `result` mid-batch resets what came before it in the SAME batch too).
       */
      const captureLiveEvents = (values: readonly unknown[]): void => {
        // Hoisted so the TASK-301 queued-turn delivery (below) can fire AFTER
        // `set()` has fully applied `sending: false` — never from inside the
        // updater itself, which must stay a pure state computation.
        let sawTerminalOut = false;
        set((s) => {
          let events = s.liveEvents;
          // A turn that settled on a DIFFERENT renderer than the one currently
          // mounted (e.g. after a reload mid-turn — `sending` was hydrated from
          // `turnState`, not from a live `sendMessage` promise this renderer is
          // holding) has no `finally` block here to clear `sending`. The live
          // tail's own terminal envelopes are therefore the only signal this
          // renderer will ever see, so a `result` (normal completion / error)
          // or an `assistant_interrupted` marker must clear it directly.
          let sawTerminal = false;
          for (const value of values) {
            if (!isThreadStreamEnvelope(value)) continue;
            if (value.type === 'result') {
              events = [];
              sawTerminal = true;
              continue;
            }
            if (
              value.type === 'system' &&
              typeof value.payload === 'object' &&
              value.payload !== null &&
              (value.payload as { subtype?: unknown }).subtype === 'assistant_interrupted'
            ) {
              sawTerminal = true;
            }
            events =
              events.length >= MAX_LIVE_EVENTS
                ? [...events.slice(events.length - MAX_LIVE_EVENTS + 1), value]
                : [...events, value];
          }
          const next: Partial<AgentThreadState> = {};
          if (events !== s.liveEvents) next.liveEvents = events;
          if (sawTerminal) {
            terminalEpoch += 1;
            sawTerminalOut = true;
            if (s.sending) next.sending = false;
            // The turn this poll was reconciling has now ended via its own
            // terminal marker — the poll's job is done.
            stopReconcile();
          }
          return next;
        });
        // TASK-301: a turn queued while THIS renderer held no local send
        // promise for the turn that just ended (e.g. after a reload) has no
        // `sendMessage` `finally` to deliver it — the live tail's own terminal
        // marker is the only signal available, so deliver here too.
        //
        // Guarded on `currentSendPromise === null`: the server can publish the
        // terminal `result` envelope over the live tail WHILE this renderer's
        // own `sendMessage` call is still awaiting its `sendMessage.mutate()`
        // promise (AgentThreadService's `onOutput` fires the terminal envelope
        // from inside `spawn()`, before `spawn()` itself — and therefore the
        // mutation — returns). When a local `currentSendPromise` exists for the
        // in-flight turn, delivery is left ENTIRELY to that call's own `finally`
        // block once it actually settles — calling `deliverQueuedTurnIfAny` here
        // too would double-deliver: two overlapping `sendMessage.mutate()` calls
        // racing `AgentThreadService`'s single `inFlight` bookkeeping (it has no
        // per-thread send queue of its own).
        if (sawTerminalOut && currentSendPromise === null) deliverQueuedTurnIfAny();
      };

      // onThreadEvent's input is `{ threadId }` (server-side per-thread filter),
      // so it cannot be wired until getThread resolves — bootstrap sequences it.
      const bootstrap = async (): Promise<void> => {
        try {
          const thread = await trpc.cyboflow.agentThread.getThread.query();
          set({ thread });
          await refreshProposals(thread.id);
          if (tornDown) return;
          // Open the live tail BEFORE querying `turnState` below: a terminal
          // envelope (`result` / `assistant_interrupted`) for a turn that
          // ends while that query is still in flight must be observable by
          // the epoch check below, and the subscription can only see it once
          // it is actually open.
          threadEventSub = openResilientSubscription<unknown[]>(
            'onThreadEvent',
            (handlers) =>
              trpc.cyboflow.agentThread.onThreadEvent.subscribe({ threadId: thread.id }, handlers),
            {
              onData: (values) => {
                captureLiveEvents(values);
                scheduleLiveTailRefresh(thread.id);
              },
            },
          );

          // A renderer reload loses the in-memory `sending` flag a live
          // `sendMessage` call would otherwise be holding — hydrate it from
          // the server's own record of what is actually in flight, so a turn
          // that started before this mount still shows Stop, not Send.
          const epochBeforeQuery = terminalEpoch;
          const sendEpochBeforeQuery = localSendEpoch;
          try {
            const { inFlight } = await trpc.cyboflow.agentThread.turnState.query({
              threadId: thread.id,
            });
            if (tornDown) return;
            // The subscribe IPC call above is itself async and may not be
            // live server-side yet, so it can still miss the terminal event
            // for THIS query's answer — the epoch check only catches the
            // envelope having already arrived by now. Trust the query's
            // answer only when nothing terminal has landed in the meantime.
            if (terminalEpoch !== epochBeforeQuery) return;
            // A local send started while the query was in flight: this
            // renderer now owns `sending`, and the answer may predate it.
            if (localSendEpoch !== sendEpochBeforeQuery) return;
            set({ sending: inFlight });
            if (inFlight) {
              // Reconcile: this renderer holds no `sendMessage` promise for
              // this turn, so nothing else will ever flip `sending` back to
              // false except a terminal envelope arriving (handled above) or
              // this poll noticing the server itself has gone idle.
              hydratedSending = true;
              reconcileTimer = setInterval(() => {
                void (async () => {
                  if (tornDown || !hydratedSending) return;
                  try {
                    const result = await trpc.cyboflow.agentThread.turnState.query({
                      threadId: thread.id,
                    });
                    if (tornDown || !hydratedSending) return;
                    if (!result.inFlight) {
                      set({ sending: false });
                      stopReconcile();
                      // TASK-301: this reconcile poll IS the "turn landed"
                      // signal for a hydrated-sending turn with no terminal
                      // envelope observed (or none this renderer subscribed in
                      // time for) — deliver any queued turn now.
                      deliverQueuedTurnIfAny();
                    }
                  } catch (err: unknown) {
                    console.warn('[agentThreadStore] turnState reconcile failed:', err);
                  }
                })();
              }, HYDRATED_SENDING_RECONCILE_MS);
            }
          } catch (err: unknown) {
            console.warn('[agentThreadStore] turnState hydration failed:', err);
          }
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
        stopReconcile();
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
      // This renderer is about to own `sending` via its own promise +
      // `finally` below — cancel any hydration-driven reconcile poll left
      // over from bootstrap so the two mechanisms never race each other, and
      // invalidate any bootstrap `turnState` hydration still in flight.
      stopReconcile();
      localSendEpoch += 1;
      // A new turn starts the live tail clean — a prior turn's trailing
      // envelopes (if any survived without a `result`, e.g. a cancelled turn)
      // must not bleed into this one's progressive render.
      set({ sending: true, liveEvents: [] });
      // TASK-301: track this call's own promise so `interruptAndSend` can await
      // it fully settling before issuing a follow-up send on the same thread
      // (see `currentSendPromise`'s doc comment above).
      const run = async (): Promise<void> => {
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
          // This turn just landed — deliver whatever was queued against it.
          deliverQueuedTurnIfAny();
        }
      };
      const p = run();
      currentSendPromise = p;
      try {
        await p;
      } finally {
        if (currentSendPromise === p) currentSendPromise = null;
      }
    },

    interrupt: async () => {
      const threadId = get().thread?.id;
      if (threadId === undefined) return;
      try {
        await trpc.cyboflow.agentThread.interruptTurn.mutate({ threadId });
      } catch (err: unknown) {
        console.error('[agentThreadStore] interrupt failed:', err);
      }
    },

    interruptAndSend: async (text: string, images?: AgentThreadImageAttachment[]) => {
      const threadId = get().thread?.id;
      if (threadId === undefined) return;
      // An explicit interrupt-and-send supersedes anything already queued.
      set({ queuedTurn: null });
      const inFlight = currentSendPromise;
      try {
        await trpc.cyboflow.agentThread.interruptTurn.mutate({ threadId });
      } catch (err: unknown) {
        console.error('[agentThreadStore] interrupt (interruptAndSend) failed:', err);
      }
      if (inFlight !== null) {
        // The turn THIS renderer started — its own `sendMessage` call resolves
        // once the aborted turn's spawn has fully unwound server-side (the
        // `trpc...sendMessage.mutate()` promise settles when
        // AgentThreadService.sendMessage's async function returns). Awaiting it
        // here is what prevents a second overlapping `spawn()` call.
        await inFlight.catch(() => undefined);
      } else {
        // Hydrated-sending case: this renderer holds no local promise for the
        // turn it just aborted (e.g. a reload mid-turn), so there is nothing to
        // await directly. Briefly poll turnState so the aborted spawn's own
        // `finally` has a chance to clear server-side first — bounded so a
        // stuck server-side state can never wedge the composer.
        for (let i = 0; i < 10; i++) {
          try {
            const { inFlight: stillInFlight } = await trpc.cyboflow.agentThread.turnState.query({ threadId });
            if (!stillInFlight) break;
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await get().sendMessage(text, images !== undefined && images.length > 0 ? { images } : undefined);
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
