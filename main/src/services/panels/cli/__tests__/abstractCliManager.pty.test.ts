/**
 * B4 — Live PTY base primitives of AbstractCliManager.
 *
 * These tests drive the REAL process-management primitives against REAL child
 * processes (detached `sh`/`node` trees), NOT the pid=0 FakePty bypass used by
 * the sibling claudeCodeManager / interactiveClaudeManager suites. Per the
 * AGENT-GUIDE.md dual-substrate note, `killProcessTree` / `getAllDescendantPids` /
 * `spawnPtyProcess` are LIVE and load-bearing for the interactive substrate.
 *
 * Coverage:
 *  - killProcessTree: real `sh -c 'sleep 100 & sleep 100 & wait'` tree torn down
 *    (verified independently via `pgrep` + `process.kill(pid, 0)`); SIGTERM ->
 *    SIGKILL escalation via a SIGTERM-ignoring child; already-exited pid resolves
 *    without throwing.
 *  - getAllDescendantPids: finds a real descendant tree (`sh -c 'sleep 100 &
 *    sleep 100 & wait'`) recursively; empty-safe on a childless pid.
 *  - spawnPtyProcess: cwd + env threaded to the child, returned IPty exposes a
 *    numeric pid and an exit event; absent command surfaces as a nonzero exit.
 *
 * PLATFORM NOTE: `getAllDescendantPids` shells out to `pgrep -P <pid>`, which is
 * portable across macOS/BSD and Linux and so genuinely enumerates descendants
 * on both. (It previously used GNU-only `ps -o pid= --ppid <pid>`, which errors
 * on macOS/BSD `ps` and was swallowed by a trailing `|| true`, so descendant
 * enumeration silently returned [] on macOS — the primary ship platform.) The
 * killProcessTree kill assertions below still verify teardown independently via
 * `pgrep` + a `process.kill(pid, 0)` liveness probe rather than by asserting on
 * `getAllDescendantPids` itself, to keep that coverage decoupled from the
 * primitive exercised directly in the section below.
 *
 * FIXTURES ARE PLATFORM-CONDITIONAL, deliberately: the `sh` job-control trees,
 * `pgrep` cross-checks, and trappable-signal probes pin POSIX process semantics
 * and skip on Windows, where each has a `win32:`-gated twin (or a cross-platform
 * `node` fixture) exercising the same contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { AbstractCliManager } from '../AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConversationMessage } from '../../../../database/models';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { collectDescendantPids, listPidPpidTableSync } from '../../../../utils/platformProcess';
import { collectDescendantPids as walkPidPpidTable } from '../../../processTable';
import { isAlive, spawnDetachedGrandchildTree, waitUntil } from '../../../../__test_fixtures__/processTree';

// ---------------------------------------------------------------------------
// Minimal concrete subclass exposing the protected primitives under test.
// The CLI-specific abstract methods are stubbed to no-ops — none are exercised
// by the primitives we cover.
// ---------------------------------------------------------------------------

class TestCliManager extends AbstractCliManager {
  constructor() {
    super({} as unknown as SessionManager, undefined, undefined);
  }

  protected getCliToolName(): string {
    return 'testcli';
  }

  protected getAgentProvider(): 'claude' | 'codex' {
    return 'claude';
  }
  protected async testCliAvailability(): Promise<{ available: boolean }> {
    return { available: true };
  }
  protected buildCommandArgs(): string[] {
    return [];
  }
  protected async getCliExecutablePath(): Promise<string> {
    return 'sh';
  }
  protected parseCliOutput(): [] {
    return [];
  }
  protected async initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  protected async cleanupCliResources(): Promise<void> {
    return;
  }
  protected async getCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  async startPanel(): Promise<void> {
    return;
  }
  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[]
  ): Promise<void> {
    return;
  }
  async stopPanel(): Promise<void> {
    return;
  }
  async restartPanelWithHistory(): Promise<void> {
    return;
  }

  // ---- test-only bridges to the protected primitives ----
  public killTree(pid: number): Promise<boolean> {
    return this.killProcessTree(pid, 'panel-under-test', 'session-under-test');
  }
  public descendants(pid: number): Promise<number[]> {
    return this.getAllDescendantPids(pid);
  }
  public spawnPty(
    command: string,
    args: string[],
    cwd: string,
    env: { [key: string]: string }
  ): Promise<IPty> {
    return this.spawnPtyProcess(command, args, cwd, env);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function childPidsOf(pid: number): number[] {
  try {
    const out = execSync(`pgrep -P ${pid} || true`, { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

// Clean env (no undefined values) for pty.spawn's { [k]: string } contract.
function cleanEnv(extra: Record<string, string> = {}): { [key: string]: string } {
  const base: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') base[k] = v;
  }
  return { ...base, ...extra };
}

// ---------------------------------------------------------------------------
// Test lifecycle — track spawned pids/pty and reap them defensively.
// ---------------------------------------------------------------------------

const spawnedChildren: ChildProcess[] = [];
const spawnedPtys: IPty[] = [];

function trackChild(c: ChildProcess): ChildProcess {
  spawnedChildren.push(c);
  return c;
}

afterEach(() => {
  for (const c of spawnedChildren) {
    if (c.pid) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* group gone */
      }
      try {
        process.kill(c.pid, 'SIGKILL');
      } catch {
        /* already dead */
      }
    }
  }
  spawnedChildren.length = 0;
  for (const p of spawnedPtys) {
    try {
      p.kill();
    } catch {
      /* already dead */
    }
  }
  spawnedPtys.length = 0;
  // The base spawnPtyProcess sets a global fallback flag only if pty.spawn
  // throws; clear it so ordering between tests never leaks the node-fallback
  // path into an unrelated case.
  delete (global as typeof global & Record<string, boolean>).testcliNeedsNodeFallback;
});

// ---------------------------------------------------------------------------
// killProcessTree / getAllDescendantPids
// ---------------------------------------------------------------------------

describe('AbstractCliManager.killProcessTree', () => {
  // POSIX-only fixture: a detached `sh` job-control tree torn down via the
  // negative-pid process-group ladder. Windows has no group semantics — the
  // taskkill ladder has its own twin below.
  it.skipIf(process.platform === 'win32')('tears down a real sleep-tree (parent + all descendants gone)', async () => {
    const mgr = new TestCliManager();
    // Detached => the spawned sh is a process-group leader, so the negative-pid
    // group kills in killProcessTree reach the two backgrounded sleeps.
    const child = trackChild(
      spawn('sh', ['-c', 'sleep 100 & sleep 100 & wait'], { detached: true, stdio: 'ignore' })
    );
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');
    if (!pid) throw new Error('no pid');

    // Independently discover the real descendant sleeps (pgrep works on macOS
    // and Linux, unlike the GNU-only `ps --ppid` inside getAllDescendantPids).
    await waitUntil(() => childPidsOf(pid).length >= 2, 5000);
    const kids = childPidsOf(pid);
    expect(kids.length).toBeGreaterThanOrEqual(2);
    expect(kids.every((k) => isAlive(k))).toBe(true);

    await mgr.killTree(pid);

    // Parent and every discovered descendant must be gone.
    const parentGone = await waitUntil(() => !isAlive(pid), 5000);
    expect(parentGone).toBe(true);
    for (const k of kids) {
      const gone = await waitUntil(() => !isAlive(k), 5000);
      expect(gone).toBe(true);
    }
  }, 15000);

  it('escalates SIGTERM -> SIGKILL against a SIGTERM-ignoring child', async () => {
    const mgr = new TestCliManager();
    // A node process that installs a no-op SIGTERM handler: it survives TERM but
    // cannot trap the SIGKILL that killProcessTree escalates to.
    const child = trackChild(
      spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        { detached: true, stdio: 'ignore' }
      )
    );
    const pid = child.pid;
    if (!pid) throw new Error('no pid');

    // POSIX only: a child can install a SIGTERM handler and survive TERM. On
    // Windows process.kill unconditionally terminates, so "TERM was ignored" is
    // unobservable — but the escalation itself still runs: the graceful taskkill
    // rung cannot stop a console app, and the /F rung below does.
    if (process.platform !== 'win32') {
      // Give the handler time to register, then prove a plain SIGTERM is ignored.
      await new Promise((r) => setTimeout(r, 400));
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(isAlive(pid)).toBe(true); // TERM was ignored
    }

    // killProcessTree escalates to SIGKILL, which the child cannot ignore.
    await mgr.killTree(pid);
    const gone = await waitUntil(() => !isAlive(pid), 5000);
    expect(gone).toBe(true);
  }, 15000);

  it('resolves without throwing when the pid has already exited', async () => {
    const mgr = new TestCliManager();
    // A real process that exits 0 immediately — node, not `sh -c`, so the
    // fixture runs identically on every platform.
    const child = trackChild(
      spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' })
    );
    const pid = child.pid;
    if (!pid) throw new Error('no pid');

    // Wait for the process to actually exit.
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await waitUntil(() => !isAlive(pid), 3000);
    expect(isAlive(pid)).toBe(false);

    // Killing an already-dead pid must not throw; returns true (no survivors).
    await expect(mgr.killTree(pid)).resolves.toBe(true);
  }, 15000);

  it.skipIf(process.platform !== 'win32')(
    'win32: tears down a real node tree via the taskkill ladder (parent + descendants gone)',
    async () => {
      const mgr = new TestCliManager();
      // A node child with its own long-lived detached grandchild — the taskkill
      // ladder (shared-table descendant enumeration + /T /F) must take BOTH;
      // the POSIX `kill`/`pkill` ladder below is a silent no-op on Windows.
      const child = trackChild(
        spawnDetachedGrandchildTree()
      );
      const pid = child.pid;
      if (!pid) throw new Error('no pid');

      // Independently discover the grandchild BEFORE the kill, through the
      // shared pid/ppid table rather than the production enumeration. It is
      // detached, so a tree walk that loses the parent link orphans it — the
      // exact case this ladder exists for, and the one the old assertion on
      // the parent alone could not see.
      let kids: number[] = [];
      await waitUntil(() => {
        kids = walkPidPpidTable(pid, listPidPpidTableSync());
        return kids.length >= 1;
      }, 8000);
      expect(kids.length).toBeGreaterThanOrEqual(1);
      expect(kids.every((k) => isAlive(k))).toBe(true);

      await mgr.killTree(pid);

      // Parent and every discovered descendant must be gone.
      const parentGone = await waitUntil(() => !isAlive(pid), 8000);
      expect(parentGone).toBe(true);
      for (const k of kids) {
        const gone = await waitUntil(() => !isAlive(k), 8000);
        expect(gone).toBe(true);
      }
    },
    30000,
  );
});

describe('AbstractCliManager.getAllDescendantPids', () => {
  // POSIX-only fixture: a detached `sh` job-control tree, cross-checked against
  // `pgrep -P` — which does not exist on Windows; the win32 twin below uses the
  // PowerShell pid/ppid table instead.
  it.skipIf(process.platform === 'win32')('finds a real descendant tree recursively', async () => {
    const mgr = new TestCliManager();
    const child = trackChild(
      spawn('sh', ['-c', 'sleep 100 & sleep 100 & wait'], { detached: true, stdio: 'ignore' })
    );
    const pid = child.pid;
    if (!pid) throw new Error('no pid');

    // Poll: the two backgrounded sleeps take a beat to appear under the shell.
    let found: number[] = [];
    const ok = await waitUntil(async () => {
      found = await mgr.descendants(pid);
      return found.length >= 2;
    }, 5000);

    expect(ok).toBe(true);
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.every((k) => isAlive(k))).toBe(true);
    // Cross-check against an independent enumeration (pgrep) of the same tree.
    const independentlyFound = childPidsOf(pid);
    for (const k of independentlyFound) {
      expect(found).toContain(k);
    }
  }, 10000);

  it.skipIf(process.platform !== 'win32')(
    'win32: finds a real node tree (parent + detached grandchild) via the process table',
    async () => {
      const mgr = new TestCliManager();
      // Same shape as the win32 killProcessTree fixture: a node child that
      // spawns its own long-lived detached grandchild.
      const child = trackChild(
        spawnDetachedGrandchildTree()
      );
      const pid = child.pid;
      if (!pid) throw new Error('no pid');

      // Positive control via the shared pid/ppid table: the tree really exists.
      let grandkids: number[] = [];
      const ok = await waitUntil(() => {
        grandkids = collectDescendantPids(pid);
        return grandkids.length >= 1;
      }, 5000);
      expect(ok).toBe(true);

      // The primitive must find those processes, and they must be alive.
      const found = await mgr.descendants(pid);
      for (const g of grandkids) {
        expect(found).toContain(g);
      }
      expect(found.every((k) => isAlive(k))).toBe(true);
    },
    15000,
  );

  it('returns an empty array for a childless pid', async () => {
    const mgr = new TestCliManager();
    // A real long-lived childless process — node, not `sleep`, so the fixture
    // runs identically on every platform.
    const child = trackChild(
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    );
    const pid = child.pid;
    if (!pid) throw new Error('no pid');
    await new Promise((r) => setTimeout(r, 150));

    // The interval process genuinely has no children.
    expect(await mgr.descendants(pid)).toEqual([]);
  }, 10000);
});

// ---------------------------------------------------------------------------
// spawnPtyProcess
// ---------------------------------------------------------------------------

describe('AbstractCliManager.spawnPtyProcess', () => {
  it('threads cwd + env to the child and returns an IPty with a live pid/exit', async () => {
    const mgr = new TestCliManager();
    const cwd = fs.realpathSync(os.tmpdir());
    // node -e prints its cwd and the injected env var — a cross-platform
    // stand-in for the old `sh -c 'echo ...'` fixture (no `sh` on Windows).
    const pty = await mgr.spawnPty(
      process.execPath,
      ['-e', 'console.log("CWD=" + process.cwd()); console.log("VAR=" + process.env.CYBOFLOW_PTY_TEST); process.exit(0)'],
      cwd,
      cleanEnv({ CYBOFLOW_PTY_TEST: 'pty-env-marker-123' })
    );
    spawnedPtys.push(pty);

    expect(typeof pty.pid).toBe('number');
    expect(pty.pid).toBeGreaterThan(0);

    let output = '';
    const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      pty.onData((d: string) => {
        output += d;
      });
      pty.onExit((e) => resolve(e));
    });

    expect(exit.exitCode).toBe(0);
    // cwd flowed through to the child ...
    expect(output).toContain(cwd);
    // ... and so did the injected environment variable.
    expect(output).toContain('pty-env-marker-123');
  }, 15000);

  it('surfaces an absent command as a nonzero child exit', async () => {
    const mgr = new TestCliManager();
    // On POSIX pty.spawn does not throw for a missing binary; the base impl
    // returns an IPty and the failure surfaces as a nonzero exit code. Windows
    // conpty cannot create a pty for a nonexistent image — node-pty throws
    // ("File not found"), which spawnPtyProcess rethrows. Same contract ("an
    // absent command never looks like a working session"), surfaced as a
    // rejected spawn instead of a dead terminal.
    if (process.platform === 'win32') {
      await expect(
        mgr.spawnPty('/nonexistent/definitely-not-a-real-binary-xyz', [], fs.realpathSync(os.tmpdir()), cleanEnv()),
      ).rejects.toThrow(/file not found/i);
      return;
    }
    const pty = await mgr.spawnPty(
      '/nonexistent/definitely-not-a-real-binary-xyz',
      [],
      fs.realpathSync(os.tmpdir()),
      cleanEnv()
    );
    spawnedPtys.push(pty);

    const exit = await new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      pty.onExit((e) => resolve(e));
    });
    expect(exit.exitCode).not.toBe(0);
  }, 15000);
});
