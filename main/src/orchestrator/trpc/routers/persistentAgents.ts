/**
 * cyboflow.persistentAgents sub-router — Agents & Environments (persistent vendor agents).
 *
 *   status                : query        -> PersistentAgentsStatus (never throws; all false when unset)
 *   listConnectors        : query        -> ConnectorView[]          (unset -> [])
 *   listAgents            : query        -> AgentView[]              (unset -> [])
 *   getThread             : query        -> ThreadPage
 *   send                  : mutation     -> SendResult
 *   connect               : mutation     -> ConnectMutationResult    (may carry the one-time pairing secret)
 *   verify                : mutation     -> VerifyResult
 *   switchConnection      : mutation     -> ConnectMutationResult    (may carry the one-time pairing secret)
 *   cancelSwitch          : mutation     -> OkResult
 *   disconnect            : mutation     -> DisconnectResult
 *   archiveAgent          : mutation     -> OkResult
 *   control               : mutation     -> OkResult
 *   markRead              : mutation     -> { unread }               (throws a mapped TRPCError)
 *   listCredentials       : query        -> CredentialView[]         (unset -> [])
 *   addCredential         : mutation     -> CredentialMutationResult
 *   rotateCredential      : mutation     -> CredentialMutationResult
 *   forgetCredential      : mutation     -> ForgetCredentialResult   ('in_use' + referencedBy unless detach)
 *   getActivity           : query        -> ActivityView[]
 *   getUsage              : query        -> UsageView
 *   repairPairing         : mutation     -> RepairPairingResult      (may carry the one-time pairing secret)
 *   getPairing            : query        -> PairingPayload | null    (token/brief always null; unset -> null)
 *   onAgentsChanged       : subscription -> PersistentAgentsChangedEvent
 *   onThreadEvent         : subscription -> PersistentAgentThreadEvent
 *
 * Every procedure is a thin wrapper over the PersistentAgentsFacade wired at boot. Mutations return result
 * unions ({ok:true,…} | PersistentAgentsFailure): the service throws NAMED errors and this file converts
 * them by `err.name` + structural fields (toPersistentAgentsFailure). An unrecognised error is rethrown and
 * surfaces as INTERNAL_SERVER_ERROR. Queries (and markRead) throw mapped TRPCErrors instead.
 *
 * SECRETS: renderer -> main secrets are CredentialChoice.secret, addCredential.secret and
 * rotateCredential.secret; they stop at the service. The only main -> renderer secret is the one-time pair
 * on BridgePairingPayload (oneTimeToken, instructionBrief), returned by connect / switchConnection /
 * repairPairing only.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3' or main/src/services/*. The
 * service-side error classes are recognised BY NAME for that reason.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import {
  peekPersistentAgentsFacade,
  persistentAgentEvents,
  persistentAgentThreadChannel,
  PERSISTENT_AGENTS_CHANNEL,
  type PersistentAgentsFacade,
} from '../../persistentAgentsBridge';
import {
  CONNECTOR_AVAILABILITY_STATES,
  CONNECTOR_ERROR_KINDS,
  CONTROL_VERBS,
  DISABLED_PERSISTENT_AGENTS_STATUS,
  isOneOf,
  PERSISTENT_AGENT_HANDLE_RE,
  PERSISTENT_AGENT_LINK_RE,
  PERSISTENT_AGENT_MAX_DISPLAY_NAME,
  PERSISTENT_AGENT_MAX_LINK_LENGTH,
  PERSISTENT_AGENT_MAX_LINKS,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  PERSISTENT_AGENT_VENDORS,
  PERSISTENT_AGENTS_ERROR_NAMES as N,
  VENDOR_CREDENTIAL_VENDORS,
} from '../../../../../shared/types/persistentAgents';
import type {
  ActivityView,
  AgentView,
  ConnectMutationResult,
  ConnectorAvailabilityState,
  ConnectorErrorKind,
  ConnectorView,
  CredentialMutationResult,
  CredentialView,
  DisconnectResult,
  ForgetCredentialResult,
  OkResult,
  PairingPayload,
  PersistentAgentsChangedEvent,
  PersistentAgentsErrorCode,
  PersistentAgentsFailure,
  PersistentAgentsResult,
  PersistentAgentsStatus,
  PersistentAgentThreadEvent,
  RepairPairingResult,
  SendResult,
  ThreadPage,
  UsageView,
  VerifyResult,
} from '../../../../../shared/types/persistentAgents';

// ---------------------------------------------------------------------------
// Zod pieces
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const noControlChars = (s: string): boolean => !CONTROL_CHARS_RE.test(s);

const id = z.string().min(1).max(128);
const vendor = z.enum(PERSISTENT_AGENT_VENDORS);
const link = z.string().max(PERSISTENT_AGENT_MAX_LINK_LENGTH).regex(PERSISTENT_AGENT_LINK_RE);
const secret = z.string().trim().min(8).max(4096);
const newAgent = z.object({
  displayName: z.string().trim().min(1).max(PERSISTENT_AGENT_MAX_DISPLAY_NAME)
    .refine(noControlChars, 'Name contains control characters'),
  vendor,
  handle: z.string().regex(PERSISTENT_AGENT_HANDLE_RE).optional(),
  githubLogin: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(),
}).strict();
const credentialChoice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), credentialId: id }).strict(),
  z.object({ mode: z.literal('new'), label: z.string().trim().min(1).max(80), secret }).strict(),
]);
const connectionInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bridge'),
    connectorId: z.literal('bridge'),
    transport: z.enum(['relay-mcp', 'relay-http']),
    label: z.string().trim().min(1).max(100).refine(noControlChars).optional(),
  }).strict(),
  z.object({
    kind: z.literal('native'),
    connectorId: id,
    credential: credentialChoice,
    remote: z.object({
      remoteAgentId: id.optional(),
      templateId: id.optional(),
      remoteEnvironmentId: id.optional(),
    }).strict(),
  }).strict(),
]);

// ---------------------------------------------------------------------------
// Error conversion
// ---------------------------------------------------------------------------

function errName(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function errMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return fallback;
}

function field<T>(err: unknown, key: string): T | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as Record<string, unknown>)[key] as T | undefined;
}

const AVAILABILITY_TO_CODE: Record<Exclude<ConnectorAvailabilityState, 'ok'>, PersistentAgentsErrorCode> = {
  signed_out: 'not_signed_in',
  locked: 'cloud_locked',
  device_revoked: 'device_revoked',
  needs_update: 'upgrade_required',
  not_entitled: 'not_entitled',
  other_account: 'other_account',
  disabled: 'connector_disabled',
  unavailable: 'service_unavailable',
};

const PAUSED_CODE_TO_CODE: Record<string, PersistentAgentsErrorCode> = {
  signed_out: 'not_signed_in',
  locked: 'cloud_locked',
  needs_sign_in: 'device_revoked',
  needs_update: 'upgrade_required',
  not_entitled: 'not_entitled',
  other_account: 'other_account',
  disabled: 'connector_disabled',
};

const FAILURE_FIELDS = ['displayName', 'handle', 'label', 'secret', 'text'] as const;

function connectorErrorCode(kind: ConnectorErrorKind, code: string | null): PersistentAgentsErrorCode {
  switch (kind) {
    case 'auth': return 'auth_rejected';
    case 'device_auth': return 'device_revoked';
    case 'paused':
      return (code !== null && Object.prototype.hasOwnProperty.call(PAUSED_CODE_TO_CODE, code))
        ? PAUSED_CODE_TO_CODE[code]
        : 'connector_unavailable';
    case 'not_entitled': return 'not_entitled';
    case 'upgrade_required': return 'upgrade_required';
    case 'rate_limited': return 'rate_limited';
    case 'retryable': return 'service_unavailable';
    case 'not_found':
    case 'revoked': return 'connection_gone';
    case 'invalid': return code === 'message_too_large' ? 'too_large' : 'invalid_input';
    case 'conflict': return code === 'connection_limit' ? 'connection_limit' : 'conflict';
    case 'permanent': return 'unknown';
  }
}

/**
 * Convert a thrown service error into the mutation failure union, by `err.name` and structural fields only
 * (this file may not import the error classes). Returns null for anything unrecognised: the caller rethrows.
 * Messages are safe by contract — fixed strings plus server error codes, never bodies, tokens or URLs.
 */
export function toPersistentAgentsFailure(err: unknown): PersistentAgentsFailure | null {
  const name = errName(err);
  if (name === null) return null;
  const fail = (error: PersistentAgentsErrorCode, message: string): PersistentAgentsFailure =>
    ({ ok: false, error, message });

  switch (name) {
    case N.notInitialized:
    case N.disabled:
      return fail('feature_disabled', 'Agents & Environments is turned off.');
    case N.agentNotFound:
    case N.connectionNotFound:
    case N.credentialNotFound:
      return fail('not_found', errMessage(err, 'Not found.'));
    case N.connectorNotRegistered:
      return fail('connector_unavailable', "This connector isn't available in this build.");
    case N.connectorUnavailable: {
      const availability = field<unknown>(err, 'availability');
      const state = typeof availability === 'object' && availability !== null
        ? (availability as { state?: unknown }).state
        : undefined;
      if (!isOneOf(CONNECTOR_AVAILABILITY_STATES, state) || state === 'ok') {
        return fail('connector_unavailable', errMessage(err, "This connector isn't available right now."));
      }
      const a = availability as { message?: unknown; retryAt?: unknown };
      const message = typeof a.message === 'string' ? a.message : errMessage(err, "This connector isn't available right now.");
      const retryAt = typeof a.retryAt === 'string' ? a.retryAt : null;
      return { ...fail(AVAILABILITY_TO_CODE[state], message), retryAt };
    }
    case N.controlNotSupported:
      return fail('control_not_supported', errMessage(err, "This agent doesn't support that control."));
    case N.agentNotSendable: {
      const reason = field<unknown>(err, 'reason');
      const code: PersistentAgentsErrorCode = reason === 'archived' ? 'agent_archived'
        : reason === 'revoked' ? 'connection_revoked'
        : 'no_connection';
      return fail(code, errMessage(err, "This agent can't receive messages."));
    }
    case N.swapInProgress:
      return fail('swap_in_progress', errMessage(err, 'A reconnect is already in progress.'));
    case N.noSwapInProgress:
      return fail('no_swap_in_progress', errMessage(err, 'There is no reconnect to cancel.'));
    case N.invalidInput: {
      const reason = field<unknown>(err, 'reason');
      const f = field<unknown>(err, 'field');
      const failure = fail(reason === 'too_large' ? 'too_large' : 'invalid_input', errMessage(err, 'Invalid input.'));
      return isOneOf(FAILURE_FIELDS, f) ? { ...failure, field: f } : failure;
    }
    case N.handleTaken:
      return { ...fail('handle_taken', 'Another agent already uses this handle.'), field: 'handle' };
    case N.pairingNotSupported:
      return fail('pairing_not_supported', errMessage(err, "This connection doesn't use pairing."));
    case N.secretsUnavailable:
      return fail('secrets_unavailable', "This computer's keychain isn't available; nothing was saved.");
    case N.credentialUndecryptable:
      return fail('credential_undecryptable', "The stored key can't be read on this computer. Re-enter it.");
    case N.connector: {
      const kind = field<unknown>(err, 'kind');
      if (!isOneOf(CONNECTOR_ERROR_KINDS, kind)) return null;
      const rawCode = field<unknown>(err, 'code');
      const code = typeof rawCode === 'string' ? rawCode : null;
      const retryAfterMs = field<unknown>(err, 'retryAfterMs');
      const retryAt = typeof retryAfterMs === 'number' && retryAfterMs > 0
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : null;
      return { ...fail(connectorErrorCode(kind, code), errMessage(err, 'The connector failed.')), retryAt };
    }
    default:
      return null;
  }
}

const NOT_FOUND_NAMES: readonly string[] = [N.agentNotFound, N.connectionNotFound, N.credentialNotFound];
const PRECONDITION_NAMES: readonly string[] = [N.notInitialized, N.disabled];

/** Queries and markRead: not-found -> NOT_FOUND, disabled/not-initialized -> PRECONDITION_FAILED, else rethrow. */
function rethrowAsTRPCError(err: unknown): never {
  const name = errName(err);
  if (name !== null && NOT_FOUND_NAMES.includes(name)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: errMessage(err, 'Not found.'), cause: err });
  }
  if (name !== null && PRECONDITION_NAMES.includes(name)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: errMessage(err, 'Agents & Environments is turned off.'),
      cause: err,
    });
  }
  throw err;
}

const NOT_RUNNING: PersistentAgentsFailure = {
  ok: false,
  error: 'feature_disabled',
  message: 'Agents & Environments is not running.',
};

/** Mutation template: unset facade -> feature_disabled; known errors -> failure; unknown -> rethrow. */
async function run<T extends object>(
  fn: (f: PersistentAgentsFacade) => Promise<T>,
): Promise<PersistentAgentsResult<T>> {
  const f = peekPersistentAgentsFacade();
  if (!f) return { ...NOT_RUNNING };
  try {
    return { ok: true as const, ...(await fn(f)) };
  } catch (err) {
    const failure = toPersistentAgentsFailure(err);
    if (failure) return failure;
    throw err; // unexpected: surfaces as INTERNAL_SERVER_ERROR; the renderer shows 'unknown'
  }
}

/** Query template: the facade (or a mapped PRECONDITION_FAILED), errors mapped by name. */
function query<T>(fn: (f: PersistentAgentsFacade) => T): T {
  const f = peekPersistentAgentsFacade();
  if (!f) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Agents & Environments is not running.' });
  }
  try {
    return fn(f);
  } catch (err) {
    rethrowAsTRPCError(err);
  }
}

const EMPTY: Record<never, never> = {};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const persistentAgentsRouter = router({
  status: protectedProcedure.query((): PersistentAgentsStatus => {
    const f = peekPersistentAgentsFacade();
    if (!f) return { ...DISABLED_PERSISTENT_AGENTS_STATUS };
    try {
      return f.status();
    } catch {
      return { ...DISABLED_PERSISTENT_AGENTS_STATUS };
    }
  }),

  listConnectors: protectedProcedure.query((): ConnectorView[] => {
    const f = peekPersistentAgentsFacade();
    if (!f) return [];
    try {
      return f.listConnectors();
    } catch (err) {
      rethrowAsTRPCError(err);
    }
  }),

  listAgents: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).strict().optional())
    .query(({ input }): AgentView[] => {
      const f = peekPersistentAgentsFacade();
      if (!f) return [];
      try {
        return f.listAgents({ includeArchived: input?.includeArchived ?? false });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  getThread: protectedProcedure
    .input(z.object({
      agentId: id,
      before: id.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).strict())
    .query(({ input }): ThreadPage => query((f) => f.getThread(input))),

  send: protectedProcedure
    .input(z.object({
      agentId: id,
      text: z.string().min(1).max(PERSISTENT_AGENT_MAX_MESSAGE_BYTES),
      links: z.array(link).max(PERSISTENT_AGENT_MAX_LINKS).optional(),
    }).strict())
    .mutation(({ input }): Promise<SendResult> => run((f) => f.send(input))),

  connect: protectedProcedure
    .input(z.object({ agent: newAgent, connection: connectionInput }).strict())
    .mutation(({ input }): Promise<ConnectMutationResult> => run((f) => f.connect(input))),

  verify: protectedProcedure
    .input(z.object({ connectionId: id }).strict())
    .mutation(({ input }): Promise<VerifyResult> => run((f) => f.verify(input))),

  switchConnection: protectedProcedure
    .input(z.object({ agentId: id, connection: connectionInput }).strict())
    .mutation(({ input }): Promise<ConnectMutationResult> => run((f) => f.switchConnection(input))),

  cancelSwitch: protectedProcedure
    .input(z.object({ agentId: id }).strict())
    .mutation(({ input }): Promise<OkResult> => run(async (f) => {
      await f.cancelSwitch(input);
      return EMPTY;
    })),

  disconnect: protectedProcedure
    .input(z.object({ agentId: id }).strict())
    .mutation(({ input }): Promise<DisconnectResult> => run((f) => f.disconnect(input))),

  archiveAgent: protectedProcedure
    .input(z.object({ agentId: id }).strict())
    .mutation(({ input }): Promise<OkResult> => run(async (f) => {
      await f.archiveAgent(input);
      return EMPTY;
    })),

  control: protectedProcedure
    .input(z.object({ agentId: id, verb: z.enum(CONTROL_VERBS) }).strict())
    .mutation(({ input }): Promise<OkResult> => run(async (f) => {
      await f.control(input);
      return EMPTY;
    })),

  markRead: protectedProcedure
    .input(z.object({ agentId: id, upTo: id.optional() }).strict())
    .mutation(async ({ input }): Promise<{ unread: number }> => {
      const f = peekPersistentAgentsFacade();
      if (!f) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Agents & Environments is not running.' });
      }
      try {
        return await f.markRead(input);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  listCredentials: protectedProcedure.query((): CredentialView[] => {
    const f = peekPersistentAgentsFacade();
    if (!f) return [];
    try {
      return f.listCredentials();
    } catch (err) {
      rethrowAsTRPCError(err);
    }
  }),

  addCredential: protectedProcedure
    .input(z.object({
      vendor: z.enum(VENDOR_CREDENTIAL_VENDORS),
      label: z.string().trim().min(1).max(80),
      secret,
    }).strict())
    .mutation(({ input }): Promise<CredentialMutationResult> =>
      run(async (f) => ({ credential: await f.addCredential(input) }))),

  rotateCredential: protectedProcedure
    .input(z.object({ id, secret }).strict())
    .mutation(({ input }): Promise<CredentialMutationResult> =>
      run(async (f) => ({ credential: await f.rotateCredential(input) }))),

  forgetCredential: protectedProcedure
    .input(z.object({ id, detach: z.boolean().default(false) }).strict())
    .mutation(async ({ input }): Promise<ForgetCredentialResult> => {
      const f = peekPersistentAgentsFacade();
      if (!f) return { ...NOT_RUNNING };
      try {
        const outcome = await f.forgetCredential(input);
        if (outcome.forgotten) return { ok: true };
        return { ok: false, error: 'in_use', message: 'This key is in use.', referencedBy: outcome.referencedBy };
      } catch (err) {
        const failure = toPersistentAgentsFailure(err);
        if (failure) return failure;
        throw err;
      }
    }),

  getActivity: protectedProcedure
    .input(z.object({
      agentId: id,
      scope: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(200).default(100),
    }).strict())
    .query(({ input }): ActivityView[] => query((f) => f.getActivity(input))),

  getUsage: protectedProcedure
    .input(z.object({ agentId: id }).strict())
    .query(({ input }): UsageView => query((f) => f.getUsage(input))),

  repairPairing: protectedProcedure
    .input(z.object({ connectionId: id }).strict())
    .mutation(({ input }): Promise<RepairPairingResult> =>
      run(async (f) => ({ pairing: await f.repairPairing(input) }))),

  getPairing: protectedProcedure
    .input(z.object({ connectionId: id }).strict())
    .query(({ input }): PairingPayload | null => {
      const f = peekPersistentAgentsFacade();
      if (!f) return null;
      try {
        return f.getPairing(input);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Agent-list / connection / unread / credentials / status changes. Notifications only: the renderer
   * re-queries. Does not need the facade (the emitter is module-level), so it works before boot wiring.
   */
  onAgentsChanged: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<PersistentAgentsChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<PersistentAgentsChangedEvent>(
        persistentAgentEvents,
        PERSISTENT_AGENTS_CHANNEL,
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),

  /** One agent's thread changes (messages, receipts, read, activity, usage, connection). */
  onThreadEvent: protectedProcedure
    .input(z.object({ agentId: id }).strict())
    .subscription(async function* ({ input, signal }): AsyncGenerator<PersistentAgentThreadEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<PersistentAgentThreadEvent>(
        persistentAgentEvents,
        persistentAgentThreadChannel(input.agentId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
