/**
 * OMP command contract — the privileged, supervisor-only surface that Cyboflow
 * declares but does NOT implement in the first pass (a stub ships; real
 * commands are a separate ADR with its own go/no-go).
 *
 * Authority is encoded as types, not comments:
 * - `OmpControlPlaneAdapter.authority: 'read'` (shared/types/omp.ts) — read-only.
 * - `OmpCommandAdapter.authority: 'supervise'` (below) — privileged commands.
 * Workers never receive the supervise surface.
 *
 * The producer's ACTUAL tool surface this mirrors (verified):
 * - lifecycle: fleet_spawn / fleet_kill (plus list/state/read/wait, which stay
 *   on the read side)
 * - proposal: fleet_proposal_apply / fleet_proposal_discard
 * - verification: fleet_verification_candidate/run/status/proof (candidate-bound)
 * There is no `fleet_verify`/`fleet_apply` tool; verify is `fleet_verification_*`,
 * apply is `fleet_proposal_apply`. Callers pass only `proposalId` (+ `reason`
 * for apply/discard); the producer resolves and binds the candidate digest/proof.
 *
 * ## Correlation + idempotency
 *
 * Every request carries a required `operationId`, minted by the router (or set
 * to the client-supplied idempotency key). The adapter MUST echo it verbatim in
 * `OmpCommandResult.operationId`, so the audit trail and the returned result
 * correlate on ONE token. The same token is the idempotency handle: the Phase-3
 * real adapter dedupes and cancel-by-id on it.
 */

import type { ExecutionIntent, WorkerScope } from './omp';

/** Immutable per-request principal. In v1 it is hardcoded `'local'`; v2 populates it from a session token. */
export interface OmpPrincipal {
  readonly userId: string;
  readonly capabilities: ReadonlySet<string>;
}

/** The capability a principal must hold to reach any OMP command. */
export const OMP_SUPERVISE_CAPABILITY = 'omp:supervise' as const;

export function hasSupervise(principal: OmpPrincipal | undefined): boolean {
  return principal?.capabilities.has(OMP_SUPERVISE_CAPABILITY) === true;
}

/** Producer execution_mode, carried verbatim. */
export type OmpExecutionMode = 'auto' | 'subprocess' | 'shepherd';

export interface OmpSpawnRequest {
  /** Correlation/idempotency token — echoed verbatim in the result. */
  operationId: string;
  model: string;
  task: string;
  label?: string;
  /** Pane to split from (producer `target`). */
  target?: string;
  workspace?: string;
  cwd?: string;
  /** Bounded duration; the producer aborts on expiry. Cancel-by-id rides the operationId. */
  timeoutMs?: number;
  executionMode?: OmpExecutionMode;
  intent?: ExecutionIntent;
  scope?: WorkerScope;
}

export interface OmpKillRequest {
  operationId: string;
  workerId: string;
  timeoutMs?: number;
}

/** Producer `fleet_read` `source`, carried verbatim. */
export type OmpReadSource = 'visible' | 'recent' | 'recent-unwrapped' | 'detection';

export interface OmpReadRequest {
  operationId: string;
  workerId: string;
  lines?: number;
  source?: OmpReadSource;
}

export interface OmpSendRequest {
  operationId: string;
  workerId: string;
  text: string;
  /** When true, the producer treats `text` as space-separated key-combos. */
  keys?: boolean;
}

export interface OmpStateRequest {
  operationId: string;
  workerId: string;
}

export interface OmpApplyRequest {
  operationId: string;
  proposalId: string;
  reason: string;
}

export interface OmpDiscardRequest {
  operationId: string;
  proposalId: string;
  reason: string;
}

export interface OmpVerifyRequest {
  operationId: string;
  /** The retained proposal to verify. The producer resolves the candidate digest from this; the caller never supplies argv or proof. */
  proposalId: string;
}

/**
 * Result of any OMP command. `operationId` MUST equal the request's token so a
 * caller can correlate the audit trail and retry idempotently. `blocked` and
 * `shadow` are distinct from a plain failure: a BLOCKED candidate is not a
 * PASS, and shadow is not enforcement.
 */
export type OmpCommandResult =
  | { ok: true; operationId: string; detail: string }
  | {
      ok: false;
      operationId: string;
      error: 'unavailable' | 'forbidden' | 'conflict' | 'blocked' | 'shadow';
      detail: string;
    };

/**
 * The privileged supervisor surface. Declared now, stubbed in the first pass.
 * Real implementations (Phase 3 ADR) shell to the producer's fleet_* tools
 * behind this interface, never exposing a worker-reachable path.
 */
export interface OmpCommandAdapter {
  readonly authority: 'supervise';
  spawn(req: OmpSpawnRequest): Promise<OmpCommandResult>;
  kill(req: OmpKillRequest): Promise<OmpCommandResult>;
  apply(req: OmpApplyRequest): Promise<OmpCommandResult>;
  discard(req: OmpDiscardRequest): Promise<OmpCommandResult>;
  verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult>;
  send(req: OmpSendRequest): Promise<OmpCommandResult>;
  read(req: OmpReadRequest): Promise<OmpCommandResult>;
  state(req: OmpStateRequest): Promise<OmpCommandResult>;
}
