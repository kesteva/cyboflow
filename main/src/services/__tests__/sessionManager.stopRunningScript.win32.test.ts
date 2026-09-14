/**
 * SessionManager.stopRunningScript — the win32 ladder.
 *
 * Windows has no process groups and no POSIX signals, so the POSIX ladder's
 * `kill -TERM -<pid>` / `kill -9` / `pkill -9 -P` calls are silent no-ops
 * there (and every failed descendant kill inflated an "already terminated
 * gracefully" counter shown to the user). The win32 arm delegates to
 * `taskkill /PID <pid> /T /F` plus per-descendant forced kills, counting only
 * liveness-verified terminations.
 *
 * Runs only on win32 hosts (where the ladder actually executes); it drives a
 * REAL parent+grandchild node tree and reaps it through the production code
 * path. Mock-db harness mirrors sessionManagerLastActivity.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const sessionLogCalls = vi.hoisted(() => [] as Array<{ level: string; message: string }>);

vi.mock('../../ipc/logs', () => ({
  addSessionLog: (_sessionId: string, level: string, message: string) => {
    sessionLogCalls.push({ level, message });
  },
  cleanupSessionLogs: vi.fn(),
}));
vi.mock('../panelManager', () => ({
  panelManager: { ensureDiffPanel: vi.fn(), getPanelsForSession: vi.fn().mockReturnValue([]) },
}));
vi.mock('../scriptExecutionTracker', () => ({
  scriptExecutionTracker: {
    start: vi.fn(),
    stop: vi.fn(),
    markClosing: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    getRunningScriptId: vi.fn().mockReturnValue(null),
  },
}));

import { SessionManager } from '../sessionManager';
import type { DatabaseService } from '../../database/database';
import {
  isAlive,
  spawnNamedDetachedGrandchildTree,
  waitUntil,
} from '../../__test_fixtures__/processTree';

describe('SessionManager.stopRunningScript — win32 ladder', () => {
  it.skipIf(process.platform !== 'win32')(
    'force-kills the whole tree via taskkill and reports clean termination',
    async () => {
      const sm = new SessionManager({} as unknown as DatabaseService);

      // A REAL node child that spawns its own long-lived detached grandchild —
      // the shape a RUN script presents (shell + app + app children). It names
      // its grandchild, so this suite asserts over the tree it OWNS rather than
      // a pid/ppid walk, which sweeps up phantoms on Windows (processTree.ts).
      const tree = await spawnNamedDetachedGrandchildTree();
      const pid = tree.child.pid;
      expect(pid).toBeTypeOf('number');

      // Positive control: both halves are up before the ladder runs.
      expect(isAlive(pid as number)).toBe(true);
      expect(isAlive(tree.grandchildPid)).toBe(true);

      (sm as unknown as { runningScriptProcess: ChildProcess | null }).runningScriptProcess = tree.child;
      (sm as unknown as { currentRunningSessionId: string | null }).currentRunningSessionId = 'session-under-test';

      await sm.stopRunningScript();

      const allDead = await waitUntil(
        () => !isAlive(pid as number) && !isAlive(tree.grandchildPid),
        8000,
      );
      expect(allDead).toBe(true);

      // The ladder finished its verification pass — and no "already
      // terminated gracefully" inflation: on win32 the count reflects only
      // liveness-verified kills, and this tree was reaped wholesale.
      const messages = sessionLogCalls.map((c) => c.message);
      expect(messages.join('\n')).toContain('[All processes terminated successfully]');
      expect(messages.join('\n')).not.toContain('already terminated');
    },
    30000,
  );
});
