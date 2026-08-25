/**
 * Tests for `OmpBridgeCommandAdapter` — the Cyboflow→producer tool mapping.
 *
 * Verifies the translation contract: Cyboflow's camelCase request types become
 * the producer's exact `fleet_*` tool names and snake_case argument schemas,
 * and the producer's `isError`/structured detail maps onto `OmpCommandResult`
 * with `operationId` echoed verbatim (correlation).
 *
 * The client is a fake `OmpBridgeClientLike`, so no bridge is reached.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OmpBridgeCallResult, OmpBridgeClientLike, OmpBridgeToolCall } from './ompBridgeClient';
import { OmpBridgeCommandAdapter } from './ompBridgeCommandAdapter';

function fakeClient(record: Array<{ call: OmpBridgeToolCall; result: OmpBridgeCallResult }>) {
  const client: OmpBridgeClientLike = {
    callTool: vi.fn(async (call: OmpBridgeToolCall): Promise<OmpBridgeCallResult> => {
      const entry = record.find((e) => e.call.name === call.name);
      if (entry === undefined) throw new Error(`unexpected tool: ${call.name}`);
      return entry.result;
    }),
  };
  return { client, calls: record };
}

describe('OmpBridgeCommandAdapter', () => {
  it('maps spawn to fleet_spawn with snake_case args and timeout in seconds', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_spawn', arguments: {} }, result: { ok: true, text: 'spawned w1' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    const result = await adapter.spawn({
      operationId: 'op-1',
      model: 'm',
      task: 't',
      label: 'L',
      target: 'pane',
      workspace: 'ws',
      cwd: '/tmp',
      timeoutMs: 1500,
      executionMode: 'shepherd',
      intent: 'mutating',
      scope: { repo: { path: '/r', access: 'overlay_write', include: ['src'], exclude: ['dist'] } },
    });

    expect(result).toEqual({ ok: true, operationId: 'op-1', detail: 'spawned w1' });
    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as OmpBridgeToolCall;
    expect(call).toEqual({
      name: 'fleet_spawn',
      arguments: {
        model: 'm',
        task: 't',
        label: 'L',
        target: 'pane',
        workspace: 'ws',
        cwd: '/tmp',
        timeout: 2,
        execution_mode: 'shepherd',
        intent: 'mutating',
        scope: { repo: { path: '/r', access: 'overlay_write', include: ['src'], exclude: ['dist'] } },
      },
    });
  });

  it('maps kill to fleet_kill with { id }', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_kill', arguments: {} }, result: { ok: true, text: 'killed' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    await adapter.kill({ operationId: 'op-2', workerId: 'w9' });
    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as OmpBridgeToolCall;
    expect(call).toEqual({ name: 'fleet_kill', arguments: { id: 'w9' } });
  });

  it('maps apply/discard to proposal_id + reason', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_proposal_apply', arguments: {} }, result: { ok: true, text: 'applied' } },
      { call: { name: 'fleet_proposal_discard', arguments: {} }, result: { ok: true, text: 'discarded' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    await adapter.apply({ operationId: 'op-3', proposalId: 'p1', reason: 'because' });
    await adapter.discard({ operationId: 'op-4', proposalId: 'p1', reason: 'nope' });
    const calls = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c?.[0]) as OmpBridgeToolCall[];
    expect(calls[0]).toEqual({ name: 'fleet_proposal_apply', arguments: { proposal_id: 'p1', reason: 'because' } });
    expect(calls[1]).toEqual({ name: 'fleet_proposal_discard', arguments: { proposal_id: 'p1', reason: 'nope' } });
  });

  it('maps verifyRun to fleet_verification_run with { proposal_id }', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_verification_run', arguments: {} }, result: { ok: true, text: 'PASS' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    await adapter.verifyRun({ operationId: 'op-5', proposalId: 'p1' });
    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as OmpBridgeToolCall;
    expect(call).toEqual({ name: 'fleet_verification_run', arguments: { proposal_id: 'p1' } });
  });

  it('surfaces a producer isError as unavailable with operationId echoed', async () => {
    const { client } = fakeClient([
      {
        call: { name: 'fleet_spawn', arguments: {} },
        result: { ok: false, isError: true, text: 'fleet_spawn blocked by escalation' },
      },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    const result = await adapter.spawn({ operationId: 'op-6', model: 'm', task: 't' });
    expect(result).toEqual({
      ok: false,
      operationId: 'op-6',
      error: 'unavailable',
      detail: 'fleet_spawn blocked by escalation',
    });
  });

  it('maps an apply denial (verification denied) to blocked, shadow_warning to shadow', async () => {
    const { client } = fakeClient([
      {
        call: { name: 'fleet_proposal_apply', arguments: {} },
        result: {
          ok: false,
          isError: true,
          text: 'Apply failed',
          structuredContent: { verification: { status: 'denied', reason: 'no PASS' } },
        },
      },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    const denied = await adapter.apply({ operationId: 'op-7', proposalId: 'p1', reason: 'r' });
    expect(denied).toEqual({ ok: false, operationId: 'op-7', error: 'blocked', detail: 'Apply failed' });

    const shadowClient: OmpBridgeClientLike = {
      callTool: vi.fn(async () => ({
        ok: false,
        isError: true,
        text: 'Apply failed',
        structuredContent: { verification: { status: 'shadow_warning', reason: 'no proof' } },
      })),
    };
    const shadowAdapter = new OmpBridgeCommandAdapter(shadowClient);
    const shadow = await shadowAdapter.apply({ operationId: 'op-8', proposalId: 'p1', reason: 'r' });
    expect(shadow).toEqual({ ok: false, operationId: 'op-8', error: 'shadow', detail: 'Apply failed' });
  });

  it('omits undefined spawn options from the producer args', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_spawn', arguments: {} }, result: { ok: true, text: 'ok' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    await adapter.spawn({ operationId: 'op-9', model: 'm', task: 't' });
    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as OmpBridgeToolCall;
    expect(call.arguments).toEqual({ model: 'm', task: 't' });
  });

  it('maps send to fleet_send with { id, text } and includes keys only when set', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_send', arguments: {} }, result: { ok: true, text: 'Sent to w1.' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    const result = await adapter.send({ operationId: 'op-10', workerId: 'w1', text: 'continue' });
    expect(result).toEqual({ ok: true, operationId: 'op-10', detail: 'Sent to w1.' });

    await adapter.send({ operationId: 'op-10b', workerId: 'w1', text: 'ctrl+c', keys: true });
    const calls = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c?.[0]) as OmpBridgeToolCall[];
    expect(calls[0]).toEqual({ name: 'fleet_send', arguments: { id: 'w1', text: 'continue' } });
    expect(calls[1]).toEqual({ name: 'fleet_send', arguments: { id: 'w1', text: 'ctrl+c', keys: true } });
  });

  it('maps read to fleet_read with { id } and includes lines/source only when set', async () => {
    const { client } = fakeClient([
      { call: { name: 'fleet_read', arguments: {} }, result: { ok: true, text: 'pane output' } },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    await adapter.read({ operationId: 'op-11', workerId: 'w1' });
    await adapter.read({ operationId: 'op-11b', workerId: 'w1', lines: 40, source: 'recent' });
    const calls = (client.callTool as ReturnType<typeof vi.fn>).mock.calls.map((c) => c?.[0]) as OmpBridgeToolCall[];
    expect(calls[0]).toEqual({ name: 'fleet_read', arguments: { id: 'w1' } });
    expect(calls[1]).toEqual({ name: 'fleet_read', arguments: { id: 'w1', lines: 40, source: 'recent' } });
  });

  it('maps state to fleet_state with { id }', async () => {
    const { client } = fakeClient([
      {
        call: { name: 'fleet_state', arguments: {} },
        result: { ok: true, text: 'w1 backend=herdr pane=p1 model=m state=working' },
      },
    ]);
    const adapter = new OmpBridgeCommandAdapter(client);
    const result = await adapter.state({ operationId: 'op-12', workerId: 'w1' });
    expect(result).toEqual({ ok: true, operationId: 'op-12', detail: 'w1 backend=herdr pane=p1 model=m state=working' });
    const call = (client.callTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as OmpBridgeToolCall;
    expect(call).toEqual({ name: 'fleet_state', arguments: { id: 'w1' } });
  });
});
