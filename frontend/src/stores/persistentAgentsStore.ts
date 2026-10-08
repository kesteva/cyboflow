/**
 * persistentAgentsStore: renderer state for Agents & Environments.
 *
 * Events are SIGNALS: every handler re-queries and never patches state from the payload (same posture as the
 * tracker settings section). Subscriptions are opened BEFORE the seed query on every (re)open, so a change
 * that lands between "subscribe" and "seed resolves" is never lost (docs/CODE-PATTERNS.md race policy), and
 * every query carries a sequence number so a slow response cannot overwrite a newer one.
 *
 * Gate: everything is inert unless `featureStatus.running` (dev build + config flag, kill switch not set).
 * `init()` is called once from App; Settings only READS `featureStatus`.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { errorText } from '../utils/errorText';
import { parseTimestamp } from '../utils/timestampUtils';
import { openResilientSubscription } from './agentThreadStore';
import { useConfigStore } from './configStore';
import { useNavigationStore } from './navigationStore';
import {
  DISABLED_PERSISTENT_AGENTS_STATUS,
  type ControlVerb,
} from '../../../shared/types/persistentAgents';
import type {
  AgentViewT,
  AgentsChangedEvent,
  AgentsFeatureStatus,
  ConnectInputT,
  ConnectResult,
  ConnectionInputT,
  ConnectorViewT,
  ControlResult,
  DisconnectResult,
  OkResultT,
  PairingPayloadT,
  RepairPairingResult,
  SendResult,
  SwitchResult,
  ThreadEvent,
  ThreadMessage,
  VerifyResult,
} from '../components/agentsEnv/types';

export const THREAD_PAGE_SIZE = 100;
export const SIGNAL_DEBOUNCE_MS = 150;
const MARK_READ_DEBOUNCE_MS = 300;

/** Renderer-local failure for a THROWN mutation (IPC error, router bug); never produced by the server. */
export type LocalFailure = { ok: false; error: 'unknown'; message: string };

export interface ThreadState {
  /** Oldest to newest, unique by id. */
  messages: ThreadMessage[];
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error';
  loadingEarlier: boolean;
  error: string | null;
}

export interface PersistentAgentsState {
  featureStatus: AgentsFeatureStatus | null;
  connectors: ConnectorViewT[] | null;
  agents: AgentViewT[];
  agentsStatus: 'idle' | 'loading' | 'ready' | 'error';
  agentsError: string | null;
  threads: Record<string, ThreadState>;

  /** Idempotent; returns the teardown. Called once from App. */
  init: () => () => void;
  refreshFeatureStatus: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  /** NOT cached: the view carries live availability. Returns the previous list (or []) on error. */
  loadConnectors: () => Promise<ConnectorViewT[]>;
  /** Ref-counted: the first opener subscribes and seeds; returns an idempotent release fn. */
  openThread: (agentId: string) => () => void;
  loadEarlier: (agentId: string) => Promise<void>;
  send: (agentId: string, text: string) => Promise<SendResult | LocalFailure>;
  /** Optimistically zeroes unreadCount, then calls markRead (debounced 300 ms per agent). */
  markRead: (agentId: string) => void;
  connect: (input: ConnectInputT) => Promise<ConnectResult | LocalFailure>;
  switchConnection: (agentId: string, input: ConnectionInputT) => Promise<SwitchResult | LocalFailure>;
  cancelSwitch: (agentId: string) => Promise<OkResultT | LocalFailure>;
  archiveAgent: (agentId: string) => Promise<OkResultT | LocalFailure>;
  /** Resume mode: the cached pairing payload for a connection, or null. Never throws. */
  getPairing: (connectionId: string) => Promise<PairingPayloadT | null>;
  repairPairing: (connectionId: string) => Promise<RepairPairingResult | LocalFailure>;
  verify: (connectionId: string) => Promise<VerifyResult | LocalFailure>;
  disconnect: (agentId: string) => Promise<DisconnectResult | LocalFailure>;
  control: (agentId: string, verb: ControlVerb) => Promise<ControlResult | LocalFailure>;
}

/** Union by id (incoming wins), sorted by (createdAt, then id). Pure. */
export function mergeThreadMessages(
  existing: readonly ThreadMessage[],
  incoming: readonly ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => {
    const d = parseTimestamp(a.createdAt).getTime() - parseTimestamp(b.createdAt).getTime();
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function localFailure(e: unknown, fallback: string): LocalFailure {
  return { ok: false, error: 'unknown', message: errorText(e) ?? fallback };
}

interface ThreadRuntime {
  refs: number;
  sub: { close: () => void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  seq: number;
}

export const usePersistentAgentsStore = create<PersistentAgentsState>((set, get) => {
  let initialized = false;
  let tornDown = true;
  let cachedTeardown: (() => void) | null = null;
  let configUnsub: (() => void) | null = null;
  let agentsSub: { close: () => void } | null = null;
  let agentsTimer: ReturnType<typeof setTimeout> | null = null;
  let sawAvailabilitySignal = false;
  let statusSeq = 0;
  let agentsSeq = 0;
  let connectorsSeq = 0;
  const threadRt = new Map<string, ThreadRuntime>();
  const markReadTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const rt = (agentId: string): ThreadRuntime => {
    let r = threadRt.get(agentId);
    if (!r) {
      r = { refs: 0, sub: null, timer: null, seq: 0 };
      threadRt.set(agentId, r);
    }
    return r;
  };

  const closeThread = (agentId: string): void => {
    const r = threadRt.get(agentId);
    if (!r) return;
    r.sub?.close();
    r.sub = null;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = null;
  };

  const closeAllThreads = (): void => {
    for (const id of [...threadRt.keys()]) closeThread(id);
    threadRt.clear();
  };

  const closeAgentsSub = (): void => {
    agentsSub?.close();
    agentsSub = null;
    if (agentsTimer !== null) clearTimeout(agentsTimer);
    agentsTimer = null;
  };

  const scheduleAgentsRefresh = (): void => {
    if (agentsTimer !== null) clearTimeout(agentsTimer);
    agentsTimer = setTimeout(() => {
      agentsTimer = null;
      void get().refreshAgents();
      if (sawAvailabilitySignal) {
        sawAvailabilitySignal = false;
        void get().loadConnectors();
      }
    }, SIGNAL_DEBOUNCE_MS);
  };

  const refetchLatest = async (agentId: string): Promise<void> => {
    const r = threadRt.get(agentId);
    if (!r || r.refs === 0) return;
    const mySeq = ++r.seq;
    try {
      const page = await trpc.cyboflow.persistentAgents.getThread.query({ agentId, limit: THREAD_PAGE_SIZE });
      const live = threadRt.get(agentId);
      if (tornDown || !live || live.refs === 0 || live.seq !== mySeq) return;
      const prev = get().threads[agentId];
      const held = prev?.messages ?? [];
      let messages: ThreadMessage[];
      let hasMore: boolean;
      const oldestIncoming = page.messages[0];
      const newestHeld = held[held.length - 1];
      if (held.length === 0) {
        messages = page.messages;
        hasMore = page.hasMore;
      } else if (
        page.hasMore &&
        oldestIncoming !== undefined &&
        newestHeld !== undefined &&
        parseTimestamp(oldestIncoming.createdAt).getTime() > parseTimestamp(newestHeld.createdAt).getTime()
      ) {
        // More than a page arrived since the last refetch: the cache has a hole; start over from this page.
        messages = page.messages;
        hasMore = true;
      } else {
        messages = mergeThreadMessages(held, page.messages);
        hasMore = prev?.hasMore ?? page.hasMore;
      }
      set((s) => ({
        threads: {
          ...s.threads,
          [agentId]: { messages, hasMore, status: 'ready', loadingEarlier: false, error: null },
        },
      }));
    } catch (e) {
      const live = threadRt.get(agentId);
      if (tornDown || !live || live.refs === 0 || live.seq !== mySeq) return;
      set((s) => {
        const prev = s.threads[agentId];
        return {
          threads: {
            ...s.threads,
            [agentId]: {
              messages: prev?.messages ?? [],
              hasMore: prev?.hasMore ?? false,
              loadingEarlier: false,
              status: prev !== undefined && prev.messages.length > 0 ? 'ready' : 'error',
              error: errorText(e) ?? 'Could not load this thread.',
            },
          },
        };
      });
    }
  };

  const scheduleThreadRefresh = (agentId: string): void => {
    const r = threadRt.get(agentId);
    if (!r) return;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      void refetchLatest(agentId);
    }, SIGNAL_DEBOUNCE_MS);
  };

  const openAgentsSub = (): void => {
    if (agentsSub !== null) return;
    agentsSub = openResilientSubscription<AgentsChangedEvent>(
      'persistentAgents.onAgentsChanged',
      (h) => {
        const sub = trpc.cyboflow.persistentAgents.onAgentsChanged.subscribe(undefined, h);
        void get().refreshAgents();
        return sub;
      },
      {
        onData: (ev) => {
          if (ev.kind === 'connection' && ev.agentId === null) sawAvailabilitySignal = true;
          scheduleAgentsRefresh();
        },
      },
    );
  };

  /** Run a mutation; on ok refresh the agent list; a throw becomes a LocalFailure. */
  const mutate = async <T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string,
  ): Promise<T | LocalFailure> => {
    try {
      const res = await call();
      if (res.ok) void get().refreshAgents();
      else if ((res as { error?: string }).error === 'not_found') void get().refreshAgents();
      return res;
    } catch (e) {
      return localFailure(e, fallback);
    }
  };

  return {
    featureStatus: null,
    connectors: null,
    agents: [],
    agentsStatus: 'idle',
    agentsError: null,
    threads: {},

    init: () => {
      if (initialized && cachedTeardown) return cachedTeardown;
      initialized = true;
      tornDown = false;
      configUnsub = useConfigStore.subscribe((s, p) => {
        if (s.config !== p.config) void get().refreshFeatureStatus();
      });
      void get().refreshFeatureStatus();
      const teardown = (): void => {
        tornDown = true;
        closeAgentsSub();
        closeAllThreads();
        configUnsub?.();
        configUnsub = null;
        for (const t of markReadTimers.values()) clearTimeout(t);
        markReadTimers.clear();
        initialized = false;
        cachedTeardown = null;
      };
      cachedTeardown = teardown;
      return teardown;
    },

    refreshFeatureStatus: async () => {
      const mySeq = ++statusSeq;
      let status: AgentsFeatureStatus;
      try {
        status = await trpc.cyboflow.persistentAgents.status.query();
      } catch {
        status = DISABLED_PERSISTENT_AGENTS_STATUS;
      }
      if (tornDown || mySeq !== statusSeq) return;
      set({ featureStatus: status });
      if (status.running) {
        if (agentsSub === null) openAgentsSub();
      } else if (agentsSub !== null || get().agents.length > 0 || Object.keys(get().threads).length > 0) {
        closeAgentsSub();
        closeAllThreads();
        set({ agents: [], threads: {}, agentsStatus: 'idle', agentsError: null, connectors: null });
      }
    },

    refreshAgents: async () => {
      const mySeq = ++agentsSeq;
      if (get().agentsStatus === 'idle') set({ agentsStatus: 'loading' });
      try {
        const agents = await trpc.cyboflow.persistentAgents.listAgents.query();
        if (tornDown || mySeq !== agentsSeq) return;
        set({ agents, agentsStatus: 'ready', agentsError: null });
      } catch (e) {
        if (tornDown || mySeq !== agentsSeq) return;
        set((s) => ({
          agentsStatus: s.agents.length > 0 ? 'ready' : 'error',
          agentsError: errorText(e) ?? 'Could not load agents.',
        }));
      }
    },

    loadConnectors: async () => {
      const mySeq = ++connectorsSeq;
      try {
        const connectors = await trpc.cyboflow.persistentAgents.listConnectors.query();
        if (tornDown || mySeq !== connectorsSeq) return connectors;
        set({ connectors });
        return connectors;
      } catch {
        return get().connectors ?? [];
      }
    },

    openThread: (agentId) => {
      const r = rt(agentId);
      r.refs++;
      if (r.refs === 1) {
        if (get().threads[agentId] === undefined) {
          set((s) => ({
            threads: {
              ...s.threads,
              [agentId]: { messages: [], hasMore: false, status: 'loading', loadingEarlier: false, error: null },
            },
          }));
        }
        r.sub = openResilientSubscription<ThreadEvent>(
          `persistentAgents.onThreadEvent:${agentId}`,
          (h) => {
            const sub = trpc.cyboflow.persistentAgents.onThreadEvent.subscribe({ agentId }, h);
            void refetchLatest(agentId);
            return sub;
          },
          { onData: () => scheduleThreadRefresh(agentId) },
        );
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = threadRt.get(agentId);
        if (!cur) return;
        cur.refs = Math.max(0, cur.refs - 1);
        if (cur.refs === 0) closeThread(agentId);
      };
    },

    loadEarlier: async (agentId) => {
      const t = get().threads[agentId];
      if (!t || !t.hasMore || t.loadingEarlier || t.messages.length === 0) return;
      const before = t.messages[0].id;
      set((s) => ({ threads: { ...s.threads, [agentId]: { ...t, loadingEarlier: true } } }));
      try {
        const page = await trpc.cyboflow.persistentAgents.getThread.query({
          agentId,
          before,
          limit: THREAD_PAGE_SIZE,
        });
        if (tornDown) return;
        set((s) => {
          const cur = s.threads[agentId] ?? t;
          return {
            threads: {
              ...s.threads,
              [agentId]: {
                ...cur,
                messages: mergeThreadMessages(cur.messages, page.messages),
                hasMore: page.hasMore,
                loadingEarlier: false,
              },
            },
          };
        });
      } catch (e) {
        if (tornDown) return;
        set((s) => {
          const cur = s.threads[agentId] ?? t;
          return {
            threads: {
              ...s.threads,
              [agentId]: { ...cur, loadingEarlier: false, error: errorText(e) ?? 'Could not load earlier messages.' },
            },
          };
        });
      }
    },

    send: async (agentId, text) => {
      try {
        const res = await trpc.cyboflow.persistentAgents.send.mutate({ agentId, text });
        if (res.ok) void refetchLatest(agentId);
        else if (res.error === 'not_found') void get().refreshAgents();
        return res;
      } catch (e) {
        return localFailure(e, "Couldn't send. Try again.");
      }
    },

    markRead: (agentId) => {
      set((s) => ({ agents: s.agents.map((a) => (a.id === agentId ? { ...a, unreadCount: 0 } : a)) }));
      const prev = markReadTimers.get(agentId);
      if (prev !== undefined) clearTimeout(prev);
      markReadTimers.set(
        agentId,
        setTimeout(() => {
          markReadTimers.delete(agentId);
          void trpc.cyboflow.persistentAgents.markRead.mutate({ agentId }).catch(() => {
            void get().refreshAgents();
          });
        }, MARK_READ_DEBOUNCE_MS),
      );
    },

    connect: (input) =>
      mutate(() => trpc.cyboflow.persistentAgents.connect.mutate(input), 'Something went wrong. Try again.'),

    switchConnection: (agentId, input) =>
      mutate(
        () => trpc.cyboflow.persistentAgents.switchConnection.mutate({ agentId, connection: input }),
        'Something went wrong. Try again.',
      ),

    cancelSwitch: (agentId) =>
      mutate(() => trpc.cyboflow.persistentAgents.cancelSwitch.mutate({ agentId }), 'Something went wrong. Try again.'),

    archiveAgent: (agentId) =>
      mutate(() => trpc.cyboflow.persistentAgents.archiveAgent.mutate({ agentId }), 'Something went wrong. Try again.'),

    getPairing: async (connectionId) => {
      try {
        return await trpc.cyboflow.persistentAgents.getPairing.query({ connectionId });
      } catch {
        return null;
      }
    },

    repairPairing: (connectionId) =>
      mutate(
        () => trpc.cyboflow.persistentAgents.repairPairing.mutate({ connectionId }),
        'Something went wrong. Try again.',
      ),

    verify: (connectionId) =>
      mutate(() => trpc.cyboflow.persistentAgents.verify.mutate({ connectionId }), 'Something went wrong. Try again.'),

    disconnect: (agentId) =>
      mutate(() => trpc.cyboflow.persistentAgents.disconnect.mutate({ agentId }), 'Something went wrong. Try again.'),

    control: (agentId, verb) =>
      mutate(
        () => trpc.cyboflow.persistentAgents.control.mutate({ agentId, verb }),
        'Something went wrong. Try again.',
      ),
  };
});

/**
 * Whether Agents & Environments is running (dev build + config.agents.enabled, kill switch not set): the gate for
 * the nav item, the rail section and the pane. Also closes a pane that is still open when the gate drops, so a
 * stale pane never lingers after the kill switch or the config toggle turns the feature off.
 */
export function useAgentsEnvAvailable(): boolean {
  const available = usePersistentAgentsStore((s) => s.featureStatus?.running === true);
  useEffect(() => {
    if (!available && useNavigationStore.getState().agentsEnvOpen) {
      useNavigationStore.getState().closeAgentsEnv();
    }
  }, [available]);
  return available;
}
