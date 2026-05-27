/**
 * questionStore — Zustand slice for the pending question queue.
 *
 * Owns all pending-question state visible in the ask-user-question UI.
 *
 * ## Resync strategy
 *
 * The store performs a FULL-STATE resync on every `init()` call by calling
 * `cyboflow.questions.listPending` and replacing the entire queue with
 * `replaceAll()`.  This prevents stale-queue bugs after:
 *   - Renderer reload (HMR in dev, hard reload in prod)
 *   - tRPC subscription drop-and-reconnect
 *   - Component remount after a disconnect
 *
 * Deltas from `onQuestionCreated` are an optimisation on top of the full
 * sync — correctness does NOT depend on receiving every delta.
 *
 * ## Idempotency guarantee
 *
 * `addQuestion` is idempotent on duplicate `id` (subscription replay safety).
 * `removeQuestion` is a no-op when the id is not present.
 * `replaceAll` is always atomic — it wipes the queue before inserting.
 */
import { create } from 'zustand';
import type { Question } from '../../../shared/types/questions';
import { trpc } from '../trpc/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface QuestionStoreState {
  /** Current pending question items. Empty until `init()` is called. */
  queue: Question[];
  /** Connection status of the tRPC subscription to the question event stream. */
  connectionStatus: ConnectionStatus;

  /**
   * "Other"-text bus — keyed by questionId.
   *
   * The bottom-bar ChatInput (TASK-762) writes typed text here for the active
   * pending question; AskUserQuestionCard reads it and pre-fills its "Other"
   * free-text field. This keeps ChatInput dumb (knows only about transport)
   * and AskUserQuestionCard the sole submit authority (owns the full answers
   * payload).
   *
   * Supports the 1–4 sub-questions case: each sub-question has its own
   * questionId so multiple cards can coexist without stomping each other.
   */
  otherText: Record<string, string>;

  // -- Reducers (pure / synchronous) ---------------------------------------

  /**
   * Add a question to the queue if its id is not already present.
   *
   * Idempotent: calling twice with the same question id is a no-op.
   * This makes subscription replay safe — if the server replays an event
   * after reconnect, the queue stays consistent.
   */
  addQuestion: (question: Question) => void;

  /**
   * Remove a question from the queue by id.
   *
   * No-op when the id is not in the queue — avoids throws on out-of-order
   * answered events.
   */
  removeQuestion: (id: string) => void;

  /**
   * Replace the entire queue atomically with a new set of questions.
   *
   * Used by the full-state resync path: wipes the existing queue and inserts
   * the items returned by `listPending`.  Starting from a clean slate ensures
   * that items answered between the last delta event and the resync are not
   * shown as stale.
   */
  replaceAll: (items: Question[]) => void;

  /** Update the tRPC connection status for display in the UI. */
  setConnectionStatus: (status: ConnectionStatus) => void;

  /**
   * Set the "Other" free-text for a specific question (by questionId).
   *
   * Called by ChatInput when the user types in workflow-question mode.
   * AskUserQuestionCard reads this value to pre-fill its "Other" input.
   */
  setOtherText: (questionId: string, text: string) => void;

  /**
   * Clear the "Other" free-text for a specific question (by questionId).
   *
   * Called by AskUserQuestionCard after the user submits the answer, or by
   * ChatInput after the textarea is cleared on a successful send.
   */
  clearOtherText: (questionId: string) => void;

  // -- Actions (async / side-effectful) ------------------------------------

  /**
   * Initialize the store: perform a full-state sync and subscribe to deltas.
   *
   * Safe to call multiple times (on remount, on reconnect).  Each call:
   *   1. Sets connectionStatus to 'connecting'
   *   2. Fetches the full list via listPending → replaceAll
   *   3. Sets connectionStatus to 'connected'
   *   4. Subscribes to onQuestionCreated for incremental additions
   *   5. Subscribes to onQuestionAnswered for incremental removals
   *
   * On subscription error, sets connectionStatus to 'disconnected'.
   * Consumers should call `init()` again to reconnect (e.g. from a useEffect
   * retry or after a component remount).
   *
   * Returns an unsubscribe function that the caller should invoke on unmount.
   */
  init: () => (() => void);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useQuestionStore = create<QuestionStoreState>((set, get) => {
  // Closure-private idempotency state — NOT exposed via QuestionStoreState.
  let initialized = false;
  let cachedUnsubscribe: (() => void) | null = null;

  return {
    queue: [],
    connectionStatus: 'idle',
    otherText: {},

    // -- Reducers -------------------------------------------------------------

    addQuestion: (question) => {
      const state = get();
      if (state.queue.some((q) => q.id === question.id)) return;
      const next = [...state.queue, question];
      set({ queue: next });
    },

    removeQuestion: (id) => {
      const state = get();
      const next = state.queue.filter((q) => q.id !== id);
      if (next.length === state.queue.length) return;
      set({ queue: next });
    },

    replaceAll: (items) => {
      const next = [...items];
      set({ queue: next });
    },

    setConnectionStatus: (status) => {
      set({ connectionStatus: status });
    },

    setOtherText: (questionId, text) => {
      set((s) => ({ otherText: { ...s.otherText, [questionId]: text } }));
    },

    clearOtherText: (questionId) => {
      set((s) => {
        const next = { ...s.otherText };
        delete next[questionId];
        return { otherText: next };
      });
    },

    // -- Actions --------------------------------------------------------------

    init: () => {
      // Idempotency guard: if already initialized, return the cached unsubscribe.
      if (initialized) {
        // cachedUnsubscribe is set synchronously after subscribe() returns, before
        // any re-entry can occur on this event-loop turn.
        return cachedUnsubscribe!;
      }

      // Mark initialized BEFORE async work begins so a concurrent second call
      // during the same tick sees the guard and returns early.
      initialized = true;

      const { addQuestion, removeQuestion, replaceAll, setConnectionStatus } = get();

      setConnectionStatus('connecting');

      // Full-state resync: fetch all pending questions and replace the queue
      trpc.cyboflow.questions.listPending
        .query()
        .then((items) => {
          replaceAll(items);
          setConnectionStatus('connected');
        })
        .catch((err: unknown) => {
          console.error('[questionStore] listPending failed:', err);
          setConnectionStatus('disconnected');
        });

      // Subscribe to incremental additions.
      // The event type emitted by onQuestionCreated is QuestionCreatedEvent.
      // We type the handler as `unknown` and apply a runtime guard so the
      // store remains type-safe while the backend implementation evolves.
      const createdSubscription = trpc.cyboflow.questions.onQuestionCreated.subscribe(undefined, {
        onData: (evt: unknown) => {
          // Expected shape: { question: Question }
          // Guard: only call addQuestion when the event carries the full record.
          if (
            typeof evt === 'object' &&
            evt !== null &&
            'question' in evt &&
            typeof (evt as Record<string, unknown>).question === 'object' &&
            (evt as Record<string, unknown>).question !== null
          ) {
            addQuestion((evt as { question: Question }).question);
          }
          // If the event doesn't carry a full question, silently ignore it —
          // the full-state resync on init() is the source of truth.
        },
        onError: (err: unknown) => {
          console.error('[questionStore] onQuestionCreated subscription error:', err);
          setConnectionStatus('disconnected');
          // Clear closure state so a subsequent init() re-subscribes.
          createdSubscription.unsubscribe();
          initialized = false;
          cachedUnsubscribe = null;
        },
      });

      // Subscribe to answered events so the item leaves the queue once the user
      // answers or the gate times out. The full-state listPending sync
      // remains the source of truth on reconnect; deltas are an optimisation.
      const answeredSubscription = trpc.cyboflow.questions.onQuestionAnswered.subscribe(undefined, {
        onData: (evt: unknown) => {
          if (
            typeof evt === 'object' &&
            evt !== null &&
            'questionId' in evt &&
            typeof (evt as Record<string, unknown>).questionId === 'string'
          ) {
            removeQuestion((evt as { questionId: string }).questionId);
          }
        },
        onError: (err: unknown) => {
          console.error('[questionStore] onQuestionAnswered subscription error:', err);
          setConnectionStatus('disconnected');
          // Mirror the onQuestionCreated onError pattern: unsubscribe BOTH
          // subscriptions and clear closure state so a subsequent init()
          // re-subscribes. Without this, a second-subscription drop leaves the
          // store stuck "initialized" with no recovery path.
          createdSubscription.unsubscribe();
          answeredSubscription.unsubscribe();
          initialized = false;
          cachedUnsubscribe = null;
        },
      });

      // Build the unsubscribe function, cache it, and return it.
      const unsubscribe = () => {
        createdSubscription.unsubscribe();
        answeredSubscription.unsubscribe();
        initialized = false;
        cachedUnsubscribe = null;
      };
      cachedUnsubscribe = unsubscribe;
      return unsubscribe;
    },
  };
});

// ---------------------------------------------------------------------------
// Pure reducer exports for unit testing
// ---------------------------------------------------------------------------
// These functions are extracted so unit tests can exercise reducer logic
// without needing a live tRPC connection or a real Zustand store.

/** Pure addQuestion reducer — exported for unit testing. */
export function pureAddQuestion(queue: Question[], question: Question): Question[] {
  if (queue.some((q) => q.id === question.id)) return queue;
  return [...queue, question];
}

/** Pure removeQuestion reducer — exported for unit testing. */
export function pureRemoveQuestion(queue: Question[], id: string): Question[] {
  return queue.filter((q) => q.id !== id);
}

/** Pure replaceAll reducer — exported for unit testing. */
export function pureReplaceAll(_queue: Question[], items: Question[]): Question[] {
  return [...items];
}
