import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerTransportError,
  CODEX_APP_SERVER_ARGS,
  CodexAppServerClient,
  type AppServerProcess,
  type AppServerSpawnOptions,
  type CodexAppServerClientOptions,
  type SpawnAppServerProcess,
} from './client';
import type { AppServerInitializeParams } from './protocol';

class FakeAppServerProcess extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];

  private written = '';

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8');
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

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: AppServerSpawnOptions;
}

function makeHarness(options: Omit<CodexAppServerClientOptions, 'spawn'> = {}): {
  child: FakeAppServerProcess;
  client: CodexAppServerClient;
  spawnCalls: SpawnCall[];
} {
  const child = new FakeAppServerProcess();
  const spawnCalls: SpawnCall[] = [];
  const spawn: SpawnAppServerProcess = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args: [...args], options: spawnOptions });
    return child;
  };
  const client = new CodexAppServerClient({ ...options, spawn });
  client.start();
  return { child, client, spawnCalls };
}

const initializeParams: AppServerInitializeParams = {
  clientInfo: {
    name: 'cyboflow',
    title: 'Cyboflow',
    version: '0.1.20',
  },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
  },
};

describe('CodexAppServerClient', () => {
  it('spawns stdio app-server and performs the initialize/initialized handshake', async () => {
    const env = { TEST_APP_SERVER: '1' };
    const { child, client, spawnCalls } = makeHarness({
      command: '/opt/bin/codex',
      cwd: '/tmp/worktree',
      env,
    });

    expect(spawnCalls).toEqual([{
      command: '/opt/bin/codex',
      args: [...CODEX_APP_SERVER_ARGS],
      options: { cwd: '/tmp/worktree', env },
    }]);

    const initialization = client.initialize(initializeParams);
    expect(child.outboundFrames()).toEqual([{
      id: 1,
      method: 'initialize',
      params: initializeParams,
    }]);

    const responseFrame = Buffer.from(`${JSON.stringify({
      id: 1,
      result: {
        userAgent: 'Codex 0.143.0 cafe\u0301',
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    })}\n`, 'utf8');
    const splitAt = responseFrame.indexOf(Buffer.from('e\u0301')) + 2;
    child.stdout.write(responseFrame.subarray(0, splitAt));
    child.stdout.write(responseFrame.subarray(splitAt));

    await expect(initialization).resolves.toEqual({
      userAgent: 'Codex 0.143.0 cafe\u0301',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
    expect(client.isInitialized).toBe(true);
    expect(child.outboundFrames()[1]).toEqual({ method: 'initialized' });
  });

  it('correlates out-of-order responses and parses multiple frames in one chunk', async () => {
    const notifications: unknown[] = [];
    const { child, client } = makeHarness({
      onNotification: (notification) => notifications.push(notification),
    });

    const first = client.sendRequest<{ value: string }, { sequence: number }>(
      'test/first',
      { sequence: 1 },
    );
    const second = client.sendRequest<{ value: string }, { sequence: number }>(
      'test/second',
      { sequence: 2 },
    );

    child.stdout.write(
      `${JSON.stringify({ id: 2, result: { value: 'second' } })}\n`
      + `${JSON.stringify({ method: 'thread/started', params: { threadId: 'thread-1' } })}\n`
      + `${JSON.stringify({ id: 1, result: { value: 'first' } })}\n`,
    );

    await expect(first).resolves.toEqual({ value: 'first' });
    await expect(second).resolves.toEqual({ value: 'second' });
    expect(notifications).toEqual([{
      method: 'thread/started',
      params: { threadId: 'thread-1' },
    }]);
  });

  it('rejects only the correlated request for a valid RPC error response', async () => {
    const { child, client } = makeHarness();
    const request = client.sendRequest<never, object>('thread/start', {});

    child.writeFrame({
      id: 1,
      error: { code: -32000, message: 'thread start failed', data: { retryable: false } },
    });

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect(error).toMatchObject({
      code: -32000,
      message: 'thread start failed',
      data: { retryable: false },
    });
    expect(client.state).toBe('running');
    expect(child.killCalls).toEqual([]);
  });

  it('dispatches command, file, and MCP approval requests with typed responders', () => {
    const handled: string[] = [];
    const { child } = makeHarness({
      onServerRequest: (request) => {
        handled.push(request.method);
        switch (request.method) {
          case 'item/commandExecution/requestApproval':
            expect(request.params.command).toBe('pnpm test');
            request.respond({ decision: 'accept' });
            break;
          case 'item/fileChange/requestApproval':
            expect(request.params.grantRoot).toBe('/tmp/worktree');
            request.respond({ decision: 'decline' });
            break;
          case 'mcpServer/elicitation/request':
            expect(request.params.serverName).toBe('cyboflow');
            request.respond({ action: 'cancel', content: null, _meta: null });
            break;
        }
      },
    });

    child.stdout.write(
      `${JSON.stringify({
        id: 'command-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 100,
          environmentId: null,
          command: 'pnpm test',
          cwd: '/tmp/worktree',
        },
      })}\n`
      + `${JSON.stringify({
        id: 'file-1',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-2',
          startedAtMs: 101,
          reason: 'write generated output',
          grantRoot: '/tmp/worktree',
        },
      })}\n`
      + `${JSON.stringify({
        id: 'mcp-1',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          serverName: 'cyboflow',
          mode: 'form',
          _meta: { codex_approval_kind: 'mcp_tool_call' },
          message: 'Allow tool call?',
          requestedSchema: { type: 'object', properties: {} },
        },
      })}\n`,
    );

    expect(handled).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'mcpServer/elicitation/request',
    ]);
    expect(child.outboundFrames()).toEqual([
      { id: 'command-1', result: { decision: 'accept' } },
      { id: 'file-1', result: { decision: 'decline' } },
      { id: 'mcp-1', result: { action: 'cancel', content: null, _meta: null } },
    ]);
  });

  it('cancels approval requests when no handler is installed', () => {
    const { child } = makeHarness();

    child.writeFrame({
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 100,
        environmentId: null,
      },
    });
    child.writeFrame({
      id: 42,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: null,
        serverName: 'cyboflow',
        mode: 'url',
        _meta: null,
        message: 'Open authorization URL',
        url: 'https://example.test/authorize',
        elicitationId: 'elicitation-1',
      },
    });

    expect(child.outboundFrames()).toEqual([
      { id: 41, result: { decision: 'cancel' } },
      { id: 42, result: { action: 'cancel', content: null, _meta: null } },
    ]);
  });

  it('rejects unsupported server requests without failing open', () => {
    const unhandled = vi.fn();
    const { child, client } = makeHarness({ onUnhandledServerRequest: unhandled });

    child.writeFrame({
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: { permissions: ['network'] },
    });

    expect(child.outboundFrames()).toEqual([{
      id: 'permissions-1',
      error: {
        code: -32601,
        message: 'Unsupported Codex app-server request: item/permissions/requestApproval',
      },
    }]);
    expect(unhandled).toHaveBeenCalledWith({
      id: 'permissions-1',
      method: 'item/permissions/requestApproval',
      params: { permissions: ['network'] },
    });
    expect(client.state).toBe('running');
  });

  it('fails closed on malformed JSON and rejects all correlated requests', async () => {
    const errors: Error[] = [];
    const { child, client } = makeHarness({ onError: (error) => errors.push(error) });
    const pending = client.sendRequest<unknown, object>('thread/start', {});
    const caught = pending.catch((error: unknown) => error);

    child.stdout.write('{"id":1,"result":]\n');

    expect(await caught).toBeInstanceOf(AppServerProtocolError);
    expect(client.state).toBe('failed');
    expect(child.killCalls).toEqual(['SIGTERM']);
    expect(errors[0]).toBeInstanceOf(AppServerProtocolError);
    expect(() => client.sendNotification('after/failure')).toThrow(AppServerTransportError);
  });

  it('fails closed when a known approval request has malformed nested parameters', () => {
    const { child, client } = makeHarness();

    child.writeFrame({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: 100,
        environmentId: null,
        commandActions: 'not-an-array',
      },
    });

    expect(client.state).toBe('failed');
    expect(child.killCalls).toEqual(['SIGTERM']);
    expect(child.outboundFrames()).toEqual([]);
  });

  it('forwards stderr and rejects pending requests when the process exits', async () => {
    const stderr: string[] = [];
    const exits: unknown[] = [];
    const errors: Error[] = [];
    const { child, client } = makeHarness({
      onStderr: (chunk) => stderr.push(chunk),
      onExit: (exit) => exits.push(exit),
      onError: (error) => errors.push(error),
    });
    const pending = client.sendRequest<unknown, object>('turn/start', {});
    const caught = pending.catch((error: unknown) => error);

    child.stderr.write('warning from codex\n');
    child.emit('exit', 7, 'SIGTERM');

    expect(stderr).toEqual(['warning from codex\n']);
    expect(await caught).toBeInstanceOf(AppServerExitedError);
    expect(client.state).toBe('exited');
    expect(exits).toEqual([{ code: 7, signal: 'SIGTERM' }]);
    expect(errors[0]).toBeInstanceOf(AppServerExitedError);
  });

  it('stops once, rejects pending requests, and treats the resulting exit as expected', async () => {
    const exits: unknown[] = [];
    const errors: Error[] = [];
    const { child, client } = makeHarness({
      onExit: (exit) => exits.push(exit),
      onError: (error) => errors.push(error),
    });
    const pending = client.sendRequest<unknown, object>('turn/start', {});
    const caught = pending.catch((error: unknown) => error);

    client.stop('SIGINT');
    client.stop('SIGTERM');

    expect(await caught).toMatchObject({
      name: 'AppServerTransportError',
      message: 'Codex app-server transport stopped',
    });
    expect(client.state).toBe('stopping');
    expect(child.killCalls).toEqual(['SIGINT']);

    child.emit('exit', null, 'SIGINT');

    expect(client.state).toBe('exited');
    expect(exits).toEqual([{ code: null, signal: 'SIGINT' }]);
    expect(errors).toEqual([]);
  });

  it('treats child-process errors as fatal transport failures', async () => {
    const { child, client } = makeHarness();
    const pending = client.sendRequest<unknown, object>('turn/start', {});
    const caught = pending.catch((error: unknown) => error);

    child.emit('error', new Error('spawned process failed'));

    expect(await caught).toMatchObject({
      name: 'AppServerTransportError',
      message: 'Codex app-server process failed: spawned process failed',
    });
    expect(client.state).toBe('failed');
    expect(child.killCalls).toEqual(['SIGTERM']);
  });
});
