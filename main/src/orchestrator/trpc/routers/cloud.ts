/**
 * cyboflow.cloud sub-router — the shared "cyboflow cloud" sign-in for this computer.
 *
 *   status            : query        -> CloudStatus              (unset facade -> {available:false})
 *   signIn            : mutation     -> CloudSignInStart         ({expiresAt} only; the login URL stays in main)
 *   cancelSignIn      : mutation     -> { cancelled }
 *   reopenSignInPage  : mutation     -> { opened }               (unset facade -> {opened:false})
 *   signOut           : mutation     -> CloudSignOutResult
 *   refreshAccount    : mutation     -> CloudStatus
 *   listDevices       : query        -> CloudListDevicesResult
 *   openDevicesPage   : mutation     -> { opened: true }
 *   unlock            : mutation     -> CloudStatus              (unset facade -> {available:false})
 *   onCloudChanged    : subscription -> CloudChangedEvent
 *
 * Preconditions THROW (mapped by error name below); expected HTTP failures are VALUES (status.lastError,
 * status.lastSignInFailure, CloudListDevicesResult.ok === false) and never throw through tRPC.
 *
 * No token, account id, device id, PKCE value, `state` or login URL ever crosses this boundary.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3' or main/src/services/*;
 * service error classes are recognised BY NAME.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import {
  CLOUD_CHANGED_CHANNEL,
  cloudAccountEvents,
  getCloudAccountFacade,
  type CloudAccountFacade,
} from '../../cloudAccountBridge';
import { CLOUD_ERROR_NAMES } from '../../../../../shared/types/cloudAccountWire';
import type {
  CloudChangedEvent,
  CloudListDevicesResult,
  CloudSignInStart,
  CloudSignOutResult,
  CloudStatus,
} from '../../../../../shared/types/cloudAccountWire';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const deviceNameSchema = z.string().trim().min(1).max(100)
  .refine((s) => !CONTROL_CHARS_RE.test(s), 'Device name contains control characters');

function isErrorNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/**
 *   CloudNotAvailableError      -> PRECONDITION_FAILED
 *   CloudAlreadySignedInError   -> CONFLICT
 *   CloudSignInInProgressError  -> CONFLICT
 *   CloudNotSignedInError       -> PRECONDITION_FAILED
 *   CloudSignInStartError       -> INTERNAL_SERVER_ERROR (verbatim; its code reaches the renderer via
 *                                  status.lastSignInFailure)
 * Anything else re-throws unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (isErrorNamed(err, CLOUD_ERROR_NAMES.notAvailable)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Turn on Agents & Environments to use cyboflow cloud.',
      cause: err,
    });
  }
  if (isErrorNamed(err, CLOUD_ERROR_NAMES.alreadySignedIn)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This computer is already signed in. Sign out first.', cause: err });
  }
  if (isErrorNamed(err, CLOUD_ERROR_NAMES.signInInProgress)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'A sign-in is already in progress.', cause: err });
  }
  if (isErrorNamed(err, CLOUD_ERROR_NAMES.notSignedIn)) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This computer is not signed in.', cause: err });
  }
  if (isErrorNamed(err, CLOUD_ERROR_NAMES.signInStart)) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err instanceof Error ? err.message : 'Sign-in could not start.',
      cause: err,
    });
  }
  throw err;
}

function requireFacade(): CloudAccountFacade {
  const f = getCloudAccountFacade();
  if (!f) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'cyboflow cloud is not available in this build' });
  }
  return f;
}

async function call<T>(fn: (f: CloudAccountFacade) => Promise<T>): Promise<T> {
  const f = requireFacade();
  try {
    return await fn(f);
  } catch (err) {
    rethrowAsTRPCError(err);
  }
}

function callSync<T>(fn: (f: CloudAccountFacade) => T): T {
  const f = requireFacade();
  try {
    return fn(f);
  } catch (err) {
    rethrowAsTRPCError(err);
  }
}

export const cloudRouter = router({
  status: protectedProcedure.query((): CloudStatus => getCloudAccountFacade()?.getStatus() ?? { available: false }),

  signIn: protectedProcedure
    .input(z.object({ deviceName: deviceNameSchema.optional() }).strict().optional())
    .mutation(({ input }): Promise<CloudSignInStart> =>
      call((f) => f.startSignIn({ deviceName: input?.deviceName }))),

  cancelSignIn: protectedProcedure.mutation((): { cancelled: boolean } => callSync((f) => f.cancelSignIn())),

  reopenSignInPage: protectedProcedure.mutation(async (): Promise<{ opened: boolean }> => {
    if (!getCloudAccountFacade()) return { opened: false };
    return call((f) => f.reopenSignInPage());
  }),

  signOut: protectedProcedure.mutation((): Promise<CloudSignOutResult> => call((f) => f.signOut())),

  refreshAccount: protectedProcedure
    .input(z.object({ force: z.boolean().default(false) }).strict().optional())
    .mutation(({ input }): Promise<CloudStatus> =>
      call((f) => f.refreshAccount({ force: input?.force ?? false }))),

  listDevices: protectedProcedure.query((): Promise<CloudListDevicesResult> => call((f) => f.listDevices())),

  openDevicesPage: protectedProcedure.mutation(async (): Promise<{ opened: true }> => {
    await call((f) => f.openDevicesPage());
    return { opened: true };
  }),

  unlock: protectedProcedure
    .input(z.object({ explicitRetry: z.boolean().default(false) }).strict().optional())
    .mutation(({ input }): CloudStatus => {
      if (!getCloudAccountFacade()) return { available: false };
      return callSync((f) => f.unlock({ explicitRetry: input?.explicitRetry ?? false }));
    }),

  onCloudChanged: protectedProcedure.subscription(async function* ({ signal }): AsyncGenerator<CloudChangedEvent> {
    const abortSignal = signal ?? new AbortController().signal;
    const source = eventToAsyncIterable<CloudChangedEvent>(cloudAccountEvents, CLOUD_CHANGED_CHANNEL, abortSignal);
    for await (const ev of source) {
      yield ev;
    }
  }),
});
