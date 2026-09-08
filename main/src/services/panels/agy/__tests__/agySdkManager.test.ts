import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import { AgySdkManager } from '../agySdkManager';

const spawnMock = vi.hoisted(() =>
  vi.fn((_exe: string, args: string[], _opts: unknown) => {
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: {
        write: vi.fn(),
        end: vi.fn(),
      },
      stdout,
      stderr,
      killed: false,
      kill: vi.fn(),
    });

    // Simulate agy output stream
    queueMicrotask(() => {
      stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            event: 'init',
            conversation_id: 'conv-test-123',
            init: { cwd: '/tmp', tools: ['view_file'] },
          }) + '\n',
        ),
      );
      stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'conv-test-123',
              status: 'SUCCESS',
              response: 'Hello from Antigravity',
              duration_seconds: 0.5,
            },
          }) + '\n',
        ),
      );
      emitter.emit('close', 0);
    });

    return child;
  }),
);

vi.mock('node:child_process', () => ({ spawn: spawnMock, exec: vi.fn() }));

class TestableAgySdk extends AgySdkManager {
  protected override getCliExecutablePath(): Promise<string> {
    return Promise.resolve('/fake/agy');
  }
}

function makeManager() {
  return new TestableAgySdk(
    { getDbSession: () => null } as never,
    undefined,
    { getDefaultAgentPermissionMode: () => 'default' } as never,
  );
}

type SpawnCall = [string, string[], { env: Record<string, string | undefined> }];

function lastSpawnCall(): SpawnCall {
  const call = spawnMock.mock.calls.at(-1) as SpawnCall | undefined;
  if (!call) throw new Error('spawn was never called');
  return call;
}

describe('AgySdkManager turn spawning and conversation resumption', () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it('spawns agy with prompt, output format, model, and effort', async () => {
    const mgr = makeManager();
    const outcome = await mgr.spawnCliProcess({
      panelId: 'panel-1',
      sessionId: 'sess-1',
      worktreePath: '/tmp/wt',
      prompt: 'say hi',
      model: 'gemini-3.8-flash-high',
      reasoningEffort: 'high',
      agentPermissionMode: 'dontAsk',
    } satisfies ClaudeSpawnerOptions);

    expect(outcome.resultText).toBe('Hello from Antigravity');

    const [, args] = lastSpawnCall();
    expect(args).toContain('-p');
    expect(args).toContain('say hi');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-3.8-flash-high');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('resumes with recorded conversationId on subsequent turns', async () => {
    const mgr = makeManager();

    // Turn 1
    await mgr.spawnCliProcess({
      panelId: 'panel-2',
      sessionId: 'sess-2',
      worktreePath: '/tmp/wt',
      prompt: 'turn 1',
    });
    const [, argsTurn1] = lastSpawnCall();
    expect(argsTurn1).not.toContain('--conversation');

    // Turn 2: uses conv-test-123 recorded from turn 1's init event
    await mgr.spawnCliProcess({
      panelId: 'panel-2',
      sessionId: 'sess-2',
      worktreePath: '/tmp/wt',
      prompt: 'turn 2',
    });
    const [, argsTurn2] = lastSpawnCall();
    expect(argsTurn2).toContain('--conversation');
    expect(argsTurn2).toContain('conv-test-123');
  });
});
