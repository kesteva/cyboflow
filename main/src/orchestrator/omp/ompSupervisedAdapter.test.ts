/**
 * Tests for `OmpSupervisedAdapter` — the capability + audit chokepoint.
 *
 * The regression this guards: `OmpSessionManager` drives the same privileged
 * fleet_* surface as the `ompCommand` tRPC router, but from the panel dispatch
 * seams. Handed a bare bridge adapter it spawned and killed real remote workers
 * with no capability check and no audit trail, while the router answered
 * FORBIDDEN for the same verbs. Wrapping makes the gate structural, so these
 * tests assert it holds for BOTH the mutating and the read-only surface.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OmpCommandAdapter, OmpCommandResult, OmpPrincipal } from '../../../../shared/types/ompCommand';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../shared/types/ompCommand';
import { OmpSupervisedAdapter, type OmpSupervisedAuditEntry } from './ompSupervisedAdapter';

const authorized: OmpPrincipal = { userId: 'local', capabilities: new Set([OMP_SUPERVISE_CAPABILITY]) };
const unauthorized: OmpPrincipal = { userId: 'local', capabilities: new Set<string>() };

function ok(operationId: string): OmpCommandResult {
  return { ok: true, operationId, detail: 'worker=w1' };
}

function makeInner(): { inner: OmpCommandAdapter; calls: string[] } {
  const calls: string[] = [];
  const record =
    (verb: string) =>
    async (req: { operationId: string }): Promise<OmpCommandResult> => {
      calls.push(verb);
      return ok(req.operationId);
    };
  const inner: OmpCommandAdapter = {
    authority: 'supervise',
    spawn: record('spawn'),
    kill: record('kill'),
    send: record('send'),
    apply: record('apply'),
    discard: record('discard'),
    verifyRun: record('verifyRun'),
    read: record('read'),
    state: record('state'),
  };
  return { inner, calls };
}

function make(principal: OmpPrincipal): {
  adapter: OmpSupervisedAdapter;
  calls: string[];
  audit: OmpSupervisedAuditEntry[];
} {
  const { inner, calls } = makeInner();
  const audit: OmpSupervisedAuditEntry[] = [];
  return { adapter: new OmpSupervisedAdapter(inner, principal, (e) => audit.push(e)), calls, audit };
}

const MUTATIONS = ['spawn', 'kill', 'send', 'apply', 'discard', 'verifyRun'] as const;

/** Minimal well-typed request per verb; only operationId matters to the wrapper. */
function invoke(adapter: OmpSupervisedAdapter, verb: string, operationId: string): Promise<OmpCommandResult> {
  switch (verb) {
    case 'spawn':
      return adapter.spawn({ operationId, model: 'm', task: 't' });
    case 'kill':
      return adapter.kill({ operationId, workerId: 'w1' });
    case 'send':
      return adapter.send({ operationId, workerId: 'w1', text: 'hi' });
    case 'apply':
      return adapter.apply({ operationId, proposalId: 'p1', reason: 'r' });
    case 'discard':
      return adapter.discard({ operationId, proposalId: 'p1', reason: 'r' });
    case 'verifyRun':
      return adapter.verifyRun({ operationId, proposalId: 'p1' });
    case 'read':
      return adapter.read({ operationId, workerId: 'w1' });
    default:
      return adapter.state({ operationId, workerId: 'w1' });
  }
}

describe('OmpSupervisedAdapter — without the supervise capability', () => {
  for (const verb of MUTATIONS) {
    it(`refuses ${verb} and never reaches the bridge`, async () => {
      const { adapter, calls, audit } = make(unauthorized);
      const result = await invoke(adapter, verb, 'op-1');

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toBe('forbidden');
      expect(calls).toEqual([]);
      // Refusals are audited too — a denied privileged attempt is exactly the
      // event an operator wants in the trail.
      expect(audit).toEqual([
        { verb, principal: 'local', outcome: 'attempted', operationId: 'op-1', detail: '' },
        { verb, principal: 'local', outcome: 'completed', operationId: 'op-1', detail: 'forbidden' },
      ]);
    });
  }

  for (const verb of ['read', 'state'] as const) {
    it(`refuses the read-only verb ${verb} without auditing the poll`, async () => {
      const { adapter, calls, audit } = make(unauthorized);
      const result = await invoke(adapter, verb, 'op-1');

      expect(result.ok === false && result.error).toBe('forbidden');
      expect(calls).toEqual([]);
      expect(audit).toEqual([]);
    });
  }
});

describe('OmpSupervisedAdapter — with the supervise capability', () => {
  for (const verb of MUTATIONS) {
    it(`delegates ${verb} and records attempted + completed on one operationId`, async () => {
      const { adapter, calls, audit } = make(authorized);
      const result = await invoke(adapter, verb, 'op-7');

      expect(result.ok).toBe(true);
      expect(result.operationId).toBe('op-7');
      expect(calls).toEqual([verb]);
      expect(audit.map((e) => e.outcome)).toEqual(['attempted', 'completed']);
      expect(audit.every((e) => e.operationId === 'op-7')).toBe(true);
      expect(audit[1].detail).toBe('ok');
    });
  }

  it('delegates the poll verbs without writing audit rows', async () => {
    const { adapter, calls, audit } = make(authorized);
    await invoke(adapter, 'read', 'op-r');
    await invoke(adapter, 'state', 'op-s');

    // Two log lines per poll per panel would bury the mutation trail this sink
    // exists to preserve; these verbs observe, they never act.
    expect(calls).toEqual(['read', 'state']);
    expect(audit).toEqual([]);
  });

  it('records a terminal outcome when the bridge throws, and never propagates', async () => {
    const { inner } = makeInner();
    const audit: OmpSupervisedAuditEntry[] = [];
    inner.spawn = vi.fn(async () => {
      throw new Error('bridge unreachable');
    });
    const adapter = new OmpSupervisedAdapter(inner, authorized, (e) => audit.push(e));

    const result = await adapter.spawn({ operationId: 'op-9', model: 'm', task: 't' });

    expect(result.ok === false && result.error).toBe('unavailable');
    expect(result.ok === false && result.detail).toBe('bridge unreachable');
    expect(audit.map((e) => e.outcome)).toEqual(['attempted', 'completed']);
    expect(audit[1].detail).toBe('unavailable');
  });

  it('carries a non-ok bridge result through as the audited outcome', async () => {
    const { inner } = makeInner();
    const audit: OmpSupervisedAuditEntry[] = [];
    inner.kill = vi.fn(
      async (req): Promise<OmpCommandResult> => ({
        ok: false,
        operationId: req.operationId,
        error: 'conflict',
        detail: 'worker already gone',
      }),
    );
    const adapter = new OmpSupervisedAdapter(inner, authorized, (e) => audit.push(e));

    const result = await adapter.kill({ operationId: 'op-c', workerId: 'w1' });

    expect(result.ok === false && result.error).toBe('conflict');
    expect(audit[1].detail).toBe('conflict');
  });

  it('audits no raw payload — the attempted row carries no task text', async () => {
    const { adapter, audit } = make(authorized);
    await adapter.spawn({ operationId: 'op-x', model: 'm', task: 'SECRET customer data' });

    for (const entry of audit) {
      expect(JSON.stringify(entry)).not.toContain('SECRET');
    }
  });
});

describe('OmpSupervisedAdapter — a live principal (Aria mode flipped at runtime)', () => {
  /** Same harness, but the identity comes from a mutable cell via a thunk. */
  function makeLive(): {
    adapter: OmpSupervisedAdapter;
    calls: string[];
    setSupervise: (on: boolean) => void;
  } {
    const { inner, calls } = makeInner();
    let supervise = false;
    const adapter = new OmpSupervisedAdapter(
      inner,
      () => ({
        userId: 'local',
        capabilities: supervise ? new Set([OMP_SUPERVISE_CAPABILITY]) : new Set<string>(),
      }),
      () => {},
    );
    return { adapter, calls, setSupervise: (on: boolean) => { supervise = on; } };
  }

  // The restart bug: the manager captured its principal at boot, so granting
  // Aria mode did nothing until relaunch. Resolving per call fixes it.
  it('authorizes commands as soon as the capability is granted, with no rebuild', async () => {
    const { adapter, calls, setSupervise } = makeLive();

    expect((await invoke(adapter, 'spawn', 'op-1')).ok).toBe(false);
    expect(calls).toEqual([]);

    setSupervise(true);

    expect((await invoke(adapter, 'spawn', 'op-2')).ok).toBe(true);
    expect(calls).toEqual(['spawn']);
  });

  // The same freeze in the dangerous direction: a captured principal kept an
  // already-built adapter authorized for the rest of the run.
  it('forbids the very next command once the capability is revoked', async () => {
    const { adapter, calls, setSupervise } = makeLive();
    setSupervise(true);
    expect((await invoke(adapter, 'kill', 'op-1')).ok).toBe(true);

    setSupervise(false);

    const result = await invoke(adapter, 'kill', 'op-2');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('forbidden');
    // The revoked call never reached the bridge.
    expect(calls).toEqual(['kill']);
  });

  it('gates the read-only verbs on the live capability too', async () => {
    const { adapter, calls, setSupervise } = makeLive();
    expect((await adapter.read({ operationId: 'op-1', workerId: 'w1' })).ok).toBe(false);
    setSupervise(true);
    expect((await adapter.read({ operationId: 'op-2', workerId: 'w1' })).ok).toBe(true);
    expect(calls).toEqual(['read']);
  });

  // A provider that throws (config not yet constructed at an early call) must
  // fail CLOSED rather than crash the caller.
  it('forbids rather than throwing when the principal provider throws', async () => {
    const { inner, calls } = makeInner();
    const adapter = new OmpSupervisedAdapter(
      inner,
      () => {
        throw new Error('configManager not ready');
      },
      () => {},
    );
    const result = await invoke(adapter, 'spawn', 'op-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('forbidden');
    expect(calls).toEqual([]);
  });
});
