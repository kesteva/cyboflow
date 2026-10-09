/**
 * cyboflow.hosts sub-router — Environments ("This Mac" + SSH machines).
 *
 *   status             : query        -> HostsFeatureStatus (never throws; all false when unset)
 *   list               : query        -> HostView[]         (unset -> [])
 *   get                : query        -> HostView           (throws a mapped TRPCError)
 *   add                : mutation     -> HostsResult<{ id }>
 *   update             : mutation     -> HostsResult<{}>
 *   setUserCap         : mutation     -> HostsResult<{}>    (cap: 'cli' | null)
 *   runPreflight       : mutation     -> HostsResult<{ result: PreflightResult }>
 *   archive            : mutation     -> HostsResult<{}>
 *   setProjectDefault  : mutation     -> HostsResult<{}>
 *   terminalOpen       : mutation     -> HostsResult<{ terminalId }>
 *   terminalInput      : mutation     -> HostsResult<{}>    (high frequency: thin)
 *   terminalResize     : mutation     -> HostsResult<{}>    (high frequency: thin)
 *   terminalBacklog    : query        -> HostsResult<{ backlog, exited, exitCode }>
 *   terminalClose      : mutation     -> HostsResult<{}>
 *   onHostsChanged     : subscription -> HostsChangedEvent
 *   onPreflightProgress: subscription -> PreflightProgressEvent
 *
 * Every procedure is a thin wrapper over the HostsFacade wired at boot. The service throws NAMED errors and
 * this file converts them by `err.name` (HOSTS_ERROR_NAMES); an unrecognised error is rethrown and surfaces
 * as INTERNAL_SERVER_ERROR. A facade that is unset or not `running` answers `feature_disabled`.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3' or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import {
  hostEvents,
  hostPreflightChannel,
  HOSTS_CHANNEL,
  peekHostsFacade,
  type HostsFacade,
} from '../../hostsBridge';
import {
  DISABLED_HOSTS_STATUS,
  HOST_LABEL_MAX,
  HOSTS_ERROR_NAMES as N,
  SSH_TARGET_RE,
} from '../../../../../shared/types/hosts';
import type {
  HostsChangedEvent,
  HostsFailureCode,
  HostsFeatureStatus,
  HostsResult,
  HostView,
  PreflightProgressEvent,
} from '../../../../../shared/types/hosts';

// ---------------------------------------------------------------------------
// Zod pieces
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const noControlChars = (s: string): boolean => !CONTROL_CHARS_RE.test(s);

const TERMINAL_TEXT_MAX = 64 * 1024;
const TERMINAL_DIM_MAX = 1000;

const id = z.string().min(1).max(128);
const label = z.string().trim().min(1).max(HOST_LABEL_MAX).refine(noControlChars, 'Name contains control characters');
const sshTarget = z.string().regex(SSH_TARGET_RE);
const dim = z.number().int().positive().max(TERMINAL_DIM_MAX);

// ---------------------------------------------------------------------------
// Error conversion
// ---------------------------------------------------------------------------

const NAME_TO_CODE: Readonly<Record<string, HostsFailureCode>> = {
  [N.notFound]: 'not_found',
  [N.labelTaken]: 'label_taken',
  [N.invalidTarget]: 'invalid_target',
  [N.invalidLabel]: 'invalid_label',
  [N.capAboveDetected]: 'cap_above_detected',
  [N.localImmutable]: 'local_immutable',
  [N.hasActiveWork]: 'has_active_work',
  [N.killed]: 'remote_hosts_disabled',
  [N.disabled]: 'feature_disabled',
  [N.terminalUnavailable]: 'terminal_unavailable',
};

function errName(err: unknown): string | null {
  return err instanceof Error ? err.name : null;
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Convert a thrown service error into the failure union, by `err.name`. null for anything unrecognised. */
export function toHostsFailure(err: unknown): { ok: false; error: HostsFailureCode; message: string } | null {
  const name = errName(err);
  if (name === null || !Object.prototype.hasOwnProperty.call(NAME_TO_CODE, name)) return null;
  return { ok: false, error: NAME_TO_CODE[name], message: errMessage(err, 'Something went wrong.') };
}

const NOT_RUNNING = {
  ok: false,
  error: 'feature_disabled',
  message: 'Environments is not running.',
} as const;

/** The facade when wired AND running; otherwise null (the caller answers feature_disabled). */
function liveFacade(): HostsFacade | null {
  const f = peekHostsFacade();
  return f && f.status().running ? f : null;
}

/** Mutation template: not running -> feature_disabled; known errors -> failure; unknown -> rethrow. */
async function run<T extends object>(fn: (f: HostsFacade) => Promise<T> | T): Promise<HostsResult<T>> {
  const f = liveFacade();
  if (!f) return { ...NOT_RUNNING };
  try {
    return { ok: true as const, ...(await fn(f)) };
  } catch (err) {
    const failure = toHostsFailure(err);
    if (failure) return failure;
    throw err; // unexpected: surfaces as INTERNAL_SERVER_ERROR
  }
}

/** `get`: not-found -> NOT_FOUND, disabled/unset -> PRECONDITION_FAILED, else rethrow. */
function rethrowAsTRPCError(err: unknown): never {
  const name = errName(err);
  if (name === N.notFound) {
    throw new TRPCError({ code: 'NOT_FOUND', message: errMessage(err, 'Environment not found.'), cause: err });
  }
  if (name === N.disabled || name === N.killed) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: errMessage(err, 'Environments is turned off.'), cause: err });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const hostsRouter = router({
  /** Never throws: an unset facade reads as all-false. */
  status: protectedProcedure.query((): HostsFeatureStatus => {
    const f = peekHostsFacade();
    return f ? f.status() : { ...DISABLED_HOSTS_STATUS };
  }),

  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).strict().optional())
    .query(({ input }): HostView[] => {
      const f = peekHostsFacade();
      return f ? f.list({ includeArchived: input?.includeArchived ?? false }) : [];
    }),

  get: protectedProcedure
    .input(z.object({ id }).strict())
    .query(({ input }): HostView => {
      const f = peekHostsFacade();
      if (!f) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Environments is not running.' });
      try {
        return f.get(input.id);
      } catch (err) {
        return rethrowAsTRPCError(err);
      }
    }),

  add: protectedProcedure
    .input(z.object({ label, sshTarget }).strict())
    .mutation(({ input }) => run((f) => f.addSsh(input))),

  update: protectedProcedure
    .input(z.object({ id, label: label.optional(), sshTarget: sshTarget.optional() }).strict())
    .mutation(({ input }) => run(async (f) => {
      const { id: hostId, ...patch } = input;
      await f.update(hostId, patch);
      return {};
    })),

  setUserCap: protectedProcedure
    .input(z.object({ id, cap: z.enum(['cli']).nullable() }).strict())
    .mutation(({ input }) => run(async (f) => {
      await f.setUserCap(input.id, input.cap);
      return {};
    })),

  runPreflight: protectedProcedure
    .input(z.object({ id }).strict())
    .mutation(({ input }) => run(async (f) => ({ result: await f.runPreflight(input.id) }))),

  archive: protectedProcedure
    .input(z.object({ id }).strict())
    .mutation(({ input }) => run(async (f) => {
      await f.archive(input.id);
      return {};
    })),

  setProjectDefault: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive(), hostId: id.nullable() }).strict())
    .mutation(({ input }) => run(async (f) => {
      await f.setProjectDefault(input.projectId, input.hostId);
      return {};
    })),

  terminalOpen: protectedProcedure
    .input(z.object({ hostId: id }).strict())
    .mutation(({ input }) => run((f) => f.terminalOpen(input.hostId))),

  terminalInput: protectedProcedure
    .input(z.object({ terminalId: id, text: z.string().max(TERMINAL_TEXT_MAX) }).strict())
    .mutation(({ input }) => run((f) => {
      f.terminalInput(input.terminalId, input.text);
      return {};
    })),

  terminalResize: protectedProcedure
    .input(z.object({ terminalId: id, cols: dim, rows: dim }).strict())
    .mutation(({ input }) => run((f) => {
      f.terminalResize(input.terminalId, input.cols, input.rows);
      return {};
    })),

  terminalBacklog: protectedProcedure
    .input(z.object({ terminalId: id }).strict())
    .query(({ input }) => run((f) => f.terminalBacklog(input.terminalId))),

  terminalClose: protectedProcedure
    .input(z.object({ terminalId: id }).strict())
    .mutation(({ input }) => run((f) => {
      f.terminalClose(input.terminalId);
      return {};
    })),

  /** Any host change (rows, lifecycle, preflight running) or feature-status change. */
  onHostsChanged: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<HostsChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<HostsChangedEvent>(hostEvents, HOSTS_CHANNEL, abortSignal);
      for await (const ev of source) {
        yield ev;
      }
    }),

  /** One host's preflight: a frame per decided check, then done:true. */
  onPreflightProgress: protectedProcedure
    .input(z.object({ id }).strict())
    .subscription(async function* ({ input, signal }): AsyncGenerator<PreflightProgressEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<PreflightProgressEvent>(
        hostEvents,
        hostPreflightChannel(input.id),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
