import { afterEach, describe, expect, it } from 'vitest';
import { describeCodexTurnFailure } from '../codexSdkManager';
import { AppServerProtocolError, AppServerTransportError } from '../appServer/client';
import { _resetHostsFacadeForTesting, setHostsFacade, type HostsFacade } from '../../../../orchestrator/hostsBridge';
import type { RemoteRuntimeSession } from '../../../hosts/remoteRuntime';

const remote = { hostId: 'h1' } as RemoteRuntimeSession;
const dropped = new AppServerTransportError('Codex app-server stdout ended before the process exited');

afterEach(() => _resetHostsFacadeForTesting());

describe('describeCodexTurnFailure', () => {
  it('names the environment when a remote transport drops', () => {
    setHostsFacade({ get: () => ({ label: 'Cybo-mbp' }) } as unknown as HostsFacade);
    expect(describeCodexTurnFailure(dropped, remote)).toBe(
      'host-unreachable: Lost the connection to Cybo-mbp during this turn. Send your message again to reconnect.',
    );
  });

  it('falls back to a generic name without a facade', () => {
    expect(describeCodexTurnFailure(dropped, remote)).toMatch(/^host-unreachable: Lost the connection to the environment/);
  });

  it('keeps the raw message on This Mac, for protocol errors and for other errors', () => {
    expect(describeCodexTurnFailure(dropped, null)).toBe(dropped.message);
    const bad = new AppServerProtocolError('frame exceeded maxFrameBytes');
    expect(describeCodexTurnFailure(bad, remote)).toBe(bad.message);
    expect(describeCodexTurnFailure(new Error('turn start timed out'), remote)).toBe('turn start timed out');
  });
});
