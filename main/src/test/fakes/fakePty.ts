/**
 * FakePty — the shared stub `IPty` used to drive PTY-substrate managers without
 * spawning a real terminal.
 *
 * Extracted VERBATIM from `interactiveClaudeManager.test.ts` (its original home)
 * so the Tier-3 mocked-SDK integration suite can drive the REAL
 * `InteractiveClaudeManager` through the same harness the unit tests use, rather
 * than growing a second, drifting copy. Behaviour is unchanged — this is a pure
 * move.
 *
 * pid is 0 (falsy) so `AbstractCliManager.killProcess` takes the simple
 * `process.kill()` fallback and never runs the real `ps`/`kill` process-tree
 * shell calls in tests.
 */

/** Listener shape node-pty's `onExit` hands back. */
export interface FakePtyExitListener {
  (e: { exitCode: number; signal?: number }): void;
}

export class FakePty {
  readonly pid = 0;
  readonly process = 'claude';
  readonly cols = 80;
  readonly rows = 30;
  readonly handleFlowControl = false;
  readonly writes: string[] = [];
  /** The argv a testable manager's spawnPtyProcess override recorded for this pty (if it does). */
  args: string[] = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: FakePtyExitListener[] = [];
  killed = false;

  onData = (cb: (d: string) => void): { dispose(): void } => {
    this.dataListeners.push(cb);
    return { dispose: () => undefined };
  };

  onExit = (cb: FakePtyExitListener): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {
    // no-op
  }

  clear(): void {
    // no-op
  }

  kill(): void {
    this.killed = true;
  }

  pause(): void {
    // no-op
  }

  resume(): void {
    // no-op
  }

  on(): void {
    // no-op (deprecated event surface)
  }

  /** Test driver: fire the captured onExit listeners. */
  fireExit(exitCode: number): void {
    for (const cb of this.exitListeners) cb({ exitCode });
  }

  /** Test driver: push a raw chunk through every captured onData listener. */
  fireData(chunk: string): void {
    for (const cb of this.dataListeners) cb(chunk);
  }
}
