/**
 * Tests for `OmpSessionManager` (OMP Phase 4, increment 3) — the sibling
 * manager beside the four `AbstractCliManager` managers.
 *
 * Verifies the ADR chat-lifecycle mapping: spawn → `fleet_spawn` (worker id
 * stored on the panel), sendInput → `fleet_send`, output → polled
 * `fleet_read` with sliding-window dedup, liveness → `fleet_state` with
 * terminal detection matching the producer's `isTerminalStatus`, stop →
 * `fleet_kill`. The adapter is a fake `OmpCommandAdapter`; no bridge is
 * reached, and timers are driven by explicit `tick()` calls (plus fake
 * timers where the interval itself is under test).
 */
import { describe, expect, it, vi } from 'vitest';
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
} from '../../../../../shared/types/ompCommand';
import {
  newOutputSince,
  OmpSessionManager,
  type OmpErrorEvent,
  type OmpExitEvent,
  type OmpOutputEvent,
  type OmpSpawnedEvent,
} from '../ompSessionManager';

const okResult = (detail: string): OmpCommandResult => ({
  ok: true,
  operationId: 'op',
  detail,
});

const failResult = (detail: string): OmpCommandResult => ({
  ok: false,
  operationId: 'op',
  error: 'unavailable',
  detail,
});

type FakeOverride = (req: unknown) => OmpCommandResult | Promise<OmpCommandResult>;

function makeManager(overrides: Partial<Record<'spawn' | 'kill' | 'send' | 'read' | 'state', FakeOverride>> = {}) {
  const spawn = vi.fn(async (_req: OmpSpawnRequest): Promise<OmpCommandResult> => okResult('worker=w1 pane=p1 model=m [pane]'));
  const kill = vi.fn(async (_req: OmpKillRequest): Promise<OmpCommandResult> => okResult('killed'));
  const send = vi.fn(async (_req: OmpSendRequest): Promise<OmpCommandResult> => okResult('Sent to p1.'));
  const read = vi.fn(async (_req: OmpReadRequest): Promise<OmpCommandResult> => okResult('(empty)'));
  const state = vi.fn(async (_req: OmpStateRequest): Promise<OmpCommandResult> => okResult('w1 backend=pane pane=p1 model=m state=working'));

  const adapter: OmpCommandAdapter = {
    authority: 'supervise',
    spawn: (req: OmpSpawnRequest) => spawn(req),
    kill: (req: OmpKillRequest) => kill(req),
    send: (req: OmpSendRequest) => send(req),
    read: (req: OmpReadRequest) => read(req),
    state: (req: OmpStateRequest) => state(req),
    apply: (req: OmpApplyRequest) => Promise.resolve(failResult(`apply unused: ${req.proposalId}`)),
    discard: (req: OmpDiscardRequest) => Promise.resolve(failResult(`discard unused: ${req.proposalId}`)),
    verifyRun: (req: OmpVerifyRequest) => Promise.resolve(failResult(`verify unused: ${req.proposalId}`)),
  };

  const manager = new OmpSessionManager(
    { ...adapter, ...overrides } as unknown as OmpCommandAdapter,
    undefined,
    { pollMs: 60_000 }, // never fires in tests unless timers are advanced
  );
  return { manager, adapter, spawn, kill, send, read, state };
}

const collect = <T>(emitter: OmpSessionManager, event: string): T[] => {
  const seen: T[] = [];
  emitter.on(event, (payload: T) => {
    seen.push(payload);
  });
  return seen;
};

describe('OmpSessionManager — spawn', () => {
  it('spawns via fleet_spawn, stores the worker id, and emits spawned', async () => {
    const { manager, spawn } = makeManager();
    const spawned = collect<OmpSpawnedEvent>(manager, 'spawned');

    const started = await manager.spawn('panel-1', 'session-1', 'do the thing', { model: 'zai/glm-5.2:high', workspace: 'ws-1', cwd: '/tmp/r' });

    expect(started).toBe(true);
    expect(spawn).toHaveBeenCalledWith({
      model: 'zai/glm-5.2:high',
      task: 'do the thing',
      label: undefined,
      workspace: 'ws-1',
      cwd: '/tmp/r',
      operationId: expect.any(String),
    });
    expect(spawned).toEqual([{ panelId: 'panel-1', sessionId: 'session-1' }]);
    expect(manager.isPanelRunning('panel-1')).toBe(true);
    expect(manager.panelCount).toBe(1);
  });

  it('emits exit (not spawned) when fleet_spawn fails — fail-closed, nothing tracked', async () => {
    const { manager } = makeManager({
      spawn: async () => failResult('bridge offline'),
    });
    const spawned = collect<OmpSpawnedEvent>(manager, 'spawned');
    const exits = collect<OmpExitEvent>(manager, 'exit');

    const started = await manager.spawn('panel-1', 'session-1', 'prompt', { model: 'm' });

    // The IPC seam answers the composer from this boolean: spawn fails CLOSED
    // rather than throwing, so reporting `void` let a failed launch surface as
    // a delivered turn.
    expect(started).toBe(false);
    expect(spawned).toEqual([]);
    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: 1, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
    expect(manager.panelCount).toBe(0);
  });

  it('emits exit when the spawn detail carries no parseable worker id', async () => {
    const { manager } = makeManager({
      spawn: async () => okResult('unexpected detail without a worker token'),
    });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    const started = await manager.spawn('panel-1', 'session-1', 'prompt', { model: 'm' });

    expect(started).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(1);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('rejects an empty prompt and an empty model', async () => {
    const { manager } = makeManager();
    await expect(manager.spawn('panel-1', 'session-1', '   ', { model: 'm' })).rejects.toThrow(TypeError);
    await expect(manager.spawn('panel-1', 'session-1', 'prompt', { model: '' })).rejects.toThrow(TypeError);
  });

  it('rejects a double spawn of the same panel', async () => {
    const { manager } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    await expect(manager.spawn('panel-1', 'session-1', 'second', { model: 'm' })).rejects.toThrow(/already spawned/);
  });

  it('reserves the panel while a spawn is in flight: a concurrent spawn is rejected', async () => {
    const { manager } = makeManager();
    const inFlight = manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    // The sync prefix has run: a pending record is in the map before the first
    // await. A concurrent spawn (double-click) sees it and rejects instead of
    // orphaning a second remote worker.
    await expect(manager.spawn('panel-1', 'session-1', 'second', { model: 'm' })).rejects.toThrow(/already spawned/);
    await inFlight;
    expect(manager.isPanelRunning('panel-1')).toBe(true);
    expect(manager.panelCount).toBe(1);
  });
  it('replaces a terminal record: respawn after the worker reached a terminal state', async () => {
    const { manager, spawn, state } = makeManager({
      state: async () => okResult('state=done'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    spawn.mockClear();

    // Drive the worker to a terminal state.
    await manager.tick('panel-1');
    expect(manager.isPanelRunning('panel-1')).toBe(false);

    // The respawn (ADR: "the first message spawns") must replace the dead
    // record, not throw 'already spawned'.
    await manager.spawn('panel-1', 'session-1', 'second message', { model: 'm' });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toMatchObject({ task: 'second message' });
    expect(manager.isPanelRunning('panel-1')).toBe(true);
    expect(manager.panelCount).toBe(1);
  });

  it('replaces a stopped record: respawn after stopPanel', async () => {
    const { manager, spawn, kill } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    spawn.mockClear();

    await manager.stopPanel('panel-1');
    expect(manager.isPanelRunning('panel-1')).toBe(false);

    await manager.spawn('panel-1', 'session-1', 'after stop', { model: 'm' });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1); // the respawn does not kill the new worker
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});

describe('OmpSessionManager — sendInput', () => {
  it('forwards to fleet_send with the stored worker id', async () => {
    const { manager, send } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    const handed = await manager.sendInput('panel-1', 'follow up');

    expect(handed).toBe(true);
    expect(send).toHaveBeenCalledWith({
      workerId: 'w1',
      text: 'follow up',
      operationId: expect.any(String),
      keys: undefined,
    });
  });

  it('returns false for an unknown panel (spawn needed instead)', async () => {
    const { manager, send } = makeManager();
    const handed = await manager.sendInput('ghost', 'hi');
    expect(handed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('emits an error event when fleet_send fails, but the panel stays live', async () => {
    const { manager } = makeManager({
      send: async () => failResult('pane gone'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const errors = collect<{ error: string }>(manager, 'error');

    const handed = await manager.sendInput('panel-1', 'follow up');

    expect(handed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('fleet_send failed');
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});

describe('OmpSessionManager — output polling (fleet_read)', () => {
  it('emits only the new output since the last read', async () => {
    const { manager, read } = makeManager();
    let transcript = 'line 1\n';
    read.mockImplementation(async () => okResult(transcript));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['line 1\n']);

    transcript = 'line 1\nline 2\n';
    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['line 1\n', 'line 2\n']);

    // Unchanged window ⇒ no event.
    await manager.tick('panel-1');
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ panelId: 'panel-1', sessionId: 'session-1', type: 'stdout' });
    expect(outputs[0].timestamp).toBeInstanceOf(Date);
  });

  it('emits only the non-overlapping tail when the recent window slid', async () => {
    const { manager, read } = makeManager();
    read.mockImplementationOnce(async () => okResult('AAAA\nBBBB\n'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    read.mockImplementationOnce(async () => okResult('BBBB\nCCCC\n'));
    await manager.tick('panel-1');
    read.mockImplementationOnce(async () => okResult('CCCC\nDDDD\n'));
    await manager.tick('panel-1');

    expect(outputs.map((e) => e.data)).toEqual(['AAAA\nBBBB\n', 'CCCC\n', 'DDDD\n']);
  });

  it('treats the producer "(empty)" rendering as an empty read', async () => {
    const { manager, read } = makeManager();
    read.mockImplementationOnce(async () => okResult('(empty)'));
    read.mockImplementationOnce(async () => okResult('hello'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    expect(outputs).toEqual([]);
    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['hello']);
  });

  it('surfaces a failed fleet_read as an error event but keeps the panel alive', async () => {
    const { manager, read } = makeManager({
      read: async () => failResult('herdr offline'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const errors = collect<{ error: string }>(manager, 'error');

    await manager.tick('panel-1');

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('fleet_read failed');
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});

describe('OmpSessionManager — liveness and exit (fleet_state)', () => {
  it('does not exit while the worker is working or idle', async () => {
    for (const stateText of ['state=working', 'state=idle']) {
      const { manager, state } = makeManager();
      state.mockImplementation(async () => okResult(`w1 backend=pane pane=p1 model=m ${stateText}`));
      await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
      const exits = collect<OmpExitEvent>(manager, 'exit');

      await manager.tick('panel-1');

      expect(exits).toEqual([]);
      expect(manager.isPanelRunning('panel-1')).toBe(true);
    }
  });

  it('surfaces a failed fleet_state as an error event but keeps the panel alive', async () => {
    const { manager, state } = makeManager();
    state.mockImplementation(async () => failResult('herdr offline'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const errors = collect<{ error: string }>(manager, 'error');
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(exits).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('fleet_state failed');
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });

  it.each([
    ['state=done', 0],
    ['state=failed', 1],
    ['state=dead', 1],
    ['state=evicted', 1],
  ])('exits with the right code when the worker is %s', async (stateText, exitCode) => {
    const { manager, state } = makeManager();
    state.mockImplementation(async () => okResult(`w1 backend=pane pane=p1 model=m ${stateText}`));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('treats a vanished worker as terminal (evicted)', async () => {
    const { manager, state } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=- model=m state=working [not found]'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: 1, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('stops polling once terminal, after one final drain', async () => {
    const { manager, state, read } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=done'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    await manager.tick('panel-1');
    expect(state).toHaveBeenCalledTimes(1);
    // Exactly one read: the final drain. Everything the worker emitted between
    // the previous poll and its exit lives only in the recent-lines window, and
    // for a `done` worker that tail IS its answer — terminating without reading
    // it would drop the one message the user is waiting for.
    expect(read).toHaveBeenCalledTimes(1);

    await manager.tick('panel-1');
    await manager.tick('panel-1');
    expect(state).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("emits the worker's final output before the exit event", async () => {
    const { manager, state, read } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=done'));
    read.mockImplementation(async () => okResult('the final answer'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(outputs.map((o) => o.data)).toEqual(['the final answer']);
    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: 0, signal: null }]);
  });

  it('does not read a worker that has vanished', async () => {
    const { manager, state, read } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=- model=m state=working [not found]'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    await manager.tick('panel-1');

    // A worker that is gone has no transcript left to drain.
    expect(read).not.toHaveBeenCalled();
  });

  it('never overlaps two poll cycles for the same panel', async () => {
    const { manager, state, read } = makeManager();
    let releaseState: (() => void) | undefined;
    const stateEntered = new Promise<void>((resolve) => {
      state.mockImplementation(async () => {
        resolve();
        await new Promise<void>((r) => {
          releaseState = r;
        });
        return okResult('w1 backend=pane pane=p1 model=m state=working');
      });
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    const first = manager.tick('panel-1');
    await stateEntered;
    // The interval fires again while the first cycle is still awaiting the
    // bridge. Without the in-flight guard both cycles would read the same
    // sliding window and emit it twice (or interleave and drop a chunk).
    await manager.tick('panel-1');
    expect(state).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();

    releaseState?.();
    await first;
    expect(state).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('OmpSessionManager — stop', () => {
  it('kills the worker and emits exit exactly once', async () => {
    const { manager, kill } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.stopPanel('panel-1');

    expect(kill).toHaveBeenCalledWith({ workerId: 'w1', operationId: expect.any(String), timeoutMs: undefined });
    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: null, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);

    // Idempotent: a second stop is a no-op.
    await manager.stopPanel('panel-1');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(exits).toHaveLength(1);
  });

  it('still emits exit when fleet_kill fails (terminating locally)', async () => {
    const { manager } = makeManager({
      kill: async () => failResult('herdr offline'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.stopPanel('panel-1');

    expect(exits).toHaveLength(1);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('sendInput after stop returns false (no live worker)', async () => {
    const { manager, send } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    await manager.stopPanel('panel-1');

    const handed = await manager.sendInput('panel-1', 'too late');

    expect(handed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('OmpSessionManager — polling interval', () => {
  it('ticks live panels on the configured interval and stops after terminal', async () => {
    vi.useFakeTimers();
    try {
      const { manager, state } = makeManager();
      state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=working'));
      await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

      await vi.advanceTimersByTimeAsync(160_000); // 60_000 pollMs → 2 ticks
      expect(state).toHaveBeenCalledTimes(2);

      state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=done'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(state).toHaveBeenCalledTimes(3); // terminal ⇒ polling stopped
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('newOutputSince', () => {
  it('returns empty for an unchanged or empty window', () => {
    expect(newOutputSince('abc', 'abc')).toBe('');
    expect(newOutputSince('abc', '')).toBe('');
    expect(newOutputSince('', 'abc')).toBe('abc');
  });

  it('returns the delta for a strict extension', () => {
    expect(newOutputSince('line 1\n', 'line 1\nline 2\n')).toBe('line 2\n');
  });

  it('returns the non-overlapping tail for a slid window', () => {
    expect(newOutputSince('AA\nBB\n', 'BB\nCC\n')).toBe('CC\n');
  });

  it('falls back to the whole window when nothing overlaps', () => {
    expect(newOutputSince('xyz\n', 'abc\n')).toBe('abc\n');
  });
});

describe('OmpSessionManager — teardown races', () => {
  it('kills the worker when a stop lands while fleet_spawn is still in flight', async () => {
    let releaseSpawn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const { manager, kill } = makeManager({
      spawn: async () => {
        await gate;
        return okResult('worker=w9 pane=p1 model=m [pane]');
      },
    });

    const inFlight = manager.spawn('panel-1', 'session-1', 'go', { model: 'm' });
    // The stop lands while the reservation still has a null workerId, so it
    // has nothing to kill and simply marks the record terminal.
    await manager.stopPanel('panel-1');
    expect(kill).not.toHaveBeenCalled();

    releaseSpawn();
    expect(await inFlight).toBe(false);

    // The worker was born AFTER the kill sweep passed. If spawn does not reap
    // it here, nothing ever will: no record tracks it and its id exists in no
    // other frame — it would keep working the worktree forever.
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls[0][0]).toMatchObject({ workerId: 'w9' });
    expect(manager.isPanelRunning('panel-1')).toBe(false);
    expect(manager.panelCount).toBe(1); // the terminal record, replaceable by a respawn
  });

  it('emits no output after exit when a stop races an in-flight fleet_read', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const { manager } = makeManager({
      read: async () => {
        await gate;
        return okResult('a late line\n');
      },
    });
    const outputs = collect<OmpOutputEvent>(manager, 'output');
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.spawn('panel-1', 'session-1', 'go', { model: 'm' });
    const ticking = manager.tick('panel-1');
    await manager.stopPanel('panel-1');
    expect(exits).toHaveLength(1);

    releaseRead();
    await ticking;

    // The read resolved after exit. Emitting it would reopen a panel the
    // consumer has already closed out.
    expect(outputs).toHaveLength(0);
  });

  it('marks a poll blip transient and keeps the panel live', async () => {
    const { manager } = makeManager({ state: async () => failResult('bridge unreachable') });
    const errors = collect<OmpErrorEvent>(manager, 'error');

    await manager.spawn('panel-1', 'session-1', 'go', { model: 'm' });
    await manager.tick('panel-1');

    // Transient: the worker is untouched and the next poll may succeed, so the
    // consumer must not park the panel in a terminal-looking 'error' state.
    expect(errors).toHaveLength(1);
    expect(errors[0].transient).toBe(true);
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});
