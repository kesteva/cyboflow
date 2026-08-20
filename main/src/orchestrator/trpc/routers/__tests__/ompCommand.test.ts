/**
 * Tests for cyboflow.ompCommand — the privileged OMP command router.
 *
 * Verifies the authority boundary, the fail-closed audit trail, the
 * operationId correlation, and the actual stub behavior:
 *   1. A principal without `omp:supervise` is rejected FORBIDDEN AND the
 *      attempt is still audited (attempted + forbidden completed).
 *   2. A supervised principal with the REAL stub returns `unavailable` with an
 *      operationId that matches the audit rows (correlation).
 *   3. A missing audit sink is refused with `unavailable` before anything runs.
 *   4. Input is genuinely redacted: field keys survive, field VALUES do not.
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { OmpCommandStub } from '../../../omp/ompCommandStub';
import type { OmpAuditEntry } from '../ompCommand';
import type { OmpPrincipal } from '../../../../../../shared/types/ompCommand';

const SUPERVISE: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set(['omp:supervise']),
};

const NO_SUPERVISE: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set([]),
};

function callerWith(deps: Parameters<typeof createContext>[0]): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller(createContext(deps));
}

describe('cyboflow.ompCommand authorization', () => {
  it('rejects a non-supervise principal FORBIDDEN and still audits the attempt', async () => {
    const audit: OmpAuditEntry[] = [];
    const caller = callerWith({ principal: NO_SUPERVISE, auditOmp: (e) => audit.push(e) });

    await expect(
      caller.cyboflow.ompCommand.spawn({ model: 'm', task: 'secret task text' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ verb: 'spawn', outcome: 'attempted' });
    expect(audit[1]).toMatchObject({ verb: 'spawn', outcome: 'completed', detail: 'forbidden' });
    // Both rows share one operationId.
    expect(audit[0].operationId).toBe(audit[1].operationId);
  });

  it('redacts input values: keys survive, secret values do not', async () => {
    const audit: OmpAuditEntry[] = [];
    const caller = callerWith({ principal: SUPERVISE, ompCommand: new OmpCommandStub(), auditOmp: (e) => audit.push(e) });

    await caller.cyboflow.ompCommand.spawn({ model: 'm', task: 'SECRET_DO_NOT_LEAK', scope: { repo: { path: '/SECRET/PATH', access: 'read' } } });

    const attempted = audit.find((e) => e.outcome === 'attempted');
    expect(attempted).toBeDefined();
    expect(attempted!.detail).toContain('model');
    expect(attempted!.detail).toContain('task');
    expect(attempted!.detail).toContain('scope');
    // Values are redacted: no raw task text, no raw repo path.
    expect(JSON.stringify(audit)).not.toContain('SECRET_DO_NOT_LEAK');
    expect(JSON.stringify(audit)).not.toContain('/SECRET/PATH');
  });

  it('the real stub returns unavailable with a correlated operationId', async () => {
    const audit: OmpAuditEntry[] = [];
    const caller = callerWith({ principal: SUPERVISE, ompCommand: new OmpCommandStub(), auditOmp: (e) => audit.push(e) });

    const res = await caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't', idempotencyKey: 'op-123' });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('unavailable');
      // The client-supplied idempotency key became the correlation token.
      expect(res.operationId).toBe('op-123');
    }
    // Both audit rows carry the same token as the result.
    expect(audit).toHaveLength(2);
    expect(audit[0].operationId).toBe('op-123');
    expect(audit[1].operationId).toBe('op-123');
  });

  it('refuses outright when no audit sink is configured', async () => {
    const caller = callerWith({ principal: SUPERVISE, ompCommand: new OmpCommandStub() });
    const res = await caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('unavailable');
  });

  it('rejects an idempotencyKey with newline/control characters (log-injection guard)', async () => {
    const caller = callerWith({ principal: SUPERVISE, ompCommand: new OmpCommandStub(), auditOmp: () => {} });
    await expect(
      caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't', idempotencyKey: 'forged\nop=evil' }),
    ).rejects.toBeDefined();
  });
});
