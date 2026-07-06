/**
 * pendingSendStore — client-side optimistic-echo model for chat sends.
 *
 * When the user sends a chat message, the real transcript row only appears after
 * a server round-trip + a debounced DB refetch (quick sessions) or a streamEvents
 * delta (flow runs). To make a send feel INSTANT — and to give a
 * queued-but-not-yet-delivered message a distinct, clickable treatment — every
 * send pushes a lightweight "pending" entry here the moment it dispatches. The
 * entry is rendered pinned at the bottom of the chat area (`PendingSendRow`) and
 * settled by:
 *   - RECONCILIATION: dropped once the real user turn shows up in the transcript
 *     (timestamp-windowed text match, so identical repeat sends don't mis-dedupe).
 *   - the send promise: flipped to 'failed' when the dispatch rejects.
 *   - REOPEN: a 'queued' / 'failed' row is clicked → its text is handed back to
 *     the composer (via `draftRequest`) and the entry removed.
 *
 * Keyed by HOST: panelId for quick sessions, runId for flow runs (the same id the
 * host passes as `railId` to UnifiedChatView). In-memory only — a pending send is
 * inherently ephemeral (it is either reconciled or failed within one turn), so it
 * intentionally does NOT survive a full reload, only a component remount.
 */
import { create } from 'zustand';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';

export type PendingSendStatus = 'sending' | 'queued' | 'failed';

export interface PendingSend {
  /** Client-generated id. For server-buffered ('queued') sends it is ALSO the
   *  id handed to the queue API, so a later dequeue can target this exact entry. */
  id: string;
  text: string;
  /** epoch ms at dispatch — the lower bound of the reconciliation window. */
  createdAt: number;
  status: PendingSendStatus;
}

/**
 * A repopulate-the-composer request. Set by {@link requestReopen}; consumed by the
 * composer host via a nonce-keyed effect (so re-reopening the SAME text still
 * fires). The composer clears it via {@link clearDraftRequest} after applying.
 */
export interface DraftRequest {
  text: string;
  nonce: number;
}

/**
 * Clock-skew tolerance (ms) for reconciliation. The transcript row is written
 * server-side AT/AFTER the client stamps `createdAt`, but the two clocks are the
 * same machine, so a small negative window only guards against sub-second
 * resolution differences. A message OLDER than this window (e.g. an identical
 * message already in history) must NOT match a fresh pending entry.
 */
const CLOCK_SKEW_MS = 5_000;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ps-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Flatten a UnifiedMessage's text segments into a single trimmed string. */
function messageText(msg: UnifiedMessage): string {
  return msg.segments
    .filter((s) => s.type === 'text')
    .map((s) => (s.type === 'text' ? s.content : ''))
    .join('\n')
    .trim();
}

interface PendingSendState {
  byHost: Record<string, PendingSend[]>;
  draftRequest: Record<string, DraftRequest | undefined>;

  /** Push a pending entry; returns its id. Defaults to 'sending'. */
  addPending: (hostKey: string, text: string, status?: PendingSendStatus) => string;
  /** Flip an entry's status (e.g. 'sending' → 'failed', or → 'queued'). */
  setStatus: (hostKey: string, id: string, status: PendingSendStatus) => void;
  /** Remove an entry outright (reconciled / reopened / dropped). */
  removePending: (hostKey: string, id: string) => void;
  /**
   * Drop pending entries whose real user turn has appeared in `messages`.
   * Greedy one-to-one match (earliest entry first) so two identical sends map to
   * two distinct transcript rows. 'failed' entries are never auto-dropped — they
   * wait for the user to reopen or dismiss them.
   */
  reconcile: (hostKey: string, messages: UnifiedMessage[]) => void;
  /** Reopen: remove the entry and stage its text for the composer to pick up. */
  requestReopen: (hostKey: string, id: string) => void;
  /** Composer ack: clear the staged draft request after applying it. */
  clearDraftRequest: (hostKey: string) => void;
  /** Test seam: wipe a host's state (entries + draft request). */
  resetHost: (hostKey: string) => void;
}

export const usePendingSendStore = create<PendingSendState>((set, get) => ({
  byHost: {},
  draftRequest: {},

  addPending: (hostKey, text, status = 'sending') => {
    const id = newId();
    const entry: PendingSend = { id, text, createdAt: Date.now(), status };
    set((state) => ({
      byHost: { ...state.byHost, [hostKey]: [...(state.byHost[hostKey] ?? []), entry] },
    }));
    return id;
  },

  setStatus: (hostKey, id, status) => {
    set((state) => {
      const list = state.byHost[hostKey];
      if (!list) return state;
      const next = list.map((e) => (e.id === id ? { ...e, status } : e));
      return { byHost: { ...state.byHost, [hostKey]: next } };
    });
  },

  removePending: (hostKey, id) => {
    set((state) => {
      const list = state.byHost[hostKey];
      if (!list) return state;
      const next = list.filter((e) => e.id !== id);
      return { byHost: { ...state.byHost, [hostKey]: next } };
    });
  },

  reconcile: (hostKey, messages) => {
    const list = get().byHost[hostKey];
    if (!list || list.length === 0) return;

    // Consumable = anything still in flight (a 'failed' row stays until the user
    // acts on it). Match earliest-createdAt first for stable one-to-one mapping.
    const consumable = list
      .filter((e) => e.status !== 'failed')
      .sort((a, b) => a.createdAt - b.createdAt);
    if (consumable.length === 0) return;

    const userTurns = messages
      .filter((m) => m.role === 'user')
      .map((m) => ({ text: messageText(m), time: Date.parse(m.timestamp) }))
      .sort((a, b) => a.time - b.time);

    const matchedIds = new Set<string>();
    for (const turn of userTurns) {
      const hit = consumable.find(
        (e) =>
          !matchedIds.has(e.id) &&
          e.text.trim() === turn.text &&
          (Number.isNaN(turn.time) || turn.time >= e.createdAt - CLOCK_SKEW_MS),
      );
      if (hit) matchedIds.add(hit.id);
    }
    if (matchedIds.size === 0) return;

    set((state) => {
      const cur = state.byHost[hostKey];
      if (!cur) return state;
      const next = cur.filter((e) => !matchedIds.has(e.id));
      return { byHost: { ...state.byHost, [hostKey]: next } };
    });
  },

  requestReopen: (hostKey, id) => {
    set((state) => {
      const list = state.byHost[hostKey];
      if (!list) return state;
      const entry = list.find((e) => e.id === id);
      if (!entry) return state;
      const prevNonce = state.draftRequest[hostKey]?.nonce ?? 0;
      return {
        byHost: { ...state.byHost, [hostKey]: list.filter((e) => e.id !== id) },
        draftRequest: {
          ...state.draftRequest,
          [hostKey]: { text: entry.text, nonce: prevNonce + 1 },
        },
      };
    });
  },

  clearDraftRequest: (hostKey) => {
    set((state) => {
      if (!state.draftRequest[hostKey]) return state;
      return { draftRequest: { ...state.draftRequest, [hostKey]: undefined } };
    });
  },

  resetHost: (hostKey) => {
    set((state) => ({
      byHost: { ...state.byHost, [hostKey]: [] },
      draftRequest: { ...state.draftRequest, [hostKey]: undefined },
    }));
  },
}));
