/**
 * cyboflow.ompCommand sub-router — the privileged OMP command surface.
 *
 * Every mutation is gated on `hasSupervise(ctx.principal)` (an immutable
 * capability, NOT merely `ctx.userId === 'local'`) and is audited twice —
 * ATTEMPTED before delegation, COMPLETED after — with input/result redacted.
 *
 * Audit is FAIL-CLOSED: every attempt with an audit sink present records a
 * terminal outcome, including `forbidden` and thrown adapter failures. A
 * missing audit sink is refused (a privileged mutation without an audit trail
 * is never allowed). A single operationId is minted per request, threaded into
 * the adapter request, echoed in the result, and recorded in both audit rows —
 * so audit trail, adapter result, and idempotency key all correlate.
 *
 * In Phase 2 the injected `OmpCommandAdapter` is a stub that fails closed with
 * `unavailable`, so no real command can run even though the router, its
 * authorization, and its audit trail are all live and tested.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { hasSupervise, OMP_SUPERVISE_CAPABILITY } from '../../../../../shared/types/ompCommand';
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpPrincipal,
  OmpSpawnRequest,
  OmpVerifyRequest,
} from '../../../../../shared/types/ompCommand';

/** Audit entry shape — narrow and string-only, trivially redactable and serializable. */
export interface OmpAuditEntry {
  verb: string;
  principal: string;
  outcome: 'attempted' | 'completed';
  operationId: string;
  /** Redacted detail: never raw task text, scope paths, or proof blobs. */
  detail: string;
}

type OmpAuditSink = (entry: OmpAuditEntry) => void;

/** Redact command input to a stable, non-sensitive summary (field keys only). */
function redactInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'object') {
    return Object.keys(input as Record<string, unknown>).join(',');
  }
  return String(input);
}

interface OmpCommandCtx {
  principal?: OmpPrincipal;
  ompCommand?: OmpCommandAdapter;
  auditOmp?: OmpAuditSink;
}

const scopeSchema = z
  .object({
    repo: z
      .object({
        path: z.string(),
        access: z.enum(['none', 'read', 'overlay_write', 'host_write']),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .optional(),
    shell: z.object({ allowed: z.boolean(), commands: z.array(z.string()).optional() }).optional(),
    network: z.object({ allowed: z.boolean(), domains: z.array(z.string()).optional() }).optional(),
    secrets: z.object({ allowed: z.boolean(), names: z.array(z.string()).optional() }).optional(),
  })
  .optional();

/**
 * Authorize, audit, and dispatch one command. Mints a single operationId,
 * threads it into the request, records both audit rows with it, and returns the
 * adapter result (which must echo it). An unauthorized attempt with an audit
 * sink still records attempted + forbidden completed before failing closed.
 */
async function runGuarded<TInput extends { idempotencyKey?: string }, TReq>(
  ctx: OmpCommandCtx,
  verb: string,
  input: TInput,
  buildReq: (input: TInput, operationId: string) => TReq,
  invoke: (adapter: OmpCommandAdapter, req: TReq) => Promise<OmpCommandResult>,
): Promise<OmpCommandResult> {
  // A privileged mutation without an audit trail is refused, not allowed.
  if (!ctx.auditOmp) {
    return {
      ok: false,
      operationId: 'n/a',
      error: 'unavailable',
      detail: 'OMP audit sink not configured',
    };
  }

  // One correlation token: the client-supplied idempotency key, else minted.
  const operationId = input.idempotencyKey ?? randomUUID();
  const principal = ctx.principal?.userId ?? 'unknown';
  ctx.auditOmp({ verb, principal, outcome: 'attempted', operationId, detail: redactInput(input) });

  if (!hasSupervise(ctx.principal)) {
    ctx.auditOmp({ verb, principal, outcome: 'completed', operationId, detail: 'forbidden' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `missing capability ${OMP_SUPERVISE_CAPABILITY}`,
    });
  }

  let result: OmpCommandResult;
  if (!ctx.ompCommand) {
    result = {
      ok: false,
      operationId,
      error: 'unavailable',
      detail: 'OMP command adapter not configured',
    };
  } else {
    try {
      result = await invoke(ctx.ompCommand, buildReq(input, operationId));
    } catch (error) {
      result = {
        ok: false,
        operationId,
        error: 'unavailable',
        detail: error instanceof Error ? error.message : 'OMP command failed',
      };
    }
  }

  ctx.auditOmp({
    verb,
    principal,
    outcome: 'completed',
    operationId,
    detail: result.ok ? 'ok' : result.error,
  });
  return result;
}

// Bounded, log-safe token: UUID/ULID/snowflake-shaped. Rejects whitespace and
// control characters so a caller cannot inject newlines into the audit trail.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const idempotency = z.object({ idempotencyKey: z.string().max(128).regex(IDEMPOTENCY_KEY_PATTERN).optional() });

const spawnInput = idempotency.extend({
  model: z.string(),
  task: z.string(),
  label: z.string().optional(),
  target: z.string().optional(),
  workspace: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  executionMode: z.enum(['auto', 'subprocess', 'shepherd']).optional(),
  intent: z.enum(['read_only', 'mutating', 'high_stakes_mutating', 'external_side_effect']).optional(),
  scope: scopeSchema,
});

type SpawnInput = z.infer<typeof spawnInput>;
const killInput = idempotency.extend({ workerId: z.string(), timeoutMs: z.number().optional() });
const proposalInput = idempotency.extend({ proposalId: z.string(), reason: z.string() });
const verifyInput = idempotency.extend({ proposalId: z.string() });
type KillInput = z.infer<typeof killInput>;
type ProposalInput = z.infer<typeof proposalInput>;
type VerifyInput = z.infer<typeof verifyInput>;

function toSpawnReq(input: SpawnInput, operationId: string): OmpSpawnRequest {
  return { ...input, operationId };
}
function toKillReq(input: KillInput, operationId: string): OmpKillRequest {
  return { ...input, operationId };
}
function toApplyReq(input: ProposalInput, operationId: string): OmpApplyRequest {
  return { ...input, operationId };
}
function toDiscardReq(input: ProposalInput, operationId: string): OmpDiscardRequest {
  return { ...input, operationId };
}
function toVerifyReq(input: VerifyInput, operationId: string): OmpVerifyRequest {
  return { ...input, operationId };
}

export const ompCommandRouter = router({
  spawn: protectedProcedure
    .input(spawnInput)
    .mutation(({ ctx, input }) => runGuarded(ctx, 'spawn', input, toSpawnReq, (a, req) => a.spawn(req))),
  kill: protectedProcedure
    .input(killInput)
    .mutation(({ ctx, input }) => runGuarded(ctx, 'kill', input, toKillReq, (a, req) => a.kill(req))),
  applyProposal: protectedProcedure
    .input(proposalInput)
    .mutation(({ ctx, input }) => runGuarded(ctx, 'apply', input, toApplyReq, (a, req) => a.apply(req))),
  discard: protectedProcedure
    .input(proposalInput)
    .mutation(({ ctx, input }) => runGuarded(ctx, 'discard', input, toDiscardReq, (a, req) => a.discard(req))),
  verifyRun: protectedProcedure
    .input(verifyInput)
    .mutation(({ ctx, input }) => runGuarded(ctx, 'verifyRun', input, toVerifyReq, (a, req) => a.verifyRun(req))),
});
