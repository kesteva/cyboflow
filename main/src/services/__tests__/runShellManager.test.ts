/**
 * Unit tests for RunShellManager — the run-worktree-scoped user shell PTY.
 *
 * The node-pty spawner is injected, so these run without the native module:
 * a fake PTY records writes/resizes/kills and lets the test drive onData/onExit.
 * ShellDetector + getShellPath are mocked to keep spawn hermetic (no execSync).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunShellManager, type ManagedPty, type ShellSpawner } from '../runShellManager';

vi.mock('../../utils/shellDetector', () => ({
  ShellDetector: { getDefaultShell: () => ({ path: '/bin/zsh', name: 'zsh', args: [] }) },
}));
vi.mock('../../utils/shellPath', () => ({ getShellPath: () => '/usr/bin:/bin' }));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakePty extends ManagedPty {
  emitData(data: string): void;
  emitExit(exitCode?: number): void;
  written: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
}

function makeFakePty(): FakePty {
  let onDataCb: ((d: string) => void) | null = null;
  let onExitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const written: string[] = [];
  const resizes: Array<[number, number]> = [];
  return {
    pid: 4242,
    written,
    resizes,
    killed: false,
    onData(cb) {
      onDataCb = cb;
    },
    onExit(cb) {
      onExitCb = cb;
    },
    write(d) {
      written.push(d);
    },
    resize(c, r) {
      resizes.push([c, r]);
    },
    kill() {
      this.killed = true;
    },
    emitData(d) {
      onDataCb?.(d);
    },
    emitExit(exitCode = 0) {
      onExitCb?.({ exitCode });
    },
  };
}

interface SpawnRecord {
  file: string;
  args: string[] | string;
  options: { cwd?: string; env?: Record<string, string | undefined> };
  pty: FakePty;
}

function makeHarness(opts?: { worktree?: string | null }) {
  // `undefined` → resolve a distinct worktree per run id (so multiple shells can
  // coexist); an explicit value (incl. null) → return it for every run.
  const fixed = opts?.worktree;
  const spawns: SpawnRecord[] = [];
  const emits: Array<{ runId: string; chunk: string }> = [];
  const spawner: ShellSpawner = (file, args, options) => {
    const pty = makeFakePty();
    spawns.push({ file, args, options: options as SpawnRecord['options'], pty });
    return pty;
  };
  const resolveWorktree = vi.fn((runId: string) =>
    fixed === undefined ? `/wt/${runId}` : fixed,
  );
  const emitBytes = (runId: string, chunk: string) => emits.push({ runId, chunk });
  const mgr = new RunShellManager(resolveWorktree, emitBytes, spawner);
  return { mgr, spawns, emits, resolveWorktree };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// open()
// ---------------------------------------------------------------------------

describe('RunShellManager.open', () => {
  it('spawns the default shell in the run worktree and reports ok', () => {
    const { mgr, spawns } = makeHarness({ worktree: '/wt/run-1' });

    const result = mgr.open('run-1');

    expect(result).toEqual({ ok: true });
    expect(spawns).toHaveLength(1);
    expect(spawns[0].file).toBe('/bin/zsh');
    expect(spawns[0].options.cwd).toBe('/wt/run-1');
    expect(spawns[0].options.env?.WORKTREE_PATH).toBe('/wt/run-1');
    // The user shell must NOT leak the run id into the env (would hijack any
    // `claude` the user launches in the shell).
    expect(spawns[0].options.env?.CYBOFLOW_RUN_ID).toBeUndefined();
    expect(mgr.isOpen('run-1')).toBe(true);
  });

  it('is idempotent — a second open for a live shell does not re-spawn', () => {
    const { mgr, spawns } = makeHarness();
    expect(mgr.open('run-1')).toEqual({ ok: true });
    expect(mgr.open('run-1')).toEqual({ ok: true });
    expect(spawns).toHaveLength(1);
  });

  it('returns no_worktree (no spawn) when the run has no worktree', () => {
    const { mgr, spawns } = makeHarness({ worktree: null });
    const result = mgr.open('run-1');
    expect(result).toEqual({ ok: false, reason: 'no_worktree' });
    expect(spawns).toHaveLength(0);
    expect(mgr.isOpen('run-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// byte stream + backlog
// ---------------------------------------------------------------------------

describe('RunShellManager byte stream', () => {
  it('forwards PTY data to emitBytes and accumulates the backlog', () => {
    const { mgr, spawns, emits } = makeHarness();
    mgr.open('run-1');

    spawns[0].pty.emitData('hello ');
    spawns[0].pty.emitData('world');

    expect(emits).toEqual([
      { runId: 'run-1', chunk: 'hello ' },
      { runId: 'run-1', chunk: 'world' },
    ]);
    expect(mgr.getBacklog('run-1')).toBe('hello world');
  });

  it('trims the backlog to the cap while still emitting every chunk live', () => {
    const { mgr, spawns, emits } = makeHarness();
    mgr.open('run-1');

    spawns[0].pty.emitData('x'.repeat(300_000));

    expect(mgr.getBacklog('run-1').length).toBe(256_000);
    // The live emit is never truncated — only the retained replay buffer is.
    expect(emits[0].chunk.length).toBe(300_000);
  });

  it('getBacklog is empty for an unknown run', () => {
    const { mgr } = makeHarness();
    expect(mgr.getBacklog('nope')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// write / resize
// ---------------------------------------------------------------------------

describe('RunShellManager.write / resize', () => {
  it('writes keystrokes and relays positive resizes to the PTY', () => {
    const { mgr, spawns } = makeHarness();
    mgr.open('run-1');

    mgr.write('run-1', 'ls\r');
    mgr.resize('run-1', 120, 40);

    expect(spawns[0].pty.written).toEqual(['ls\r']);
    expect(spawns[0].pty.resizes).toEqual([[120, 40]]);
  });

  it('ignores non-positive resizes (node-pty throws on 0×0)', () => {
    const { mgr, spawns } = makeHarness();
    mgr.open('run-1');
    mgr.resize('run-1', 0, 0);
    mgr.resize('run-1', 80, 0);
    expect(spawns[0].pty.resizes).toEqual([]);
  });

  it('write / resize for an unknown run are silent no-ops', () => {
    const { mgr } = makeHarness();
    expect(() => mgr.write('nope', 'x')).not.toThrow();
    expect(() => mgr.resize('nope', 80, 24)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

describe('RunShellManager teardown', () => {
  it('close() kills the PTY and forgets the run', () => {
    const { mgr, spawns } = makeHarness();
    mgr.open('run-1');
    mgr.close('run-1');
    expect(spawns[0].pty.killed).toBe(true);
    expect(mgr.isOpen('run-1')).toBe(false);
    expect(mgr.getBacklog('run-1')).toBe('');
  });

  it('a PTY exit frees the slot so a later open re-spawns', () => {
    const { mgr, spawns } = makeHarness();
    mgr.open('run-1');
    spawns[0].pty.emitExit(0);
    expect(mgr.isOpen('run-1')).toBe(false);
    mgr.open('run-1');
    expect(spawns).toHaveLength(2);
  });

  it('destroyAll() kills every shell and clears the registry', () => {
    // Default harness resolves a distinct worktree per run id.
    const { mgr, spawns } = makeHarness();
    mgr.open('run-1');
    mgr.open('run-2');

    mgr.destroyAll();

    expect(spawns.every((s) => s.pty.killed)).toBe(true);
    expect(mgr.isOpen('run-1')).toBe(false);
    expect(mgr.isOpen('run-2')).toBe(false);
  });
});
