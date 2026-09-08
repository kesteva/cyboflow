import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  OmpRpcClient,
  OmpRpcCommandError,
  OmpRpcProtocolError,
  type OmpRpcClientOptions,
  type OmpRpcProcess,
  type SpawnOmpRpcProcess,
} from '../ompRpcClient';
import { collectDescendantPids } from '../../../../processTable';
import { listPidPpidTableSync } from '../../../../../utils/platformProcess';
import { OMP_RPC_MODE_ARGS, OMP_RPC_UI_MODE_ARGS, type OmpRpcEvent } from '../ompContract';
import {
  DETACHED_GRANDCHILD_SCRIPT,
  isAlive,
  waitUntil,
} from '../../../../../__test_fixtures__/processTree';

class FakeOmpProcess extends EventEmitter implements OmpRpcProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
  stdinEnded = false;

  private written = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8');
    });
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killCalls.push(signal);
    return true;
  }

  outboundFrames(): Array<Record<string, unknown>> {
    return this.written
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  writeFrame(frame: object): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }
}

const READY_FRAME = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
} as const;

interface Harness {
  child: FakeOmpProcess;
  client: OmpRpcClient;
  errors: Error[];
  events: OmpRpcEvent[];
  spawnCalls: Array<{ command: string; args: readonly string[] }>;
}

function makeHarness(options: Omit<OmpRpcClientOptions, 'spawn'> = {}): Harness {
  const child = new FakeOmpProcess();
  const errors: Error[] = [];
  const events: OmpRpcEvent[] = [];
  const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnOmpRpcProcess = (command, args) => {
    spawnCalls.push({ command, args: [...args] });
    return child;
  };
  const client = new OmpRpcClient({
    negotiateProtocolV2: false,
    ...options,
    spawn,
    onError: (error) => errors.push(error),
    onEvent: (event) => events.push(event),
  });
  client.start();
  return { child, client, errors, events, spawnCalls };
}

/** Let queued stream data and microtasks drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('OmpRpcClient — spawn + handshake', () => {
  it('spawns the binary with --mode rpc ahead of caller args', () => {
    const { spawnCalls } = makeHarness({
      command: '/opt/bin/omp',
      args: ['--approval-mode', 'always-ask'],
    });
    expect(spawnCalls).toEqual([{
      command: '/opt/bin/omp',
      args: [...OMP_RPC_MODE_ARGS, '--approval-mode', 'always-ask'],
    }]);
  });

  it('honors an explicit mode argv (the UI-bearing rpc-ui mode)', () => {
    const { spawnCalls } = makeHarness({
      command: '/opt/bin/omp',
      modeArgs: OMP_RPC_UI_MODE_ARGS,
      args: ['--approval-mode', 'always-ask'],
    });
    expect(spawnCalls[0].args).toEqual([
      ...OMP_RPC_UI_MODE_ARGS,
      '--approval-mode',
      'always-ask',
    ]);
  });

  it('resolves the handshake from the ready frame', async () => {
    const { child, client } = makeHarness();
    child.writeFrame(READY_FRAME);
    const handshake = await client.handshake();
    expect(handshake.ready.maxFrameBytes).toBe(1048576);
    expect(handshake.protocolVersion).toBe(1);
    expect(client.ready).toEqual(READY_FRAME);
  });

  it('REFUSES a ready frame whose supported versions exclude v1', async () => {
    const { child, client } = makeHarness();
    child.writeFrame({ ...READY_FRAME, supportedProtocolVersions: [2, 3] });
    await expect(client.handshake()).rejects.toThrow(/does not support protocol v1/);
    expect(client.state).toBe('failed');
  });

  it('negotiates v2 when advertised and the option is on', async () => {
    const { child, client } = makeHarness({ negotiateProtocolV2: true });
    child.writeFrame(READY_FRAME);
    const handshake = client.handshake();
    await flush();

    const negotiate = child.outboundFrames().find((frame) => frame.type === 'negotiate_protocol');
    expect(negotiate).toMatchObject({ type: 'negotiate_protocol', protocolVersion: 2 });
    child.writeFrame({
      id: negotiate?.id,
      type: 'response',
      command: 'negotiate_protocol',
      success: true,
      data: { protocolVersion: 2 },
    });

    expect((await handshake).protocolVersion).toBe(2);
    expect(client.protocolVersion).toBe(2);
  });

  it('stays on v1 and reports when v2 negotiation is refused', async () => {
    const { child, client, errors } = makeHarness({ negotiateProtocolV2: true });
    child.writeFrame(READY_FRAME);
    const handshake = client.handshake();
    await flush();

    const negotiate = child.outboundFrames().find((frame) => frame.type === 'negotiate_protocol');
    child.writeFrame({
      id: negotiate?.id,
      type: 'response',
      command: 'negotiate_protocol',
      success: false,
      error: 'nope',
    });

    // A refusal costs only fidelity on oversized frames; the session survives.
    expect((await handshake).protocolVersion).toBe(1);
    expect(client.state).toBe('running');
    expect(errors.some((error) => /staying on v1/.test(error.message))).toBe(true);
  });
});

describe('OmpRpcClient — framing', () => {
  it('reassembles a frame split across data events, including mid-UTF-8 boundaries', async () => {
    const { child, client } = makeHarness();
    const encoded = Buffer.from(`${JSON.stringify({ ...READY_FRAME, note: 'café' })}\n`, 'utf8');
    // Split inside the two-byte é so a naive toString() would corrupt it.
    const splitAt = encoded.indexOf(Buffer.from('é', 'utf8')) + 1;
    child.stdout.write(encoded.subarray(0, splitAt));
    child.stdout.write(encoded.subarray(splitAt));

    await expect(client.handshake()).resolves.toBeDefined();
  });

  it('handles several frames arriving in one data event', async () => {
    const { child, client, events } = makeHarness();
    child.stdout.write(
      `${JSON.stringify(READY_FRAME)}\n${JSON.stringify({ type: 'agent_start' })}\n`
      + `${JSON.stringify({ type: 'turn_start' })}\n`,
    );
    await client.handshake();
    expect(events.map((event) => event.type)).toEqual(['agent_start', 'turn_start']);
  });

  it('tolerates an unparseable line and keeps processing the stream', async () => {
    const { child, client, events, errors } = makeHarness();
    child.stdout.write('this is not json\n');
    child.writeFrame(READY_FRAME);
    child.writeFrame({ type: 'agent_start' });
    await client.handshake();

    expect(errors.some((error) => /unparseable/i.test(error.message))).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['agent_start']);
    expect(client.state).toBe('running');
  });

  it('REJECTS an oversized outbound command loudly rather than truncating it', async () => {
    const { child, client } = makeHarness({ maxFrameBytes: 256 });
    child.writeFrame(READY_FRAME);
    await client.handshake();

    await expect(client.send({ type: 'prompt', message: 'x'.repeat(512) }))
      .rejects.toThrow(/exceeds the 256-byte frame limit/);
    // The command must never reach the wire in truncated form.
    expect(child.outboundFrames().some((frame) => frame.type === 'prompt')).toBe(false);
    // An over-long command is the caller's error, not a transport fault.
    expect(client.state).toBe('running');
  });

  it('fails the transport on an inbound line past the physical frame limit', async () => {
    const { child, client, errors } = makeHarness({ maxFrameBytes: 256 });
    child.writeFrame({ type: 'agent_start', padding: 'x'.repeat(1024) });
    await flush();
    expect(client.state).toBe('failed');
    expect(errors.some((error) => /physical frame limit/.test(error.message))).toBe(true);
  });
});

describe('OmpRpcClient — request correlation', () => {
  async function readyHarness(): Promise<Harness> {
    const harness = makeHarness();
    harness.child.writeFrame(READY_FRAME);
    await harness.client.handshake();
    return harness;
  }

  it('resolves responses that arrive OUT OF ORDER', async () => {
    const { child, client } = await readyHarness();
    const first = client.send({ type: 'get_state' });
    const second = client.send({ type: 'get_session_stats' });
    await flush();

    const frames = child.outboundFrames();
    const stateId = frames.find((frame) => frame.type === 'get_state')?.id;
    const statsId = frames.find((frame) => frame.type === 'get_session_stats')?.id;

    // Second request answered first — ordering across commands is explicitly
    // not guaranteed (rpc.md:172), so only the id may be trusted.
    child.writeFrame({ id: statsId, type: 'response', command: 'get_session_stats', success: true, data: { b: 2 } });
    child.writeFrame({ id: stateId, type: 'response', command: 'get_state', success: true, data: { a: 1 } });

    await expect(first).resolves.toEqual({ a: 1 });
    await expect(second).resolves.toEqual({ b: 2 });
  });

  it('rejects with the command error on a failure response', async () => {
    const { child, client } = await readyHarness();
    const pending = client.send({ type: 'set_model', provider: 'anthropic', modelId: 'nope' });
    await flush();
    const id = child.outboundFrames().find((frame) => frame.type === 'set_model')?.id;
    child.writeFrame({
      id,
      type: 'response',
      command: 'set_model',
      success: false,
      error: 'Model not found: anthropic/nope',
      code: 'not_found',
    });

    await expect(pending).rejects.toBeInstanceOf(OmpRpcCommandError);
    await expect(pending).rejects.toThrow('Model not found: anthropic/nope');
  });

  it('routes an ID-LESS failure back by command name (the unknown-command hazard)', async () => {
    const { child, client } = await readyHarness();
    const pending = client.send({ type: 'get_state' });
    await flush();

    // Exactly how the real binary answers an unrecognized command: no id.
    child.writeFrame({ type: 'response', command: 'get_state', success: false, error: 'Unknown command: get_state' });
    await expect(pending).rejects.toThrow('Unknown command: get_state');
  });

  it('does NOT guess when two requests of the same command are in flight', async () => {
    const { child, client, errors } = await readyHarness();
    const first = client.send({ type: 'get_state' });
    const second = client.send({ type: 'get_state' });
    await flush();

    child.writeFrame({ type: 'response', command: 'get_state', success: false, error: 'boom' });
    await flush();
    // Ambiguous: rejecting an arbitrary one would surface the error on the wrong
    // caller, so it is reported and both stay pending.
    expect(errors.some((error) => /no matching request/.test(error.message))).toBe(true);

    const ids = child.outboundFrames().filter((frame) => frame.type === 'get_state').map((frame) => frame.id);
    child.writeFrame({ id: ids[0], type: 'response', command: 'get_state', success: true, data: 1 });
    child.writeFrame({ id: ids[1], type: 'response', command: 'get_state', success: true, data: 2 });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('tolerates a response for an unknown id', async () => {
    const { child, client, errors } = await readyHarness();
    child.writeFrame({ id: 'not-ours', type: 'response', command: 'prompt', success: true });
    await flush();
    expect(errors.some((error) => /no matching request/.test(error.message))).toBe(true);
    expect(client.state).toBe('running');
  });

  it('parses the real command payloads', async () => {
    const { child, client } = await readyHarness();
    const models = client.getAvailableModels();
    const lastText = client.getLastAssistantText();
    await flush();

    const frames = child.outboundFrames();
    child.writeFrame({
      id: frames.find((frame) => frame.type === 'get_available_models')?.id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          { id: 'claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5', contextWindow: 200000 },
          { id: 'no-provider-row' },
        ],
      },
    });
    child.writeFrame({
      id: frames.find((frame) => frame.type === 'get_last_assistant_text')?.id,
      type: 'response',
      command: 'get_last_assistant_text',
      success: true,
      data: {},
    });

    // The malformed row is dropped rather than surfaced half-formed.
    await expect(models).resolves.toEqual([
      { id: 'claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5', contextWindow: 200000 },
    ]);
    // An ABSENT text key reads as null, not as the string "undefined".
    await expect(lastText).resolves.toBeNull();
  });

  it('sends provider and modelId as separate fields', async () => {
    const { child, client } = await readyHarness();
    void client.setModel('anthropic', 'claude-haiku-4-5');
    await flush();
    expect(child.outboundFrames().find((frame) => frame.type === 'set_model')).toMatchObject({
      type: 'set_model',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
    });
  });

  it('writes an extension_ui_response verbatim, with no pending request behind it', async () => {
    const { child, client, errors } = await readyHarness();
    client.respondToExtensionUi({ type: 'extension_ui_response', id: 'ui-7', value: 'Approve' });
    await flush();

    // The frame carries the id OMP minted for the REQUEST — `send` would have
    // stamped a generated one, which correlates to nothing (rpc-mode.ts:278-284)
    // while leaving a pending entry OMP never answers.
    expect(child.outboundFrames()).toEqual([
      { type: 'extension_ui_response', id: 'ui-7', value: 'Approve' },
    ]);
    expect(client.state).toBe('running');
    expect(errors).toEqual([]);
  });
});

describe('OmpRpcClient — turn contract', () => {
  async function readyHarness(): Promise<Harness> {
    const harness = makeHarness();
    harness.child.writeFrame(READY_FRAME);
    await harness.client.handshake();
    return harness;
  }

  it('resolves at the first TERMINAL agent_end, not at the prompt ack', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('hello');
    await flush();

    const prompt = child.outboundFrames().find((frame) => frame.type === 'prompt');
    expect(prompt).toMatchObject({ type: 'prompt', message: 'hello' });

    // The ack alone must NOT settle the turn.
    child.writeFrame({ id: prompt?.id, type: 'response', command: 'prompt', success: true });
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: true });
    await expect(turn).resolves.toMatchObject({ completion: 'agent_end' });
  });

  it('treats agent_end with isTerminal:false as NON-terminal (maintenance resumes)', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('hello');
    await flush();
    const prompt = child.outboundFrames().find((frame) => frame.type === 'prompt');
    child.writeFrame({ id: prompt?.id, type: 'response', command: 'prompt', success: true });

    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: false });
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    // The session resumed and then truly finished.
    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: true });
    await expect(turn).resolves.toMatchObject({ completion: 'agent_end' });
  });

  it('treats an agent_end with NO isTerminal field as terminal', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('hello');
    await flush();
    child.writeFrame({ type: 'agent_end', messages: [] });
    await expect(turn).resolves.toMatchObject({ completion: 'agent_end' });
  });

  it('IGNORES post-terminal events instead of settling the next turn early', async () => {
    const { child, client, events } = await readyHarness();
    const first = client.runTurn('one');
    await flush();
    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: true });
    await expect(first).resolves.toMatchObject({ completion: 'agent_end' });

    // A maintenance agent_end arriving between turns must not leak into the next.
    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: true });
    await flush();

    const second = client.runTurn('two');
    await flush();
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    child.writeFrame({ type: 'agent_end', messages: [], isTerminal: true });
    await expect(second).resolves.toMatchObject({ completion: 'agent_end' });
    // All three agent_ends reached subscribers — the orphan was ignored for
    // TURN purposes only, never swallowed from the stream.
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(3);
  });

  it('settles a LOCAL-ONLY prompt from the ack, which produces no agent_end', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('/help');
    await flush();
    const prompt = child.outboundFrames().find((frame) => frame.type === 'prompt');
    child.writeFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: false },
    });
    await expect(turn).resolves.toEqual({ completion: 'local' });
  });

  it('settles a local-only prompt that resolves later via prompt_result', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('/help');
    await flush();
    const prompt = child.outboundFrames().find((frame) => frame.type === 'prompt');
    child.writeFrame({ id: prompt?.id, type: 'response', command: 'prompt', success: true });
    child.writeFrame({ type: 'prompt_result', id: prompt?.id, agentInvoked: false });
    await expect(turn).resolves.toEqual({ completion: 'local' });
  });

  it('rejects the turn when the prompt command itself fails', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('hello');
    await flush();
    const prompt = child.outboundFrames().find((frame) => frame.type === 'prompt');
    child.writeFrame({
      id: prompt?.id,
      type: 'response',
      command: 'prompt',
      success: false,
      error: 'streamingBehavior is required while streaming',
    });
    await expect(turn).rejects.toThrow(/streamingBehavior is required/);
  });

  it('refuses a second concurrent turn', async () => {
    const { client } = await readyHarness();
    void client.runTurn('one');
    await expect(client.runTurn('two')).rejects.toBeInstanceOf(OmpRpcProtocolError);
  });

  it('rejects an in-flight turn when the process exits', async () => {
    const { child, client } = await readyHarness();
    const turn = client.runTurn('hello');
    await flush();
    child.emit('exit', 1, null);
    await expect(turn).rejects.toThrow(/exited \(code=1/);
  });

  it('passes streamingBehavior through for a steer/follow-up prompt', async () => {
    const { child, client } = await readyHarness();
    void client.runTurn('also this', { streamingBehavior: 'followUp' });
    await flush();
    expect(child.outboundFrames().find((frame) => frame.type === 'prompt'))
      .toMatchObject({ streamingBehavior: 'followUp' });
  });
});

describe('OmpRpcClient — teardown', () => {
  it('closes stdin first and exits without any signal when OMP drains cleanly', async () => {
    const { child, client } = makeHarness({ stopTimeoutMs: 50, forceKillTimeoutMs: 10 });
    child.writeFrame(READY_FRAME);
    await client.handshake();

    const stopping = client.stop();
    await flush();
    // rpc.md:29 — stdin close is OMP's documented clean-shutdown path.
    expect(child.stdinEnded).toBe(true);
    child.emit('exit', 0, null);
    await stopping;

    expect(child.killCalls).toEqual([]);
    expect(client.state).toBe('exited');
  });

  it('escalates stdin close -> SIGTERM -> SIGKILL when the child will not exit', async () => {
    const { child, client } = makeHarness({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
    child.writeFrame(READY_FRAME);
    await client.handshake();

    await client.stop();
    expect(child.stdinEnded).toBe(true);
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('rejects everything still pending when the transport stops', async () => {
    const { child, client } = makeHarness({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
    child.writeFrame(READY_FRAME);
    await client.handshake();

    const pending = client.send({ type: 'get_state' });
    const turn = client.runTurn('hello');
    const stopping = client.stop();

    await expect(pending).rejects.toThrow(/transport stopped/);
    await expect(turn).rejects.toThrow(/transport stopped/);
    await stopping;
  });

  it('is idempotent across repeated stop calls', async () => {
    const { child, client } = makeHarness({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
    child.writeFrame(READY_FRAME);
    await client.handshake();
    await Promise.all([client.stop(), client.stop()]);
    expect(child.killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('refuses commands once the transport is no longer running', async () => {
    const { child, client } = makeHarness({ stopTimeoutMs: 5, forceKillTimeoutMs: 5 });
    child.writeFrame(READY_FRAME);
    await client.handshake();
    await client.stop();
    expect(() => client.send({ type: 'get_state' })).toThrow(/is not running/);
  });
});

// ---------------------------------------------------------------------------
// win32 tree teardown (runs only on Windows hosts — the platform where the
// negative-pid group kill is a no-op and the taskkill arm is load-bearing)
// ---------------------------------------------------------------------------

describe('OmpRpcClient — win32 tree teardown', () => {
  it.skipIf(process.platform !== 'win32')(
    'reaps a real omp tree via taskkill (grandchild not orphaned)',
    async () => {
      // A REAL node child that spawns its own long-lived detached grandchild —
      // the shape `omp --mode rpc` presents (it owns MCP servers). The
      // taskkill arm must take BOTH; a bare child kill would orphan the
      // grandchild.
      let realChild: ChildProcess | undefined;
      const spawn: SpawnOmpRpcProcess = () => {
        realChild = nodeSpawn(
          process.execPath,
          [
            '-e',
            // Emit the ready frame OMP would, spawn a long-lived detached
            // grandchild (its MCP-server stand-in), then stay alive.
            `console.log(JSON.stringify(${JSON.stringify(READY_FRAME)}));` +
              DETACHED_GRANDCHILD_SCRIPT,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
        );
        return realChild as unknown as OmpRpcProcess;
      };
      const client = new OmpRpcClient({
        negotiateProtocolV2: false,
        stopTimeoutMs: 500,
        forceKillTimeoutMs: 500,
        spawn,
      });
      client.start();
      const pid = realChild?.pid;
      expect(pid).toBeTypeOf('number');

      await client.handshake();

      // Positive control via the shared process table: the grandchild exists.
      let grandkids: number[] = [];
      for (let i = 0; i < 15 && grandkids.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 200));
        grandkids = collectDescendantPids(pid as number, listPidPpidTableSync());
      }
      expect(grandkids.length).toBeGreaterThanOrEqual(1);

      await client.stop();

      const allDead = await waitUntil(
        () => !isAlive(pid as number) && grandkids.every((g) => !isAlive(g)),
        8000,
      );
      expect(allDead).toBe(true);
    },
    30000,
  );
});
