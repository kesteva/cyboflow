/**
 * B4 — Live PTY base primitives of AbstractCliManager.
 *
 * These tests drive the REAL process-management primitives against REAL child
 * processes (detached `sh`/`node` trees), NOT the pid=0 FakePty bypass used by
 * the sibling claudeCodeManager / interactiveClaudeManager suites. Per the
 * CLAUDE.md dual-substrate note, `killProcessTree` / `getAllDescendantPids` /
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
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { AbstractCliManager } from '../AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConversationMessage } from '../../../../database/models';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

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
  public descendants(pid: number): number[] {
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
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
  it('tears down a real sleep-tree (parent + all descendants gone)', async () => {
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

    // Give the handler time to register, then prove a plain SIGTERM is ignored.
    await new Promise((r) => setTimeout(r, 400));
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(pid)).toBe(true); // TERM was ignored

    // killProcessTree escalates to SIGKILL, which the child cannot ignore.
    await mgr.killTree(pid);
    const gone = await waitUntil(() => !isAlive(pid), 5000);
    expect(gone).toBe(true);
  }, 15000);

  it('resolves without throwing when the pid has already exited', async () => {
    const mgr = new TestCliManager();
    const child = trackChild(spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' }));
    const pid = child.pid;
    if (!pid) throw new Error('no pid');

    // Wait for the process to actually exit.
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    await waitUntil(() => !isAlive(pid), 3000);
    expect(isAlive(pid)).toBe(false);

    // Killing an already-dead pid must not throw; returns true (no survivors).
    await expect(mgr.killTree(pid)).resolves.toBe(true);
  }, 15000);
});

describe('AbstractCliManager.getAllDescendantPids', () => {
  it('finds a real descendant tree recursively', async () => {
    const mgr = new TestCliManager();
    const child = trackChild(
      spawn('sh', ['-c', 'sleep 100 & sleep 100 & wait'], { detached: true, stdio: 'ignore' })
    );
    const pid = child.pid;
    if (!pid) throw new Error('no pid');

    // Poll: the two backgrounded sleeps take a beat to appear under the shell.
    let found: number[] = [];
    const ok = await waitUntil(() => {
      found = mgr.descendants(pid);
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

  it('returns an empty array for a childless pid', async () => {
    const mgr = new TestCliManager();
    const child = trackChild(spawn('sleep', ['100'], { detached: true, stdio: 'ignore' }));
    const pid = child.pid;
    if (!pid) throw new Error('no pid');
    await new Promise((r) => setTimeout(r, 150));

    // `sleep` genuinely has no children.
    expect(mgr.descendants(pid)).toEqual([]);
  }, 10000);
});

// ---------------------------------------------------------------------------
// spawnPtyProcess
// ---------------------------------------------------------------------------

describe('AbstractCliManager.spawnPtyProcess', () => {
  it('threads cwd + env to the child and returns an IPty with a live pid/exit', async () => {
    const mgr = new TestCliManager();
    const cwd = fs.realpathSync(os.tmpdir());
    const pty = await mgr.spawnPty(
      'sh',
      ['-c', 'echo CWD=$(pwd); echo VAR=$CYBOFLOW_PTY_TEST; exit 0'],
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
    // pty.spawn does not throw for a missing binary on this platform; the base
    // impl returns an IPty and the failure surfaces as a nonzero exit code.
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
