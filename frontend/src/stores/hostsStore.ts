/**
 * hostsStore: renderer state for Environments ("This Mac" + SSH machines).
 *
 * Same posture as persistentAgentsStore: events are SIGNALS (every handler re-queries, never patches from the
 * payload), subscriptions open BEFORE the seed query on every (re)open, and every query carries a sequence
 * number so a slow response cannot overwrite a newer one. Inert unless `featureStatus.running`.
 * `init()` is called once from App; Settings only reads the status.
 *
 * Preflight progress is the one exception to "signals only": `onPreflightProgress` frames carry the decided
 * check, which is shown live (`preflightLive`) until the run finishes and the persisted result is re-queried.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { errorText } from '../utils/errorText';
import { openResilientSubscription } from './agentThreadStore';
import { useConfigStore } from './configStore';
import {
  DISABLED_HOSTS_STATUS,
  type HostsFeatureStatus,
  type HostsResult,
  type HostView,
  type PreflightCheckResult,
  type PreflightResult,
  type PreflightProgressEvent,
  type HostsChangedEvent,
} from '../../../shared/types/hosts';

export const HOSTS_SIGNAL_DEBOUNCE_MS = 150;

/** Renderer-local failure for a THROWN mutation (IPC error, router bug); never produced by the server. */
export type HostsLocalFailure = { ok: false; error: 'unknown'; message: string };

export interface HostsState {
  featureStatus: HostsFeatureStatus | null;
  hosts: HostView[];
  hostsStatus: 'idle' | 'loading' | 'ready' | 'error';
  hostsError: string | null;
  /** Checks decided so far for a preflight that is running right now, by host id. */
  preflightLive: Record<string, PreflightCheckResult[]>;

  /** Idempotent; returns the teardown. Called once from App. */
  init: () => () => void;
  refreshFeatureStatus: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  /** Ref-counted: the first watcher subscribes; returns an idempotent release fn. */
  watchPreflight: (hostId: string) => () => void;
  add: (input: { label: string; sshTarget: string }) => Promise<HostsResult<{ id: string }> | HostsLocalFailure>;
  update: (
    id: string,
    patch: { label?: string; sshTarget?: string },
  ) => Promise<HostsResult<object> | HostsLocalFailure>;
  setUserCap: (id: string, cap: 'cli' | null) => Promise<HostsResult<object> | HostsLocalFailure>;
  runPreflight: (id: string) => Promise<HostsResult<{ result: PreflightResult }> | HostsLocalFailure>;
  archive: (id: string) => Promise<HostsResult<object> | HostsLocalFailure>;
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
}

function localFailure(e: unknown, fallback: string): HostsLocalFailure {
  return { ok: false, error: 'unknown', message: errorText(e) ?? fallback };
}

interface PreflightRuntime {
  refs: number;
  sub: { close: () => void } | null;
}

export const useHostsStore = create<HostsState>((set, get) => {
  let initialized = false;
  let tornDown = true;
  let cachedTeardown: (() => void) | null = null;
  let configUnsub: (() => void) | null = null;
  let hostsSub: { close: () => void } | null = null;
  let hostsTimer: ReturnType<typeof setTimeout> | null = null;
  let statusSeq = 0;
  let hostsSeq = 0;
  const preflightRt = new Map<string, PreflightRuntime>();

  const closeHostsSub = (): void => {
    hostsSub?.close();
    hostsSub = null;
    if (hostsTimer !== null) clearTimeout(hostsTimer);
    hostsTimer = null;
  };

  const closePreflightSubs = (): void => {
    for (const r of preflightRt.values()) {
      r.sub?.close();
      r.sub = null;
    }
  };

  const scheduleHostsRefresh = (): void => {
    if (hostsTimer !== null) return;
    hostsTimer = setTimeout(() => {
      hostsTimer = null;
      void get().refreshHosts();
    }, HOSTS_SIGNAL_DEBOUNCE_MS);
  };

  const openHostsSub = (): void => {
    if (hostsSub !== null) return;
    hostsSub = openResilientSubscription<HostsChangedEvent>(
      'hosts.onHostsChanged',
      (h) => {
        const sub = trpc.cyboflow.hosts.onHostsChanged.subscribe(undefined, h);
        void get().refreshHosts();
        return sub;
      },
      {
        onData: (ev) => {
          if (ev.kind === 'status') void get().refreshFeatureStatus();
          scheduleHostsRefresh();
        },
      },
    );
  };

  const onProgress = (hostId: string, ev: PreflightProgressEvent): void => {
    if (ev.check !== null) {
      const check = ev.check;
      set((s) => {
        const prev = s.preflightLive[hostId] ?? [];
        const next = prev.some((c) => c.id === check.id)
          ? prev.map((c) => (c.id === check.id ? check : c))
          : [...prev, check];
        return { preflightLive: { ...s.preflightLive, [hostId]: next } };
      });
    }
    if (ev.done) {
      set((s) => ({ preflightLive: withoutKey(s.preflightLive, hostId) }));
      scheduleHostsRefresh();
    }
  };

  const openPreflightSub = (hostId: string, r: PreflightRuntime): void => {
    r.sub = openResilientSubscription<PreflightProgressEvent>(
      `hosts.onPreflightProgress:${hostId}`,
      (h) => {
        // A (re)opened stream starts clean: frames missed while closed would leave stale partial rows that
        // merge into the next run.
        set((s) => ({ preflightLive: withoutKey(s.preflightLive, hostId) }));
        return trpc.cyboflow.hosts.onPreflightProgress.subscribe({ id: hostId }, h);
      },
      { onData: (ev) => onProgress(hostId, ev) },
    );
  };

  /** Run a mutation; on any server answer re-list (state may have moved); a throw becomes a local failure. */
  const mutate = async <T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string,
  ): Promise<T | HostsLocalFailure> => {
    try {
      const res = await call();
      void get().refreshHosts();
      return res;
    } catch (e) {
      return localFailure(e, fallback);
    }
  };

  return {
    featureStatus: null,
    hosts: [],
    hostsStatus: 'idle',
    hostsError: null,
    preflightLive: {},

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
        closeHostsSub();
        closePreflightSubs();
        preflightRt.clear();
        configUnsub?.();
        configUnsub = null;
        initialized = false;
        cachedTeardown = null;
      };
      cachedTeardown = teardown;
      return teardown;
    },

    refreshFeatureStatus: async () => {
      const mySeq = ++statusSeq;
      let status: HostsFeatureStatus;
      try {
        status = await trpc.cyboflow.hosts.status.query();
      } catch {
        status = DISABLED_HOSTS_STATUS;
      }
      if (tornDown || mySeq !== statusSeq) return;
      set({ featureStatus: status });
      if (status.running) {
        if (hostsSub === null) openHostsSub();
        for (const [hostId, r] of preflightRt) {
          if (r.refs > 0 && r.sub === null) openPreflightSub(hostId, r);
        }
      } else if (hostsSub !== null || get().hosts.length > 0) {
        closeHostsSub();
        closePreflightSubs();
        set({ hosts: [], hostsStatus: 'idle', hostsError: null, preflightLive: {} });
      }
    },

    refreshHosts: async () => {
      const mySeq = ++hostsSeq;
      if (get().hostsStatus === 'idle') set({ hostsStatus: 'loading' });
      try {
        const hosts = await trpc.cyboflow.hosts.list.query();
        if (tornDown || mySeq !== hostsSeq) return;
        set({ hosts, hostsStatus: 'ready', hostsError: null });
      } catch (e) {
        if (tornDown || mySeq !== hostsSeq) return;
        set((s) => ({
          hostsStatus: s.hosts.length > 0 ? 'ready' : 'error',
          hostsError: errorText(e) ?? 'Could not load environments.',
        }));
      }
    },

    watchPreflight: (hostId) => {
      let r = preflightRt.get(hostId);
      if (!r) {
        r = { refs: 0, sub: null };
        preflightRt.set(hostId, r);
      }
      r.refs++;
      if (r.refs === 1 && !tornDown && get().featureStatus?.running === true) openPreflightSub(hostId, r);
      const rt = r;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rt.refs--;
        if (rt.refs <= 0) {
          rt.sub?.close();
          rt.sub = null;
          preflightRt.delete(hostId);
          // Nobody is watching: drop the partial rows so they cannot merge into a later run.
          set((s) => ({ preflightLive: withoutKey(s.preflightLive, hostId) }));
        }
      };
    },

    add: (input) => mutate(() => trpc.cyboflow.hosts.add.mutate(input), 'Could not add the environment.'),
    update: (id, patch) =>
      mutate(() => trpc.cyboflow.hosts.update.mutate({ id, ...patch }), 'Could not save the environment.'),
    setUserCap: (id, cap) =>
      mutate(() => trpc.cyboflow.hosts.setUserCap.mutate({ id, cap }), 'Could not change the limit.'),
    runPreflight: (id) => {
      set((s) => ({ preflightLive: withoutKey(s.preflightLive, id) }));
      return mutate(() => trpc.cyboflow.hosts.runPreflight.mutate({ id }), 'Could not run the check.');
    },
    archive: (id) =>
      mutate(() => trpc.cyboflow.hosts.archive.mutate({ id }), 'Could not remove the environment.'),
  };
});

/** The host row for an id (null/undefined and unknown ids give undefined). Used by run/session markers. */
export function useHostLookup(hostId: string | null | undefined): HostView | undefined {
  const hosts = useHostsStore((s) => s.hosts);
  return useMemo(
    () => (hostId ? hosts.find((h) => h.id === hostId) : undefined),
    [hosts, hostId],
  );
}
