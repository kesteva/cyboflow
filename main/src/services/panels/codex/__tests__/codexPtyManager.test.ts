import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { CodexPtyManager, codexPermissionFlagsForMode } from '../codexPtyManager';
import type { SessionManager } from '../../../sessionManager';

/** Minimal stand-in for a live node-pty process, recording every write. */
interface FakePty {
  writes: string[];
  killed: boolean;
  write(data: string): void;
  kill(): void;
  pid: undefined;
}

function makeFakePty(): FakePty {
  const proc: FakePty = {
    writes: [],
    killed: false,
    write(data: string) {
      proc.writes.push(data);
    },
    kill() {
      proc.killed = true;
    },
    // `undefined` keeps killProcess on its no-PID fallback branch, so stopPanel is
    // exercised for real without shelling out to pgrep / signalling anything.
    pid: undefined,
  };
  return proc;
}

interface CliProcessLike {
  process: pty.IPty;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

class TestableCodexPtyManager extends CodexPtyManager {
  callBuildCommandArgs(options: Record<string, unknown>): string[] {
    return this.buildCommandArgs({
      panelId: 'panel-1',
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      prompt: '',
      ...options,
    });
  }

  captureConcurrentContext(
    context: { panelId: string; sessionId: string; runId: string },
    delayMs: number,
  ): Promise<{ panelId: string; sessionId: string; runId: string } | undefined> {
    return this.runWithPtySpawnContext(context, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return this.getActivePtySpawnContext();
    });
  }

  // Test accessors for the private per-panel bookkeeping cleanupCliResources
  // touches, so its panel-scoping can be verified without a real PTY spawn.
  private maps(): { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> } {
    return this as unknown as { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> };
  }
  seedPanelRunId(panelId: string, runId: string): void {
    this.maps().panelRunIds.set(panelId, runId);
  }
  seedPtyBacklog(runId: string, data: string): void {
    this.maps().ptyBacklog.set(runId, data);
  }
  hasPanelRunId(panelId: string): boolean {
    return this.maps().panelRunIds.has(panelId);
  }
  hasPtyBacklog(runId: string): boolean {
    return this.maps().ptyBacklog.has(runId);
  }
  callCleanupCliResources(panelId: string, sessionId: string): Promise<void> {
    return (this as unknown as { cleanupCliResources(p: string, s: string): Promise<void> }).cleanupCliResources(
      panelId,
      sessionId,
    );
  }

  /** Install a fake live PTY for `panelId` without spawning anything. */
  seedProcess(panelId: string, proc: FakePty, sessionId = 'session-1'): void {
    (this.processes as unknown as Map<string, CliProcessLike>).set(panelId, {
      process: proc as unknown as pty.IPty,
      panelId,
      sessionId,
      worktreePath: '/tmp/worktree',
    });
  }
}

function makeSessionManager(mode?: string): SessionManager {
  return {
    getDbSession: () => ({ agent_permission_mode: mode }),
  } as unknown as SessionManager;
}

describe('codexPermissionFlagsForMode', () => {
  it('maps Cyboflow permission modes to Codex sandbox and approval flags', () => {
    expect(codexPermissionFlagsForMode('default')).toEqual({
      sandbox: 'read-only',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('acceptEdits')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('auto')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('dontAsk')).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });
});

describe('CodexPtyManager.buildCommandArgs', () => {
  it('uses the session agent permission mode and passes model plus prompt after --', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'gpt-5.5', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-5.5',
      '--',
      'implement this',
    ]);
  });

  it('omits a stale Claude model', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'opus', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--',
      'implement this',
    ]);
  });

  it('omits auto so the Codex runtime selects its advertised default', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'auto' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('maps legacy ignore to dontAsk for compatibility with old session rows', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());

    expect(manager.callBuildCommandArgs({ permissionMode: 'ignore' })).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
    ]);
  });
});

describe('CodexPtyManager concurrent spawn context', () => {
  it('keeps interleaved PTY spawn provenance isolated', async () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const first = { panelId: 'panel-1', sessionId: 'session-1', runId: 'run-1' };
    const second = { panelId: 'panel-2', sessionId: 'session-2', runId: 'run-2' };

    const [capturedFirst, capturedSecond] = await Promise.all([
      manager.captureConcurrentContext(first, 10),
      manager.captureConcurrentContext(second, 0),
    ]);

    expect(capturedFirst).toEqual(first);
    expect(capturedSecond).toEqual(second);
  });
});

/**
 * The composer-relay seam. Regression cover for the "a follow-up typed into the
 * app's chat composer never sends, but the same text typed straight into the
 * terminal does" defect: the Codex TUI treats a `body + '\r'` written in ONE
 * pty.write as a PASTE, so the trailing '\r' is inserted as a literal newline and
 * the turn sits unsubmitted in the composer forever. Reproduced deterministically
 * against the bundled Codex CLI 0.153.3 through a node-pty harness (see
 * COMPOSER_SUBMIT_DELAY_MS in codexPtyManager.ts for the full measurement table).
 */
describe('CodexPtyManager.relayUserTurn (composer submit)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the body and the Enter as two distinct writes, body first', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'follow-up turn');

    // The body goes out on its own — no '\r' riding along in the same write.
    expect(proc.writes).toEqual(['follow-up turn']);

    vi.advanceTimersByTime(1000);

    expect(proc.writes).toEqual(['follow-up turn', '\r']);
  });

  it('suppresses the deferred Enter when the panel was stopped inside the delay window', async () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'doomed turn');
    await manager.stopPanel('panel-1');

    vi.advanceTimersByTime(1000);

    // No stray '\r' into a dead process.
    expect(proc.writes).toEqual(['doomed turn']);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('suppresses the deferred Enter when the panel process was REPLACED inside the delay window', () => {
    // continuePanel / restartPanelWithHistory kill and respawn under the SAME
    // panelId, so a presence-only guard would fire the Enter into a fresh REPL
    // that never received the body — committing whatever the new process had.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const original = makeFakePty();
    manager.seedProcess('panel-1', original);

    manager.relayUserTurn('panel-1', 'turn for the old process');
    const replacement = makeFakePty();
    manager.seedProcess('panel-1', replacement);

    vi.advanceTimersByTime(1000);

    expect(original.writes).toEqual(['turn for the old process']);
    expect(replacement.writes).toEqual([]);
  });

  it('delivers the turn exactly once and never respawns the persistent process', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'hello codex');
    vi.advanceTimersByTime(5000);

    expect(proc.writes).toEqual(['hello codex', '\r']);
    expect(proc.killed).toBe(false);
    expect(manager.getProcess('panel-1')?.process).toBe(proc as unknown as pty.IPty);
  });

  it('still throws for a panel with no live process, and schedules nothing', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());

    expect(() => manager.relayUserTurn('panel-ghost', 'nowhere to go')).toThrow(
      /No Codex process found/,
    );
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it('keeps two panels fully isolated — each deferred Enter lands only on the process its own body was written to', () => {
    // The identity guard is captured per-call from getProcess(panelId), so a
    // second panel's relayUserTurn (and its OWN pending timer) must never let
    // panel-1's Enter drift onto panel-2's process, or vice versa.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const procA = makeFakePty();
    const procB = makeFakePty();
    manager.seedProcess('panel-1', procA, 'session-1');
    manager.seedProcess('panel-2', procB, 'session-2');

    manager.relayUserTurn('panel-1', 'turn for panel one');
    manager.relayUserTurn('panel-2', 'turn for panel two');

    expect(procA.writes).toEqual(['turn for panel one']);
    expect(procB.writes).toEqual(['turn for panel two']);

    vi.advanceTimersByTime(1000);

    expect(procA.writes).toEqual(['turn for panel one', '\r']);
    expect(procB.writes).toEqual(['turn for panel two', '\r']);
  });

  it('SERIALIZES two relayUserTurn calls on the same panel into two distinct turns instead of merging them', () => {
    // Regression: each call used to write its body immediately and schedule its
    // own bare timer, so a second turn arriving inside the ~150ms delay window
    // produced writes ['bodyA', 'bodyB', '\r', '\r'] — bodyB was appended to the
    // still-unsubmitted bodyA inside the TUI composer with NO separator, the
    // first '\r' submitted the concatenation as ONE turn, and the second '\r'
    // hit an empty composer. The user's two messages silently became one prompt.
    //
    // The second body must not be written until the first turn's Enter has
    // actually gone out.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'first turn');
    manager.relayUserTurn('panel-1', 'second turn');

    // Only the FIRST body is on the wire — the second is queued, not written.
    expect(proc.writes).toEqual(['first turn']);

    vi.advanceTimersByTime(1000);

    // Strict alternation: every body is followed by its OWN Enter, and no body
    // is ever adjacent to another body.
    expect(proc.writes).toEqual(['first turn', '\r', 'second turn', '\r']);
  });

  it('never writes a queued body before the preceding Enter, at any point in the timeline', () => {
    // Walks the chain in COMPOSER_SUBMIT_DELAY_MS-sized steps so the ORDERING
    // invariant is checked mid-flight, not just at the end: a fix that wrote
    // both bodies up front and merely reordered the final array would pass the
    // end-state assertion above but fail here.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'alpha');
    manager.relayUserTurn('panel-1', 'beta');
    manager.relayUserTurn('panel-1', 'gamma');

    expect(proc.writes).toEqual(['alpha']);
    vi.advanceTimersByTime(150);
    expect(proc.writes).toEqual(['alpha', '\r']);
    vi.advanceTimersByTime(150);
    expect(proc.writes).toEqual(['alpha', '\r', 'beta']);
    vi.advanceTimersByTime(150);
    expect(proc.writes).toEqual(['alpha', '\r', 'beta', '\r']);
    vi.advanceTimersByTime(150);
    expect(proc.writes).toEqual(['alpha', '\r', 'beta', '\r', 'gamma']);
    vi.advanceTimersByTime(150);
    expect(proc.writes).toEqual(['alpha', '\r', 'beta', '\r', 'gamma', '\r']);

    // Chain retired — nothing further is armed.
    vi.advanceTimersByTime(5000);
    expect(proc.writes).toEqual(['alpha', '\r', 'beta', '\r', 'gamma', '\r']);
  });

  it('drops queued turns too when the panel process is replaced mid-chain', () => {
    // A queued body is written LATER, so the process-identity guard has to cover
    // the queued steps as well — otherwise a respawn under the same panelId
    // would receive a body typed for the process it replaced.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const original = makeFakePty();
    manager.seedProcess('panel-1', original);

    manager.relayUserTurn('panel-1', 'first turn');
    manager.relayUserTurn('panel-1', 'queued turn');
    const replacement = makeFakePty();
    manager.seedProcess('panel-1', replacement);

    vi.advanceTimersByTime(5000);

    expect(original.writes).toEqual(['first turn']);
    expect(replacement.writes).toEqual([]);
  });

  it('starts a fresh chain on the replacement process for a turn relayed AFTER the swap', () => {
    // The stale chain must not swallow the new turn: relayUserTurn sees that the
    // live process no longer matches the pending chain's target, abandons it, and
    // submits normally against the replacement.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const original = makeFakePty();
    manager.seedProcess('panel-1', original);

    manager.relayUserTurn('panel-1', 'turn for the old process');
    const replacement = makeFakePty();
    manager.seedProcess('panel-1', replacement);
    manager.relayUserTurn('panel-1', 'turn for the new process');

    expect(replacement.writes).toEqual(['turn for the new process']);

    vi.advanceTimersByTime(5000);

    expect(original.writes).toEqual(['turn for the old process']);
    expect(replacement.writes).toEqual(['turn for the new process', '\r']);
  });

  it('still throws on a dead panel even when a chain is pending, and delivers nothing', async () => {
    // The synchronous dead-panel throw is the caller's only signal; queueing must
    // not swallow it.
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'first turn');
    await manager.stopPanel('panel-1');

    expect(() => manager.relayUserTurn('panel-1', 'after the stop')).toThrow(
      /No Codex process found/,
    );

    vi.advanceTimersByTime(5000);
    expect(proc.writes).toEqual(['first turn']);
  });

  it('accepts a new turn on the same process once the previous chain has drained', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayUserTurn('panel-1', 'first turn');
    vi.advanceTimersByTime(1000);
    manager.relayUserTurn('panel-1', 'much later turn');
    vi.advanceTimersByTime(1000);

    expect(proc.writes).toEqual(['first turn', '\r', 'much later turn', '\r']);
  });
});

describe('CodexPtyManager.relayRawInput (raw keystroke passthrough)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards bytes verbatim in a single synchronous write, with no split and no delay', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    // A real Enter keystroke already arrives as its own '\r' — it must NOT be
    // split off or deferred the way the composer path's Enter is.
    manager.relayRawInput('panel-1', 'ls -la\r');
    expect(proc.writes).toEqual(['ls -la\r']);

    vi.advanceTimersByTime(1000);
    expect(proc.writes).toEqual(['ls -la\r']);
  });

  it('passes control sequences through byte-for-byte', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const proc = makeFakePty();
    manager.seedProcess('panel-1', proc);

    manager.relayRawInput('panel-1', '\x1b[A'); // Up arrow
    manager.relayRawInput('panel-1', '\x03'); // Ctrl-C
    manager.relayRawInput('panel-1', '\x1b[200~pasted\r text\x1b[201~'); // bracketed paste

    expect(proc.writes).toEqual(['\x1b[A', '\x03', '\x1b[200~pasted\r text\x1b[201~']);
    vi.advanceTimersByTime(1000);
    expect(proc.writes).toHaveLength(3);
  });
});

describe('CodexPtyManager.cleanupCliResources', () => {
  it('scopes cleanup to the exiting panel only — a sibling panel sharing the same session keeps its bookkeeping', async () => {
    // Regression: cleanupCliResources used to scan `this.processes` for every
    // panel matching the SESSION id and delete each one's panelRunIds/
    // ptyBacklog entry, so one panel's exit tore down a still-live sibling
    // panel's bookkeeping too (both panels in one session share the id).
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const sharedSessionId = 'session-shared';
    manager.seedPanelRunId('panel-A', 'run-A');
    manager.seedPtyBacklog('run-A', 'A output');
    manager.seedPanelRunId('panel-B', 'run-B');
    manager.seedPtyBacklog('run-B', 'B output');

    await manager.callCleanupCliResources('panel-A', sharedSessionId);

    // Only panel-A's bookkeeping is gone.
    expect(manager.hasPanelRunId('panel-A')).toBe(false);
    expect(manager.hasPtyBacklog('run-A')).toBe(false);
    // panel-B (still live, same session) is untouched.
    expect(manager.hasPanelRunId('panel-B')).toBe(true);
    expect(manager.hasPtyBacklog('run-B')).toBe(true);
  });
});
