/**
 * `OmpSupervisedAdapter` — the capability + audit chokepoint for the OMP
 * command surface, expressed as a decorator over any `OmpCommandAdapter`.
 *
 * WHY THIS EXISTS. The `cyboflow.ompCommand` tRPC router gates every mutation on
 * `hasSupervise(ctx.principal)` and refuses to run at all without an audit sink.
 * But the router is not the only caller: `OmpSessionManager` drives the SAME
 * privileged surface (`fleet_spawn` / `fleet_send` / `fleet_kill`) directly from
 * the panel dispatch seams. Handing that manager a bare
 * `OmpBridgeCommandAdapter` put the product's actual path OUTSIDE the
 * authorization model — a user with the bridge configured but the supervise
 * capability withheld could spawn and kill real remote workers with no check
 * and no audit trail, while the tRPC surface for the same verbs answered
 * FORBIDDEN.
 *
 * Wrapping instead of re-checking at each call site makes the guarantee
 * structural: a manager holding this adapter CANNOT reach the bridge
 * unauthorized, and a future seam that discovers the adapter inherits the gate
 * rather than having to remember it.
 *
 * WHAT IS AUDITED. The six MUTATING verbs (spawn, kill, send, apply, discard,
 * verifyRun) are capability-checked and audited ATTEMPTED + COMPLETED, matching
 * the router's contract. The two read-only verbs (read, state) are
 * capability-checked but NOT audited: they are the poll loop, firing per live
 * panel every `OMP_DEFAULT_POLL_MS`, and writing two log lines per poll would
 * bury the mutation trail it exists to preserve. They observe, they never act.
 *
 * Standalone-typecheck invariant: no imports from electron, better-sqlite3, or
 * services/*. This module is pure.
 */
import { randomUUID } from 'node:crypto';
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpPrincipal,
  OmpReadRequest,
  OmpSendRequest,
  OmpSpawnRequest,
  OmpStateRequest,
  OmpVerifyRequest,
} from '../../../../shared/types/ompCommand';
import { hasSupervise, OMP_SUPERVISE_CAPABILITY } from '../../../../shared/types/ompCommand';

/** Mirrors the router's `OmpAuditEntry` — narrow, string-only, trivially redactable. */
export interface OmpSupervisedAuditEntry {
  verb: string;
  principal: string;
  outcome: 'attempted' | 'completed';
  operationId: string;
  detail: string;
}

export type OmpSupervisedAuditSink = (entry: OmpSupervisedAuditEntry) => void;

/**
 * Where the adapter reads its identity from.
 *
 * A THUNK is the form production uses, and the distinction is load-bearing: the
 * supervise capability comes from Aria mode, a setting the user can flip while
 * the app is running. Capturing an `OmpPrincipal` value at construction freezes
 * the answer at whatever it was when the owning object was built — which for a
 * boot-time singleton means "whatever it was at launch", so granting the
 * capability appeared to do nothing until a restart and revoking it kept
 * authorizing commands. Resolving per call makes both directions immediate.
 *
 * A plain value stays accepted for tests, which want a fixed identity.
 */
export type OmpPrincipalSource = OmpPrincipal | (() => OmpPrincipal);

export class OmpSupervisedAdapter implements OmpCommandAdapter {
  readonly authority = 'supervise' as const;

  constructor(
    private readonly inner: OmpCommandAdapter,
    private readonly principalSource: OmpPrincipalSource,
    private readonly audit: OmpSupervisedAuditSink,
  ) {}

  spawn(req: OmpSpawnRequest): Promise<OmpCommandResult> {
    return this.guardMutation('spawn', req.operationId, () => this.inner.spawn(req));
  }
  kill(req: OmpKillRequest): Promise<OmpCommandResult> {
    return this.guardMutation('kill', req.operationId, () => this.inner.kill(req));
  }
  send(req: OmpSendRequest): Promise<OmpCommandResult> {
    return this.guardMutation('send', req.operationId, () => this.inner.send(req));
  }
  apply(req: OmpApplyRequest): Promise<OmpCommandResult> {
    return this.guardMutation('apply', req.operationId, () => this.inner.apply(req));
  }
  discard(req: OmpDiscardRequest): Promise<OmpCommandResult> {
    return this.guardMutation('discard', req.operationId, () => this.inner.discard(req));
  }
  verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult> {
    return this.guardMutation('verifyRun', req.operationId, () => this.inner.verifyRun(req));
  }

  read(req: OmpReadRequest): Promise<OmpCommandResult> {
    return this.guardRead('read', req.operationId, () => this.inner.read(req));
  }
  state(req: OmpStateRequest): Promise<OmpCommandResult> {
    return this.guardRead('state', req.operationId, () => this.inner.state(req));
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * The identity for THIS call. Never cached: see {@link OmpPrincipalSource}.
   * A throwing provider (config not yet constructed) is the fail-closed answer,
   * not a crash — an empty capability set forbids everything.
   */
  private principal(): OmpPrincipal {
    if (typeof this.principalSource !== 'function') return this.principalSource;
    try {
      return this.principalSource();
    } catch {
      return { userId: 'unknown', capabilities: new Set<string>() };
    }
  }

  private forbidden(operationId: string): OmpCommandResult {
    return {
      ok: false,
      operationId,
      error: 'forbidden',
      detail: `missing capability ${OMP_SUPERVISE_CAPABILITY}`,
    };
  }

  /**
   * A privileged verb: audited ATTEMPTED before delegation and COMPLETED after,
   * including the forbidden and thrown paths. `operationId` correlates all
   * three, exactly as the router's `runGuarded` does. An adapter that throws is
   * converted to `unavailable` rather than propagating, so a caller can never
   * observe a mutation whose completion went unrecorded.
   */
  private async guardMutation(
    verb: string,
    operationId: string,
    invoke: () => Promise<OmpCommandResult>,
  ): Promise<OmpCommandResult> {
    const id = operationId || randomUUID();
    const identity = this.principal();
    const principal = identity.userId;
    this.audit({ verb, principal, outcome: 'attempted', operationId: id, detail: '' });

    if (!hasSupervise(identity)) {
      this.audit({ verb, principal, outcome: 'completed', operationId: id, detail: 'forbidden' });
      return this.forbidden(id);
    }

    let result: OmpCommandResult;
    try {
      result = await invoke();
    } catch (error) {
      result = {
        ok: false,
        operationId: id,
        error: 'unavailable',
        detail: error instanceof Error ? error.message : 'OMP command failed',
      };
    }
    this.audit({
      verb,
      principal,
      outcome: 'completed',
      operationId: id,
      detail: result.ok ? 'ok' : result.error,
    });
    return result;
  }

  /** A read-only verb: same capability gate, no audit rows (see the header). */
  private async guardRead(
    verb: string,
    operationId: string,
    invoke: () => Promise<OmpCommandResult>,
  ): Promise<OmpCommandResult> {
    if (!hasSupervise(this.principal())) return this.forbidden(operationId || randomUUID());
    try {
      return await invoke();
    } catch (error) {
      return {
        ok: false,
        operationId,
        error: 'unavailable',
        detail: error instanceof Error ? error.message : `OMP ${verb} failed`,
      };
    }
  }
}
