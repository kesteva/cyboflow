/**
 * Stub implementation of `OmpCommandAdapter` — Phase 2 of the OMP plan.
 *
 * Every method fails closed with `unavailable`, echoing the request's
 * `operationId` verbatim so the audit trail and the returned result correlate
 * on one token. There is no transport yet (Phase 3 ADR:
 * `docs/proposals/omp-phase3-command-adr.md` records that decision as NO-GO),
 * so no method can distinguish a real producer denial from a not-implemented
 * gap — `unavailable` is the only honest failure class at this layer.
 * `blocked`/`shadow` are producer verification outcomes, not transport states,
 * and are only returned by a real adapter after an actual gate result.
 */
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpReadRequest,
  OmpSendRequest,
  OmpSpawnRequest,
  OmpStateRequest,
  OmpVerifyRequest,
} from '../../../../shared/types/ompCommand';

export class OmpCommandStub implements OmpCommandAdapter {
  readonly authority = 'supervise' as const;

  private unavailable(verb: string, operationId: string): OmpCommandResult {
    return {
      ok: false,
      operationId,
      error: 'unavailable',
      detail: `omp:${verb} not implemented (Phase 3 ADR: transport NO-GO)`,
    };
  }

  spawn(req: OmpSpawnRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('spawn', req.operationId));
  }

  kill(req: OmpKillRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('kill', req.operationId));
  }

  apply(req: OmpApplyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('apply', req.operationId));
  }

  discard(req: OmpDiscardRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('discard', req.operationId));
  }

  verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('verifyRun', req.operationId));
  }

  send(req: OmpSendRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('send', req.operationId));
  }

  read(req: OmpReadRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('read', req.operationId));
  }

  state(req: OmpStateRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('state', req.operationId));
  }
}
