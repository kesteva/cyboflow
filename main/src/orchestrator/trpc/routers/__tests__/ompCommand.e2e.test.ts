/**
 * End-to-end integration test for the privileged OMP command path.
 *
 * Drives the REAL tRPC router (`cyboflow.ompCommand.spawn`) with a supervise
 * principal, the REAL `OmpBridgeCommandAdapter`, and a FAKE bridge client, to
 * prove the whole chain — authorize → audit → map → invoke → correlate — works
 * as one path, not as isolated units.
 *
 * The fake client asserts the exact producer wire call, so this also pins the
 * mapping contract at the integration boundary.
 */
import { describe, expect, it, vi } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { OmpAuditEntry } from '../ompCommand';
import { OmpBridgeCommandAdapter } from '../../../omp/ompBridgeCommandAdapter';
import type { OmpBridgeCallResult, OmpBridgeClientLike, OmpBridgeToolCall } from '../../../omp/ompBridgeClient';
import { OMP_SUPERVISE_CAPABILITY, type OmpPrincipal } from '../../../../../../shared/types/ompCommand';

const SUPERVISE: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set([OMP_SUPERVISE_CAPABILITY]),
};

describe('cyboflow.ompCommand end-to-end (real router + real adapter + fake bridge)', () => {
  it('spawn reaches the bridge with the mapped producer call and returns the result', async () => {
    const calls: OmpBridgeToolCall[] = [];
    const client: OmpBridgeClientLike = {
      callTool: vi.fn(async (call: OmpBridgeToolCall): Promise<OmpBridgeCallResult> => {
        calls.push(call);
        return { ok: true, text: 'spawned wkr-1' };
      }),
    };
    const adapter = new OmpBridgeCommandAdapter(client);
    const audit: OmpAuditEntry[] = [];
    const caller = appRouter.createCaller(
      createContext({ principal: SUPERVISE, ompCommand: adapter, auditOmp: (e) => audit.push(e) }),
    );

    const result = await caller.cyboflow.ompCommand.spawn({
      model: 'zai/glm-5.2:high',
      task: 'edit files',
      executionMode: 'shepherd',
      intent: 'mutating',
      scope: { repo: { path: '/repos/x', access: 'overlay_write' } },
      idempotencyKey: 'op-e2e-1',
    });

    expect(result).toMatchObject({ ok: true, operationId: 'op-e2e-1', detail: 'spawned wkr-1' });

    // The exact producer wire call, with snake_case + seconds timeout omitted when absent.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: 'fleet_spawn',
      arguments: {
        model: 'zai/glm-5.2:high',
        task: 'edit files',
        execution_mode: 'shepherd',
        intent: 'mutating',
        scope: { repo: { path: '/repos/x', access: 'overlay_write' } },
      },
    });

    // Both audit rows correlate on the client-supplied token.
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ verb: 'spawn', outcome: 'attempted', operationId: 'op-e2e-1' });
    expect(audit[1]).toMatchObject({ verb: 'spawn', outcome: 'completed', operationId: 'op-e2e-1', detail: 'ok' });
  });
});
