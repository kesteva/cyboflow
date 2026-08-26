import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import type * as NodeOS from 'node:os';
import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import { PiSdkManager } from '../piSdkManager';
import { PI_GATE_ENV_KEYS } from '../piGateExtension';

/**
 * Pins the permission-mode → env handoff on the pi sdk lane: the turn's
 * resolved `agentPermissionMode` must reach CYBOFLOW_GATE_MODE on the spawned
 * `pi --mode json` process ('dontAsk' passes through; omitted/default/
 * acceptEdits/auto all fail closed to 'gated') — on fresh AND reused panels.
 * Also pins the argv/stdin contract: lockdown pair + explicit `-e` gate file,
 * exactly one `--print`, and the prompt riding STDIN, never argv.
 */

const spawnMock = vi.hoisted(() =>
  vi.fn((_exe: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: {
        write(s: string) {
          stdinWrites.push(s);
        },
        end: vi.fn(),
      },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(),
    });
    // Settle every turn asynchronously with a clean exit.
    queueMicrotask(() => emitter.emit('close', 0));
    return child;
  }),
);

vi.mock('node:child_process', () => ({ spawn: spawnMock, exec: vi.fn() }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOS>()),
  homedir: () => fakeHome,
}));

// Closures above capture these bindings; they are only READ at test runtime
// (per spawn / per gate-file write), long after both initializers ran.
let fakeHome = '';
const stdinWrites: string[] = [];

/** Bypass the PATH/version-probe ladder; the spawn itself is fully mocked. */
class TestablePiSdk extends PiSdkManager {
  protected override getCliExecutablePath(): Promise<string> {
    return Promise.resolve('/fake/pi');
  }
}

function makeManager() {
  return new TestablePiSdk(
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

/** One settled turn; returns the env the spawn received. */
async function spawnOnce(mgr: TestablePiSdk, over: Partial<ClaudeSpawnerOptions> = {}) {
  await mgr.spawnCliProcess({
    // FIXED panelId: the reused-panel case depends on both turns landing here.
    panelId: 'panel-1',
    sessionId: 'sess-shared',
    worktreePath: '/tmp/wt',
    prompt: 'do a thing',
    ...over,
  } satisfies ClaudeSpawnerOptions);
  return lastSpawnCall()[2].env;
}

describe('PiSdkManager gate mode (CYBOFLOW_GATE_MODE)', () => {
  beforeEach(() => {
    stdinWrites.length = 0;
    spawnMock.mockClear();
    fakeHome = mkdtempSync(path.join(tmpdir(), 'pi-gate-home-'));
  });
  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("threads agentPermissionMode 'dontAsk' through to the gate env", async () => {
    const env = await spawnOnce(makeManager(), { agentPermissionMode: 'dontAsk' });
    expect(env[PI_GATE_ENV_KEYS.mode]).toBe('dontAsk');
  });

  it("fails closed to 'gated' for omitted/default/acceptEdits/auto", async () => {
    const cases = [undefined, 'default', 'acceptEdits', 'auto'] as const;
    for (const mode of cases) {
      const env = await spawnOnce(makeManager(), { agentPermissionMode: mode });
      expect(env[PI_GATE_ENV_KEYS.mode], `agentPermissionMode=${String(mode)}`).toBe('gated');
    }
  });

  it('reuses the panel but still picks up the CURRENT mode per turn', async () => {
    const mgr = makeManager();
    const first = await spawnOnce(mgr); // no mode → fail closed
    expect(first[PI_GATE_ENV_KEYS.mode]).toBe('gated');
    const second = await spawnOnce(mgr, { agentPermissionMode: 'dontAsk' }); // same manager + panel-1
    expect(second[PI_GATE_ENV_KEYS.mode]).toBe('dontAsk');
  });

  it('spawns with lockdown flags, one --print, and the prompt on stdin only', async () => {
    await spawnOnce(makeManager());
    const args = lastSpawnCall()[1];
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-skills');
    expect(args).toContain('-e');
    expect(args.filter((a) => a === '--print')).toHaveLength(1);
    expect(args).not.toContain('do a thing');
    expect(stdinWrites).toEqual(['do a thing']);
  });
});
