/**
 * LIVE smoke — runs Cyboflow's real config resolver, adapter, and HTTP client
 * against the real bridge. Requires OMP_BRIDGE_* env AND an explicit
 * OMP_BRIDGE_LIVE=1 opt-in (the skip gate is on by default, so a normal
 * `pnpm test:unit` run never reaches a live bridge by accident); run explicitly:
 *   OMP_BRIDGE_LIVE=1 OMP_BRIDGE_TOKEN_FILE=... OMP_BRIDGE_SESSION_ID=... \
 *     npx vitest run <this>
 * Uses a nonexistent worker id so fleet_kill traverses the full path (auth →
 * session scope → tool gate → tool host → fleet controller) without side effects.
 */
import { describe, expect, it } from 'vitest';
import { resolveOmpBridgeCommandConfig } from './ompBridgeConfig';
import { OmpBridgeCommandAdapter } from './ompBridgeCommandAdapter';
import { OmpBridgeHttpClient } from './ompBridgeClient';

const config = resolveOmpBridgeCommandConfig();
// Opt-in ONLY: a live smoke must never run in CI / a plain test:unit pass.
const live = process.env.OMP_BRIDGE_LIVE === '1';

describe.skipIf(!live || config === undefined)('live bridge smoke', () => {
  it('resolves real config', () => {
    expect(config).toBeDefined();
  });

  it('fleet_kill on a nonexistent worker traverses the full path', async () => {
    const adapter = new OmpBridgeCommandAdapter(
      new OmpBridgeHttpClient(config!.url, config!.token, config!.sessionId),
    );
    const result = await adapter.kill({ operationId: 'op-live-smoke-1', workerId: 'cyboflow-smoke-nonexistent' });
    // The command must correlate and return a structured result — not throw.
    expect(result.operationId).toBe('op-live-smoke-1');
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) expect(typeof result.detail).toBe('string');
  });

  it.each([
    ['read', 'op-live-smoke-2'],
    ['state', 'op-live-smoke-3'],
    ['send', 'op-live-smoke-4'],
  ] as const)('%s on a nonexistent worker traverses the full path', async (verb, operationId) => {
    const adapter = new OmpBridgeCommandAdapter(
      new OmpBridgeHttpClient(config!.url, config!.token, config!.sessionId),
    );
    let result;
    if (verb === 'read') result = await adapter.read({ operationId, workerId: 'cyboflow-smoke-nonexistent' });
    else if (verb === 'state') result = await adapter.state({ operationId, workerId: 'cyboflow-smoke-nonexistent' });
    else result = await adapter.send({ operationId, workerId: 'cyboflow-smoke-nonexistent', text: 'noop' });
    // The command must correlate and return a structured result — not throw.
    expect(result.operationId).toBe(operationId);
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) expect(typeof result.detail).toBe('string');
  });
});
