/**
 * remoteFencing (spec M2 §7): the fixed F1/F2/F3 programs EXECUTED under the real local /bin/sh (through
 * quoteRemoteArgv, exactly as the remote login shell receives them) against real processes and files, their parse
 * round trip through every login shell, and the JS wrappers / quit-drain tracker over fakes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ExecResult, MachineExec } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import {
  FENCE_PROGRAM,
  RUN_DIR_GC_PROGRAM,
  RUN_REAP_PROGRAM,
  TOKEN_REMOVE_PROGRAM,
  RemoteProcessTracker,
  fenceArgv,
  fenceSpawnKey,
  gcRemoteRunDir,
  parseFenceOutput,
  parseRunDirGcOutput,
  reapRunPidFiles,
  runDirGcArgv,
  runPidFileGlobs,
  runReapArgv,
  tokenRemoveArgv,
  type TrackedRemoteProcess,
} from '../remoteFencing';
import { quoteRemoteArgv, spawnCapture } from '../sshTransport';

const posix = process.platform !== 'win32';
const NONCE_A = '0123456789abcdef';
const NONCE_B = 'fedcba9876543210';
const silent: LoggerLike = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

let home: string | null = null;
const victims: ChildProcess[] = [];

afterEach(() => {
  for (const v of victims.splice(0)) {
    try {
      if (v.pid) process.kill(-v.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function setup(): { root: string; run: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cf-fence-')));
  const root = join(home, 'cf-remote', 'h1');
  const run = join(root, 'run');
  mkdirSync(run, { recursive: true });
  return { root, run };
}

/** A MachineExec that runs the argv like ssh does: one quoted command string parsed by a login /bin/sh. */
function localExec(): MachineExec & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (argv, opts) => {
      calls.push(argv);
      return spawnCapture('/bin/sh', ['-c', quoteRemoteArgv(argv)], {
        env: { PATH: '/usr/bin:/bin', HOME: home ?? tmpdir() },
        timeoutMs: opts?.timeoutMs ?? 15_000,
      });
    },
  };
}

/** A detached process leads its own group (pgid = pid), like the sshd session the spawn wrapper records. */
function victim(script: string): { proc: ChildProcess; exited: Promise<NodeJS.Signals | null> } {
  const proc = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  victims.push(proc);
  const exited = new Promise<NodeJS.Signals | null>((resolve) => proc.on('exit', (_c, sig) => resolve(sig)));
  return { proc, exited };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Spawn a process that cannot have a pid > 2^22 on any of our OSes: a guaranteed-dead pid. */
const DEAD_PID = 4_000_000;

function old(path: string): void {
  const t = new Date(Date.now() - 25 * 3600 * 1000);
  utimesSync(path, t, t);
}

// ---------------------------------------------------------------------------------------------------------------

describe.skipIf(!posix)('the fencing programs parse back byte-identical through every login shell', () => {
  const shells = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/tcsh', '/bin/csh'].filter((s) => existsSync(s));
  const programs = { FENCE_PROGRAM, RUN_REAP_PROGRAM, RUN_DIR_GC_PROGRAM, TOKEN_REMOVE_PROGRAM };
  for (const shell of shells) {
    it(shell, async () => {
      for (const [name, program] of Object.entries(programs)) {
        expect(program.includes('\n'), name).toBe(false);
        const argv = ['/bin/sh', '-c', program, 'sh', "/x/it's ! $HOME", 'k.[0-9a-f].pid', '!$'];
        const args = shell.endsWith('csh') || shell.endsWith('zsh') ? ['-f', '-c'] : ['-c'];
        const r = await spawnCapture(shell, [...args, `/usr/bin/printf '%s\\0' ${quoteRemoteArgv(argv)}`], {
          env: { PATH: '/usr/bin:/bin', HOME: tmpdir() }, timeoutMs: 10_000,
        });
        const words = r.stdout.split('\0');
        words.pop();
        expect(words, `${shell} ${name}`).toEqual(argv);
      }
    });
  }
});

describe.skipIf(!posix)('FENCE_PROGRAM under the real /bin/sh', () => {
  it('TERMs a live process group of the key, removes stale / reused-pid pidfiles, leaves other keys alone', async () => {
    const { root, run } = setup();
    const childPidFile = join(home as string, 'child.pid');
    const group = victim(`/bin/sleep 30 & echo $! > '${childPidFile}'; wait`);
    expect(await until(() => existsSync(childPidFile) && readFileSync(childPidFile, 'utf8').trim() !== '')).toBe(true);
    const grandchild = Number(readFileSync(childPidFile, 'utf8').trim());
    const bystander = victim('exec /bin/sleep 30');
    const otherKey = victim('exec /bin/sleep 30');
    const gp = group.proc.pid as number;
    const bp = bystander.proc.pid as number;
    const op = otherKey.proc.pid as number;

    writeFileSync(join(run, `lane-1.${NONCE_A}.pid`), `${gp} ${gp}\n`);
    writeFileSync(join(run, `lane-1.${NONCE_B}.pid`), `${DEAD_PID} ${DEAD_PID}\n`);
    // Alive pid but recorded in ANOTHER group: a reused pid — never signalled.
    writeFileSync(join(run, `lane-1.aaaaaaaaaaaaaaaa.pid`), `${bp} ${DEAD_PID}\n`);
    writeFileSync(join(run, `lane-1.bbbbbbbbbbbbbbbb.pid`), 'garbage\n');
    // `lane-1.x` is a different spawnKey whose name starts with `lane-1.`.
    writeFileSync(join(run, `lane-1.x.${NONCE_A}.pid`), `${op} ${op}\n`);
    writeFileSync(join(run, 'run-1.token'), 'secret\n');

    const exec = localExec();
    const r = await exec.exec(fenceArgv(root, 'lane-1', 10));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(parseFenceOutput(r.stdout)).toEqual({ termed: 1, killed: 0, stale: 3 });
    expect(await group.exited).toBe('SIGTERM');
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(alive(bp)).toBe(true);
    expect(alive(op)).toBe(true);
    expect(existsSync(join(run, `lane-1.${NONCE_A}.pid`))).toBe(false);
    expect(existsSync(join(run, `lane-1.${NONCE_B}.pid`))).toBe(false);
    expect(existsSync(join(run, 'lane-1.aaaaaaaaaaaaaaaa.pid'))).toBe(false);
    expect(existsSync(join(run, `lane-1.x.${NONCE_A}.pid`))).toBe(true);
    expect(existsSync(join(run, 'run-1.token'))).toBe(true);
  });

  it('KILLs a survivor of TERM after the wait and removes its pidfile', async () => {
    const { root, run } = setup();
    const stubborn = victim('trap "" TERM; exec /bin/sleep 30');
    const sp = stubborn.proc.pid as number;
    await new Promise((r) => setTimeout(r, 150)); // let the trap install
    writeFileSync(join(run, `k.${NONCE_A}.pid`), `${sp} ${sp}\n`);
    const started = Date.now();
    const r = await localExec().exec(fenceArgv(root, 'k', 6));
    expect(parseFenceOutput(r.stdout)).toEqual({ termed: 1, killed: 1, stale: 0 });
    expect(await stubborn.exited).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(existsSync(join(run, `k.${NONCE_A}.pid`))).toBe(false);
  });

  it('nothing to fence (no run dir, no match) is a fast `0 0 0`', async () => {
    const { root } = setup();
    expect(parseFenceOutput((await localExec().exec(fenceArgv(root, 'none'))).stdout)).toEqual({ termed: 0, killed: 0, stale: 0 });
    expect(parseFenceOutput((await localExec().exec(fenceArgv(join(root, 'missing'), 'none'))).stdout)).toEqual({ termed: 0, killed: 0, stale: 0 });
  });
});

describe.skipIf(!posix)('RUN_REAP_PROGRAM under the real /bin/sh', () => {
  it("removes the run's dead pidfiles only: live, empty and other runs' files stay", async () => {
    const { root, run } = setup();
    const live = victim('exec /bin/sleep 30');
    const lp = live.proc.pid as number;
    writeFileSync(join(run, `run-1.${NONCE_A}.pid`), `${DEAD_PID} ${DEAD_PID}\n`);
    writeFileSync(join(run, `run-1_item-2-abcd1234.${NONCE_A}.pid`), `${DEAD_PID} 7\n`);
    writeFileSync(join(run, `run-1.${NONCE_B}.pid`), `${lp} ${lp}\n`);
    writeFileSync(join(run, `run-1-x.${NONCE_B}.pid`), '');
    writeFileSync(join(run, `run-2.${NONCE_A}.pid`), `${DEAD_PID} ${DEAD_PID}\n`);
    writeFileSync(join(run, 'run-1.token'), 't\n');
    const exec = localExec();
    expect(await reapRunPidFiles(exec, root, 'run-1', { hostId: 'h1' })).toBe(2);
    expect(existsSync(join(run, `run-1.${NONCE_A}.pid`))).toBe(false);
    expect(existsSync(join(run, `run-1_item-2-abcd1234.${NONCE_A}.pid`))).toBe(false);
    expect(existsSync(join(run, `run-1.${NONCE_B}.pid`))).toBe(true);
    expect(existsSync(join(run, `run-1-x.${NONCE_B}.pid`))).toBe(true);
    expect(existsSync(join(run, `run-2.${NONCE_A}.pid`))).toBe(true);
    expect(existsSync(join(run, 'run-1.token'))).toBe(true);
    expect(alive(lp)).toBe(true);
    expect(await reapRunPidFiles(exec, join(root, 'missing'), 'run-1', { hostId: 'h1' })).toBe(0);
  });

  it('globs cover the bare key and the lane keys remoteSpawnKey derives; an unsafe run id is refused', () => {
    expect(runPidFileGlobs('run-1')).toEqual(['run-1.*.pid', 'run-1-*.pid', 'run-1_*.pid']);
    expect(runPidFileGlobs('a:b')).toEqual(['a_b.*.pid', 'a_b-*.pid', 'a_b_*.pid']);
    expect(() => runPidFileGlobs('../x')).toThrow();
    expect(runReapArgv('/r', 'run-1').slice(0, 5)).toEqual(['/bin/sh', '-c', RUN_REAP_PROGRAM, 'sh', '/r/run']);
  });
});

describe.skipIf(!posix)('RUN_DIR_GC_PROGRAM + TOKEN_REMOVE_PROGRAM under the real /bin/sh', () => {
  it('collects old dead pidfiles and temp files, keeps live / fresh ones, lists old tokens for the caller', async () => {
    const { root, run } = setup();
    const live = victim('exec /bin/sleep 30');
    const lp = live.proc.pid as number;
    const files: Record<string, string> = {
      [`old-dead.${NONCE_A}.pid`]: `${DEAD_PID} ${DEAD_PID}\n`,
      [`old-garbage.${NONCE_A}.pid`]: 'x\n',
      [`old-live.${NONCE_A}.pid`]: `${lp} ${lp}\n`,
      [`fresh-dead.${NONCE_A}.pid`]: `${DEAD_PID} ${DEAD_PID}\n`,
      'old-run.token': 't\n',
      'active-run.token': 't\n',
      'fresh-run.token': 't\n',
      'x.token.cf-tmp.123': 'partial',
      '.hidden-old': 'h',
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(run, name), body);
      if (!name.startsWith('fresh')) old(join(run, name));
    }
    mkdirSync(join(run, 'old-dir'));
    old(join(run, 'old-dir'));

    const exec = localExec();
    const raw = await exec.exec(runDirGcArgv(root));
    expect(raw.code).toBe(0);
    const parsed = parseRunDirGcOutput(raw.stdout);
    expect(parsed.staleTokenRunIds.sort()).toEqual(['active-run', 'old-run']);
    expect(parsed.removed).toBe(4);
    const left = (n: string): boolean => existsSync(join(run, n));
    expect(left(`old-dead.${NONCE_A}.pid`)).toBe(false);
    expect(left(`old-garbage.${NONCE_A}.pid`)).toBe(false);
    expect(left('x.token.cf-tmp.123')).toBe(false);
    expect(left('.hidden-old')).toBe(false);
    expect(left(`old-live.${NONCE_A}.pid`)).toBe(true);
    expect(left(`fresh-dead.${NONCE_A}.pid`)).toBe(true);
    expect(left('old-dir')).toBe(true);
    expect(left('old-run.token')).toBe(true); // the scan never deletes a token itself

    // The JS pass: only tokens of runs that are not active, invalidation strictly before the remove.
    const order: string[] = [];
    const recording: MachineExec = {
      exec: async (argv, opts) => {
        order.push(argv[2] === TOKEN_REMOVE_PROGRAM ? 'remove' : 'scan');
        return exec.exec(argv, opts);
      },
    };
    for (const n of ['old-dead2.pid', 'old-run.token', 'active-run.token']) {
      if (!existsSync(join(run, n))) writeFileSync(join(run, n), `${DEAD_PID}\n`);
      old(join(run, n));
    }
    const out = await gcRemoteRunDir(recording, root, {
      hostId: 'h1',
      logger: silent,
      canRemoveToken: (id) => id !== 'active-run',
      beforeRemoveTokens: (ids) => order.push(`forget:${ids.join(',')}`),
    });
    expect(out).toEqual({ removed: 1, tokensRemoved: 1, tokensKept: 1 });
    expect(order).toEqual(['scan', 'forget:old-run', 'remove']);
    expect(left('old-run.token')).toBe(false);
    expect(left('active-run.token')).toBe(true);
  });

  it('TOKEN_REMOVE_PROGRAM removes only plain `.token` basenames in the run dir', async () => {
    const { root, run } = setup();
    writeFileSync(join(run, 'a.token'), 't');
    writeFileSync(join(run, 'b.pid'), '1');
    writeFileSync(join(root, 'outside.token'), 't');
    const r = await localExec().exec(tokenRemoveArgv(root, ['a.token', 'b.pid', '../outside.token', '.token', '', 'missing.token']));
    expect(r.stdout.trim()).toBe('1');
    expect(existsSync(join(run, 'a.token'))).toBe(false);
    expect(existsSync(join(run, 'b.pid'))).toBe(true);
    expect(existsSync(join(root, 'outside.token'))).toBe(true);
  });

  it('no predicate → no token is ever removed; a missing run dir is an empty pass', async () => {
    const { root, run } = setup();
    writeFileSync(join(run, 'r.token'), 't');
    old(join(run, 'r.token'));
    expect(await gcRemoteRunDir(localExec(), root, { hostId: 'h1' })).toEqual({ removed: 0, tokensRemoved: 0, tokensKept: 1 });
    expect(existsSync(join(run, 'r.token'))).toBe(true);
    expect(await gcRemoteRunDir(localExec(), join(root, 'nope'), { hostId: 'h1' })).toEqual({ removed: 0, tokensRemoved: 0, tokensKept: 0 });
  });
});

describe('parsers and wrappers over fakes', () => {
  it('parseRunDirGcOutput accepts only names this app writes', () => {
    expect(parseRunDirGcOutput('r1.token\n../x.token\nbad name.token\n..token\nok:1.token\n#3\n')).toEqual({
      staleTokenRunIds: ['r1', 'ok:1'],
      removed: 3,
    });
    expect(parseFenceOutput('junk')).toBeNull();
  });

  it('fenceSpawnKey never rejects: exec failure / non-zero / bad root / unsafe key → null, with a warning', async () => {
    const warn = vi.fn();
    const logger = { ...silent, warn };
    const failing: MachineExec = { exec: async () => { throw new Error('ssh down'); } };
    expect(await fenceSpawnKey(failing, '/r', 'k', { hostId: 'h1', logger })).toBeNull();
    const nonZero: MachineExec = { exec: async (): Promise<ExecResult> => ({ code: 255, stdout: '', stderr: 'x', timedOut: false }) };
    expect(await fenceSpawnKey(nonZero, '/r', 'k', { hostId: 'h1', logger })).toBeNull();
    expect(await fenceSpawnKey(nonZero, '~/r', 'k', { hostId: 'h1', logger })).toBeNull();
    expect(await fenceSpawnKey(nonZero, '/r', 'a b', { hostId: 'h1', logger })).toBeNull();
    expect(warn).toHaveBeenCalled();
    const ok: MachineExec = { exec: async (argv, opts) => {
      expect(argv).toEqual(fenceArgv('/r', 'k'));
      expect(opts?.timeoutMs).toBe(4_500);
      return { code: 0, stdout: '2 1 0\n', stderr: '', timedOut: false };
    } };
    expect(await fenceSpawnKey(ok, '/r', 'k', { hostId: 'h1', logger })).toEqual({ termed: 2, killed: 1, stale: 0 });
  });

  it('fenceSpawnKey is bounded even when the exec never settles', async () => {
    const hung: MachineExec = { exec: () => new Promise(() => undefined) };
    const started = Date.now();
    expect(await fenceSpawnKey(hung, '/r', 'k', { hostId: 'h1', logger: silent, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------

class FakeProc extends EventEmitter {
  readonly stdin = new PassThrough();
  get ended(): boolean {
    return this.stdin.writableEnded;
  }
}

function tracked(tracker: RemoteProcessTracker, behaviour: { exitOnTerm: boolean }): {
  proc: FakeProc;
  signals: string[];
  localKills: number;
} {
  const proc = new FakeProc();
  const state = { proc, signals: [] as string[], localKills: 0 };
  const exit = (): void => {
    untrack();
    proc.emit('exit', null, 'SIGTERM');
  };
  const entry: TrackedRemoteProcess = {
    hostId: 'h1',
    proc: proc as unknown as TrackedRemoteProcess['proc'],
    signalRemote: async (signal) => {
      state.signals.push(signal);
      if (signal === 'TERM' && behaviour.exitOnTerm) queueMicrotask(exit);
      if (signal === 'KILL') queueMicrotask(exit);
    },
    killLocal: () => {
      state.localKills++;
    },
  };
  const untrack = tracker.add(entry);
  return state;
}

describe('RemoteProcessTracker.drain (quit)', () => {
  it('no live process → resolves at once without sleeping', async () => {
    const sleep = vi.fn(async () => undefined);
    expect(await new RemoteProcessTracker().drain({ sleep })).toEqual({ total: 0, exited: 0, forced: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stdin EOF + remote TERM to all; exits within the TERM window are never KILLed', async () => {
    const tracker = new RemoteProcessTracker();
    const a = tracked(tracker, { exitOnTerm: true });
    const b = tracked(tracker, { exitOnTerm: true });
    const sleep = vi.fn(() => new Promise<void>(() => undefined)); // the window never elapses
    const out = await tracker.drain({ sleep, logger: silent });
    expect(out).toEqual({ total: 2, exited: 2, forced: 0 });
    expect(a.signals).toEqual(['TERM']);
    expect(b.signals).toEqual(['TERM']);
    expect(a.proc.ended && b.proc.ended).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it('survivors of the TERM window get remote KILL + local SIGKILL; the whole drain respects the budget', async () => {
    const tracker = new RemoteProcessTracker();
    const quick = tracked(tracker, { exitOnTerm: true });
    const stubborn = tracked(tracker, { exitOnTerm: false });
    const slept: number[] = [];
    const out = await tracker.drain({ budgetMs: 2_000, sleep: async (ms) => { slept.push(ms); }, logger: silent });
    expect(quick.signals).toEqual(['TERM']);
    expect(stubborn.signals).toEqual(['TERM', 'KILL']);
    expect(stubborn.localKills).toBe(1);
    expect(out.total).toBe(2);
    expect(out.forced).toBe(1);
    expect(slept.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(2_000);
  });

  it('a process that never exits is abandoned at the budget (real timers)', async () => {
    const tracker = new RemoteProcessTracker();
    const proc = new FakeProc();
    tracker.add({ hostId: 'h1', proc: proc as unknown as TrackedRemoteProcess['proc'], signalRemote: async () => undefined, killLocal: () => undefined });
    const started = Date.now();
    const out = await tracker.drain({ budgetMs: 200 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toEqual({ total: 1, exited: 0, forced: 1 });
  });
});
