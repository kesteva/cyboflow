/**
 * cloudAccountStore: renderer view of the shared "cyboflow cloud" sign-in for this computer.
 *
 * The single store behind the Settings cloud card and the Connect dialog / thread banner prompts.
 * `init()` is ref-counted: every consumer calls it on mount and runs the returned teardown on unmount; the
 * first call opens the subscription, the last teardown closes it. The seed query is issued from inside the
 * subscription factory so it re-runs on every (re)open (subscribe first, then seed; an event that lands
 * during the seed wins over the seed: docs/CODE-PATTERNS.md race policy).
 *
 * Main never sends a token, account id, device id or the sign-in URL (the browser is opened and re-opened
 * in main), so none of them can be held here.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import { errorText } from '../utils/errorText';
import { openResilientSubscription } from './agentThreadStore';
import type { CloudChangedEventT, CloudStatusT } from '../components/agentsEnv/types';
import type {
  CloudDeviceSummary,
  CloudLastError,
  CloudSignOutResult,
} from '../../../shared/types/cloudAccountWire';

export type CloudPending =
  | null
  | 'signIn'
  | 'cancel'
  | 'signOut'
  | 'refresh'
  | 'openDevices'
  | 'unlock'
  | 'reopen';

export interface CloudAccountStoreState {
  status: CloudStatusT | null;
  devices: CloudDeviceSummary[] | null;
  devicesError: CloudLastError | null;
  devicesLoading: boolean;
  pending: CloudPending;
  /** Message of the last rejected mutation (preconditions throw; expected HTTP failures are status values). */
  actionError: string | null;
  /** Result of the last signOut(); memory only, cleared by signIn(). */
  lastSignOut: CloudSignOutResult | null;

  /** Ref-counted; returns this caller's teardown. */
  init: () => () => void;
  signIn: (deviceName?: string) => Promise<void>;
  cancelSignIn: () => Promise<void>;
  /** Resolves false when main could not open the browser. */
  reopenSignInPage: () => Promise<boolean>;
  signOut: () => Promise<void>;
  clearSignOutNotice: () => void;
  refresh: (force: boolean) => Promise<void>;
  /** A Try again / Unlock button passes true; an implicit unlock (mount, auto-unlock) passes false. */
  unlock: (explicitRetry: boolean) => Promise<CloudStatusT | null>;
  /** unlock(true), then refresh(false) when that left the account usable. */
  retryUnlock: () => Promise<void>;
  loadDevices: () => Promise<void>;
  openDevicesPage: () => Promise<void>;
}

export type CloudDisplay = Extract<CloudStatusT, { available: true }>['display'];

/** Whether the Bridge may be used right now: signed in, account fetched, and entitled. */
export function hasBridgeEntitlement(s: CloudStatusT | null): boolean {
  return (
    s?.available === true &&
    s.account !== null &&
    s.account.lastOkAt !== null &&
    s.account.bridgeEntitled === true &&
    (s.display === 'signed_in' || s.display === 'needs_update')
  );
}

let refCount = 0;
let sub: { close: () => void } | null = null;
let eventSeq = 0;
let statusSeq = 0;
let devicesSeq = 0;

export const useCloudAccountStore = create<CloudAccountStoreState>((set, get) => {
  const usable = (s: CloudStatusT | null): boolean =>
    s?.available === true && (s.display === 'signed_in' || s.display === 'needs_update');

  const seed = async (): Promise<void> => {
    const seqAtStart = eventSeq;
    const mySeq = ++statusSeq;
    let seeded: CloudStatusT;
    try {
      seeded = (await trpc.cyboflow.cloud.status.query()) ?? { available: false };
    } catch {
      seeded = { available: false };
    }
    if (refCount === 0 || mySeq !== statusSeq) return;
    if (eventSeq === seqAtStart) set({ status: seeded });
    const current = get().status;
    if (current?.available === true && current.display === 'locked') {
      void get().unlock(false);
    } else if (usable(current)) {
      void get().refresh(false);
    }
  };

  const openSubscription = (): { close: () => void } =>
    openResilientSubscription<CloudChangedEventT>(
      'cloud.onCloudChanged',
      (h) => {
        const s = trpc.cyboflow.cloud.onCloudChanged.subscribe(undefined, h);
        void seed();
        return s;
      },
      {
        onData: (ev) => {
          eventSeq++;
          set({ status: ev.status });
          if (ev.kind === 'signedOut' || ev.kind === 'revoked') set({ devices: null });
        },
      },
    );

  return {
    status: null,
    devices: null,
    devicesError: null,
    devicesLoading: false,
    pending: null,
    actionError: null,
    lastSignOut: null,

    init: () => {
      refCount++;
      if (refCount === 1) sub = openSubscription();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        refCount = Math.max(0, refCount - 1);
        if (refCount === 0 && sub !== null) {
          sub.close();
          sub = null;
        }
      };
    },

    signIn: async (deviceName) => {
      set({ pending: 'signIn', actionError: null, lastSignOut: null });
      try {
        await trpc.cyboflow.cloud.signIn.mutate(deviceName ? { deviceName } : undefined);
      } catch (e) {
        set({ actionError: errorText(e) ?? 'Sign-in could not start. Try again.' });
        try {
          set({ status: await trpc.cyboflow.cloud.status.query() });
        } catch {
          /* keep the previous status */
        }
      } finally {
        set({ pending: null });
      }
    },

    cancelSignIn: async () => {
      set({ pending: 'cancel', actionError: null });
      try {
        await trpc.cyboflow.cloud.cancelSignIn.mutate();
      } catch (e) {
        set({ actionError: errorText(e) ?? 'Could not cancel the sign-in.' });
      } finally {
        set({ pending: null });
      }
    },

    reopenSignInPage: async () => {
      set({ pending: 'reopen', actionError: null });
      try {
        const res = await trpc.cyboflow.cloud.reopenSignInPage.mutate();
        return res.opened;
      } catch (e) {
        set({ actionError: errorText(e) ?? "cyboflow couldn't open your browser." });
        return false;
      } finally {
        set({ pending: null });
      }
    },

    signOut: async () => {
      set({ pending: 'signOut', actionError: null });
      try {
        const res = await trpc.cyboflow.cloud.signOut.mutate();
        set({ lastSignOut: res, devices: null });
      } catch (e) {
        set({ actionError: errorText(e) ?? 'Could not sign out. Try again.' });
      } finally {
        set({ pending: null });
      }
    },

    clearSignOutNotice: () => set({ lastSignOut: null }),

    refresh: async (force) => {
      set({ pending: 'refresh', actionError: null });
      try {
        const status = await trpc.cyboflow.cloud.refreshAccount.mutate({ force });
        // An absent answer (a stubbed or half-wired router) must not wipe a known status.
        if (status) {
          eventSeq++;
          set({ status });
        }
      } catch (e) {
        set({ actionError: errorText(e) ?? "Couldn't check your account. Try again." });
      } finally {
        set({ pending: null });
      }
    },

    unlock: async (explicitRetry) => {
      set({ pending: 'unlock', actionError: null });
      try {
        const status = await trpc.cyboflow.cloud.unlock.mutate({ explicitRetry });
        if (!status) return null;
        eventSeq++;
        set({ status });
        return status;
      } catch (e) {
        set({ actionError: errorText(e) ?? "Couldn't unlock the saved sign-in." });
        return null;
      } finally {
        set({ pending: null });
      }
    },

    retryUnlock: async () => {
      const status = await get().unlock(true);
      if (usable(status)) await get().refresh(false);
    },

    loadDevices: async () => {
      const mySeq = ++devicesSeq;
      set({ devicesLoading: true });
      try {
        const res = await trpc.cyboflow.cloud.listDevices.query();
        if (mySeq !== devicesSeq) return;
        if (res.ok) set({ devices: res.devices, devicesError: null });
        else set({ devicesError: res.error });
      } catch (e) {
        if (mySeq === devicesSeq) set({ actionError: errorText(e) ?? "Couldn't load your devices." });
      } finally {
        if (mySeq === devicesSeq) set({ devicesLoading: false });
      }
    },

    openDevicesPage: async () => {
      set({ pending: 'openDevices', actionError: null });
      try {
        await trpc.cyboflow.cloud.openDevicesPage.mutate();
      } catch (e) {
        set({ actionError: errorText(e) ?? "Couldn't open the Devices page." });
      } finally {
        set({ pending: null });
      }
    },
  };
});
